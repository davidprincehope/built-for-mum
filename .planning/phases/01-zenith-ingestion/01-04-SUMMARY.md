---
phase: 01-zenith-ingestion
plan: "04"
subsystem: observability
tags: [staleness, alerter, telegram, heartbeat, pino, resilience, monitoring]

requires:
  - phase: 01-zenith-ingestion-01
    provides: Postgres heartbeat pipeline_health.last_zenith_email_processed_at, pino JSON logger, atomic insertTransactionAtomically
  - phase: 01-zenith-ingestion-02
    provides: Zenith parser/validation/sender credit-only, suspicious storage
  - phase: 01-zenith-ingestion-03
    provides: Gmail watch/poll/push ingestion, alerter stub, TEXT pipeline_health

provides:
  - Heartbeat atomically bound to transactions COMMIT only (never on suspicious/validation_failed/duplicate)
  - Africa/Lagos 07:00-21:00 staleness checker 60s pinned with once-per-window cooldown and never_seeded/outside_hours semantics
  - Telegram-first alerter sendOnce with in-memory cooldown Map, generic fallback, distinct Possible spoof vs Zenith format drift vs Pipeline stale prefixes
  - Worker wiring: staleness + poll + watch timers with unref, HTTP server for Pub/Sub, graceful SIGTERM/SIGINT draining, pino child(email_message_id) at every stage, 429 retry on Gmail and 100ms retry on Postgres connect
  - Integration suites proving T-6.x monitoring, T-5.x resilience, T-4.x/T-3.x security

affects: [worker, observability, alerts, gmail, db, phase-02-whatsapp, matching]

actuals:
  tokens: 62000
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns: [pg pool connect retry 100ms for insert path, date-fns-tz formatInTimeZone HH:mm business hours, sendOnce keyed cooldown with Telegram chat_id fallback, pino child stage logging, unref timers + SIGTERM draining, getMessageFull 429 exponential backoff]

key-files:
  created:
    - .planning/phases/01-zenith-ingestion/STALENESS.md
    - src/observability/staleness.ts
    - tests/unit/staleness.test.ts
    - tests/unit/alerter.test.ts
    - tests/integration/monitoring.test.ts
    - tests/integration/resilience.test.ts
  modified:
    - src/db/transactions.ts
    - src/db/health.ts
    - src/alerts/alerter.ts
    - src/config/env.ts
    - src/worker.ts
    - src/gmail/fetch.ts

key-decisions:
  - "D-16 pinned: STALENESS_THRESHOLD 60m, window 07:00-21:00 Africa/Lagos every day no weekend suppression, 60s setInterval with isRunning guard and local lastStalenessFiredAt + alerter.sendOnce 60m cooldown for transition-only firing"
  - "Alerter D-15 Telegram primary via ALERT_WEBHOOK_URL (api.telegram.org) with chat_id, parse_mode HTML, fallback to ALERT_FALLBACK_WEBHOOK_URL on throw/non-2xx, host redacted in logs, env-driven per NFR-1.6"
  - "Heartbeat honesty: only INSERT INTO pipeline_health on COMMIT inside transactions TX; duplicate ON CONFLICT ROLLBACK and suspicious/validation_failed never touch heartbeat so staleness is truthful (T-04-02 mitigation)"
  - "Worker lifecycle: HTTP server + registerWatch boot + scheduleWatchRenewal 24h + schedulePollSweep 15m + startStalenessChecker 60s all unref; SIGTERM drains staleness/poll/watch timers, closes httpServer, drains pg pool"

patterns-established:
  - "Staleness: checkStaleness() returns ok|stale|outside_hours|never_seeded; startStalenessChecker(60_000) immediate tick + interval unref; isBusinessHours uses formatInTimeZone Africa/Lagos HH:mm inclusive"
  - "Alerter: sendOnce(key,text,cooldownMs) Map dedup, suspicious 0ms, parseFailure 5m per messageId, staleness 60m; prefixes Possible spoof vs Zenith format drift for on-call triage"
  - "Resilience: insertTransactionAtomically retries pool.connect 2x 100ms; getMessageFull retries 429 3x exponential backoff; kill-mid-batch idempotent via UNIQUE"

requirements-completed: [FR-1.9, FR-1.10, FR-1.11, FR-1.12, NFR-1.1, NFR-1.2, NFR-1.4, NFR-1.5, NFR-1.6]

coverage:
  - id: D1
    description: "Heartbeat atomicity — insertTransactionAtomically COMMIT only, duplicate ROLLBACK leaves pipeline_health unchanged, suspicious/validation_failed never advance heartbeat"
    requirement: "FR-1.11"
    verification:
      - kind: unit
        ref: "tests/unit/staleness.test.ts#insertTransactionAtomically duplicate does NOT update heartbeat"
        status: pass
    human_judgment: false
  - id: D2
    description: "Staleness 90m during 10:00 Africa/Lagos fires stale once per 60m cooldown, 22:00 returns outside_hours without alert, never_seeded returns without alert, isBusinessHours WAT mapping"
    requirement: "FR-1.10"
    verification:
      - kind: unit
        ref: "tests/unit/staleness.test.ts#checkStaleness 90m/ outside_hours/ never_seeded/ isBusinessHours WAT"
        status: pass
    human_judgment: false
  - id: D3
    description: "Telegram-first alerter sendOnce dedup within cooldown, Telegram POST with chat_id+text+email_message_id, fallback on throw/500, distinct Possible spoof vs Zenith format drift prefixes"
    requirement: "FR-1.10"
    verification:
      - kind: unit
        ref: "tests/unit/alerter.test.ts#cooldown, Telegram primary, fallback, distinct prefixes, no console.log"
        status: pass
    human_judgment: false
  - id: D4
    description: "Monitoring T-6.x: staleness once until new credit resets to ok, Zenith verified but unparsable alerts drift distinct, spoof alerts spoof distinct with suspicious_emails row"
    requirement: "FR-1.10"
    verification:
      - kind: integration
        ref: "tests/integration/monitoring.test.ts#T-6.1/6.2/6.3/6.4 + D-14 log correlation"
        status: pass
    human_judgment: false
  - id: D5
    description: "Resilience T-5.1 kill-mid-batch idempotent 5→5, T-5.2 Postgres connect retry, T-5.3 Gmail 429 backoff, plus T-3.1 typosquat, T-3.4 dup refs, T-4.1/4.2/4.3 spoof blocking"
    requirement: "NFR-1.1"
    verification:
      - kind: integration
        ref: "tests/integration/resilience.test.ts#T-5.1/5.2/5.3/T-3.1/T-3.4/T-4.1/4.2/4.3 + D-14"
        status: pass
    human_judgment: false
  - id: D6
    description: "Worker wiring — staleness 60s + poll 15m + watch 24h with unref, HTTP Pub/Sub + /health, SIGTERM draining, pino JSON stage logging with email_message_id per D-14"
    requirement: "FR-1.12"
    verification:
      - kind: other
        ref: "npx tsc --noEmit; grep unref src/worker.ts; npm test 134/134"
        status: pass
    human_judgment: false

duration: 18 min
completed: 2026-09-09
status: complete
---

# Phase 01 Plan 04: Monitoring, Staleness & Alerting Summary

**Heartbeat atomically bound to committed credits only, Africa/Lagos 07:00-21:00 staleness pinned 60s with once-per-window cooldown, Telegram-first alerter with fallback and distinct spoof vs drift prefixes, worker draining and full monitoring/resilience proof**

## Performance

- **Duration:** 18 min
- **Started:** 2026-09-09T13:17:57+01:00
- **Completed:** 2026-09-09T13:35:33+01:00
- **Tasks:** 3
- **Files modified:** 11 (6 created, 5 modified)

## Accomplishments

- Hardened `insertTransactionAtomically` to single `pool.connect()` TX with `BEGIN` → `INSERT ... ON CONFLICT DO NOTHING RETURNING id` → `rowCount 0 → ROLLBACK duplicate` else `INSERT pipeline_health now()` → `COMMIT`; duplicate/suspicious/validation_failed never advance heartbeat; added `pool.connect` retry 2× 100ms for Postgres unavailable per T-5.2
- Implemented `src/observability/staleness.ts` with `isBusinessHours` via `date-fns-tz` WAT `HH:mm`, `checkStaleness` reading `last_zenith_email_processed_at`, `never_seeded`/`outside_hours`/`ok`/`stale` with 60m threshold and local `lastStalenessFiredAt` + `alerter.sendOnce 60m` double guard, `startStalenessChecker(60_000)` pinned with `isRunning` guard and `unref`, `stopStalenessChecker` for shutdown
- Documented `STALENESS.md` one-pager: window semantics, threshold/cooldown, trail `COMMIT → pipeline_health → isBusinessHours → sendOnce`, heartbeat honesty, env overrides, on-call actions
- Built `src/alerts/alerter.ts` Telegram-first with `sendOnce` Map cooldown, `redactedHost` never logs token, `GET` webhook via `fetch` POST `{chat_id,text,parse_mode}` for `api.telegram.org` else generic `{text,key}`, fallback to `ALERT_FALLBACK_WEBHOOK_URL` on throw/non-2xx, convenience `suspicious` (Possible spoof, 0ms), `parseFailure` (Zenith format drift, 5m per messageId), `staleness` (60m) all embedding `email_message_id`
- Wired `src/worker.ts` single call site: `processEmail` now calls `alerter.suspicious` on DKIM fail and `alerter.parseFailure` on decode/ParseFailure/validation fail, emits `createChildLogger({email_message_id})` + `stage: received|auth|parse|validation|dedup|insert` JSON to Railway stdout per D-14/FR-1.12, uses `getMessageFull` for 429 retry, `start()` now mounts HTTP `/gmail/pubsub` + `/health`, `registerWatch` boot with alert-but-continue, `scheduleWatchRenewal` 24h, `schedulePollSweep` 15m, `startStalenessChecker` 60s, all `unref`, `SIGTERM/SIGINT` drains timers/http/pool
- Green suite: staleness 7, alerter 5, monitoring 5, resilience 7 plus existing 110 → **134 tests passing**, `npx tsc --noEmit` clean, full `npm test` 15 files green

## Task Commits

Each task was committed atomically:

1. **Task 4.1: Heartbeat atomicity hardening + staleness checker with business-hours window** - `69d66fa` (feat)
2. **Task 4.2: Telegram-first alerter with email fallback + three-trigger wiring** - `3706904` (feat)
3. **Task 4.3: Monitoring, resilience, and security integration tests** - `3b02707` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified

- `.planning/phases/01-zenith-ingestion/STALENESS.md` - On-call one-pager threshold/window/cooldown/trail/env
- `src/observability/staleness.ts` - `isBusinessHours`, `checkStaleness` with 60m/WAT/cooldown/never_seeded, `startStalenessChecker` 60s pinned unref
- `src/db/transactions.ts` - Atomic TX + duplicate ROLLBACK + heartbeat only on COMMIT + pg connect 2×100ms retry
- `src/db/health.ts` - `getLastProcessedAt`/`setLastProcessedAt` TEXT/ISO handling (re-verified)
- `src/alerts/alerter.ts` - `sendOnce` cooldown, Telegram primary with chat_id, fallback, redacted logging, `suspicious`/`parseFailure`/`staleness` with distinct prefixes
- `src/config/env.ts` - Added `ALERT_FALLBACK_WEBHOOK_URL`, `TELEGRAM_CHAT_ID`, `ALERT_CHAT_ID`
- `src/worker.ts` - Alerter + staleness + poll + watch wiring, stage logging, 429 retry, graceful shutdown
- `src/gmail/fetch.ts` - `getMessageFull` 429 exponential backoff used by `processEmail`
- `tests/unit/staleness.test.ts` - 7 tests: WAT mapping, stale once/cooldown, outside_hours, never_seeded, ok, checker unref, heartbeat duplicate
- `tests/unit/alerter.test.ts` - 5 tests: cooldown, Telegram chat_id+email_message_id, fallback, distinct prefixes, no console.log
- `tests/integration/monitoring.test.ts` - 5 tests: T-6.1 once, T-6.2 reset, T-6.3 drift distinct, T-6.4 spoof distinct, D-14 correlation
- `tests/integration/resilience.test.ts` - 7 tests: T-5.1 kill-mid-batch, T-5.2 PG retry, T-5.3 429, T-3.1 typosquat, T-3.4 dup refs, T-4 trio spoof, D-14

## Decisions Made

- Retries are scoped: Postgres connect 2× 100ms only on insert path (not infinite), Gmail messages.get 429 3× exponential backoff with jitter via `getMessageFull`; poll list path already had its own 429 wrapper — avoids quota burn while ensuring no silent drop
- Staleness `lastStalenessFiredAt` in-memory is sufficient for single-replica Phase 1; DB-backed `lastAlertedAt` deferred to multi-replica scaling per pitfall 7; local guard plus alerter Map gives double dedup without extra query
- Alerter is stateless env-driven per NFR-1.6; `createAlerter` factory kept for DI compatibility but no instance state — global Map preserves cooldown across imports

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Worker 404 fallback and pool heartbeat Text handling**
- **Found during:** Task 4.1/4.3 verification — `fetchMessage` without 429 retry caused T-5.3 to throw, and `pipeline_health` TEXT vs TIMESTAMPTZ already migrated in 01-03 required health.ts String handling
- **Issue:** `processEmail` used `fetchMessage` directly (no retry) so Gmail 429 test failed; prior migration 004 already fixed health but worker still imported old `fetchMessage`
- **Fix:** Switched `processEmail` to `getMessageFull` with retry, added `insertTransactionAtomically` connect retry, kept health TEXT handling; updated `tests/unit/staleness.test.ts` fake-timer isolation for duplicate-heartbeat case
- **Files modified:** `src/worker.ts`, `src/db/transactions.ts`, `tests/unit/staleness.test.ts`, `tests/integration/resilience.test.ts`
- **Verification:** `npx tsc --noEmit` clean, `npm test` 134/134 green including T-5.3 1.5s backoff
- **Committed in:** `3b02707`

**2. [Rule 2 - Missing Critical] Alerter fallback env and redacted logging**
- **Found during:** Task 4.2 acceptance — plan required `ALERT_FALLBACK_WEBHOOK_URL` and token-safe logging per T-04-04
- **Issue:** Original `src/alerts/alerter.ts` (01-03 stub) lacked fallback, chat_id handling, and redacted host; `src/config/env.ts` lacked new vars
- **Fix:** Added `ALERT_FALLBACK_WEBHOOK_URL`, `TELEGRAM_CHAT_ID`, `ALERT_CHAT_ID` to env schema, implemented `redactedHost`, `isTelegramUrl`, `sendToWebhook` with fallback branch, never logs full URL
- **Files modified:** `src/alerts/alerter.ts`, `src/config/env.ts`
- **Verification:** `tests/unit/alerter.test.ts` fallback throw/500 path passes, grep for `console.log` zero
- **Committed in:** `3706904`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical)
**Impact on plan:** Both essential for FR-1.10/NFR-1.1 correctness and T-04-04 disclosure mitigation; no scope creep, no new deps.

## Issues Encountered

- Intermediate commit `69d66fa` included worker alerter imports before alerter exports existed, but was corrected by next commit `3706904` adding full alerter — final HEAD is consistent and green; history reflects wave sequencing not broken deliverable
- Host Node 24.14.0 vs Railway 20-slim engines `>=20` already satisfied from 01-01, no change

## User Setup Required

**External services require manual configuration.** See `STALENESS.md` and `.env.example` for:

- `ALERT_WEBHOOK_URL` → Telegram bot `https://api.telegram.org/bot{token}/sendMessage`
- `TELEGRAM_CHAT_ID` / `ALERT_CHAT_ID` → destination chat
- `ALERT_FALLBACK_WEBHOOK_URL` → secondary webhook/email for fallback when Telegram fails
- `STALENESS_THRESHOLD_MINUTES=60`, `BUSINESS_HOURS_TIMEZONE=Africa/Lagos`, `BUSINESS_HOURS_START=07:00`, `BUSINESS_HOURS_END=21:00`
- `GOOGLE_CLOUD_PROJECT`, `GOOGLE_PUBSUB_TOPIC`, `PORT` already documented in 01-03

No external service needed for unit/integration tests (all use injected mocks and `example.com` webhook).

## Next Phase Readiness

- Ledger trust is now closed loop: heartbeat bound to COMMIT only, staleness 60s pinned 07:00-21:00 WAT once-per-window, Telegram primary with fallback and distinct triage prefixes, every stage JSON-correlated via `email_message_id`, resilience proven (kill-mid-batch, PG retry, 429 backoff, missed push via poll already in 01-03)
- Exit criteria 4/5/6 satisfied: parse failures alert distinctly, staleness during business hours fires exactly once, full Section 10 T-IDs 1.x/2.x/3.x/4.x/5.x/6.x green (134 tests), ledger single source of truth with heartbeat bound
- Phase 1 complete — ready for `/gsd-verify-work 01` and then `02-whatsapp` which will consume `transactions` as source of truth

---
*Phase: 01-zenith-ingestion*
*Completed: 2026-09-09*

## Self-Check: PASSED

- Found: src/observability/staleness.ts isBusinessHours/checkStaleness/startStalenessChecker
- Found: src/alerts/alerter.ts sendOnce/suspicious/parseFailure/staleness with fallback
- Found: src/worker.ts staleness+alerter wiring + graceful shutdown + stage logging
- Found: .planning/phases/01-zenith-ingestion/STALENESS.md
- Found: tests/unit/staleness.test.ts + alerter.test.ts + integration/monitoring + resilience
- Verified: npx tsc --noEmit clean, npm test 134/134 15 files
- Verified: git log 69d66fa/3706904/3b02707 present
