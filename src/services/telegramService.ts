import TelegramBot, {
  type CallbackQuery,
  type Message,
} from "node-telegram-bot-api";
import logger from "../utils/logger.js";
import { getConfig, type AppConfig } from "../utils/config.js";

/** Maximum Telegram message length */
const TG_MAX_LENGTH = 4096;

/** Minimum gap between messages to avoid flood (ms) */
const MIN_SEND_GAP = 1100;

export class TelegramService {
  private bot: TelegramBot;
  private config: AppConfig;
  private chatId: number | null = null;

  // Rate-limiting
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

  /** Send a plain text message (queued for rate-limit). */
  sendMessage(text: string): void {
    this.enqueueSend(() => this.rawSend(text));
  }

  /** Send a message with inline keyboard buttons. */
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

  /** Stop the bot gracefully. */
  async stop(): Promise<void> {
    await this.bot.stopPolling();
    logger.info("Telegram bot stopped");
  }

  // ────────────────────────── Internals ──────────────────────────

  private setupHandlers(): void {
    this.bot.on("message", (msg: Message) => {
      if (!this.authorize(msg)) return;
      this.chatId = msg.chat.id;

      const text = msg.text?.trim() ?? "";
      if (!text) return;

      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.split(" ");
        const command = cmd.slice(1).toLowerCase();
        this.onCommandHandler?.(command, rest.join(" "));
        return;
      }

      this.onTextHandler?.(text);
    });

    this.bot.on("callback_query", (query: CallbackQuery) => {
      if (!query.message || !this.authorizeCallback(query)) return;
      this.chatId = query.message.chat.id;

      const action = query.data ?? "";
      this.onCallbackHandler?.(action, query.id);

      this.bot.answerCallbackQuery(query.id).catch(() => {});
    });
  }

  private authorize(msg: Message): boolean {
    if (msg.from?.id !== this.config.authorizedUserId) {
      logger.warn({ userId: msg.from?.id }, "Unauthorized message");
      return false;
    }
    return true;
  }

  private authorizeCallback(query: CallbackQuery): boolean {
    if (query.from.id !== this.config.authorizedUserId) {
      logger.warn({ userId: query.from.id }, "Unauthorized callback");
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
        if (err?.response?.statusCode === 429) {
          const retryAfter =
            (err.response?.body?.parameters?.retry_after ?? 5) * 1000;
          logger.warn({ retryAfter }, "Telegram rate limit, backing off");
          await sleep(retryAfter);
          this.sendQueue.unshift(fn);
        } else {
          logger.error({ err: err?.message }, "Failed to send Telegram msg");
        }
      }
    }
    this.processingQueue = false;
  }

  // ── Message helpers ──

  private async rawSend(text: string): Promise<void> {
    if (!this.chatId) return;

    const chunks = splitString(text, TG_MAX_LENGTH);
    for (const chunk of chunks) {
      await this.bot.sendMessage(this.chatId, chunk);
    }
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
    let idx = remaining.lastIndexOf("\n", maxLen);
    if (idx === -1 || idx < maxLen / 2) idx = maxLen;
    result.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx);
  }
  return result;
}
