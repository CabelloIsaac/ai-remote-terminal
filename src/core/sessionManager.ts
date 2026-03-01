import logger from "../utils/logger.js";
import { ClaudeService } from "../services/claudeService.js";
import { TelegramService } from "../services/telegramService.js";
import type { DetectedPrompt } from "../core/promptDetector.js";

/**
 * SessionManager wires ClaudeService ↔ TelegramService together.
 * Handles commands, routing, and lifecycle.
 */
export class SessionManager {
  private claude: ClaudeService;
  private telegram: TelegramService;
  private restartOnCrash = false;
  private lastArgs: string[] = [];

  constructor(claude: ClaudeService, telegram: TelegramService) {
    this.claude = claude;
    this.telegram = telegram;

    this.bindTelegramHandlers();
    this.bindClaudeHandlers();

    logger.info("SessionManager initialized");
  }

  // ────────────────────────── Telegram → Claude ──────────────────────────

  private bindTelegramHandlers(): void {
    // Commands
    this.telegram.onCommand((command, args) => {
      switch (command) {
        case "start":
          this.handleStart(args);
          break;
        case "stop":
          this.handleStop();
          break;
        case "restart":
          this.handleRestart();
          break;
        case "status":
          this.handleStatus();
          break;
        case "logs":
          this.handleLogs(args);
          break;
        case "interrupt":
          this.handleInterrupt();
          break;
        case "enter":
          this.handleEnter();
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

    // Free-form text → Claude stdin
    this.telegram.onText((text) => {
      if (!this.claude.running) {
        this.telegram.sendMessage(
          "⚠️ Claude is not running. Use /start to begin a session.",
        );
        return;
      }
      logger.info({ input: text }, "Forwarding user input to Claude");
      this.claude.sendLine(text);
    });

    // Inline button callbacks
    this.telegram.onCallback((action, queryId) => {
      if (!this.claude.running) {
        this.telegram.sendMessage("⚠️ Claude is not running.");
        return;
      }

      switch (action) {
        case "approve":
          logger.info("User approved prompt");
          this.claude.approve();
          this.telegram.sendMessage("✅ Approved");
          break;
        case "deny":
          logger.info("User denied prompt");
          this.claude.deny();
          this.telegram.sendMessage("❌ Denied");
          break;
        case "enter":
          logger.info("User pressed Enter via button");
          this.claude.write("\n");
          this.telegram.sendMessage("⏎ Enter sent");
          break;
        default:
          // Generic callback — send as raw input
          this.claude.sendLine(action);
      }
    });
  }

  // ────────────────────────── Claude → Telegram ──────────────────────────

  private bindClaudeHandlers(): void {
    this.claude.on("output", (data: string) => {
      this.telegram.pushOutput(data);
    });

    this.claude.on("prompt", (prompt: DetectedPrompt) => {
      if (prompt.type === "input") {
        this.telegram.sendEnterPrompt(prompt.summary);
      } else {
        this.telegram.sendPrompt(prompt.summary);
      }
    });

    this.claude.on(
      "exit",
      (code: number | undefined, signal: number | undefined) => {
        const msg = `🔴 Claude exited (code=${code ?? "?"}, signal=${signal ?? "?"})`;
        this.telegram.sendMessage(msg);

        if (this.restartOnCrash && code !== 0) {
          logger.info("Auto-restarting Claude after crash");
          this.telegram.sendMessage("🔄 Auto-restarting…");
          setTimeout(() => this.startClaude(this.lastArgs), 2000);
        }
      },
    );

    this.claude.on("error", (err: Error) => {
      this.telegram.sendMessage(`❗ Error: ${err.message}`);
    });
  }

  // ────────────────────────── Command Handlers ──────────────────────────

  private handleStart(args: string): void {
    if (this.claude.running) {
      this.telegram.sendMessage(
        "⚠️ Claude is already running. Use /stop first.",
      );
      return;
    }

    const parsedArgs = args ? args.split(" ").filter(Boolean) : [];
    this.startClaude(parsedArgs);
  }

  private startClaude(args: string[]): void {
    try {
      this.lastArgs = args;
      this.claude.spawn(args);
      this.telegram.sendMessage(
        `🟢 Claude started${args.length ? ` with args: ${args.join(" ")}` : ""}`,
      );
    } catch (err: any) {
      this.telegram.sendMessage(`❗ Failed to start Claude: ${err.message}`);
    }
  }

  private handleStop(): void {
    if (!this.claude.running) {
      this.telegram.sendMessage("ℹ️ Claude is not running.");
      return;
    }
    this.claude.stop();
    this.telegram.sendMessage("🛑 Claude stopped.");
  }

  private handleRestart(): void {
    this.telegram.sendMessage("🔄 Restarting Claude…");
    if (this.claude.running) {
      this.claude.stop();
    }
    setTimeout(() => this.startClaude(this.lastArgs), 1000);
  }

  private handleStatus(): void {
    const status = this.claude.running ? "🟢 Running" : "🔴 Stopped";
    this.telegram.sendMessage(`Status: ${status}`);
  }

  private handleLogs(args: string): void {
    const n = Math.min(Number(args) || 50, 200);
    const lines = this.claude.getLastLines(n);

    if (lines.length === 0) {
      this.telegram.sendMessage("No log output yet.");
      return;
    }

    this.telegram.pushOutput(lines.join("\n"));
  }

  private handleEnter(): void {
    if (!this.claude.running) {
      this.telegram.sendMessage("ℹ️ Claude is not running.");
      return;
    }
    this.claude.write("\n");
    this.telegram.sendMessage("⏎ Enter sent.");
  }

  private handleInterrupt(): void {
    if (!this.claude.running) {
      this.telegram.sendMessage("ℹ️ Claude is not running.");
      return;
    }
    this.claude.interrupt();
    this.telegram.sendMessage("⚡ Sent Ctrl+C to Claude.");
  }

  private handleHelp(): void {
    this.telegram.sendMessage(
      [
        "🤖 *Claude Remote Bot*",
        "",
        "/start [args] — Start Claude session",
        "/stop — Kill Claude process",
        "/restart — Restart Claude",
        "/status — Check if running",
        "/logs [n] — Last n lines (default 50)",
        "/enter — Send Enter keypress",
        "/interrupt — Send Ctrl+C",
        "/help — Show this message",
        "",
        "Any other text is forwarded to Claude as input.",
      ].join("\n"),
    );
  }

  // ────────────────────────── Lifecycle ──────────────────────────

  async shutdown(): Promise<void> {
    logger.info("Shutting down…");
    if (this.claude.running) {
      this.claude.stop();
    }
    await this.telegram.stop();
  }
}
