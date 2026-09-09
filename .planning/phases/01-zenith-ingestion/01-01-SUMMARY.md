---
phase: 01-zenith-ingestion
plan: "01"
subsystem: ingestion
tags: [gmail, oauth, postgres, pino, cheerio, zod, railway, quoted-printable]
requires: []
provides:
  - Postgres schema transactions/suspicious_emails/pipeline_health with email_message_id UNIQUE and heartbeat KV
  - Gmail OAuth2Client refresh_token in-memory auth factory
  - Strict B64->QP->HTML decodeStrict with clause-bound DKIM verifyAuthenticity
  - Single convergence processEmail wired end-to-end (fetch -> auth -> decode -> parse -> credit-only -> validate -> atomic insert+heartbeat)
  - Pino JSON logger with email_message_id child correlation
affects: [01-zenith-ingestion-02, 01-zenith-ingestion-03, 01-zenith-ingestion-04, worker, parser]

actuals:
  tokens: 62000
  tasks: 3
  commits: 0

tech-stack:
  added: [googleapis@178.1.1, google-auth-library@11.0.2, pg@8.23.0, pino@10.3.1, cheerio@1.2.0, zod@4.5.4, quoted-printable@1.0.1, date-fns@4.4.0, date-fns-tz@3.2.0, typescript@5.6, tsx@4.7, vitest@3.1.1]
  patterns: [pg Pool ssl:{rejectUnauthorized:false} singleton, pino child(email_message_id) JSON to stdout, zod env validation at boot, ON CONFLICT DO NOTHING dedup, atomic transactions+heartbeat TX, strict base64url decode with no fallback, clause-bound DKIM verification]

key-files:
  created:
    - package.json
    - tsconfig.json
    - vitest.config.ts
    - .env.example
    - railway.json
    - Dockerfile
    - src/config/env.ts
    - src/db/pool.ts
    - src/db/migrate.ts
    - migrations/001_transactions.sql
    - migrations/002_suspicious_emails.sql
    - migrations/003_pipeline_health.sql
    - src/observability/logger.ts
    - src/gmail/auth.ts
    - src/gmail/fetch.ts
    - src/zenith/authenticity.ts
    - src/zenith/decode.ts
    - src/zenith/parser.ts
    - src/zenith/classifier.ts
    - src/zenith/validation.ts
    - src/db/transactions.ts
    - src/db/suspicious.ts
    - src/db/health.ts
    - src/worker.ts
    - src/index.ts
    - tests/fixtures/zenith-credit-sample.eml
    - tests/tracer.test.ts
    - tests/unit/authenticity.test.ts
  modified: []

key-decisions:
  - "D-01: OAuth2Client setCredentials({refresh_token}) only — no access_token persistence; rely on google-auth-library in-memory refresh"
  - "D-09 strict pipeline: base64UrlToBase64 normalization + Buffer.from + quoted-printable decode with throw on invalid chars — no silent fallback decoder"
  - "D-07 DKIM-only clause-bound: split Authentication-Results on ';', match dkim=pass per clause, extract header.d fallback d/header.i, require lowercase zenithbank.com"
  - "Railway pg Pool ssl:{rejectUnauthorized:false} via config object not query string (pitfall 3); pool.on('error') to prevent idle crash"
  - "Mock-friendly pool singleton via _setPoolForTests global to enable tracer without live Postgres; transactions + heartbeat in single client TX"

requirements-completed: [FR-1.1, FR-1.4, FR-1.6, FR-1.7, FR-1.8, FR-1.11, FR-1.12, NFR-1.2, NFR-1.3, NFR-1.5, NFR-1.6]

coverage:
  - id: D1
    description: "Single processEmail path inserts one correct CREDIT transaction row (amount 10000, NGN, SAMPLE ACCOUNT HOLDER, masked 999****999, ZIB20260908123456) and heartbeat within 60s"
    requirement: "FR-1.6"
    verification:
      - kind: unit
        ref: "tests/tracer.test.ts#inserts one correct CREDIT row and heartbeat, dedup on replay"
        status: pass
    human_judgment: false
  - id: D2
    description: "Duplicate replay returns duplicate and leaves single row (ON CONFLICT DO NOTHING)"
    requirement: "FR-1.8"
    verification:
      - kind: unit
        ref: "tests/tracer.test.ts#inserts one correct CREDIT row and heartbeat, dedup on replay"
        status: pass
    human_judgment: false
  - id: D3
    description: "Attacker DKIM domain fixture lands in suspicious_emails not transactions"
    requirement: "FR-1.4"
    verification:
      - kind: unit
        ref: "tests/tracer.test.ts#routes attacker DKIM domain to suspicious_emails"
        status: pass
    human_judgment: false
  - id: D4
    description: "DKIM-only clause-bound verification (T-1.1 to T-1.5 plus multi-signature binding)"
    requirement: "FR-1.4"
    verification:
      - kind: unit
        ref: "tests/unit/authenticity.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "decodeStrict throws on invalid base64 with no silent fallback and round-trips fixture"
    requirement: "FR-1.6"
    verification:
      - kind: unit
        ref: "tests/tracer.test.ts#decodeStrict throws / round-trips"
        status: pass
    human_judgment: false
  - id: D6
    description: "Pino JSON logging threads email_message_id via child logger on every stage"
    requirement: "FR-1.12"
    verification:
      - kind: unit
        ref: "tests/tracer.test.ts#spy createChildLogger bindings"
        status: pass
    human_judgment: false
  - id: D7
    description: "Railway infra scaffold + migrations (transactions/suspicious_emails/pipeline_health) with idempotent runner and ssl config"
    requirement: "NFR-1.2"
    verification:
      - kind: other
        ref: "npx tsc --noEmit; npm run build; grep rejectUnauthorized src/db/pool.ts"
        status: pass
    human_judgment: false

duration: 21 min
completed: 2026-09-09
status: complete
---

# Phase 01 Plan 01: Tracer Slice — Scaffold + DB + Auth + processEmail Summary

**End-to-end CREDIT TRANSACTION NOTIFICATION through strict B64->QP->HTML, clause-bound DKIM, cheerio parsing, credit-only zod validation, and deduped atomic insert+heartbeat with pino JSON correlation**

## Performance

- **Duration:** 21 min
- **Started:** 2026-09-09T11:55:16+01:00
- **Completed:** 2026-09-09T12:16:12+01:00
- **Tasks:** 3
- **Files modified:** 27 created, 1 package-lock generated

## Accomplishments

- Project scaffold on Node >=20 with pinned deps googleapis@178.1.1 pg@8.23.0 pino@10.3.1 cheerio@1.2.0 zod@4.5.4 quoted-printable@1.0.1 and Railway Dockerfile/railway.json with `npm run migrate && npm start`
- Postgres schema (001_transactions with email_message_id UNIQUE + amount CHECK, 002_suspicious_emails, 003_pipeline_health + schema_migrations) plus idempotent migrate runner and pg Pool with ssl:{rejectUnauthorized:false} and pool.on('error')
- Gmail OAuth factory (OAuth2Client setCredentials({refresh_token}) only) and fetch helper with base64url normalization and multipart body extraction
- Single convergence processEmail wired: candidate From-domain filter -> clause-bound verifyAuthenticity (fail closed) -> suspicious insert -> strict decodeStrict -> cheerio parseZenithFields -> credit-only classifier -> zod validateTransaction -> insertTransactionAtomically + heartbeat TX -> pino child(email_message_id)
- Tracer fixture zenith-credit-sample.eml matching zenith_bank_email_format.md Full Crediting Example and tracer test proving amount 10000.00 NGN SAMPLE ACCOUNT HOLDER masked 999****999 reference ZIB20260908123456, dedup on replay, attacker DKIM rejection, decodeStrict throw, and log correlation
- Authenticity unit suite (T-1.1 to T-1.5 plus multi-signature clause-binding cases) green

## Task Commits

Each task was committed atomically (no git repo — files created directly; equivalent logical commits):

1. **Task 1.1: Project scaffold + Railway infra + Postgres + migrations** - scaffold (no git hash — file creation)
2. **Tracer: End-to-end CREDIT TRANSACTION NOTIFICATION through processEmail** - tracer (no git hash — file creation)
3. **Task 1.3: DB helpers consolidation + worker entry + idempotent migration runner wiring** - consolidation (no git hash — file creation)

**Plan metadata:** `01-01-SUMMARY.md` (docs: complete plan) — no git repo at project root, so no commit hash (commit_docs disabled / gitless workspace)

_Note: No git repository exists at path/to/repository — sequential executor writes SUMMARY.md and files without git commits per instructions._

## Files Created/Modified

- `package.json` - pinned deps + scripts build/start/dev/migrate/test
- `tsconfig.json` - ES2022 commonjs strict outDir dist rootDir src
- `vitest.config.ts` - vitest node env include tests/**/*.test.ts
- `.env.example` - Phase 1 vars mirror of envExample.example with defaults
- `railway.json` - dockerfile builder, startCommand npm run migrate && npm start
- `Dockerfile` - node:20-slim multi-stage build
- `src/config/env.ts` - zod validation, ZENITH_SENDER_DOMAINS split+trim, numeric thresholds, throw on missing required per NFR-1.6
- `src/db/pool.ts` - pg Pool singleton ssl:{rejectUnauthorized:false} max 10 idle 30000 + error handler, _setPoolForTests for tests
- `src/db/migrate.ts` - versioned migration runner against schema_migrations, BEGIN/COMMIT per file, idempotent rerun 0 new
- `migrations/001_transactions.sql` - transactions with pgcrypto gen_random_uuid, NUMERIC checks, email_message_id UNIQUE
- `migrations/002_suspicious_emails.sql` - suspicious_emails with UNIQUE
- `migrations/003_pipeline_health.sql` - pipeline_health key PK + seed heartbeat + schema_migrations
- `src/observability/logger.ts` - pino JSON logger level from LOG_LEVEL, redact auth, createChildLogger binding helper
- `src/gmail/auth.ts` - OAuth2Client factory setCredentials refresh_token only, tokens event, lazy singleton proxies
- `src/gmail/fetch.ts` - fetchMessage via gmail.users.messages.get format full, lowercased headers map, multipart bodyB64 extraction, base64UrlToBase64
- `src/zenith/authenticity.ts` - verifyAuthenticity DKIM-only clause-bound per D-07
- `src/zenith/decode.ts` - base64UrlToBase64 + decodeStrict strict B64->QP->HTML with no fallback
- `src/zenith/parser.ts` - parseZenithFields via cheerio table tr/td, parseZenithEmail wrapper
- `src/zenith/classifier.ts` - isCreditTransaction / isTransactionAlert credit-only per D-06
- `src/zenith/validation.ts` - zod schema amount regex + currency enum + DD/MM/YYYY via date-fns with future tolerance, sender_account required, buildValidationInput helper
- `src/db/transactions.ts` - insertTransactionAtomically with ON CONFLICT + heartbeat TX + stripAndCap raw_email
- `src/db/suspicious.ts` - insertSuspicious ON CONFLICT DO NOTHING + stripAndCap
- `src/db/health.ts` - getHealth/setHealth + getLastProcessedAt + get/setHistoryId via TIMESTAMPTZ handling
- `src/worker.ts` - processEmail(messageId, deps) single convergence export + start() boot sequence (env -> pool SELECT 1 -> migrate -> gmail)
- `src/index.ts` - barrel re-exports (disambiguated base64UrlToBase64)
- `tests/fixtures/zenith-credit-sample.eml` - encoded fixture from Full Crediting Example
- `tests/tracer.test.ts` - end-to-end tracer assertions (7 tests green)
- `tests/unit/authenticity.test.ts` - T-1.1 to T-1.5 plus clause-binding (8 tests green)
- `package-lock.json` - generated lockfile

## Decisions Made

- Use Node >=20 (engines >=20 to accommodate host v24.14.0) while documenting Railway as node:20-slim for prod — avoids EBADENGINE warn in dev without changing Railway runtime
- @types/quoted-printable pinned to 1.0.2 (1.0.3 does not exist on npm) — deviation from plan's 1.0.3 assumption
- Pool singleton via Proxy lazy getter to allow env validation to control boot order but still expose pool as importable singleton; _setPoolForTests for mock injection
- Validation amount transform directly to number via manual check rather than z.coerce pipeline due to zod@4 type incompatibility with pipe on transformed string
- Logger correlation: worker creates child({email_message_id}) at entry and threads through every log line; tracer proves via vi.spyOn createChildLogger
- Mock pool for tracer handles both parameterized health upsert and literal now() heartbeat path from transactions atomic TX

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] @types/quoted-printable version does not exist**
- **Found during:** Task 1.1 npm install
- **Issue:** Plan pinned @types/quoted-printable@1.0.3 — npm registry has only 1.0.2; ETARGET
- **Fix:** Pinned to 1.0.2 in package.json
- **Files modified:** package.json
- **Verification:** npm install succeeded; npx tsc --noEmit passes
- **Committed in:** scaffold (file creation)

**2. [Rule 1 - Bug] src/index.ts duplicate base64UrlToBase64 export ambiguity**
- **Found during:** Task 1.2 npx tsc --noEmit
- **Issue:** Wildcard re-exports from gmail/fetch and zenith/decode both export base64UrlToBase64 — TS2308 duplicate export
- **Fix:** Changed barrel to explicit `export { fetchMessage, base64UrlToBase64 as gmailBase64UrlToBase64 }` from gmail/fetch
- **Files modified:** src/index.ts
- **Verification:** npx tsc --noEmit clean
- **Committed in:** tracer (file creation)

**3. [Rule 1 - Bug] health.ts instanceof Date narrowing error + validation zod pipe incompatibility**
- **Found during:** Task 1.2 npx tsc --noEmit
- **Issue:** getHealth typed value as string | null then instanceof Date fails; zod .pipe(coerce.number) on transformed string rejected by zod 4 types
- **Fix:** Typed health query value as unknown|string|Date and cast; rewrote validation amount/available_balance to manual transform without pipe
- **Files modified:** src/db/health.ts, src/zenith/validation.ts
- **Verification:** npx tsc --noEmit clean; npm test 15/15 passing
- **Committed in:** tracer (file creation)

**4. [Rule 3 - Blocking] Tracer mock heartbeat via literal now() not captured**
- **Found during:** Tracer test run — health.get('last_zenith_email_processed_at') undefined
- **Issue:** insertTransactionAtomically uses `VALUES ('last_zenith_email_processed_at', now(), now())` with no params; mock only handled param form
- **Fix:** Extended mock pool query to handle literal now() insert by detecting pipeline_health + last_zenith key and setting ISO now
- **Files modified:** tests/tracer.test.ts mock helper
- **Verification:** tracer heartbeat assertion now within 60s and duplicate replay passes
- **Committed in:** tracer (file creation)

**5. [Rule 2 - Missing Critical] ESM read-only export patch for logger spy**
- **Found during:** Tracer test run — Cannot set property createChildLogger of [object Module] which has only a getter
- **Issue:** Attempt to monkey-patch createChildLogger via assignment fails on ESM module; test needs to prove correlation key
- **Fix:** Switched to vi.spyOn(loggerMod, 'createChildLogger') instead of direct assignment
- **Files modified:** tests/tracer.test.ts
- **Verification:** tracer spy asserts call bindings.email_message_id === 'tracer-001' passes; 15/15 tests green
- **Committed in:** tracer (file creation)

---

**Total deviations:** 5 auto-fixed (1 missing critical, 2 bugs, 2 blocking)
**Impact on plan:** All auto-fixes necessary for correctness/build. No scope creep; strict pipeline, DKIM clause-bound, credit-only, dedup, and logging contracts preserved.

## Issues Encountered

- No git repo at project root — sequential executor per instructions creates files and SUMMARY.md without git commits. Metadata final commit skipped (gitless workspace).
- No live Postgres DATABASE_URL available in execution environment — migrations verified via code inspection and mock pool; plan's psql \d transactions live check deferred to 01-VALIDATION.md manual staging.
- Node 24.14.0 on host vs Railway node:20-slim — engines set to >=20 to avoid EBADENGINE without changing prod runtime.

## User Setup Required

None — tracer uses in-memory mock pool and injected gmail mock; no external service configuration required for this plan's verification. For live Railway run, configure via Railway env vars per .env.example: DATABASE_URL, GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN, ZENITH_SENDER_DOMAINS.

## Next Phase Readiness

- Tracer skeleton can already insert one correct deduplicated transactions row per verified Zenith credit fixture and advance pipeline_health heartbeat — proven via 15 passing tests.
- Ready for 01-02 (polling + history cursor + staleness) and 01-03 (push handler) expansion on same processEmail convergence.
- Next step: run `/gsd-execute-phase 01` wave 2 or verify live with `DATABASE_URL` set: `npm run migrate && npm test`

---
*Phase: 01-zenith-ingestion*
*Plan: 01*
*Completed: 2026-09-09*
