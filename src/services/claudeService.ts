import { EventEmitter } from "events";
import * as pty from "node-pty";
import logger from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import {
  detectPrompt,
  stripAnsi,
  type DetectedPrompt,
} from "../core/promptDetector.js";

export interface ClaudeServiceEvents {
  output: (data: string) => void;
  prompt: (prompt: DetectedPrompt) => void;
  exit: (code: number | undefined, signal: number | undefined) => void;
  error: (err: Error) => void;
}

export class ClaudeService extends EventEmitter {
  private process: pty.IPty | null = null;
  private _running = false;
  private outputLog: string[] = [];
  private lastInput = "";
  private suppressEchoUntil = 0;

  /** Max lines kept in memory for /logs */
  private readonly MAX_LOG_LINES = 2000;

  get running(): boolean {
    return this._running;
  }

  /**
   * Spawn Claude CLI via PTY.
   * @param args  Extra CLI args passed after the claude command
   */
  spawn(args: string[] = []): void {
    if (this._running) {
      throw new Error("Claude is already running. Stop first.");
    }

    const config = getConfig();
    const cmd = config.claudeCommand;

    logger.info({ cmd, args }, "Spawning Claude CLI");

    this.process = pty.spawn(cmd, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });

    this._running = true;
    this.outputLog = [];

    this.process.onData((data: string) => {
      // Suppress PTY echo of user input
      if (this.suppressEchoUntil > Date.now()) {
        const cleaned = stripAnsi(data).trim();
        if (cleaned === this.lastInput.trim() || cleaned.length === 0) {
          return; // Skip echoed input
        }
      }

      // Also log to local console for debugging
      process.stdout.write(data);

      // Store cleaned output for /logs
      const lines = data.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          this.outputLog.push(stripAnsi(line));
          if (this.outputLog.length > this.MAX_LOG_LINES) {
            this.outputLog.shift();
          }
        }
      }

      // Emit raw output
      this.emit("output", data);

      // Check for prompts
      const prompt = detectPrompt(data);
      if (prompt) {
        this.emit("prompt", prompt);
      }
    });

    this.process.onExit(({ exitCode, signal }) => {
      logger.info({ exitCode, signal }, "Claude process exited");
      this._running = false;
      this.process = null;
      this.emit("exit", exitCode, signal);
    });
  }

  /**
   * Write raw input to Claude's stdin.
   */
  write(input: string): void {
    if (!this.process || !this._running) {
      throw new Error("Claude is not running.");
    }
    logger.debug({ input: input.trim() }, "Writing to Claude stdin");
    this.process.write(input);
  }

  /**
   * Send a line of text (appends newline).
   */
  sendLine(text: string): void {
    this.lastInput = text;
    this.suppressEchoUntil = Date.now() + 500; // suppress echo for 500ms
    this.write(text + "\n");
  }

  /**
   * Approve a prompt (send "y\n").
   */
  approve(): void {
    this.sendLine("y");
  }

  /**
   * Deny a prompt (send "n\n").
   */
  deny(): void {
    this.sendLine("n");
  }

  /**
   * Kill the Claude process.
   */
  stop(): void {
    if (this.process && this._running) {
      logger.info("Killing Claude process");
      this.process.kill();
      this._running = false;
      this.process = null;
    }
  }

  /**
   * Return the last `n` lines of output.
   */
  getLastLines(n = 50): string[] {
    return this.outputLog.slice(-n);
  }

  /**
   * Send SIGINT (Ctrl+C).
   */
  interrupt(): void {
    if (this.process && this._running) {
      this.process.write("\x03");
    }
  }

  /**
   * Resize the PTY.
   */
  resize(cols: number, rows: number): void {
    if (this.process && this._running) {
      this.process.resize(cols, rows);
    }
  }
}
