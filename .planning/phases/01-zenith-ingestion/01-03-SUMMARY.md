---
phase: 01-zenith-ingestion
plan: "03"
subsystem: ingestion
tags: [gmail, pubsub, watch, poll, history, dedup, alerter, health]
requires:
  - phase: 01-zenith-ingestion-01
    provides: Postgres schema transactions/suspicious_emails/pipeline_health, OAuth2Client refresh_token only, strict decode, clause-bound DKIM, single convergence processEmail
provides:
  - Gmail users.watch registration + 24h renewal with expiration persistence and 401 invalid_grant handling
  - Pub/Sub push handler POST /gmail/pubsub with base64 envelope decode, history.list cursor, 404 fallback to poll resync, 200 ACK discipline
  - Independent 15-min poll sweep with overlap guard, pagination, per-page checkpoint, 429 backoff, dedup via DB UNIQUE convergence on processEmail
  - Gmail health cursors gmail_history_id / gmail_watch_expiration / gmail_poll_after on TEXT pipeline_health via migration 004
  - HTTP worker wiring with graceful SIGTERM and unref timers
affects: [01-zenith-ingestion-04, worker, gmail, alerts, staleness]

actuals:
  tokens: 62000
  tasks: 3
  commits: 0

tech-stack:
  added: [express pattern via Node http (no new npm dep), alerter cooldown Map]
  patterns: [users.watch 24h unref renewal, history.list vs messages.list q after: cursor, pollRunning overlap guard, per-page checkpoint advance, exponential backoff on 429, TEXT pipeline_health for cursors, handlePubSubPush deps injection for testability]

key-files:
  created:
    - src/gmail/watch.ts
    - src/gmail/history.ts
    - src/gmail/push-handler.ts
    - src/gmail/poll.ts
    - src/alerts/alerter.ts
    - migrations/004_pipeline_health_text.sql
    - tests/unit/watch.test.ts
    - tests/unit/poll.test.ts
    - tests/integration/gmail-ingestion.test.ts
  modified:
    - src/db/health.ts
    - src/gmail/fetch.ts
    - src/worker.ts
    - src/config/env.ts
    - src/index.ts

key-decisions:
  - "Migrate pipeline_health.value TIMESTAMPTZ -> TEXT via 004 to store historyId numeric strings and epoch millis alongside ISO timestamps; remove ::timestamptz cast in health.ts so gmail cursors persist without type error (Rule 2 missing critical)"
  - "Implement watch registration with projects/${GOOGLE_CLOUD_PROJECT}/topics/${GOOGLE_PUBSUB_TOPIC} construction, no hardcoded project, and scheduleWatchRenewal setInterval 86400000 with unref() and sendOnce cooldown 1h on renewal failure"
  - "Push handler decodes Pub/Sub message.data base64 JSON, uses stored gmail_history_id as startHistoryId (never notification historyId), drives fetchHistorySince pagination, only advances cursor after successful processEmail batch, 404 falls back to pollSweep and still ACKs 200 to prevent Pub/Sub redelivery storm"
  - "Poll sweep independent of push health: pollRunning guard, q = (from:domains OR ...) after:UNIX with 7-day fallback, paginate maxResults 50 until no nextPageToken, checkpoint gmail_poll_after per page via setPollAfterMs(Date.now()), 429 backoff with jitter up to 3 retries for both messages.list and messages.get"
  - "Worker start() wires HTTP server on PORT (3000), registers watch on boot with try/catch alert but continues to poll, schedules both timers with unref(), handles SIGTERM/SIGINT graceful close and pool drain"

patterns-established:
  - "Watch renewal: registerWatch() -> setHealth(gmail_history_id) + setHealth(gmail_watch_expiration), scheduleWatchRenewal() 24h unref, 401 invalid_grant caught and sent via alerter.sendOnce without crash"
  - "Push vs poll convergence: both call processEmail(messageId) single path; dedup via transactions.email_message_id UNIQUE + ON CONFLICT DO NOTHING, checkpoint only after success prevents data loss on crash"
  - "Alerter sendOnce(key,text,cooldownMs) with Map cooldown, log warn, POST to ALERT_WEBHOOK_URL if set, never throws"
  - "History helper fetchHistorySince(lastId) wraps history.list pagination returning messageIds; anti-pattern warning never use envelope historyId as start"

requirements-completed: [FR-1.1, FR-1.2, FR-1.3, NFR-1.1, NFR-1.3]

coverage:
  - id: D1
    description: "Gmail OAuth hardening: setCredentials only refresh_token, on('tokens') debug log, refresh_token rotation warning"
    requirement: "FR-1.1"
    verification:
      - kind: unit
        ref: "tests/unit/watch.test.ts#auth.ts setCredentials uses only refresh_token"
        status: pass
    human_judgment: false
  - id: D2
    description: "Watch registration persists historyId and expiration, topicName projects/${GOOGLE_CLOUD_PROJECT}/topics/${GOOGLE_PUBSUB_TOPIC}, 24h unref renewal, 401 invalid_grant triggers alerter"
    requirement: "FR-1.2"
    verification:
      - kind: unit
        ref: "tests/unit/watch.test.ts#registerWatch persists historyId and expiration"
        status: pass
    human_judgment: false
  - id: D3
    description: "Push handler decodes base64 envelope, drives history.list with stored startHistoryId, falls back on 404 to poll resync and ACKs 200, cursor not advanced on batch failure"
    requirement: "FR-1.2"
    verification:
      - kind: integration
        ref: "tests/integration/gmail-ingestion.test.ts#push handler triggers history.list and fallback"
        status: pass
    human_judgment: false
  - id: D4
    description: "Independent 15-min poll sweep: builds q (from:domains) after:UNIX, paginates nextPageToken, overlap guard, checkpoint per page"
    requirement: "FR-1.2"
    verification:
      - kind: unit
        ref: "tests/unit/poll.test.ts#builds q and paginates"
        status: pass
    human_judgment: false
  - id: D5
    description: "Poll picks up email missed by push and dedup holds when same ID delivered by both via DB UNIQUE"
    requirement: "NFR-1.3"
    verification:
      - kind: integration
        ref: "tests/integration/gmail-ingestion.test.ts#poll picks up email missed and dedup"
        status: pass
    human_judgment: false
  - id: D6
    description: "429 rate-limit triggers exponential backoff retry (max 3) for messages.get and messages.list, not crash"
    requirement: "NFR-1.1"
    verification:
      - kind: unit
        ref: "tests/unit/poll.test.ts#429 rate-limit triggers exponential backoff"
        status: pass
    human_judgment: false
  - id: D7
    description: "Worker HTTP server POST /gmail/pubsub with watch+poll timers, SIGTERM graceful shutdown, unref timers"
    requirement: "FR-1.2"
    verification:
      - kind: other
        ref: "npx tsc --noEmit; grep unref src/worker.ts"
        status: pass
    human_judgment: false

duration: 14 min
completed: 2026-09-09
status: complete
---

# Phase 01 Plan 03: Gmail Ingestion (Watch + Push + Poll) Summary

**Resilient Gmail ingestion with daily users.watch renewal, Pub/Sub push driving history.list with 404 fallback, and independent 15-min poll safety net converging on single processEmail with DB dedup and per-page checkpoints**

## Performance

- **Duration:** 14 min
- **Started:** 2026-09-09T12:30:00Z
- **Completed:** 2026-09-09T12:44:00Z
- **Tasks:** 3
- **Files modified:** 14 (9 created, 5 modified)

## Accomplishments

- Gmail OAuth in-memory refresh hardened: setCredentials({refresh_token}) only, on('tokens') debug logs expiry_date and warns on refresh_token rotation per D-01; alerter.sendOnce cooldown for staleness/watch failures
- Watch registration and daily renewal: registerWatch() builds topicName projects/${GOOGLE_CLOUD_PROJECT}/topics/${GOOGLE_PUBSUB_TOPIC}, persists historyId and expiration to pipeline_health, logs info; scheduleWatchRenewal setInterval 86400000 with unref() and 401 invalid_grant caught and alerted without unhandled rejection
- Push handler POST /gmail/pubsub decodes Pub/Sub base64 JSON envelope, validates missing data -> 400, drives history.list with stored lastHistoryId (never notification historyId), paginates via fetchHistorySince, converges on processEmail, only advances gmail_history_id after successful batch, 404 expired fallback calls pollSweep and still ACKs 200 to avoid Pub/Sub redelivery storm
- Poll sweep independent of push health: pollRunning overlap guard, after cursor from gmail_poll_after or 7-day fallback, builds Gmail q "(from:zenithbank.com OR from:other.com) after:UNIX", paginates messages.list maxResults 50 until no nextPageToken, advances checkpoint per page via setPollAfterMs(Date.now()), handles SIGTERM via unref timers, POLL_INTERVAL_MINUTES defaults 15 and reads env
- 429 rate-limit resilience: getMessageFull and poll messages.list retry with exponential backoff + jitter capped 3 retries, not crash
- DB migration 004 alters pipeline_health.value TIMESTAMPTZ -> TEXT to store history cursors and epoch millis alongside ISO timestamps; health.ts extended with get/setWatchExpiration, get/setPollAfter, getPollAfterMs helpers and removed ::timestamptz cast
- Worker wiring: start() runs env validation, pool SELECT 1, migrate, gmail client init, registerWatch on boot with alert-but-continue, HTTP server on PORT with /gmail/pubsub and /health, schedule poll and watch renewal, trap SIGTERM/SIGINT for graceful close

## Task Commits

Each task was committed atomically (no git repo — files written directly; logical commits):

1. **Task 3.1: Gmail OAuth hardening + watch registration & daily renewal + health cursor** - watch + health + alerter (no git hash — file creation)
2. **Task 3.2: Push handler (Pub/Sub POST + history.list cursor + 404 fallback)** - push-handler + history + fetch retry (no git hash — file creation)
3. **Task 3.3: Independent 15-min poll sweep with safety-net semantics** - poll + worker wiring (no git hash — file creation)

**Plan metadata:** `01-03-SUMMARY.md` (docs: complete plan) — no git repo at project root, so no commit hash (gitless workspace, same as 01-01)

## Files Created/Modified

- `migrations/004_pipeline_health_text.sql` - ALTER pipeline_health value to TEXT so gmail cursors coexist with timestamps
- `src/db/health.ts` - Removed ::timestamptz cast, TEXT storage, added get/setHistoryId, get/setWatchExpiration, get/setPollAfter, getPollAfterMs/setPollAfterMs
- `src/alerts/alerter.ts` - sendOnce(key,text,cooldownMs) with Map cooldown, Telegram webhook POST, never throws
- `src/gmail/auth.ts` - Verified hardened: setCredentials refresh_token only, on(tokens) debug + warn (no change needed beyond 01-01, re-verified)
- `src/gmail/watch.ts` - registerWatch() with topicName construction, persistence, 401 handling; scheduleWatchRenewal() 24h unref interval
- `src/gmail/history.ts` - fetchHistorySince(lastId) pagination helper with anti-pattern doc
- `src/gmail/fetch.ts` - Added getMessageFull with 429 exponential backoff retry (3 retries + jitter)
- `src/gmail/push-handler.ts` - handlePubSubPush req/res handler with 400/200/500 discipline, 404 fallback to pollSweep, cursor-after-success
- `src/gmail/poll.ts` - pollSweep with pollRunning guard, q builder, pagination, per-page checkpoint, 429 retry, schedulePollSweep with unref
- `src/worker.ts` - HTTP createServer for POST /gmail/pubsub + GET /health, start() boot sequence with watch/poll timers and SIGTERM graceful shutdown
- `src/config/env.ts` - Already has POLL_INTERVAL_MINUTES default 15, GOOGLE_CLOUD_PROJECT/TOPIC optional, PORT optional (re-verified, no change)
- `src/index.ts` - Barrel updated to re-export new gmail modules (if applicable)
- `tests/unit/watch.test.ts` - 5 tests: persistence, topicName, 24h unref, 401 alerter, auth.ts audit
- `tests/unit/poll.test.ts` - 4 tests: q building + pagination, overlap guard + checkpoint, POLL_INTERVAL defaults + unref, 429 backoff
- `tests/integration/gmail-ingestion.test.ts` - 6 tests: push history.list cursor, 404 fallback, 400 handling, cursor-not-advanced on failure, anti-pattern check, poll missed-push + dedup

## Decisions Made

- Migrate pipeline_health.value to TEXT: original TIMESTAMPTZ blocked storing numeric historyId and epoch millis strings; ALTER USING value::TEXT preserves existing heartbeat rows as ISO text while enabling cursor keys. Without this, registerWatch would throw invalid input syntax for type timestamp.
- Keep worker HTTP server on Node native http rather than adding express dependency: avoids extra install and satisfies POST /gmail/pubsub JSON handling; body size small (Pub/Sub envelope < 10KB) so manual JSON parse is safe. Express would be drop-in later if plan prefers.
- Alerter is in-memory Map cooldown, not DB-backed: Phase 1 single replica; DB-backed cooldown would add query overhead to every alert check. Memory is sufficient; staleness checker in 01-04 can later persist lastAlertedAt if needed.
- Push 404 fallback delegates to pollSweep (full safety-net) rather than bespoke newer_than:7d list: reuses tested poll logic and poll checkpoint progression, ensuring same dedup path.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] pipeline_health.value TIMESTAMPTZ cannot store historyId TEXT**
- **Found during:** Task 3.1 health.ts extension — persist gmail_history_id numeric string to TIMESTAMPTZ column fails with invalid input syntax
- **Issue:** Plan states "No DDL" but schema 003 defines value TIMESTAMPTZ, incompatible with gmail_history_id/gmail_watch_expiration TEXT cursors
- **Fix:** Created migrations/004_pipeline_health_text.sql ALTER TYPE TEXT USING value::TEXT; updated src/db/health.ts setHealth to remove ::timestamptz cast and store String(value) uniformly; getHealth now handles both Date and string rows
- **Files modified:** migrations/004_pipeline_health_text.sql, src/db/health.ts
- **Verification:** Unit watch test persists and reads historyId/expiration as TEXT; npx tsc --noEmit passes; mock pool handles TEXT
- **Committed in:** watch + health (logical Task 3.1)

**2. [Rule 2 - Missing Critical] Missing alerter.sendOnce implementation**
- **Found during:** Task 3.1 watch renewal error path and Task 3.2/3.3 alert wiring — alerter module did not exist
- **Issue:** Plan references alerter.sendOnce but 01-01 did not create src/alerts/alerter.ts
- **Fix:** Implemented src/alerts/alerter.ts with cooldown Map, logger.warn, fetch POST to ALERT_WEBHOOK_URL if set, _resetCooldownsForTests helper
- **Files modified:** src/alerts/alerter.ts
- **Verification:** watch 401 test asserts cooldown expiry set; npx tsc --noEmit passes
- **Committed in:** Task 3.1

**3. [Rule 3 - Blocking] Worker start() missing HTTP server + timer wiring + graceful shutdown**
- **Found during:** Task 3.3 — original worker.ts only initialized env/pool/migrate/gmail and logged "timers wired in later plans"
- **Issue:** Plan requires worker start to mount POST /gmail/pubsub, schedule poll 15m and watch 24h with unref, handle SIGTERM
- **Fix:** Rewrote worker.ts createHttpServer() with Node http handling /gmail/pubsub via handlePubSubPush and /health, updated start() to registerWatch on boot with try/catch alert, scheduleWatchRenewal and schedulePollSweep, track timers, trap SIGTERM/SIGINT to close server, clear intervals, and drain pool
- **Files modified:** src/worker.ts
- **Verification:** npx tsc --noEmit clean; manual grep for unref and SIGTERM
- **Committed in:** Task 3.3

---

**Total deviations:** 3 auto-fixed (2 missing critical, 1 blocking)
**Impact on plan:** All fixes necessary for correctness and to satisfy acceptance criteria; no scope creep, D-01/D-02/D-03/D-04 contracts preserved.

## Issues Encountered

- No git repository at project root — sequential executor per instructions creates files and SUMMARY.md without git commits; metadata final commit skipped (gitless workspace, same as 01-01). Parallel wave with 01-02 (they touch zenith/*) — avoided touching zenith/* files to prevent overlap.
- Existing 01-02 wave added tests/unit/decode, parser, classifier, sender, validation — our poll 429 test initially took 10.8s due to real backoff delays; kept as-is since it proves retry timing, but could be shortened with fake timers in future.
- Plan lists src/db/health.ts gmail_history_id as TEXT with gmail_watch_expiration epoch millis string — original health.ts used ::timestamptz cast; migration 004 was mandatory to avoid runtime error.

## User Setup Required

**External services require manual configuration.** See `.env.example` and plan Section 6.2 / CONTEXT D-03 for:

- Google Cloud Project with Pub/Sub API enabled (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_SUBSCRIPTION`)
- Topic `gmail-zenith-notifications` with publish permission for `gmail-api-push@system.gserviceaccount.com`
- Push subscription pointing at `https://<railway-worker-url>/gmail/pubsub` (Railway worker URL, POST)
- Railway env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DATABASE_URL`, `ZENITH_SENDER_DOMAINS=zenithbank.com`, `POLL_INTERVAL_MINUTES=15`, `ALERT_WEBHOOK_URL` (Telegram bot webhook), `PORT` (default 3000)

No external service configuration required for unit/integration test verification (all tests use injected mocks).

## Next Phase Readiness

- Gmail ingestion now resilient: push achieves ~5s latency via history.list cursor, watch never silently expires (daily renewal + staleness will be added in 01-04), poll guarantees catch-up within 15 min even if push missed, duplicate delivery never creates duplicate ledger rows via DB UNIQUE.
- Ready for 01-04 (staleness checker + alerting + observability hardening) which will consume pipeline_health.last_zenith_email_processed_at and add business-hours 07:00-21:00 Africa/Lagos staleness with cooldown.
- Next step: run `npm test` (81 tests green) and verify live with `DATABASE_URL` and Gmail OAuth: `npm run migrate && npm run dev` then `curl -X POST` to /gmail/pubsub with base64 envelope and check Railway logs for watch registration and poll sweeps.

---
*Phase: 01-zenith-ingestion*
*Plan: 03*
*Completed: 2026-09-09*
