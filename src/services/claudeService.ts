import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import logger from "../utils/logger.js";
import { getConfig } from "../utils/config.js";

/**
 * ClaudeService — uses `claude -p --output-format stream-json` per message.
 * Each user message spawns a short-lived process; conversation state is
 * maintained via --resume <sessionId>.
 *
 * Events emitted:
 *   text(chunk: string)          — streamed assistant text
 *   tool_use(info)               — tool invocation
 *   tool_result(info)            — tool execution result
 *   result(info)                 — final result with cost/session
 *   done(code: number)           — process exited
 *   error(err: Error)            — spawn or runtime error
 */
export class ClaudeService extends EventEmitter {
  private process: ChildProcess | null = null;
  private _running = false;
  private _busy = false;
  private sessionId: string | null = null;
  private lineBuffer = "";

  get running(): boolean {
    return this._running;
  }

  get busy(): boolean {
    return this._busy;
  }

  /** Mark the service as ready (no persistent process needed). */
  start(): void {
    this._running = true;
    this.sessionId = null;
    logger.info("Claude service ready (stream-json mode)");
  }

  /** End the current session. */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._running = false;
    this._busy = false;
    this.sessionId = null;
    logger.info("Claude service stopped");
  }

  /** Start a fresh conversation (clear session, keep service running). */
  newConversation(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this._busy = false;
    this.sessionId = null;
    logger.info("New conversation started");
  }

  /** Send a message to Claude. Spawns a process, streams JSON back. */
  sendMessage(text: string): void {
    if (!this._running) {
      this.emit("error", new Error("Service not started. Use /start."));
      return;
    }
    if (this._busy) {
      this.emit(
        "error",
        new Error("Still processing. Wait or use /interrupt."),
      );
      return;
    }

    const config = getConfig();
    const args = ["-p", text, "--output-format", "stream-json"];

    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    this._busy = true;
    this.lineBuffer = "";

    logger.info({ sessionId: this.sessionId ?? "new" }, "Sending to Claude");

    // Strip CLAUDECODE env var to prevent nesting detection
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;

    logger.info({ cmd: config.claudeCommand, args }, "Spawning claude -p");

    this.process = spawn(config.claudeCommand, args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      const str = chunk.toString();
      logger.debug({ bytes: str.length }, "stdout chunk");
      this.lineBuffer += str;
      this.processLines();
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) {
        logger.warn({ stderr: msg }, "Claude stderr");
        // Surface stderr errors to Telegram so user can see them
        this.emit("error", new Error(msg));
      }
    });

    this.process.on("close", (code) => {
      logger.info({ code, bufferLeft: this.lineBuffer.length }, "Claude process closed");
      this.processLines(); // flush remaining
      this._busy = false;
      this.process = null;
      this.emit("done", code);
    });

    this.process.on("error", (err) => {
      logger.error({ err: err.message }, "Failed to spawn claude");
      this._busy = false;
      this.process = null;
      this.emit("error", err);
    });
  }

  /** Interrupt current processing (SIGINT). */
  interrupt(): void {
    if (this.process) {
      this.process.kill("SIGINT");
      this._busy = false;
      this.process = null;
    }
  }

  // ── JSON line parsing ──

  private processLines(): void {
    const parts = this.lineBuffer.split("\n");
    this.lineBuffer = parts.pop() ?? "";

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleEvent(JSON.parse(trimmed));
      } catch {
        logger.debug({ line: trimmed.slice(0, 200) }, "Non-JSON line");
      }
    }
  }

  private handleEvent(ev: any): void {
    logger.debug({ type: ev.type, subtype: ev.subtype }, "JSON event");
    switch (ev.type) {
      case "system":
        if (ev.session_id) this.sessionId = ev.session_id;
        break;

      case "assistant":
        if (ev.subtype === "text") {
          this.emit("text", ev.text ?? "");
        } else if (ev.subtype === "tool_use") {
          this.emit("tool_use", {
            tool: ev.name ?? "unknown",
            input: ev.input ?? {},
          });
        }
        break;

      case "tool_result":
        this.emit("tool_result", {
          tool: ev.name ?? "unknown",
          content: ev.content ?? "",
        });
        break;

      case "result":
        if (ev.session_id) this.sessionId = ev.session_id;
        this.emit("result", {
          text: ev.text ?? "",
          costUsd: ev.cost_usd ?? 0,
          sessionId: ev.session_id ?? this.sessionId,
          durationMs: ev.duration_ms ?? 0,
        });
        break;
    }
  }
}
