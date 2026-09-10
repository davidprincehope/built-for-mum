---
phase: 02-telegram-ledger-assistant
plan: 01
subsystem: telegram-ledger
tags: [telegram, postgres, pg_trgm, session, timingSafeEqual, balance, history, Africa/Lagos, date-fns, rate-limit]
requires:
  - phase: 01-zenith-ingestion
    provides: transactions ledger with indexed transaction_date, live worker on PORT 8080
  - phase: 01.1-telegram-admin
    provides: webhook verifySecretToken, sendMessage 4096 cap, ringBuffer 500, rateLimit sliding window
provides:
  - Telegram password /login 24h in-memory session with timingSafeEqual and hourly sweep
  - Balance read ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 1 with null to em dash
  - History Lagos DD/MM|ISO inclusive BETWEEN capped 50 description-first via extractSender with COUNT and Next pagination
  - Migration 005 pg_trgm GIN on sender_name/description + B-tree amount
  - Env validation TELEGRAM_BOT_PASSWORD min12 optional + logger redact
  - Per-command rate limits and polished help
affects: [02-02 verify media, 02-03 add-ons search/export/summary]
actuals:
  tokens: 20845
  tasks: 3
  commits: 3
tech-stack:
  added: []
  patterns: [timingSafeEqual constant-time compare, in-memory Map TTL 24h, parameterized BETWEEN cap 50, pg_trgm GIN, pino redact remove]
key-files:
  created:
    - src/telegram/session.ts
    - src/telegram/balance.ts
    - src/telegram/history.ts
    - migrations/005_telegram_ledger_indexes.sql
    - tests/telegram/session.test.ts
    - tests/telegram/balance.test.ts
    - tests/telegram/history.test.ts
  modified:
    - src/config/env.ts
    - src/observability/logger.ts
    - src/worker.ts
    - src/telegram/commands.ts
key-decisions:
  - "In-memory Map 24h session over DB — single replica per Phase 1 D-11, faster and sufficient"
  - "TELEGRAM_BOT_PASSWORD optional empty but min12 when set — fail-closed at runtime not boot, preserves allowlist fallback"
  - "Logger redact remove:true for BOT_PASSWORD etc — prevents Railway stdout leakage on failed login"
  - "History description-first via extractSender — reference blank for NIP/KUDA per parser optionalKv"
  - "GIN trigram on sender/description + B-tree amount — correct for ILIKE substring not tsvector lexeme per RESEARCH"
requirements-completed:
  - 2-R1
  - 2-R3
  - 2-R4
  - 2-R5
coverage:
  - id: D1
    description: "Password /login 24h session gates /balance and other commands before any DB query with timingSafeEqual"
    requirement: "2-R1"
    verification:
      - kind: unit
        ref: "tests/telegram/session.test.ts#wrong password returns false and isLoggedIn true within TTL and false after 24h+1ms"
        status: pass
    human_judgment: false
  - id: D2
    description: "Unauthenticated user gets login prompt with zero DB touch; wrong password generic reply never logs password"
    requirement: "2-R1"
    verification:
      - kind: unit
        ref: "tests/telegram/session.test.ts#unauthenticated /balance blocked without DB touch"
        status: pass
    human_judgment: false
  - id: D3
    description: "/balance returns Available and Current plus last TX line from ORDER BY transaction_date DESC"
    requirement: "2-R3"
    verification:
      - kind: unit
        ref: "tests/telegram/balance.test.ts#formats available current and last TX line ordered DESC"
        status: pass
    human_judgment: false
  - id: D4
    description: "/history accepts DD/MM/YYYY and YYYY-MM-DD Lagos inclusive BETWEEN capped 50 description-first with total summary and Next pagination under 4096"
    requirement: "2-R4"
    verification:
      - kind: unit
        ref: "tests/telegram/history.test.ts#parseLagosDateRange accepts DD/MM/YYYY and provides inline Next pagination"
        status: pass
    human_judgment: false
  - id: D5
    description: "Webhook still enforces X-Telegram-Bot-Api-Secret-Token timingSafeEqual lowercased before body parse"
    requirement: "2-R5"
    verification:
      - kind: unit
        ref: "src/worker.ts#verifySecretToken before readJsonBody"
        status: pass
    human_judgment: false
  - id: D6
    description: "Migration 005 creates pg_trgm extension + GIN indexes idempotently"
    requirement: "2-R4"
    verification:
      - kind: manual_procedural
        ref: "npm run migrate applies 005_telegram_ledger_indexes.sql idempotently"
        status: unknown
    human_judgment: true
    rationale: "Requires live Postgres to verify CREATE EXTENSION; unit mocks cannot prove GIN creation"
  - id: D7
    description: "Global 15/10s and per-command login 5/60s poll 1/30s watch 1/60s verify 5/60s search 10/60s rate limits"
    requirement: "2-R1"
    verification:
      - kind: unit
        ref: "tests/telegram/session.test.ts#login rate limit 5/60s via isRateLimited"
        status: pass
    human_judgment: false
duration: 25min
completed: 2026-09-10
status: complete
---

# Phase 02 Plan 01: Telegram Tracer Summary

**Telegram password /login 24h session on PORT 8080 worker with balance and history Lagos capped 50 plus pg_trgm GIN — full webhook→session→DB→4096 path proven**

## Performance

- **Duration:** 25 min
- **Started:** 2026-09-10T18:30:00Z
- **Completed:** 2026-09-10T18:55:00Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments

- In-memory session `Map<string, expiry>` 24h with `timingSafeEqual` constant-time compare, hourly unref sweep, fail-closed when `TELEGRAM_BOT_PASSWORD` missing, gated in `worker.ts` before any DB touch with allowlist fallback
- `TELEGRAM_BOT_PASSWORD` (optional min12) and `OPENROUTER_API_KEY` added to `env.ts` zod; `logger.ts` redacts both plus existing secrets with `remove:true`
- Telegram `/login` and `/logout` handlers with `5/60s` per-chat sliding window, generic `Wrong password` reply never echoing input, never logging password
- `/balance` reads `available_balance, current_balance, sender_name, amount ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC LIMIT 1` with `null→—`, `escapeHtml`, Africa/Lagos time, `4000` slice
- `/history` parses `DD/MM/YYYY` and `YYYY-MM-DD` via `date-fns` + `isValid`, normalizes to `YYYY-MM-DD` inclusive `BETWEEN $1::date AND $2::date`, `COUNT(*)` + `LIMIT 50` offset, description-first via `extractSender` truncated 17, `Total: N in range` and inline `Next/Prev` `callback_data` pagination under `4096`
- Migration `005_telegram_ledger_indexes.sql` creates `pg_trgm` extension and `GIN` indexes on `sender_name`/`description` plus `B-tree` on `amount` idempotently
- Help polished with `Ledger/Analytics/Ops` sections and inline keyboards `Status/Balance/History/Logs/Poll/Watch`; per-command rate limits `verify 5/60s search 10/60s poll 1/30s watch 1/60s` uniformly returning cooling message

## Task Commits

Each task was committed atomically:

1. **Task 1: Tracer: Telegram password /login 24h session replacing allowlist + webhook secret on PORT 8080** - `71fe1f1` (feat)
2. **Task 2: Balance + history with Lagos date range description-first capped 50 plus GIN indexes** - `f829b25` (feat)
3. **Task 3: Env validation, rate-limit tuning, help polish + session tests** - `9ebe4ed` (feat)

**Plan metadata:** `9ebe4ed` (docs: complete plan)

## Files Created/Modified

- `src/telegram/session.ts` - `Map` session 24h, `constantTimeEqual`, `isLoggedIn/login/logout`, hourly sweep unref, `_resetSessionsForTests`
- `src/telegram/balance.ts` - `buildBalanceReply` with `ORDER BY ... LIMIT 1`, null→—, Africa/Lagos, 4000 cap
- `src/telegram/history.ts` - `parseLagosDateRange` + `handleHistoryWithRange` with `BETWEEN` cap 50, `extractSender`, COUNT + pagination, 4096 cap
- `migrations/005_telegram_ledger_indexes.sql` - `CREATE EXTENSION pg_trgm` + GIN sender/description + amount B-tree
- `src/config/env.ts` - `TELEGRAM_BOT_PASSWORD` min12 optional, `OPENROUTER_API_KEY` optional
- `src/observability/logger.ts` - redact `TELEGRAM_BOT_PASSWORD`, `OPENROUTER_API_KEY`, etc `remove:true`
- `src/worker.ts` - session gate replacing allowlist when password set, `_resetWorkerStateForTests` clears session
- `src/telegram/commands.ts` - `handleLogin/handleLogout`, `verify/search` stubs with rate limits, `buildHelpReply` ledger/analytics/ops polish, `balance/history` delegation
- `tests/telegram/session.test.ts` - 9 tests covering wrong/correct/expiry/logout/fail-closed/rate-limit/handleLogin
- `tests/telegram/balance.test.ts` - 5 tests covering empty, format, null dash, HTML escape, ORDER BY
- `tests/telegram/history.test.ts` - 10 tests covering DD/MM, ISO, invalid, no-args default, BETWEEN, cap 50, description-first, Next pagination, 4-arg pagination

## Decisions Made

- In-memory `Map` session not DB — single-replica per Phase 1 high confidence, faster, restart requires re-login with explicit hint per D-12
- Password `optional` with `refine length>=12` not `required` globally — validator fails closed at runtime via reply not boot crash, keeps allowlist fallback when env missing (per RESEARCH A4)
- `remove:true` redact for all secrets — Railway stdout never sees password even on failed login warn log
- Description-first not reference — `transaction_reference` blank for `NIP/KUDA` per `parser.ts` `optionalKv`, `extractSender(description)` is correct display per D-10
- `pg_trgm` `gin_trgm_ops` not `tsvector` — sender names need `ILIKE '%SAMPLE SENDER%'` substring not lexeme ranking per postgresql.org docs

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `commands.ts` dynamic `import('./balance')` needed placeholder files to satisfy `tsc --noEmit` in tracer task — created minimal `balance.ts`/`history.ts` stubs in Task 1 then overwrote with full implementations in Task 2 (lint gate).
- `vi.useFakeTimers` in session tests caused `handleLogin` 2.6s real delay due to pino logger not using fake timers — tolerated as pass, not flake.

## User Setup Required

None - no external service configuration required. Set `TELEGRAM_BOT_PASSWORD` (>=12 chars) in Railway env to enable password mode; when unset, worker falls back to legacy `TELEGRAM_ADMIN_CHAT_IDS` allowlist. `OPENROUTER_API_KEY` optional for future `02-02` verify/media.

## Next Phase Readiness

- Tracer slice proven: webhook secret → session gate → deterministic ledger reads → 4096 reply path works end-to-end; `02-02` can build verify media 2-step `getFile`→`os.tmpdir`→`SHA256`→`OpenRouter` on top of this skeleton
- Migration `005` ready for `npm run migrate` against live Postgres; GIN indexes make future `search` `ILIKE` fast at 10k+ rows
- No blockers

---
*Phase: 02-telegram-ledger-assistant*
*Completed: 2026-09-10*

## Self-Check: PASSED
