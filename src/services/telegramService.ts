import TelegramBot, {
  type CallbackQuery,
  type Message,
} from "node-telegram-bot-api";
import logger from "../utils/logger.js";
import { getConfig, type AppConfig } from "../utils/config.js";
import { stripAnsi } from "../core/promptDetector.js";

/** Maximum Telegram message length */
const TG_MAX_LENGTH = 4096;

/** Minimum gap between messages to avoid flood (ms) */
const MIN_SEND_GAP = 1100;

export class TelegramService {
  private bot: TelegramBot;
  private config: AppConfig;
  private chatId: number | null = null;

  // Batching state
  private outputBuffer = "";
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private lastSendTime = 0;
  private sendQueue: Array<() => Promise<void>> = [];
  private processingQueue = false;

  // Callback handlers registered by the session manager
  private onTextHandler: ((text: string) => void) | null = null;
  private onCallbackHandler:
    | ((action: string, queryId: string) => void)
    | null = null;
  private onCommandHandler: ((command: string, args: string) => void) | null =
    null;

  constructor() {
    this.config = getConfig();

    this.bot = new TelegramBot(this.config.telegramToken, { polling: true });

    this.bot.on("polling_error", (err) => {
      logger.error({ err: err.message }, "Telegram polling error");
    });

    this.setupHandlers();
    this.startBatchTimer();

    logger.info("Telegram bot initialized");
  }

  // ────────────────────────── Public API ──────────────────────────

  onText(handler: (text: string) => void): void {
    this.onTextHandler = handler;
  }

  onCallback(handler: (action: string, queryId: string) => void): void {
    this.onCallbackHandler = handler;
  }

  onCommand(handler: (command: string, args: string) => void): void {
    this.onCommandHandler = handler;
  }

  /**
   * Buffer output and send according to configured mode.
   */
  pushOutput(rawData: string): void {
    const clean = stripAnsi(rawData);
    if (!clean.trim()) return;

    if (this.config.outputMode === "streaming") {
      this.enqueueSend(() => this.sendCodeBlock(clean));
    } else {
      this.outputBuffer += clean;
    }
  }

  /**
   * Send a plain text message immediately (queued for rate-limit).
   */
  sendMessage(text: string): void {
    this.enqueueSend(() => this.rawSend(text));
  }

  /**
   * Send an interactive prompt message with Approve / Deny buttons.
   */
  sendPrompt(summary: string): void {
    this.enqueueSend(async () => {
      if (!this.chatId) return;
      await this.bot.sendMessage(
        this.chatId,
        `⚠️ *Prompt Detected*\n\n${this.escapeMarkdown(summary)}`,
        {
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: "approve" },
                { text: "❌ Deny", callback_data: "deny" },
              ],
            ],
          },
        },
      );
    });
  }

  /**
   * Send an "Enter to continue" prompt with a ⏎ button.
   */
  sendEnterPrompt(summary: string): void {
    this.enqueueSend(async () => {
      if (!this.chatId) return;
      await this.bot.sendMessage(this.chatId, `⏎ ${summary}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⏎ Press Enter", callback_data: "enter" }],
          ],
        },
      });
    });
  }

  /**
   * Send an arbitrary message with custom inline keyboard.
   */
  sendWithButtons(
    text: string,
    buttons: Array<{ text: string; data: string }>,
  ): void {
    this.enqueueSend(async () => {
      if (!this.chatId) return;
      const keyboard = buttons.map((b) => ({
        text: b.text,
        callback_data: b.data,
      }));
      await this.bot.sendMessage(this.chatId, text, {
        reply_markup: { inline_keyboard: [keyboard] },
      });
    });
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(): Promise<void> {
    if (this.batchTimer) clearInterval(this.batchTimer);
    await this.bot.stopPolling();
    logger.info("Telegram bot stopped");
  }

  // ────────────────────────── Internals ──────────────────────────

  private setupHandlers(): void {
    // Authorize and capture chatId
    this.bot.on("message", (msg: Message) => {
      if (!this.authorize(msg)) return;
      this.chatId = msg.chat.id;

      const text = msg.text?.trim() ?? "";
      if (!text) return;

      // Route commands
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.split(" ");
        const command = cmd.slice(1).toLowerCase(); // strip leading /
        this.onCommandHandler?.(command, rest.join(" "));
        return;
      }

      // Route text input
      this.onTextHandler?.(text);
    });

    // Inline button callbacks
    this.bot.on("callback_query", (query: CallbackQuery) => {
      if (!query.message || !this.authorizeCallback(query)) return;
      this.chatId = query.message.chat.id;

      const action = query.data ?? "";
      this.onCallbackHandler?.(action, query.id);

      // Acknowledge the button press
      this.bot.answerCallbackQuery(query.id).catch(() => {});
    });
  }

  private authorize(msg: Message): boolean {
    if (msg.from?.id !== this.config.authorizedUserId) {
      logger.warn({ userId: msg.from?.id }, "Unauthorized message — ignored");
      return false;
    }
    return true;
  }

  private authorizeCallback(query: CallbackQuery): boolean {
    if (query.from.id !== this.config.authorizedUserId) {
      logger.warn({ userId: query.from.id }, "Unauthorized callback — ignored");
      return false;
    }
    return true;
  }

  // ── Rate-limited send queue ──

  private enqueueSend(fn: () => Promise<void>): void {
    this.sendQueue.push(fn);
    if (!this.processingQueue) {
      this.drainQueue();
    }
  }

  private async drainQueue(): Promise<void> {
    this.processingQueue = true;
    while (this.sendQueue.length > 0) {
      const fn = this.sendQueue.shift()!;
      const elapsed = Date.now() - this.lastSendTime;
      if (elapsed < MIN_SEND_GAP) {
        await sleep(MIN_SEND_GAP - elapsed);
      }
      try {
        await fn();
        this.lastSendTime = Date.now();
      } catch (err: any) {
        // Telegram 429 — back off
        if (err?.response?.statusCode === 429) {
          const retryAfter =
            (err.response?.body?.parameters?.retry_after ?? 5) * 1000;
          logger.warn({ retryAfter }, "Telegram rate limit hit, backing off");
          await sleep(retryAfter);
          this.sendQueue.unshift(fn); // re-queue
        } else {
          logger.error(
            { err: err?.message },
            "Failed to send Telegram message",
          );
        }
      }
    }
    this.processingQueue = false;
  }

  // ── Batch timer ──

  private startBatchTimer(): void {
    if (this.config.outputMode !== "batched") return;

    this.batchTimer = setInterval(() => {
      this.flushBuffer();
    }, this.config.batchIntervalMs);
  }

  private flushBuffer(): void {
    if (!this.outputBuffer.trim()) return;

    const text = this.outputBuffer;
    this.outputBuffer = "";
    this.enqueueSend(() => this.sendCodeBlock(text));
  }

  // ── Message helpers ──

  private async sendCodeBlock(text: string): Promise<void> {
    if (!this.chatId) return;

    // Split into chunks that fit Telegram's limit (minus markdown overhead)
    const maxPayload = TG_MAX_LENGTH - 20; // leave room for ``` wrapper
    const chunks = splitString(text, maxPayload);

    for (const chunk of chunks) {
      await this.bot.sendMessage(this.chatId, `\`\`\`\n${chunk}\n\`\`\``, {
        parse_mode: "Markdown",
      });
    }
  }

  private async rawSend(text: string): Promise<void> {
    if (!this.chatId) return;

    const chunks = splitString(text, TG_MAX_LENGTH);
    for (const chunk of chunks) {
      await this.bot.sendMessage(this.chatId, chunk);
    }
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  }
}

// ────────────────────────── Helpers ──────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitString(str: string, maxLen: number): string[] {
  const result: string[] = [];
  let remaining = str;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      result.push(remaining);
      break;
    }
    // Try to split at newline
    let idx = remaining.lastIndexOf("\n", maxLen);
    if (idx === -1 || idx < maxLen / 2) idx = maxLen;
    result.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx);
  }
  return result;
}
