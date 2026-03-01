import { EventEmitter } from "events";

/**
 * Loads environment config with defaults.
 */
function loadConfig() {
  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    authorizedUserId: Number(process.env.AUTHORIZED_USER_ID || "0"),
    claudeCommand: process.env.CLAUDE_COMMAND || "claude",
    outputMode: (process.env.OUTPUT_MODE || "batched") as
      | "batched"
      | "streaming",
    batchIntervalMs: Number(process.env.BATCH_INTERVAL_MS || "2000"),
    logLevel: process.env.LOG_LEVEL || "info",
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;

// Singleton
let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
