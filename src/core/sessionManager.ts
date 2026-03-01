import logger from "../utils/logger.js";
import { ClaudeService } from "../services/claudeService.js";
import { TelegramService } from "../services/telegramService.js";

/**
 * SessionManager wires ClaudeService <-> TelegramService.
 * Routes Telegram input to Claude and structured Claude events back to Telegram.
 */
export class SessionManager {
  private claude: ClaudeService;
  private telegram: TelegramService;

  // Text accumulation — Claude streams text in tiny chunks,
  // we batch them before sending to Telegram.
  private textBuffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_DELAY_MS = 800;

  constructor(claude: ClaudeService, telegram: TelegramService) {
    this.claude = claude;
    this.telegram = telegram;

    this.bindTelegramHandlers();
    this.bindClaudeHandlers();

    logger.info("SessionManager initialized");
  }

  // ────────────────────────── Telegram -> Claude ──────────────────────────

  private bindTelegramHandlers(): void {
    this.telegram.onCommand((command, args) => {
      switch (command) {
        case "start":
          this.handleStart();
          break;
        case "stop":
          this.handleStop();
          break;
        case "new":
          this.handleNew();
          break;
        case "status":
          this.handleStatus();
          break;
        case "interrupt":
          this.handleInterrupt();
          break;
        case "help":
          this.handleHelp();
          break;
        default:
          this.telegram.sendMessage(
            `Unknown command: /${command}\nUse /help for available commands.`,
          );
      }
    });

    this.telegram.onText((text) => {
      if (!this.claude.running) {
        // Auto-start on first message
        this.claude.start();
        this.telegram.sendMessage("🟢 Session started.");
      }
      if (this.claude.busy) {
        this.telegram.sendMessage("⏳ Still processing. Wait or /interrupt.");
        return;
      }
      logger.info({ input: text }, "Forwarding to Claude");
      this.claude.sendMessage(text);
    });

    this.telegram.onCallback((action, _queryId) => {
      if (!this.claude.running) {
        this.telegram.sendMessage("Claude is not running.");
        return;
      }
      // For now callbacks send as a new message to Claude
      if (!this.claude.busy) {
        this.claude.sendMessage(action);
      }
    });
  }

  // ────────────────────────── Claude -> Telegram ──────────────────────────

  private bindClaudeHandlers(): void {
    // Streamed text chunks — accumulate and flush periodically
    this.claude.on("text", (chunk: string) => {
      this.textBuffer += chunk;
      this.scheduleFlush();
    });

    // Tool invocations — show as compact notifications
    this.claude.on(
      "tool_use",
      (info: { tool: string; input: Record<string, any> }) => {
        this.flushText(); // send any pending text first

        const detail = this.summarizeTool(info.tool, info.input);
        this.telegram.sendMessage(`🔧 ${detail}`);
      },
    );

    // Final result — flush remaining text, show cost
    this.claude.on(
      "result",
      (r: {
        text: string;
        costUsd: number;
        sessionId: string;
        durationMs: number;
      }) => {
        this.flushText();

        const parts: string[] = [];
        if (r.costUsd > 0) parts.push(`$${r.costUsd.toFixed(4)}`);
        if (r.durationMs > 0) parts.push(`${(r.durationMs / 1000).toFixed(1)}s`);
        if (parts.length) {
          this.telegram.sendMessage(`✅ Done (${parts.join(", ")})`);
        }
      },
    );

    // Process exit
    this.claude.on("done", (code: number) => {
      this.flushText();
      if (code !== 0 && code !== null) {
        this.telegram.sendMessage(`⚠️ Claude exited with code ${code}`);
      }
    });

    // Errors
    this.claude.on("error", (err: Error) => {
      this.telegram.sendMessage(`❗ ${err.message}`);
    });
  }

  // ── Text batching ──

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushText();
    }, this.FLUSH_DELAY_MS);
  }

  private flushText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const text = this.textBuffer.trim();
    this.textBuffer = "";
    if (text) {
      this.telegram.sendMessage(text);
    }
  }

  // ── Tool summary formatting ──

  private summarizeTool(
    tool: string,
    input: Record<string, any>,
  ): string {
    const path =
      input.file_path ?? input.path ?? input.pattern ?? input.query ?? "";
    const cmd = input.command ?? "";

    switch (tool) {
      case "Read":
        return `Read ${path}`;
      case "Write":
        return `Write ${path}`;
      case "Edit":
        return `Edit ${path}`;
      case "Bash":
        return `Bash: ${cmd.slice(0, 80)}${cmd.length > 80 ? "…" : ""}`;
      case "Glob":
        return `Glob ${path}`;
      case "Grep":
        return `Grep "${input.pattern ?? ""}" ${path}`;
      case "WebSearch":
        return `Search: ${input.query ?? ""}`;
      case "WebFetch":
        return `Fetch ${input.url ?? ""}`;
      default:
        return `${tool}${path ? ": " + path : ""}`;
    }
  }

  // ────────────────────────── Command Handlers ──────────────────────────

  private handleStart(): void {
    if (this.claude.running) {
      this.telegram.sendMessage("Already running. Send a message or /new for fresh conversation.");
      return;
    }
    this.claude.start();
    this.telegram.sendMessage("🟢 Ready. Send a message to begin.");
  }

  private handleStop(): void {
    if (!this.claude.running) {
      this.telegram.sendMessage("Not running.");
      return;
    }
    this.claude.stop();
    this.telegram.sendMessage("🔴 Stopped. Session ended.");
  }

  private handleNew(): void {
    this.claude.newConversation();
    if (!this.claude.running) this.claude.start();
    this.telegram.sendMessage("🆕 New conversation. Send a message.");
  }

  private handleStatus(): void {
    if (!this.claude.running) {
      this.telegram.sendMessage("🔴 Stopped");
    } else if (this.claude.busy) {
      this.telegram.sendMessage("⏳ Processing...");
    } else {
      this.telegram.sendMessage("🟢 Ready");
    }
  }

  private handleInterrupt(): void {
    if (!this.claude.running) {
      this.telegram.sendMessage("Not running.");
      return;
    }
    this.claude.interrupt();
    this.telegram.sendMessage("⚡ Interrupted.");
  }

  private handleHelp(): void {
    this.telegram.sendMessage(
      [
        "🤖 Claude Remote",
        "",
        "/start — Start session",
        "/stop — End session",
        "/new — New conversation",
        "/status — Check status",
        "/interrupt — Cancel current task",
        "/help — This message",
        "",
        "Just send text to chat with Claude.",
      ].join("\n"),
    );
  }

  // ────────────────────────── Lifecycle ──────────────────────────

  async shutdown(): Promise<void> {
    logger.info("Shutting down…");
    this.claude.stop();
    await this.telegram.stop();
  }
}
