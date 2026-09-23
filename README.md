# Payment Verification

A Node.js/TypeScript worker that reads Zenith Bank transaction-notification emails from Gmail, checks the sender/authentication information, parses and validates transaction fields, and stores accepted transactions in PostgreSQL. It also provides an optional Telegram bot for viewing and searching the ledger, checking worker status, and verifying a receipt against stored transactions.

> This repository contains software, not a hosted service. You must configure your own Gmail, database, and (if using the bot) Telegram credentials. Never commit real credentials, customer data, bank statements, email exports, or production logs.

## Requirements

- Node.js 20 or newer and npm
- PostgreSQL, with a database created for this service
- A Gmail account containing the bank notification emails and Google OAuth credentials with Gmail API access
- Optional: a Telegram bot and a publicly reachable HTTPS URL if you want Telegram webhook delivery

## Quick start

1. Clone the repository and install dependencies:

   ```sh
   npm ci
   ```

2. Create a local environment file from the example:

   ```sh
   cp .env.example .env
   ```

   On Windows PowerShell, use `Copy-Item .env.example .env`. Fill in the required values described below. `.env` is ignored by Git; keep it private.

3. Create a PostgreSQL database and set `DATABASE_URL` to its connection string, for example:

   ```text
   postgresql://username:password@localhost:5432/payment_verification
   ```

4. Configure Gmail OAuth. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` for an OAuth client with Gmail API access to the mailbox to be monitored. The worker uses these to read mail; it does not send bank email.

5. Start in development mode:

   ```sh
   npm run dev
   ```

   The worker validates configuration at startup, applies database migrations, starts Gmail ingestion, and serves its HTTP endpoints. Migrations also run when starting the production Docker image.

To run as a compiled production process locally:

```sh
npm run build
npm start
```

The default HTTP port is `3000`; set `PORT` when the platform assigns another port. `GET /health` and `GET /healthz` are available for a basic health check.

## Configuration

The three required settings are:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token for the monitored Gmail account |

The rest are optional unless you enable the corresponding feature:

| Variable | Purpose / default |
| --- | --- |
| `ZENITH_SENDER_DOMAINS` | Comma-separated allowed sender domains; defaults to `zenithbank.com` |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project for Gmail push notifications |
| `GOOGLE_PUBSUB_TOPIC` | Gmail Pub/Sub topic; defaults to `gmail-zenith-notifications` |
| `GOOGLE_PUBSUB_SUBSCRIPTION` | Subscription; defaults to `gmail-zenith-push` |
| `POLL_INTERVAL_MINUTES` | Periodic Gmail poll interval; defaults to `15` |
| `TELEGRAM_BOT_TOKEN` | Enables Telegram bot replies |
| `TELEGRAM_WEBHOOK_URL` | Public HTTPS URL registered for Telegram webhook updates |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token used to validate Telegram webhook requests |
| `TELEGRAM_ADMIN_CHAT_IDS` | Comma-separated Telegram chat IDs allowed to use the bot |
| `TELEGRAM_BOT_PASSWORD` | Shared password for bot login (at least 12 characters when set) |
| `OPENROUTER_API_KEY` | Optional key for AI-assisted search/receipt features where supported |
| `ALERT_WEBHOOK_URL` | Optional alert destination |
| `ALERT_FALLBACK_WEBHOOK_URL` | Optional fallback alert destination |
| `STALENESS_THRESHOLD_MINUTES` | Pipeline staleness threshold; defaults to `60` |
| `BUSINESS_HOURS_START` / `BUSINESS_HOURS_END` | Monitoring window; defaults to `07:00`–`21:00` |
| `BUSINESS_HOURS_TIMEZONE` | Monitoring timezone; defaults to `Africa/Lagos` |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`; defaults to `info` |
| `PORT` | HTTP listen port; defaults to `3000` |

For Gmail push notifications, configure the Google Cloud Pub/Sub topic and subscription as well as the Gmail watch permissions. The periodic poll is an independent safety net. Without a push setup, configure valid Gmail credentials and leave the worker running for polling.

The checked-in `.env.example` is the concise starter template. `envExample.example` contains additional placeholders from planned or optional features; a variable appearing there does not necessarily mean that feature is implemented or required. The application validates required settings in [`src/config/env.ts`](src/config/env.ts).

## Telegram bot

Telegram is optional. Configure a bot token, a strong `TELEGRAM_BOT_PASSWORD`, and the allowed administrator chat IDs. For webhook delivery, expose the service over HTTPS and configure `TELEGRAM_WEBHOOK_URL` and `TELEGRAM_WEBHOOK_SECRET`. The worker registers the webhook during startup when configured. Do not expose the bot to untrusted users: it can display and export financial ledger data.

After opening the bot, use `/login <password>`. The help menu describes the available operations:

| Command | What it does |
| --- | --- |
| `/help` | Show bot commands and examples |
| `/login <password>` / `/logout` | Start or end an admin session |
| `/balance` | Show ledger balance and latest transaction |
| `/history [from to]` | Show recent transactions or a date range |
| `/search <query>` | Search transaction records |
| `/verify` | Start receipt verification; a photo/PDF or transaction details can be supplied |
| `/status` | Show worker, database, and Gmail pipeline status |
| `/logs [n] [level]` | Show recent in-memory log entries |
| `/suspicious [n]` | Show recent suspicious email records |
| `/summary` | Show transaction totals for recent periods |
| `/export [from to]` | Export ledger records as CSV |
| `/duplicates` | Find repeated amount/date combinations |
| `/poll` | Trigger a Gmail poll |
| `/watch` | Re-register Gmail push watch |

Date inputs accept `DD/MM/YYYY` or `YYYY-MM-DD` where date ranges are requested. Treat bot responses and exports as sensitive data.

## Development and tests

```sh
npm run dev          # Run the worker with tsx
npm run build        # Compile TypeScript to dist/
npm start            # Run the compiled worker
npm run lint         # Type-check without emitting files
npm test             # Run the Vitest suite once
npm run test:watch   # Run Vitest in watch mode
```

The tests include unit and integration-style checks. Email fixtures under `tests/fixtures` are synthetic examples; use similarly anonymized data when adding fixtures. Some scripts in `scripts/` access live Gmail or a database. Inspect a script and verify its target credentials/database before running it; do not point debugging or backfill scripts at production data unless you intend to modify it.

## Docker and deployment

The included `Dockerfile` builds the TypeScript app and starts it after applying migrations. Build and run locally with:

```sh
docker build -t payment-verification .
docker run --env-file .env -p 3000:3000 payment-verification
```

Provide a persistent PostgreSQL service and inject environment variables through the deployment platform's secret/configuration manager. `railway.json` configures the included Dockerfile for Railway. Keep `DATABASE_URL` and all OAuth, Telegram, and alert secrets out of source control and deployment logs.

## Data and security notes

- Gmail messages and transaction records may contain personal and financial information. Restrict access to the mailbox, database, deployment environment, logs, bot, and exported files.
- Configure database backups, access controls, and retention appropriate to your legal and operational requirements.
- Rotate any credential that has ever been committed, pasted into logs, or otherwise exposed. Removing it from the current files or rewriting Git history does not invalidate the old credential or erase copies in clones, caches, or backups.
- Before making a repository public, review the entire reachable Git history, Git LFS objects (if used), releases, CI logs/artifacts, and deployment configuration for secrets and private data. A history rewrite changes commit IDs and requires collaborators to re-clone or carefully synchronize; it cannot erase copies others already have.

## Project layout

```text
src/
  gmail/          Gmail OAuth, polling, push handling, and message retrieval
  zenith/         Sender checks, email decoding, parsing, and validation
  db/             PostgreSQL access and SQL migrations
  telegram/       Optional Telegram webhook and ledger commands
  alerts/         Alert delivery
  observability/  Logging and pipeline staleness checks
migrations/       PostgreSQL schema migrations
tests/            Automated tests and synthetic email fixtures
scripts/          Operational and Gmail diagnostic scripts
```

