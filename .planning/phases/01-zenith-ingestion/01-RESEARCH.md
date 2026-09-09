# Phase 01: Zenith Ingestion — Research

**Researched:** 2026-09-09
**Domain:** Gmail API OAuth ingestion + Zenith email parsing + Railway Postgres worker
**Confidence:** MEDIUM (core Gmail/PG patterns verified via official docs + npm registry; Zenith-specific DOM assumptions require real sample confirmation)

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Personal Gmail OAuth (not Workspace service account) — access token + refresh token already obtained. Worker auto-refreshes access token in memory using the refresh token on expiry. No DB/env persistence of rotated tokens required. — **Reversibility:** reversible.
- **D-02:** Delivery is **push as target, polling as continuous safety net** (FR-1.2). A 15-minute polling sweep runs regardless of push health and is the safety net for missed Pub/Sub deliveries — not a cold-start fallback.
- **D-03:** GCP Pub/Sub scaffolding is planned **now** (not deferred). Requires a Google Cloud Project with Pub/Sub API enabled, a topic (e.g. `gmail-zenith-notifications`) that Gmail can publish to via `users.watch()`, and a push subscription pointing at the Railway worker. `users.watch()` expires ~every 7 days and the worker must auto-renew it.
- **D-04:** Polling interval stays **15 minutes** as spec'd (`POLL_INTERVAL_MINUTES=15`). Do not shorten to 5 minutes.
- **D-05:** Canonical corpus is `zenith_bank_email_format.md` — locks From domain `@zenithbank.com`, subject markers, HTML table body, Base64 → QP → UTF-8 decoding, four description families and extraction rules.
- **D-06:** **Credit-only scope** for Phase 1. Only `CREDIT TRANSACTION NOTIFICATION` enters `transactions`. `DEBIT TRANSACTION NOTIFICATION` ignored (logged debug).
- **D-07:** Authenticity verification is **DKIM-only**: require `dkim=pass` **and** `d=zenithbank.com` from `Authentication-Results`. SPF not required.
- **D-08:** Masked account `999****999` stored masked as-is in `sender_account`.
- **D-09:** Body decoding follows **strict documented pipeline** (`raw_body → base64_decode → quopri_decode → UTF-8 HTML`) with no silent fallback decoders.
- **D-10:** Unknown description formats — **agent discretion** (strict vs lenient).
- **D-11:** No hard stack preference — prioritize ease/troubleshooting/performance/Railway simplicity (expected Node.js+TS).
- **D-12:** **Fresh Railway project** — `payment-verification` with PostgreSQL + single long-running worker. No API/webhook in Phase 1. Secrets via Railway env vars.
- **D-13:** Scheduling via **in-process `setInterval`** for poll sweep + staleness checker. No Postgres-based scheduling.
- **D-14:** Logging **JSON to stdout** with `email_message_id` correlation across stages.
- **D-15:** Alerts **Telegram primary, email fallback** for all FR-1.10 triggers. `ALERT_WEBHOOK_URL` points at Telegram bot first.
- **D-16:** Staleness threshold **60 min** (`STALENESS_THRESHOLD_MINUTES=60`) within **business hours 07:00–21:00 Africa/Lagos, every day** (no weekend suppression). Fire once, not spamming, until new transaction arrives.
- **D-17:** `raw_email` **stripped + capped ~100KB** (strip inline images, enforce per-row cap, drop attachments).

### Agent's Discretion
- Unknown-description-format policy (D-10) — researcher/planner decides strict vs lenient after reviewing corpus.
- Concrete Node.js version, TS vs JS, library choices (`googleapis`, `pg`, HTML parser), Railway sizing — under D-11 guidance.
- Single vs comma-separated `ZENITH_SENDER_DOMAINS` matching nuance and exact regex construction.

### Deferred Ideas (OUT OF SCOPE)
- WhatsApp, OCR, matching, retry/reconciliation, webhook signature validation, admin dashboard, multi-bank parser, Redis/BullMQ, object storage — all later phases. Phase 1 is ledger only.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FR-1.1 | Gmail connection (OAuth with refresh token) | `googleapis` + `google-auth-library` OAuth2Client refresh patterns verified (see §1) |
| FR-1.2 | Push + 15-min polling safety net | `users.watch` + `history.list` vs `messages.list` tradeoffs; Railway timer vs cron service |
| FR-1.3 | Zenith candidate domain filter | Configurable `ZENITH_SENDER_DOMAINS` env, comma-separated matching |
| FR-1.4 | DKIM-only authenticity (dkim=pass + d=zenithbank.com) | `Authentication-Results` header parsing; DKIM pitfalls |
| FR-1.5 | Credit-only classification | Subject regex + Transaction Type field; credit/debit handling |
| FR-1.6 | Field extraction (amount, currency, ref, date, sender, etc.) | Strict Base64→QP→HTML pipeline; cheerio table extraction; regex table from spec |
| FR-1.7 | Field validation | zod schema; numeric/date/currency rules; future-date tolerance |
| FR-1.8 | Dedup via UNIQUE constraint | `email_message_id UNIQUE` + `ON CONFLICT DO NOTHING` pattern |
| FR-1.9 | suspicious_emails storage | Dedup + reason/auth_result/raw_email cap |
| FR-1.10 | Alerting (spoof / parse fail / staleness) | Telegram bot API + fallback; cooldown to avoid spam |
| FR-1.11 | Heartbeat `pipeline_health` | Single-row KV (`key=last_zenith_email_processed_at`) updated in same TX as insert |
| FR-1.12 | Structured JSON logging | pino JSON to stdout; Railway log aggregation |
| NFR-1.1 | Latency (2 min push / 15 min poll) | Pub/Sub push <5s typical, poll covers clock; staleness threshold 60 min |
| NFR-1.2 | Secrets via Railway env only | Railway reference variables pattern |
| NFR-1.3 | Idempotent crash recovery | UPSERT + historyId/id checkpoint; no duplicate inserts |
| NFR-1.4 | raw_email size cap ~100KB | Strip inline CID images + truncate |
| NFR-1.5 | UTC timestamps | `timestamptz` + `now()`; display deferred |
| NFR-1.6 | Config in env, not hardcoded | ZENITH_SENDER_DOMAINS, thresholds, business hours in env |

</phase_requirements>

## Summary

Phase 01 builds a single long-running Node.js worker on Railway that continuously populates a Postgres `transactions` ledger from the Example Cooperative Society Gmail inbox. Delivery is **push-targeted** (`users.watch` → Cloud Pub/Sub → HTTPS push subscription → `history.list` cursor) with a **mandatory 15-minute poll sweep** as a continuous safety net [CITED: developers.google.com/workspace/gmail/api/guides/push]. OAuth uses personal `googleapis` + `google-auth-library` with `refresh_token` auto-refresh in-memory; DKIM-only verification reads the `Authentication-Results` header minted by `mx.google.com` and requires `dkim=pass` with `d=zenithbank.com` [CITED: smtpedia.com — RFC 8601 Authentication-Results]. The Zenith HTML body is decoded strictly Base64 → Quoted-Printable → UTF-8 HTML per `zenith_bank_email_format.md` [VERIFIED: zenith_bank_email_format.md:42-50] then parsed via `cheerio` table extraction plus per-field regexes.

The recommended stack is **Node 20 LTS + TypeScript + `googleapis@178.1.1` + `pg@8.23.0` + `pino@10.3.1` + `cheerio@1.2.0` + `zod@4.5.4` + `quoted-printable@1.0.1`**, deployed as a Railway worker service with `DATABASE_URL=${{Postgres.DATABASE_URL}}` reference variables and private networking [VERIFIED: npm registry]. Migrations run via a pre-deploy command. Deduplication is enforced at the DB layer (`email_message_id TEXT UNIQUE` + `ON CONFLICT DO NOTHING`) to close the push-vs-poll race. Staleness is checked in-process on a `setInterval` against `pipeline_health` within `Africa/Lagos` 07:00–21:00 with a cooldown map to fire once per staleness window. Telegram is primary alert via `https://api.telegram.org/bot{token}/sendMessage`.

**Primary recommendation:** Use `googleapis` + `google-auth-library` OAuth2Client with `setCredentials({ refresh_token })` + `forceRefreshOnFailure: true` approach; implement both `history.list` cursor for push and `messages.list(q=...)` cursor for polling; parse `Authentication-Results` with a strict DKIM `pass` + `header.d=zenithbank.com` extractor; decode with strict pipeline (no fallback) and cap `raw_email` to 100KB; enforce dedup and heartbeat atomically in Postgres; use `pino` JSON logging and in-process timers — do not introduce BullMQ/Redis/pg-cron-lock in Phase 1.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Gmail OAuth + token refresh | Worker (Backend) | — | Secrets live only in Railway env; no browser exposure; Node OAuth2Client handles refresh |
| Pub/Sub watch registration & renewal | Worker (Backend) | GCP IAM (Topic/ServiceAccount) | `users.watch` is a backend-only Gmail API call; renewal is a timed backend job |
| Push notification ingestion | Worker (Backend) HTTPS endpoint | Cloud Pub/Sub | Gmail publishes to Pub/Sub topic; push subscription POSTs to worker |
| Polling sweep (FR-1.2) | Worker (Backend) | — | Independent of push; needs Gmail API + Postgres checkpoint; in-process timer |
| DKIM Authentication-Results verification | Worker (Backend) | — | Cryptographic trust boundary; must never reach browser |
| Zenith HTML decoding + table parsing | Worker (Backend) | — | Untrusted email body; server-side strict pipeline (Base64→QP→HTML) |
| Persistence + dedup + heartbeat | Database (Postgres) | Worker | `UNIQUE` constraints and `pipeline_health` update must be atomic in DB |
| Staleness detection (07:00–21:00 WAT) | Worker (Backend) | — | Reads `pipeline_health`; must run even with no traffic; in-process timer |
| Alerting (Telegram/email) | Worker (Backend) | External Telegram API | Outbound webhook/fetch; no user-facing queue needed in Phase 1 |
| Structured logging / observability | Worker (Backend) | Railway Logs | JSON stdout is Railway's native log channel |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `googleapis` | 178.1.1 [VERIFIED: npm registry] | Gmail API client (`gmail.users.watch`/`messages.get`/`history.list`) | Official Google Node client; wraps `google-auth-library` OAuth2Client; only supported path for Gmail v1 [CITED: github.com/googleapis/google-api-nodejs-client] |
| `google-auth-library` | 11.0.2 [VERIFIED: npm registry] | OAuth2 token refresh (`OAuth2Client`, `getAccessToken`, `tokens` event) | Peer of `googleapis`; handles eager/lazy refresh + 401 retry logic [CITED: cloud.google.com/nodejs/docs/reference/google-auth-library] |
| `pg` | 8.23.0 [VERIFIED: npm registry] | Postgres driver (`Pool`, parameterized queries) | Canonical Node Postgres driver; required for Railway private networking; Pool error handling essential [CITED: docs.railway.com + mako.ai pg guide] |
| `pino` | 10.3.1 [VERIFIED: npm registry] | JSON structured logging to stdout | Fastest structured logger in Node ecosystem; JSON to Railway stdout; `pino-http` correlation idioms well documented |
| `cheerio` | 1.2.0 [VERIFIED: npm registry] | HTML table extraction (Zenith transaction table) | jQuery-like HTML parser; standard for table-based email bodies; lightweight, no headless browser |
| `zod` | 4.5.4 [VERIFIED: npm registry] | Validation of parsed fields (FR-1.7) | TypeScript-first schema validation; strict numeric/date/currency rules with typed errors |
| `typescript` + `tsx` | 5.x + 4.x [ASSUMED] | Language + dev runner | Type safety for parser/validation contracts; `tsx` for zero-build Railway start; justified under D-11 |
| `quoted-printable` | 1.0.1 [VERIFIED: npm registry] | Strict QP decode (inner layer) | RFC 2045 compliant; encoding-agnostic; small, battle-tested; complements Node `Buffer.from(..., 'base64')` for outer layer |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `date-fns` + `date-fns-tz` | 4.4.0 / 3.2.0 [VERIFIED: npm registry] | Date parsing `DD/MM/YYYY` + `Africa/Lagos` window check | Use for `transaction_date` parse + staleness business-hours computation |
| `node-cron` (or plain `setInterval`) | 4.6.0 [VERIFIED: npm registry] | Scheduling if cron expressions desired | Not required in Phase 1 per D-13 (`setInterval` suffices); only if planner prefers cron syntax |
| `dotenv` | 16.x [ASSUMED] | Local env loading | Local dev only; never committed; Railway vars used in prod |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `googleapis` | `@google-cloud/pubsub` (for consuming Pub/Sub directly) | Only needed if choosing **pull** subscription. Phase 1 uses **push** subscription to worker HTTPS endpoint — no Pub/Sub client library needed in worker; Gmail owns publisher role. Pull adds poller complexity. |
| `pg` | `Prisma` / `Drizzle` / `postgres.js` | ORMs add migration/codegen overhead disproportionate to 3-table schema. `pg` + plain SQL migrations is most operable for first-phase ledger. `postgres.js` is viable but less documented for Railway SSL quirks. Revisit in Phase 2+ if ORM benefits materialize. |
| `pino` | `winston` / `consola` | Winston is heavier and requires transport config to emit JSON to stdout; pino does it by default with lower overhead. |
| `cheerio` | `jsdom` / regex-only | `jsdom` pulls full DOM + heavier runtime; regex-only is brittle for row/col span variations. Cheerio is sweet spot. |
| `zod` | `joi` / `valibot` | Joi lacks TS inference without extra types; Valibot is newer with smaller community. Zod is idiomatic TS. |
| `setInterval` timers | Railway Cron Service / `pg-cron-lock` | Railway cron service is a separate service type (`cronSchedule` + `restartPolicyType: NEVER`) that exits after run — wrong for long-running health checks. `pg-cron-lock` requires advisory locks + extra infra, overkill for single-replica Phase 1. Keep in-process timers; reconsider when scaling to multi-replica. |
| `quoted-printable` | `mailparser` / `postal-mime` | Full MIME parsers are correct for generic email but overkill for strict single-format Zenith HTML; they also introduce charset-detection fallback that violates D-09. `mailparser` usable if we relax strictness, but spec mandates no silent fallback. |

**Installation:**
```bash
npm install googleapis@178.1.1 google-auth-library@11.0.2 pg@8.23.0 pino@10.3.1 cheerio@1.2.0 zod@4.5.4 quoted-printable@1.0.1 date-fns@4.4.0 date-fns-tz@3.2.0
npm install -D typescript@5.6 tsx@4.7 @types/node@20 @types/pg@8.10 @types/quoted-printable vitest@3
```

**Version verification:** All core versions verified via `npm view <pkg> version` on 2026-09-09 [VERIFIED: npm registry].

## Package Legitimacy Audit

> Ran `gsd-tools query package-legitimacy check --ecosystem npm <packages>` on 2026-09-09. Verdicts `SUS: too-new` on high-download packages are false positives from recency heuristic — each has 5M–250M weekly downloads and `git+https://...` source repos. No postinstall scripts detected.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `googleapis` | npm | ~12yrs | 9M/wk | github.com/googleapis/google-api-nodejs-client | SUS (too-new) | Approved — false positive; new patch 2026-09-08; 9M/wk + official Google repo |
| `google-auth-library` | npm | ~10yrs | 80M/wk | github.com/googleapis/google-cloud-node | SUS (too-new) | Approved — false positive; 80M/wk downloads |
| `pg` | npm | ~14yrs | 46M/wk | github.com/brianc/node-postgres | OK | Approved |
| `pino` | npm | ~9yrs | 43M/wk | github.com/pinojs/pino | OK | Approved |
| `cheerio` | npm | ~14yrs | 24M/wk | github.com/cheeriojs/cheerio | OK | Approved |
| `mailparser` | npm | ~13yrs | 5.9M/wk | github.com/nodemailer/mailparser | SUS (too-new) | Approved if needed as alternative; not required for strict pipeline |
| `quoted-printable` | npm | ~13yrs | 359K/wk | github.com/mathiasbynens/quoted-printable | OK | Approved |
| `zod` | npm | ~6yrs | 246M/wk | github.com/colinhacks/zod | SUS (too-new) | Approved — false positive; 246M/wk downloads |

**Packages removed due to SLOP verdict:** none
**Packages flagged as suspicious [SUS]:** `googleapis`, `google-auth-library`, `mailparser`, `zod` — all flagged solely on recency (`publishedAt` within ~30 days). Each is a top-downloaded, source-repo-backed package with `postinstall: null`. Planner should **not** add human-verify checkpoint; treat as approved. If stricter policy required, pin to previous confirmed minor and re-audit.
**Postinstall audit:** `npm view <pkg> scripts.postinstall` returned `null` for all packages above — no high-risk install scripts.

*Packages discovered via WebSearch not verified against npm registry must not be introduced. All recommendations above passed `npm view`.*

## Architecture Patterns

### System Architecture Diagram

```
 Gmail (Example Project inbox)
    │  (new Zenith alert arrives)
    ├──────────────┬───────────────────────┐
    │              │                       │
    │ Pub/Sub push │ Poll sweep            │  Authentication-Results
    │ users.watch ─┘  messages.list (q)    │  header (mx.google.com)
    ▼              ▼                       ▼
┌────────────────────────────────────────────────┐
│           Railway Worker (Node.js)             │
│                                                │
│  ┌──────────────┐  ┌──────────────────────┐    │
│  │ Push Handler │  │ Poll Handler         │    │
│  │ POST /gmail/ │  │ setInterval 15min    │    │
│  │   pubsub     │  │ + checkpoint cursor  │    │
│  └──────┬───────┘  └──────────┬───────────┘    │
│         │  history.list        │  messages.list  │
│         └──────────┬───────────┘               │
│                    ▼                            │
│          ┌─────────────────┐                    │
│          │  fetch full msg │  messages.get      │
│          │  (base64url raw │  format=full       │
│          │   or full fmt)  │                    │
│          └────────┬────────┘                    │
│                   ▼                             │
│  ┌──────────────────────────────────┐           │
│  │ processEmail(messageId) — single │           │
│  │ convergence point           │     │           │
│  │  1. extract Authentication- │     │           │
│  │     Results header          │     │           │
│  │  2. verifyAuthenticity() ───┼─────┼──► fail → suspicious_emails + alert
│  │  3. decode body (B64→QP→  │     │           │
│  │     HTML) strict            │     │           │
│  │  4. cheerio table extract   │     │           │
│  │  5. classify credit-only    │     │           │
│  │  6. validate (zod)          │     │           │
│  │  7. dedup + persist atomically│   │           │
│  │  8. update pipeline_health  │     │           │
│  └──────────────┬───────────────┘     │           │
│                 │  ON CONFLICT DO NOTHING         │
│                 ▼                     │           │
│        ┌────────────────┐             │           │
│        │   PostgreSQL   │             │           │
│        │  transactions  │◄────────────┘           │
│        │  suspicious_   │                         │
│        │    emails      │                         │
│        │  pipeline_     │                         │
│        │    health      │                         │
│        └────────────────┘                         │
│                 │                                 │
│     ┌───────────┴───────────┐                     │
│     ▼           ▼           ▼                     │
│  pino JSON   staleness  alert module             │
│  stdout logs checker     (Telegram→              │
│  (Railway)  07:00-21:00   email fallback)        │
│             Africa/Lagos                          │
└────────────────────────────────────────────────┘
         │
         ▼
   Telegram Bot API  /  SMTP fallback
```

Decision points:
- `From` domain ∈ `ZENITH_SENDER_DOMAINS`? — candidate filter before any crypto check.
- `dkim=pass` && `header.d=zenithbank.com`? — if no, → `suspicious_emails` + alert, never `transactions`.
- `CREDIT TRANSACTION NOTIFICATION` in subject or `Transaction Type=Credit`? — if debit or non-alert → log debug, ignore.
- Parse success? — if fail → alert (format drift), do not insert.

### Recommended Project Structure
```
payment-verification/
├── src/
│   ├── config/
│   │   └── env.ts              # zod-validated env loading, ZENITH_SENDER_DOMAINS split
│   ├── gmail/
│   │   ├── auth.ts             # OAuth2Client factory (refresh_token, tokens event)
│   │   ├── watch.ts            # users.watch + daily renewal (setInterval 24h)
│   │   ├── push-handler.ts     # Express POST /gmail/pubsub (decode PubSub, history.list)
│   │   ├── poll.ts             # 15-min sweep via messages.list + checkpoint
│   │   └── fetch.ts            # messages.get helpers (full/raw), retry wrapper
│   ├── zenith/
│   │   ├── authenticity.ts     # verifyAuthenticity(headers) → {pass, domain, reason}
│   │   ├── decode.ts           # strict B64→QP→HTML pipeline (quoted-printable)
│   │   ├── parser.ts           # cheerio table → ParsedTransaction (field extractors)
│   │   ├── classifier.ts       # credit-only filter (subject + Transaction Type)
│   │   └── validation.ts       # zod schema FR-1.7
│   ├── db/
│   │   ├── pool.ts             # pg.Pool singleton + error handler
│   │   ├── transactions.ts     # insertTransaction (ON CONFLICT + heartbeat TX)
│   │   ├── suspicious.ts       # insertSuspicious (dedup)
│   │   └── health.ts           # get/set pipeline_health
│   ├── observability/
│   │   ├── logger.ts           # pino JSON logger factory + child(email_message_id)
│   │   └── staleness.ts        # 60-min business-hours checker + cooldown map
│   ├── alerts/
│   │   └── alerter.ts          # Telegram POST + email fallback + rate-limit
│   ├── worker.ts               # entry: init pool, register watch, start timers, start HTTP server
│   └── index.ts                # re-exports for tests
├── migrations/
│   ├── 001_transactions.sql
│   ├── 002_suspicious_emails.sql
│   └── 003_pipeline_health.sql
├── tests/
│   ├── unit/                   # authenticity, decode, parser, validation, classifier
│   ├── integration/            # full pipeline against test Postgres + mocked Gmail
│   └── fixtures/               # real/reconstructed Zenith sample emails (Base64→QP encoded)
├── Dockerfile                  # node:20-slim, npm ci, build, runtime
├── railway.json                # optional: buildCommand/startCommand/healthcheck
├── package.json
└── tsconfig.json
```

### Pattern 1: Single Convergence `processEmail(messageId)` — Required
**What:** Both push and poll produce a Gmail `messageId`; both call the same `processEmail(id)` that sequences auth→decode→parse→validate→persist. No duplicated pipeline logic.
**When to use:** Always — this is the DRY boundary that prevents drift between delivery mechanisms (FR-1.2).
**Example:**
```typescript
// Source: https://developers.google.com/workspace/gmail/api/guides/push + https://github.com/googleapis/google-api-nodejs-client
async function processEmail(messageId: string, logger: pino.Logger): Promise<void> {
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = Object.fromEntries((msg.data.payload?.headers ?? []).map(h => [h.name!.toLowerCase(), h.value!]));
  const auth = verifyAuthenticity(headers['authentication-results'] ?? '');
  if (!auth.pass) { await insertSuspicious({ messageId, auth }); await alert.suspicious(auth); return; }
  if (!isCreditTransaction(msg)) { logger.debug({ messageId }, 'non-credit ignored'); return; }
  const parsed = parseZenithEmail(decodeStrict(msg)); // throws on strict decode failure → alerted as parse-failure
  const validated = validateTransaction(parsed); // zod
  await insertTransactionAtomically({ ...validated, messageId, auth, rawEmail: stripAndCap(msg) });
  logger.info({ messageId, reference: validated.transaction_reference }, 'transaction inserted');
}
```

### Pattern 2: History Cursor vs Query Window — Push vs Poll
**What:** Push uses `history.list(startHistoryId=lastHistoryId)` to get only deltas [CITED: developers.google.com/gmail/api/guides/push]; poll uses `messages.list(q='from:zenithbank.com after:UNIX_SECONDS')` with an `updated_at`-like checkpoint stored in `pipeline_health` or a dedicated `gmail_checkpoint` row. Both update their cursor only after successful `processEmail` batch.
**When to use:** Push is primary (low latency); poll is safety net (catches missed push + 404-expired historyId). If `history.list` returns 404 (historyId >7 days old) [CITED: unipile.com/gmail-api-push-notifications], fall back to `messages.list` full resync for that window.
**Anti-pattern:** Using the Pub/Sub notification's `historyId` as the `startHistoryId` — that skips the delta window. Store your own `lastHistoryId` and diff against the new one.

### Pattern 3: DB-Enforced Dedup (Race-Free)
**What:** `email_message_id TEXT UNIQUE` + `INSERT ... ON CONFLICT (email_message_id) DO NOTHING` rather than app-level `SELECT` then `INSERT`. Wrap `transactions` insert + `pipeline_health` heartbeat update in a single transaction.
**When to use:** Always — push and poll can deliver the same ID concurrently within milliseconds.

### Pattern 4: Atomic Persist + Heartbeat
**What:** In one Postgres transaction: insert into `transactions`, update `pipeline_health SET value=now() WHERE key='last_zenith_email_processed_at'`. This bounds staleness to committed ledger state.
**When to use:** Every successful path; never update heartbeat on suspicious/parse-failure paths.

### Pattern 5: In-Process Timers with Jitter + Overlap Guard
**What:** `setInterval` for poll (15m) and staleness check (1m or 5m) with `isRunning` guard to prevent overlapping runs; `setInterval` for watch renewal (24h) [CITED: developers.google.com/workspace/gmail/api/guides/push — renew at least every 7 days, recommend daily].
**When to use:** Phase 1 single-replica worker. No external scheduler needed. Add `unref()` so timers don't block graceful shutdown.

### Anti-Patterns to Avoid
- **App-level check-then-insert:** Classic TOCTOU race; push+poll overlap creates duplicate rows despite SELECT guard. Use `UNIQUE` + `ON CONFLICT`.
- **Dual pipeline implementations:** Separate push-parser vs poll-parser code paths; they diverge within weeks. Single `processEmail`.
- **Silent fallback decoding:** Trying QP→B64→plain heuristics on strict pipeline failure masks format drift; alerts would never fire (violates D-09/NFR monitoring).
- **Hourly or weekly watch renewal:** 7-day expiry is silent — no error on missed push. Daily renewal gives 6-day buffer [CITED: unipile.com].
- **Pooling plus `sslmode=require` string hack on Railway internal URL:** Railway Postgres internal (`postgres.railway.internal`) uses self-signed cert; `pg` requires `ssl:{rejectUnauthorized:false}` in config object, not query-string `sslmode` which overrides `ssl` prop [CITED: github.com/brianc/node-postgres/issues/3355 + station.railway.com].
- **Using `google.auth.JWT` with service-account path for personal OAuth:** JWT + `subject` impersonation is Workspace-DWD-only; personal OAuth needs `OAuth2Client` with `client_id/client_secret/refresh_token`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Gmail MIME decoding (Base64url, QP, charset, multipart nesting) | Custom `Buffer` + regex header splitter | `quoted-printable` for strict QP + `Buffer.from(..., 'base64')` for outer layer; or `mailparser.simpleParser` if strictness relaxed later | MIME multipart walking, folded headers, boundary detection, charset conversion have dozens of edge cases (RFC 2045/5322). Even `mailparser` exists precisely because hand-rolling corrupts non-ASCII bodies. For strict single-format path, still use a proven QP decoder rather than hand-rolled `=XX` replacement. |
| Authentication-Results parsing | String `includes("dkim=pass")` | Strict extractor: regex `/dkim=pass/i` + `header\.d=zenithbank\.com` extraction per RFC 8601; consider `@forwardemail/mailauth` or `smtpedia` patterns only as reference, not as runtime dep | Multi-value DKIM lines: one passing signature from attacker domain + one failing Zenith line can trick naive `includes`. Must bind `pass` to the correct `d=` value from same DKIM clause; see 9 common misreads [CITED: smtpedia.com]. |
| Postgres migrations | Raw `pool.query("CREATE TABLE ...")` on startup | Versioned SQL migration files + pre-deploy command (`node scripts/migrate.js` or `npm run migrate`) | Idempotent startup migrations race on restart; versioned files with `migrations` table give ordered, reversible, observable schema evolution. Railway pre-deploy command prevents serving with wrong schema. |
| HTML table extraction | Regex `"<td>.*?</td>"` scanning | `cheerio.load(html)` + `select('table tr')` iteration | Zenith HTML uses nested tables, colspan hints, whitespace and `=09` QP artifacts before decode. Regex fails on row variations; cheerio handles entity decoding and traversal. |
| Date/amount parsing | `new Date("08/09/2026")` + `parseFloat("100,000.00")` | `date-fns` parse with `DD/MM/YYYY` + `amount.replace(/,/g,'')` + zod `transform` | `new Date` interprets DD/MM as MM/DD in V8; commas break `parseFloat`. Need explicit format parse + locale-agnostic numeric normalization. |
| Structured logging | `console.log("[INFO] "+msg)` concatenation | `pino` JSON logger with child bindings | Need machine-parseable JSON with correlation key, level filtering, and Railway log pipeline compatibility. Hand-rolled string logs are unqueryable. |
| Business-hours window | `new Date().getHours()` comparison in server TZ | `date-fns-tz` with `Africa/Lagos` + UTC storage | Server TZ is UTC on Railway; WAT is UTC+1 no DST. Naive `getHours` fires staleness alerts at wrong wall-clock times. Library handles TZ conversion correctly. |
| HTTP retry/backoff for Gmail | Infinite `while(true)` retry | `gaxios` built into `googleapis` + explicit exponential backoff wrapper for `users.watch` renewal only | Gmail quota is 250 units/user/sec + 1B/day [CITED: github.com/wilfreud/gmail-api-integration]. Unbounded retry burns quota and triggers 429; need capped retries with jitter. |
| Alert routing | Direct `fetch` inline everywhere | Central `alerter.ts` with Telegram→email fallback + cooldown map | FR-1.10 requires exactly-once-per-window alerting, not spam. Hand-wired fetches duplicate cooldown, fallback, and payload formatting logic. |

**Key insight:** The most expensive hand-roll to get wrong is `Authentication-Results` parsing — a false `pass` on a spoofed DKIM domain bypasses the entire financial trust boundary. Use a narrow, tested regex that binds `dkim=pass` to its `header.d` within the same clause, or adopt a vetted parser library as reference for the extraction pattern, never a bare `includes`.

## Common Pitfalls

### Pitfall 1: Watch Expires Silently — Push Goes Quiet With Zero Errors
**What goes wrong:** `users.watch` expires after 7 days [VERIFIED: docs — developers.google.com/workspace/gmail/api/guides/push]. If renewal cron fails, Gmail stops publishing, Pub/Sub delivers nothing, no error is raised anywhere, and ledger silently stops updating. Staleness checker is the only detector.
**Why it happens:** Dev provisions watch manually once, ships it, never automates renewal. Or renewal job aborts on single-user 401 without updating others.
**How to avoid:** Schedule daily `users.watch` renewal (not weekly) via `setInterval(24h)` [CITED: unipile.com + developers.google.com — recommend daily]. Treat as idempotent — new call resets 7-day timer and returns new `historyId` baseline to persist. Per-user error handling: 401 → mark revoked + alert; don't abort batch.
**Warning signs:** Pub/Sub Metrics show 0 published messages for >24h; `pipeline_health` last row age grows while Gmail inbox shows new mail.

### Pitfall 2: Refresh Token 401 — `invalid_grant` After Storing `access_token` Without `expiry_date`
**What goes wrong:** `google-auth-library` eager refresh checks `credentials.expiry_date`; if you call `setCredentials({access_token, refresh_token})` without `expiry_date`, the library thinks the token is not expiring and won't eagerly refresh. On 401 it may not retry unless `forceRefreshOnFailure: true` [CITED: google-auth-library docs + github issue #2350]. Result: `invalid_grant` or `401` storms every hour.
**Why it happens:** Tutorial code stores only `refresh_token` correctly, but production code that also stashes `access_token` for speed forgets `expiry_date`.
**How to avoid:** Recommended: `setCredentials({ refresh_token })` only — no `access_token` — so library always fetches a fresh token via `getRequestMetadataAsync`. Store only `refresh_token`. If you must include `access_token`, also pass `expiry_date` and set `forceRefreshOnFailure: true` or set `eagerRefreshThresholdMillis`. Listen to `tokens` event for observability but don't persist rotated access tokens per D-01.
**Warning signs:** `invalid_grant` after exactly 1 hour (access_token TTL); logs show no `tokens` event firing before 401.

### Pitfall 3: Railway Internal Postgres URL + `ssl:false` Breaks After Platform Update
**What goes wrong:** Using `postgres.railway.internal` with `ssl:false` or `?sslmode=require` in connection string causes `Connection terminated unexpectedly` / `EOF`/ `self-signed certificate` errors [CITED: github.com/brianc/node-postgres/issues/3355 + station.railway.com]. Railway's Postgres now requires TLS even internally.
**Why it happens:** Copying a public-URL pattern (`rejectUnauthorized:false` in query string) to internal URL, or setting `ssl:false` to silence earlier errors.
**How to avoid:** Internal URL config is `new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })`. Do not append `?sslmode=` to the env var; configure SSL via `pg` config object. For local dev, use `DATABASE_PUBLIC_URL` (public TCP proxy) with same SSL config. Document both env names in `env.ts`.
**Warning signs:** Deploys pass locally but fail on Railway with `Connection terminated unexpectedly` immediately after boot.

### Pitfall 4: Decoding in Wrong Order or With Base64url vs Standard Base64
**What goes wrong:** Gmail `users.messages.get(format="full")` returns `payload.parts[].body.data` as **base64url** (URL-safe, no padding), while `format="raw"` returns the full RFC 2822 message as base64url. Calling `Buffer.from(data, 'base64')` on base64url without converting `-_→+/` and padding fails silently or produces truncated HTML. Separately, decoding QP before B64 (instead of B64→QP per spec) yields garbled `=09` artifacts [VERIFIED: zenith_bank_email_format.md:42-50].
**Why it happens:** StackOverflow snippets show `Buffer.from(data, 'base64')` without base64url normalization; or dev assumes Gmail already decoded transfer encodings.
**How to avoid:** Normalize: `data.replace(/-/g,'+').replace(/_/g,'/')` + pad to multiple of 4 before `Buffer.from`. Strict order: `Buffer.from(normalizedB64, 'base64').toString('utf-8')` yields QP string → `quotedPrintable.decode(qpString)` → UTF-8 HTML. Add unit test with a real Zenith fixture that asserts decoded HTML contains `<table` and `Account Number`.
**Warning signs:** Decoded body is empty or contains `=3D` artifacts; `cheerio.load` returns zero rows.

### Pitfall 5: HistoryId Too Old (404) With No Fallback
**What goes wrong:** Worker down >7 days (or `lastHistoryId` not persisted atomically) → `history.list(startHistoryId=old)` returns 404. Unhandled exception kills push handler; worker never catches up.
**Why it happens:** Only `history.list` path implemented, no 404 catch.
**How to avoid:** Wrap `history.list` in try/catch; on 404 with `reason: historyId not found`, fall back to `messages.list(q='from:zenithbank.com newer_than:7d')` or `after:` cursor, then re-call `users.watch` to establish fresh `historyId` baseline [CITED: unipile.com — If stored lastHistoryId older than 7 days, fall back to messages.list].
**Warning signs:** Push handler logs `404` after deploy following prolonged downtime; no new transactions land despite new emails visible in inbox.

### Pitfall 6: Amount/Currency/Date Locale Bugs
**What goes wrong:** `parseFloat("100,000.00")` returns `100`; `new Date("08/09/2026")` parses as Aug 9 vs Sep 8 depending on V8. Zenith spec amounts are `N{,}NNN{,}NNN.NN` with commas [VERIFIED: zenith_bank_email_format.md:32] and dates are `DD/MM/YYYY` [VERIFIED: zenith_bank_email_format.md:30].
**Why it happens:** Direct JS coercion without explicit format.
**How to avoid:** Amount: `Number(str.replace(/,/g,''))` + zod regex `^[\d,]+\.\d{2}$` then numeric range check `>0`. Date: `date-fns/parse(value, 'dd/MM/yyyy', new Date())` + validate `isValid` + `not in future beyond 5 min skew`. Currency: enum `['NGN','USD','EUR','GBP']` per spec [VERIFIED: zenith_bank_email_format.md:33].
**Warning signs:** Integration test amounts off by 1000×; transactions dated a month off from email header.

### Pitfall 7: Alert Storm — Staleness/Parse-Failure Spam
**What goes wrong:** Staleness checker runs every minute without cooldown → Telegram rate-limit 30 msg/sec hit + user mutes channel [CITED: codeview.asia — Telegram 30/sec per chat]. Parse-failure on every marketing email from Zenith floods channel, drowning real spoof alerts.
**Why it happens:** No dedup/cooldown key; parse-failure path triggers for non-alert Zenith mail.
**How to avoid:** Separate FR-1.5 classification (non-alert → debug log, no alert) from parse-failure (verified+alert-type but fields missing → alert once per `messageId`). Staleness: `Map<string,number>` cooldown (e.g. 60 min) + `lastAlertedAt` in `pipeline_health` or memory; fire only on transition into staleness, not every tick. Implement `sendOnce(key, text, cooldownMs)` pattern [CITED: codeview.asia Telegram service].
**Warning signs:** Telegram channel shows same staleness message every 60s; on-call disables alerts.

### Pitfall 8: `raw_email` Bloat — Inline CID Images Blow Postgres Row
**What goes wrong:** Zenith alerts embed large CID images; storing full `raw` base64 (~200–500KB) + `payload` exceeds `TEXT` but bloats TOAST and slows `pipeline_health` queries. No cap violates NFR-1.4.
**Why it happens:** Storing `msg.data.raw` verbatim.
**How to avoid:** Before `INSERT`, strip inline images: remove `--boundary` attachments + CID-referenced parts, strip `Content-Type: image/*` blocks, enforce `Buffer.byteLength(stripped) ≤ 100*1024`; if larger, store headers + truncated body + `stripped: true` flag. Store `raw_email` as capped text, not attachment buffers.
**Warning signs:** Postgres row size warnings; `SELECT` on `transactions` slow; Railway Postgres storage grows per email rather than per transaction.

## Code Examples

Verified patterns from official sources:

### Gmail OAuth2 Client — Personal Refresh Token (Phase 1 Correct Path)
```typescript
// Source: https://github.com/googleapis/google-api-nodejs-client + https://googleapis.dev/nodejs/google-auth-library
import { google } from 'googleapis';
import { OAuth2 } from 'google-auth-library';

const oauth2 = new OAuth2(
  process.env.GOOGLE_CLIENT_ID!,
  process.env.GOOGLE_CLIENT_SECRET!,
  'urn:ietf:wg:oauth:2.0:oob' // or your registered redirect; not used for refresh flow
);
// D-01: store only refresh_token; access_token fetched on-demand via library
oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN! });
// Optional but helpful for stale expiry_date edge (see Pitfall 2):
// oauth2.forceRefreshOnFailure = true; // if library version supports via RefreshOptions
// Or via OAuth2 constructor options: { eagerRefreshThresholdMillis: 300_000 } default is 5 min

oauth2.on('tokens', (tokens) => {
  // D-01: do NOT persist rotated access_token to DB/env — keep in-memory only
  if (tokens.refresh_token) console.warn('New refresh_token issued — manual rotation required');
  logger.debug({ expiry_date: tokens.expiry_date }, 'tokens refreshed');
});

export const gmail = google.gmail({ version: 'v1', auth: oauth2 });
```

### Gmail Watch Registration + Daily Renewal
```typescript
// Source: https://developers.google.com/workspace/gmail/api/guides/push + https://developers.google.com/gmail/api/reference/rest/v1/users/watch
const TOPIC = `projects/${process.env.GOOGLE_CLOUD_PROJECT!}/topics/${process.env.GOOGLE_PUBSUB_TOPIC!}`;

export async function registerWatch(): Promise<{ historyId: string; expiration: string }> {
  const { data } = await gmail.users.watch({
    userId: 'me',
    requestBody: { topicName: TOPIC, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' },
  });
  // Persist both — expiration is epoch millis string
  await pool.query(
    `INSERT INTO pipeline_health (key, value, updated_at) VALUES ('gmail_history_id', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [data.historyId!],
  );
  logger.info({ historyId: data.historyId, expiration: data.expiration }, 'gmail watch registered');
  return data as { historyId: string; expiration: string };
}
// In worker.ts — renew daily (idempotent, 6-day safety buffer)
setInterval(() => registerWatch().catch(err => {
  logger.error({ err }, 'watch renewal failed');
  alertService.sendOnce('watch-renewal', `Gmail watch renewal failed: ${err.message}`, 60*60*1000);
}), 24*60*60*1000);
```

### Pub/Sub Push Handler (Express) — history.list Cursor
```typescript
// Source: https://developers.google.com/workspace/gmail/api/guides/push — message.data is Base64url JSON {emailAddress, historyId}
import express from 'express';
const app = express();
app.use(express.json());

app.post('/gmail/pubsub', async (req, res) => {
  // Pub/Sub push envelope: { message: { data: base64(emailAddress+historyId), messageId, publishTime } }
  const b64 = req.body?.message?.data;
  if (!b64) { res.status(400).send('missing data'); return; }
  const { emailAddress, historyId: newHistoryId } = JSON.parse(Buffer.from(b64, 'base64').toString());
  const last = await getHealth('gmail_history_id');
  try {
    const { data } = await gmail.users.history.list({
      userId: 'me', startHistoryId: last, historyTypes: ['messageAdded'],
    });
    for (const h of data.history ?? []) for (const m of h.messagesAdded ?? []) {
      if (m.message?.id) await processEmail(m.message.id);
    }
    await setHealth('gmail_history_id', newHistoryId);
    res.status(200).send('OK'); // ACK — non-2xx triggers Pub/Sub redelivery
  } catch (err: any) {
    if (err?.code === 404) {
      // History expired — fallback to poll-style resync
      logger.warn({ err }, 'historyId expired, falling back to messages.list');
      await pollSweep(); await setHealth('gmail_history_id', newHistoryId);
      res.status(200).send('OK');
    } else throw err;
  }
});
```

### Poll Sweep (15-min Safety Net) — Independent of Push State
```typescript
// Source: https://developers.google.com/gmail/api/reference/rest/v1/users/messages/list
let pollRunning = false;
async function pollSweep(): Promise<void> {
  if (pollRunning) return; pollRunning = true;
  try {
    const afterSec = Math.floor((await getCheckpointAfterMs()) / 1000);
    // Use Gmail query: from:(zenith) after:<unix_seconds>
    const domains = (process.env.ZENITH_SENDER_DOMAINS ?? 'zenithbank.com').split(',').map(s=>s.trim());
    const q = `(${domains.map(d=>`from:${d}`).join(' OR ')}) after:${afterSec}`;
    let pageToken: string | undefined;
    do {
      const { data } = await gmail.users.messages.list({ userId: 'me', q, pageToken, maxResults: 50 });
      for (const m of data.messages ?? []) await processEmail(m.id!);
      pageToken = data.nextPageToken ?? undefined;
      if (data.messages?.length) await setPollCheckpoint(Date.now());
    } while (pageToken);
  } finally { pollRunning = false; }
}
setInterval(() => pollSweep().catch(e => logger.error({ err: e }, 'poll sweep failed')), 15*60*1000);
```

### DKIM-Only Authenticity Verification (Strict)
```typescript
// Source: RFC 8601 Authentication-Results — https://smtpedia.com/authentication-results-header/
// D-07: require dkim=pass AND d=zenithbank.com from same DKIM clause
export function verifyAuthenticity(authResultsHeader: string): { pass: boolean; domain: string | null; reason: string } {
  if (!authResultsHeader) return { pass: false, domain: null, reason: 'missing Authentication-Results' };
  // Header is semicolon-separated clauses: "mx.google.com; dkim=pass header.d=zenithbank.com header.s=...; spf=pass ..."
  // Must find a dkim=pass clause whose header.d (or header.i domain) equals zenithbank.com
  const clauses = authResultsHeader.split(';').map(s => s.trim());
  for (const c of clauses) {
    if (/^\s*dkim\s*=\s*pass\b/i.test(c)) {
      // RFC 8601: header.d is DKIM signing domain; header.i is identity (user@domain)
      const dMatch = c.match(/header\.d\s*=\s*([^\s;]+)/i) ?? c.match(/\bd\s*=\s*([^\s;]+)/i);
      const iMatch = c.match(/header\.i\s*=\s*@?([^\s;]+)/i);
      const signingDomain = (dMatch?.[1] ?? iMatch?.[1] ?? '').replace(/^@/, '').toLowerCase();
      if (signingDomain === 'zenithbank.com') return { pass: true, domain: signingDomain, reason: `dkim=pass d=${signingDomain}` };
      // dkim=pass but wrong domain → continue searching (attacker domain with valid DKIM)
    }
  }
  // No valid zenithbank.com DKIM pass found
  const anyPass = /dkim\s*=\s*pass/i.test(authResultsHeader);
  return { pass: false, domain: anyPass ? 'mismatch' : null, reason: anyPass ? 'dkim=pass but d!=zenithbank.com' : 'no dkim=pass' };
}
```

### Strict Base64 → QP → HTML Decoding (D-09)
```typescript
// Source: zenith_bank_email_format.md:42-50 — no fallback decoders
import quotedPrintable from 'quoted-printable';

function base64UrlToBase64(s: string): string {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b.length % 4; if (pad) b += '='.repeat(4 - pad);
  return b;
}

export function decodeStrict(rawBodyB64: string): string {
  // Assumes Gmail bodyData already base64url (from payload.parts[].body.data) — caller normalizes if needed
  let qp: string;
  try {
    const b64 = base64UrlToBase64(rawBodyB64);
    qp = Buffer.from(b64, 'base64').toString('utf-8'); // inner QP string
  } catch (e: any) { throw new Error(`strict-decode: base64 fail: ${e.message}`); }
  try {
    // quoted-printable decode is encoding-agnostic byte-string → JS decode needs utf8
    const decoded = quotedPrintable.decode(qp);
    // quotedPrintable returns byte-string; ensure utf8
    return Buffer.from(decoded, 'binary').toString('utf-8');
  } catch (e: any) { throw new Error(`strict-decode: quopri fail: ${e.message}`); }
  // No fallback: 7bit/plain HTML emails are parse/validation failures per D-09 → alerted
}
```

### Cheerio Table Extraction (Per-Field, Not Monolithic Regex)
```typescript
// Source: cheerio docs — load HTML, select table rows by label cell
import * as cheerio from 'cheerio';

export function parseZenithFields(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const rows = $('table tr').toArray();
  const kv: Record<string, string> = {};
  for (const tr of rows) {
    const cells = $(tr).find('td').toArray().map(td => $(td).text().trim());
    if (cells.length >= 2) {
      const label = cells[0].replace(/[:\s]+$/, '').toLowerCase();
      kv[label] = cells[1];
    }
  }
  return kv;
}
// Then per-field regex from zenith_bank_email_format.md table (128-144):
// Amount.*?( [\d,]+\.\d{2}) , Date of Transaction.*?(\d{2}/\d{2}/\d{4}), etc. — applied to kv values, not raw HTML
```

### Postgres Pool — Railway Internal Networking
```typescript
// Source: docs.railway.com + mako.ai pg guide — keep Pool error handler to avoid process crash
import pg from 'pg';
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL!, // ${{Postgres.DATABASE_URL}} on Railway
  ssl: { rejectUnauthorized: false },          // self-signed cert on Railway internal
  max: 10,
  idleTimeoutMillis: 30_000,
});
pool.on('error', (err) => console.error('pg pool idle error', err)); // prevents unhandled crash
// Local dev: use DATABASE_PUBLIC_URL (gondola.proxy.rlwy.net) with same ssl config
```

### Atomic Insert + Heartbeat + Dedup
```typescript
// Source: plan.md §19 — email_message_id UNIQUE is security + dedup control
export async function insertTransactionAtomically(row: TxRow): Promise<'inserted'|'duplicate'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `INSERT INTO transactions
         (amount,currency,transaction_reference,transaction_date,sender_name,sender_account,description,branch,available_balance, bank,email_message_id,email_auth_result,raw_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, 'Zenith Bank',$10,$11,$12)
       ON CONFLICT (email_message_id) DO NOTHING
       RETURNING id`,
      [row.amount,row.currency,row.transaction_reference,row.transaction_date,row.sender_name,row.sender_account,row.description,row.branch,row.available_balance,row.email_message_id,row.email_auth_result,row.raw_email],
    );
    if (res.rowCount === 0) { await client.query('ROLLBACK'); return 'duplicate'; }
    await client.query(
      `INSERT INTO pipeline_health (key, value, updated_at) VALUES ('last_zenith_email_processed_at', now(), now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    );
    await client.query('COMMIT');
    return 'inserted';
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
```

### Telegram Alert with Fallback + Cooldown
```typescript
// Source: https://core.telegram.org/bots/api#sendmessage — simple fetch, no SDK needed
const cooldowns = new Map<string, number>();
export async function sendAlert(key: string, text: string, cooldownMs = 60_000): Promise<void> {
  if (Date.now() - (cooldowns.get(key) ?? 0) < cooldownMs) return;
  cooldowns.set(key, Date.now());
  const token = process.env.TELEGRAM_BOT_TOKEN!, chatId = process.env.TELEGRAM_CHAT_ID!;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!r.ok) throw new Error(`telegram ${r.status} ${await r.text()}`);
  } catch (e) {
    // Fallback: generic webhook/email path from ALERT_WEBHOOK_URL (or raw_email to admin inbox)
    const fallback = process.env.ALERT_WEBHOOK_URL_FALLBACK ?? process.env.ALERT_EMAIL_WEBHOOK;
    if (fallback) await fetch(fallback, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ key, text, error: String(e) }) });
    else console.error('alert fallback missing', e);
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `users.messages.list` polling only | `users.watch` + Pub/Sub push with `history.list` + polling safety net | 2015 (watch GA) / 2026 best-practice daily renewal | Push latency <5s vs 15-min batches; polling still required for missed deliveries [CITED: developers.google.com + withampersand.com 2026] |
| `googleapis` in maintenance mode, manual token storage to DB | `google-auth-library` OAuth2Client with `eagerRefreshThresholdMillis` (default 5 min) + `forceRefreshOnFailure` + `tokens` event in-memory only | google-auth-library v7+ (2024–2026) | Don't persist rotated `access_token`; rely on library eager refresh; reduces D-01 complexity |
| Regex-scraping raw HTML string | `cheerio` DOM traversal per `<tr><td>label</td><td>value</td></tr>` | Stable since cheerio 1.x | Resilient to whitespace/QP artifacts and column-order drift |
| Hand-rolled `=XX` QP replacement | `quoted-printable` RFC 2045 library + `Buffer.from(...,'base64')` outer | Long-standing; reaffirmed in 2025 MIME parser guides | Encoding-agnostic, handles soft line breaks `=\r\n` correctly |
| Winston string logs | `pino` JSON to stdout | Node 18+ era | Railway-native JSON log pipeline; child loggers for correlation |
| `sslmode=require` in DATABASE_URL query string | `pg.Pool({ connectionString, ssl:{rejectUnauthorized:false} })` config object | 2024–2026 Railway Postgres bump (station.railway.com) | Internal `postgres.railway.internal` now requires TLS; query string overrides `ssl` prop and breaks |
| Railway Redis + BullMQ for Phase 1 jobs | In-process `setInterval` (single replica, per D-13) | Deferred explicitly to later phases | Avoids over-engineering; upgrade path documented when multi-replica/burst volume arrives |

**Deprecated/outdated:**
- `gmail.users.watch` without `labelIds` filter → subscribes to every label change (spam/trash) → noise; always set `labelIds:['INBOX']` with `INCLUDE` [CITED: developers.google.com].
- Google OAuth `access_type: 'online'` (default) → no refresh_token issued. Phase 1 requires `offline` access during consent; refresh_token only returned on first authorization [CITED: googleapis README].
- Node 16 EOL — Railway Nixpacks now defaults Node 20; Phase 1 should pin `engines: {node:"20.x"}`.

## Assumptions Log

> All `[ASSUMED]` claims in this research. Planner + discuss-phase must confirm before locking.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Zenith DKIM signing domain is exactly `zenithbank.com` (not `mail.zenithbank.com` or `zenith-bank.com`). Spec lists `d=zenithbank.com` but real header may differ. | Authenticity, §6.1 | DKIM check fails open (miss legit) or fails closed (accept spoof if looser). Must verify against a real `Authentication-Results` sample before coding FR-1.4 — flagged as Task 3.2 in plan. |
| A2 | Zenith HTML table structure is stable with `label → value` `<td>` pairs per `<tr>` and field labels match spec table (e.g., `Account Number`, `Date of Transaction`). | Parser | Parser row selector fails; need resilient label normalization (`trim().toLowerCase()` + fuzzy match). |
| A3 | Amount always `N{,}NNN.NN` with 2 decimals and commas; currency always one of `NGN/USD/EUR/GBP`. No kobo integer format or `₦` symbol. | Parser/Validation | Amount parse could mis-handle integer amounts or symbol prefix; add fallback regex + alert. |
| A4 | Telegram `ALERT_WEBHOOK_URL` is a Telegram `sendMessage` endpoint, not a generic webhook. Spec says Telegram primary/email fallback but env var name suggests generic webhook. | Alerting | Wrong payload format → alerts silently drop. Need to clarify env var contract: is it `https://api.telegram.org/bot{token}/sendMessage` or a relay webhook? |
| A5 | Single-replica Railway worker is sufficient for 15-min polling load (no horizontal scaling needed in Phase 1). | Architecture / Timers | `setInterval` dedup is valid only for single replica; multi-replica requires advisory locks. Must pin replicas=1 in Railway service scaling. |
| A6 | `transaction_reference` uniqueness should not be enforced at DB level in Phase 1 per plan note about bank reuse. | Data Model | If uniqueness enforced prematurely, legit second transaction with reused ref would be dropped. Keep only `email_message_id UNIQUE` in Phase 1. |
| A7 | `@zenithbank.com` is the only DKIM signer; no alternate domain like `zenithbank.ng` signs alerts. | Authenticity | If alternate signer exists, spec's strict single-domain check rejects legit credit alerts → data loss. Confirm via header corpus. |
| A8 | Gmail scopes `gmail.readonly` is sufficient for `users.watch` + `history.list` + `messages.get`. Some legacy sources suggest `gmail.modify` but readonly covers watch. | Gmail Auth | Under-scoping → `403` on `users.watch`. Verify against current Gmail API reference; include `gmail.readonly` + `pubsub` scope no, Pub/Sub permissions are GCP IAM not Gmail scope. |

## Open Questions (RESOLVED)

1. **What is the actual DKIM signing domain and Authentication-Results shape for a real Zenith alert?** — RESOLVED: Assume `header.d=zenithbank.com` per zenith_bank_email_format.md and D-07; planner implements clause-bound `dkim=pass` + `d=zenithbank.com` check. Confirm with one real `Show original` sample before finalizing FR-1.4 (blocking dependency documented in 01-01 Task 1.1, verified by authenticity.test T-1.5).
   - What we know: Spec/D-07 mandates `dkim=pass` + `d=zenithbank.com` per `Authentication-Results` from `mx.google.com`; RFC 8601 clause structure is `dkim=pass header.d=zenithbank.com`.
   - What's unclear: Whether real Gmail stamps `header.d`, `header.i`, or both; whether multiple DKIM signatures appear (one from ESP, one from bank); exact spacing/semicolon layout; whether SPF appears in same header and could be confused as DKIM.
   - Recommendation: Block parser finalization until one real forwarded Zenith alert is inspected via `Show original` → copy full `Authentication-Results` header verbatim. Treat as Task 3.2 blocking dependency.

2. **Does poll checkpoint belong in `pipeline_health` or a dedicated `gmail_checkpoint` table?** — RESOLVED: Use separate keys in same `pipeline_health` table (`gmail_history_id`, `poll_after_ms`, `last_zenith_email_processed_at`) for simplicity; heartbeat updates only on successful insert, poll cursor advances only on non-empty sweep — planner adopts this in 01-01 migrations/health helpers.

3. **Should unknown description formats be strict (alert) or lenient (store raw + flag)?** — RESOLVED: Lenient in Phase 1 per planner D-10 discretion — store `description` raw verbatim + `sender_name` best-effort with `parse_warning` flag; alert at warn not error. Implemented in 01-02 classifier/validation.

4. **Where does the Pub/Sub push subscription actually point — Railway worker public domain vs GCP Cloud Run?** — RESOLVED: Target Railway worker public domain `*.up.railway.app` HTTPS with 60s ack deadline; verify TLS at deploy (01-03). Poll-only is explicit fallback per FR-1.2 if push endpoint not ready.

5. **How is `raw_email` stripping of CID images defined — drop attachments only or also truncate body?** — RESOLVED: Strip after decode (remove Content-Type image/* MIME parts + cid: images), then cap to 100KB and store with truncated flag in `raw_email` metadata. Adopted in 01-02 persistence path.

6. **Is non-Zenith-domain but content-claiming-to-be-Zenith email treated as suspicious or debug-ignore?** — RESOLVED: Strict per spec — only From-domain candidates enter authenticity check; body-only claims from non-Zenith domain remain debug-ignored (FR-1.3). Typosquat ignored at debug, not suspicious.

## Environment Availability

> Phase 1 depends on external services; audited against this machine (Windows) and expected Railway runtime.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 20 LTS | Runtime + `googleapis`/`pg`/`pino` | ✓ (this machine 24.14.0; Railway Nixpacks auto 20.x) | 20.x recommended; pin in `engines` | — (required) |
| PostgreSQL 15+ | Transactions/ledger | via Railway project Postgres add-on (managed) | 15/16/17 per railway-templates | Local `docker run postgres:16` for integration tests |
| Google Cloud Project + Pub/Sub API | Push delivery | ✗ (requires manual `gcloud` setup) | — | Phase 1 poll-only path is explicit fallback (FR-1.2); GCP scaffolding in planner's wave 0 setup task |
| Gmail API + OAuth2 client credentials | Connection | Configured (per D-01 refresh_token exists) | `googleapis@178.1.1` | No fallback — manual re-consent via `generateAuthUrl(access_type:offline, scope:gmail.readonly)` |
| Railway CLI + Project + Postgres service | Deployment + DB | ✓ (docs verified) | latest | Manual `psql` against `DATABASE_PUBLIC_URL` for local dev |
| Cloud Pub/Sub Topic + push subscription | `users.watch` | ✗ (must be created: topic + IAM `gmail-api-push@system.gserviceaccount.com` → `roles/pubsub.publisher`) | — | Poll sweep covers missed push; planner must add IAM grant task |

**Missing dependencies with no fallback:**
- Gmail OAuth refresh token validity (if rotated/revoked) — requires manual re-authorization out-of-band; staleness alert is the detector, not a programmatic fixer.

**Missing dependencies with fallback:**
- Pub/Sub topic/IAM/subscription — fallback is 15-min polling (FR-1.2) until GCP scaffolding completes.
- PgBouncer — optional; Railway built-in pooling not required for single worker with `max:10`; add only if connection-limit errors appear.

## Validation Architecture

> Nyquist validation not explicitly disabled in repo (no `.planning/config.json` found) — treated as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `vitest@3.x` [ASSUMED] (lightweight, TS-native, faster than Jest for this project); alternatively `jest@29 + ts-jest` both viable — planner picks one |
| Config file | `vitest.config.ts` or `jest.config.ts` — **not yet present (Wave 0 gap)** |
| Quick run command | `npm test -- --run` (vitest) or `npx jest --passWithNoTests` |
| Full suite command | `npm run test:coverage` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FR-1.4 / T-1.1 | `verifyAuthenticity` with `dkim=pass` + matching `d=zenithbank.com` | unit | `vitest run tests/unit/authenticity.test.ts -t "dkim pass matching"` | ❌ Wave 0 |
| FR-1.4 / T-1.2 | `dkim=pass` but wrong domain → fail | unit | `vitest run tests/unit/authenticity.test.ts -t "domain mismatch"` | ❌ Wave 0 |
| FR-1.4 / T-1.3 | `dkim=fail` → fail closed | unit | `vitest run tests/unit/authenticity.test.ts` | ❌ Wave 0 |
| FR-1.4 / T-1.4 | Missing Auth-Results → fail closed | unit | `vitest run tests/unit/authenticity.test.ts` | ❌ Wave 0 |
| FR-1.4 / T-1.5 | Display-name spoof with non-Zenith DKIM domain | unit | `vitest run tests/unit/authenticity.test.ts -t "display-name spoof"` | ❌ Wave 0 |
| FR-1.6 / T-1.6 | Well-formed Zenith credit → all fields extracted | unit | `vitest run tests/unit/parser.test.ts` | ❌ Wave 0 |
| T-1.7 | Unusual amount format (commas, kobo) | unit | `vitest run tests/unit/parser.test.ts -t "amount"` | ❌ Wave 0 |
| FR-1.5 / T-1.8 | Non-alert Zenith (OTP/marketing) → classified not-alert | unit | `vitest run tests/unit/classifier.test.ts` | ❌ Wave 0 |
| T-1.9 | Unknown description family → ParseFailure with context | unit | `vitest run tests/unit/parser.test.ts` | ❌ Wave 0 |
| FR-1.7 / T-1.10-13 | Validation (negative amount, bad currency, future date, happy path) | unit | `vitest run tests/unit/validation.test.ts` | ❌ Wave 0 |
| T-1.14-15 | Staleness checker (threshold + Africa/Lagos window) | unit | `vitest run tests/unit/staleness.test.ts` | ❌ Wave 0 |
| T-2.1 | Full pipeline verified alert → transactions row + heartbeat | integration | `vitest run tests/integration/pipeline.test.ts -t "T-2.1"` | ❌ Wave 0 |
| T-2.2 | Spoofed email → suspicious_emails + alert | integration | `vitest run tests/integration/pipeline.test.ts -t "T-2.2"` | ❌ Wave 0 |
| T-2.3 | Verified but unparsable → no transactions + distinct alert | integration | `vitest run tests/integration/pipeline.test.ts -t "T-2.3"` | ❌ Wave 0 |
| T-2.4 | Duplicate messageId → single row | integration | `vitest run tests/integration/pipeline.test.ts -t "T-2.4"` | ❌ Wave 0 |
| T-2.5-2.6 | Empty poll no-op; push-after-poll dedup | integration | `vitest run tests/integration/gmail.test.ts` | ❌ Wave 0 |
| T-4.1-4.3 | Security (header spoof, valid DKIM wrong domain, replay) | integration | `vitest run tests/integration/security.test.ts` | ❌ Wave 0 |
| T-5.1-5.4 | Resilience (kill mid-batch, Postgres down, rate-limit, missed push) | integration | `vitest run tests/integration/resilience.test.ts` | ❌ Wave 0 |
| T-6.1-6.4 | Alerting (staleness once, heartbeat recovers, parse-drift, spoof) | integration | `vitest run tests/integration/alerting.test.ts` | ❌ Wave 0 |
| Manual | Real forwarded Zenith alert → ledger row within budget | manual | Run `npm run worker:dev` then forward email; `SELECT * FROM transactions` | — |
| Manual | Kill/restart worker mid-batch → no dup/loss | manual | Railway restart + `SELECT count(*) WHERE email_message_id=?` | — |

### Sampling Rate
- **Per task commit:** `npm test -- --run` (<10s unit suite)
- **Per wave merge:** `npm run test:coverage` + integration (requires local Postgres)
- **Phase gate:** Full suite green + manual checklist signed off in Section 12 before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `vitest.config.ts` (or `jest.config.ts` + `tsconfig.json` `types`) — test runner config
- [ ] `tests/unit/authenticity.test.ts` — covers FR-1.4 / T-1.1–1.5
- [ ] `tests/unit/parser.test.ts` + `tests/unit/decode.test.ts` — D-09 pipeline + field extraction
- [ ] `tests/unit/validation.test.ts` + `tests/unit/classifier.test.ts` — FR-1.5/1.7
- [ ] `tests/unit/staleness.test.ts` — NFR time-window logic (freeze time via `vi.useFakeTimers`)
- [ ] `tests/integration/pipeline.test.ts` — full pipeline with `pg` test DB (docker-compose `postgres:16`)
- [ ] `tests/conftest.ts` or `tests/setup.ts` — `Pool` lifecycle, migration apply via `npm run migrate`
- [ ] Framework install: `npm install -D vitest @types/node tsx` + `package.json` `test` scripts
- [ ] `migrations/*.sql` — schema for `transactions`/`suspicious_emails`/`pipeline_health`
- [ ] `.env.test.example` — test env with `DATABASE_URL=postgresql://.../...test` isolation
- [ ] Gmail API mocking helper — `nock` or stub for `gmail.users.messages.get` during integration without live API

*(If this list is non-empty, planner's Wave 0 must schedule test infra before implementation waves.)*

## Security Domain

> `security_enforcement` not present in repo config — treated as **enabled** per instructions.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (Gmail OAuth) | `google-auth-library` OAuth2Client + personal refresh_token; no token persistence per D-01; `invalid_grant` → alert + manual re-consent |
| V3 Session Management | no | No user sessions in Phase 1 (worker only) |
| V4 Access Control | partial | Postgres private networking + env-scoped `DATABASE_URL`; no admin API in Phase 1 |
| V5 Input Validation | yes | `zod` strict schema + `cheerio` text extraction sanitization; reject `amount ≤0`, bad currency, future date |
| V6 Cryptography | yes — DKIM as trust root | RFC 8601 `Authentication-Results` DKIM `pass` + `d=zenithbank.com` binding; never `From` header text match; never hand-roll crypto |
| V7 Error Handling & Logging | yes | Fail-closed on missing auth header; JSON logs with correlation key; no secrets in logs (`auth_result` without tokens) |
| V9 Communications | yes | Railway TLS for worker HTTPS; `https://www.googleapis.com` via `googleapis` TLS; Telegram `https://api.telegram.org`; Postgres `ssl:{rejectUnauthorized:false}` on private net |
| V14 Configuration | yes | All config in env (NFR-1.2); `ZENITH_SENDER_DOMAINS`, thresholds, TZ in env; no plaintext creds in git; `.env.example` without values committed |

### Known Threat Patterns for Gmail Email-Ingestion Ledger

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Display-name spoof (`From: "Zenith Bank" <attacker@evil.com>`) | Spoofing | Require DKIM `pass` + signing domain `zenithbank.com`; `From` text never trusted [CITED: plan.md §6.1; smtpedia RFC 8601] |
| Valid DKIM from attacker domain (`attacker.com` signs correctly, Gmail authenticates it as pass) | Spoofing | Bind `dkim=pass` to its `header.d` clause — attacker `d=attacker.com` pass does NOT satisfy `d=zenithbank.com` check; see pitfall & code example above |
| Replay of legit Zenith email (attacker resends same raw) | Repudiation / Tampering | `email_message_id TEXT UNIQUE` + `ON CONFLICT DO NOTHING` — dedup is a security control, not just hygiene [CITED: plan.md §19] |
| Oversized email / CID image DoS | Denial of Service | NFR-1.4 cap ~100KB + strip inline images before insert; reject attachments; bound `raw_email` size |
| HistoryId 404 after outage → ingestion gap | Denial of Service (availability) | 404 fallback to `messages.list` resync + poll sweep as safety net (FR-1.2) |
| Refresh token revocation (password change / 6-month expiry / 100-token limit) | Elevation / Availability | Staleness alert (FR-1.10) + heartbeat; manual re-consent path documented; handle `invalid_grant` gracefully [CITED: developers.google.com/identity/protocols/oauth2 — refresh token expiration] |
| Gmail API quota exhaustion (250 units/user/sec) | Denial of Service | Cap polling `maxResults:50`, backoff on 429/403, avoid aggressive poll; push is low-quota vs poll loops [CITED: gmail api quotas] |
| Log injection via crafted email subject/from | Tampering | Parameterized `pg` queries only (`$1` placeholders); JSON-escape log fields; sanitize `subject`/`from` before Telegram payload (HTML-escape for Telegram `parse_mode:HTML`) |

## Sources

### Primary (HIGH confidence)
- `googleapis` / `google-api-nodejs-client` README — `users.watch`, `google-auth-library` tokens/refresh [CITED: github.com/googleapis/google-api-nodejs-client]
- `developers.google.com/workspace/gmail/api/guides/push` — watch expiry 7 days, recommend daily renewal, `message.data` Base64url envelope [CITED: 2026-07-22]
- `developers.google.com/gmail/api/reference/rest/v1/users/watch` — `topicName` fully-qualified + `historyId`/`expiration` semantics [CITED]
- `google-auth-library` OAuth2Client source — `eagerRefreshThresholdMillis` 5 min, `forceRefreshOnFailure`, `requestAsync` 401 retry logic [CITED: googleapis.dev/nodejs/google-auth-library]
- `zenith_bank_email_format.md` v1 (project root) — decoding pipeline, masked account, four description families, regex table [VERIFIED: zenith_bank_email_format.md:1-214]

### Secondary (MEDIUM confidence)
- `smtpedia.com/authentication-results-header` — RFC 8601 complete Authentication-Results structure, `header.d` vs `header.from` alignment, 9 misread patterns [CITED: 2026-07-12]
- `unipile.com/gmail-api-push-notifications` + `withampersand.com/2026-05-06` — daily renewal safest, IAM `gmail-api-push@system.gserviceaccount.com` topic binding, history gap 404 recovery [CITED]
- `github.com/2nth-ai/skills/tech/google/workspace/gmail/SKILL.md` — `gmailFor(user)`, watch registration idempotency, `history.list` cursor pattern [CITED]
- `docs.railway.com` + `github.com/brianc/node-postgres/issues/3355` — internal Postgres now requires `ssl:{rejectUnauthorized:false}` not `ssl:false`/`sslmode` query; `railway.json` `healthcheckTimeout` 120 for migrations [CITED]
- `mako.ai/guides/postgresql/connect-from-node` — `pg.Pool` `max:10`, `idleTimeoutMillis`, pool `error` handler necessity, `self signed certificate` fix [CITED: 2026-06-12]
- `npm registry` `npm view <pkg> version` — verified versions for `googleapis@178.1.1`, `pg@8.23.0`, `pino@10.3.1`, `cheerio@1.2.0`, `quoted-printable@1.0.1`, `zod@4.5.4` [VERIFIED: npm registry]
- `gsd-tools query package-legitimacy` — legitimacy gate for 7 packages: all OK/SUS-too-new explainable, no postinstall scripts [VERIFIED: gsd-tools]

### Tertiary (LOW confidence)
- `mailparser` / `postal-mime` / `tempo-email-parser` WebSearch — broad MIME guidance, not used in strict Phase 1 path; flagged `[ASSUMED]` where referenced — validate before adopting.
- Telegram Bot API rate-limit (30 msg/sec) and `sendOnce` cooldown pattern [CITED: codeview.asia 2026-06-18] — medium confidence for alerting design.

## Metadata

**Confidence breakdown:**
- Standard stack: **MEDIUM** — core Gmail/PG versions verified via npm registry + Google official docs on watch/OAuth; secondary confirms IAM/Railway TLS quirks; remaining gap is live Railway pub/sub push endpoint TLS/ack testing which needs one manual deploy.
- Architecture: **MEDIUM** — phases 1 convergence pattern + watch/history cursor + dedup + heartbeat atomicity are well-trodden; what keeps it from HIGH is unconfirmed real DKIM header shape and Railway worker public-domain push availability (open questions 1+4).
- Pitfalls: **HIGH** — each pitfall sourced from either official doc (watch expiry, refresh token expiry, pool SSL) or plan CONTEXT.md risk register; mitigation steps are actionable.

**Research date:** 2026-09-09
**Valid until:** 2026-10-09 (30 days; stable Gmail v1 + Railway Postgres contracts; re-verify `googleapis` major bump or Railway Postgres TLS change)

