# Claude Remote Bot

Remote-control [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) from your phone via Telegram.

```
Claude CLI (PTY)  ←→  PC Agent (Node.js)  ←→  Telegram  ←→  You (Mobile)
```

## Features

- **Stream output** — Claude's terminal output delivered as Telegram code blocks
- **Approve / Deny prompts** — inline buttons when Claude asks for permission
- **Send input** — type messages that go straight to Claude's stdin
- **Process control** — `/start`, `/stop`, `/restart`, `/status`, `/logs`, `/interrupt`
- **Secure** — locked to a single authorized Telegram user ID
- **Rate-limit safe** — message batching + send queue with back-off

## Setup

### 1. Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the token

### 2. Your Telegram ID

1. Message [@userinfobot](https://t.me/userinfobot)
2. Copy the numeric ID

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
AUTHORIZED_USER_ID=987654321
CLAUDE_COMMAND=claude
OUTPUT_MODE=batched       # or "streaming"
BATCH_INTERVAL_MS=2000
LOG_LEVEL=info
```

### 4. Install & Run

```bash
npm install
npm start
```

Or in watch mode for development:

```bash
npm run dev
```

## Commands

| Command         | Description                      |
| --------------- | -------------------------------- |
| `/start [args]` | Start a Claude session           |
| `/stop`         | Kill the Claude process          |
| `/restart`      | Restart Claude                   |
| `/status`       | Check if Claude is running       |
| `/logs [n]`     | Show last _n_ lines (default 50) |
| `/interrupt`    | Send Ctrl+C to Claude            |
| `/help`         | Show command list                |

Any other text you type is forwarded to Claude as input.

## Architecture

```
src/
  index.ts                  — Entry point, config validation, bootstrap
  services/
    claudeService.ts        — PTY spawn, stdin/stdout, lifecycle
    telegramService.ts      — Bot polling, message sending, rate limiting
  core/
    sessionManager.ts       — Wires Claude ↔ Telegram, command routing
    promptDetector.ts       — Regex-based interactive prompt detection
  utils/
    config.ts               — Env config loader
    logger.ts               — Pino logger setup
```

## Requirements

- Node.js ≥ 18
- Claude Code CLI installed and in PATH
- A Telegram account

## License

MIT
