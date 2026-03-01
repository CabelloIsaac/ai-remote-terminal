import "dotenv/config";
import logger from "./utils/logger.js";
import { getConfig } from "./utils/config.js";
import { ClaudeService } from "./services/claudeService.js";
import { TelegramService } from "./services/telegramService.js";
import { SessionManager } from "./core/sessionManager.js";

// ── Validate config ──

const config = getConfig();

if (!config.telegramToken || config.telegramToken === "your_bot_token_here") {
  logger.fatal(
    "TELEGRAM_BOT_TOKEN is not set. Copy .env.example → .env and fill in your token.",
  );
  process.exit(1);
}

if (!config.authorizedUserId || config.authorizedUserId === 0) {
  logger.fatal(
    "AUTHORIZED_USER_ID is not set. Get your ID from @userinfobot on Telegram.",
  );
  process.exit(1);
}

// ── Bootstrap ──

logger.info("Starting Claude Remote Bot");

const claude = new ClaudeService();
const telegram = new TelegramService();
const session = new SessionManager(claude, telegram);

// ── Graceful shutdown ──

const shutdown = async (signal: string) => {
  logger.info({ signal }, "Received shutdown signal");
  await session.shutdown();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  session.shutdown().finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});

logger.info(
  "🤖 Claude Remote Bot is online. Send /help in Telegram to get started.",
);
