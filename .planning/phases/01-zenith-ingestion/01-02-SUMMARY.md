---
phase: 01-zenith-ingestion
plan: "02"
subsystem: ingestion
tags: [cheerio, zod, quoted-printable, date-fns, parsing, validation, classifier, sender]
requires:
  - phase: 01-zenith-ingestion-01
    provides: Postgres schema transactions/suspicious_emails/pipeline_health, strict B64->QP->HTML decodeStrict, clause-bound DKIM verifyAuthenticity, tracer processEmail convergence
provides:
  - Cheerio table parser with per-field regex extractors and ParseFailure on missing fields
  - Sender extractor for CIP_CR/NIP/UP_IB/CHARGE/UNKNOWN families with D-10 lenient-safe policy
  - Credit-only classifier isCreditTransaction/isTransactionAlert per D-06/FR-1.5
  - Zod validation with comma-strip amount, DD/MM/YYYY date-fns, currency enum, future-date tolerance
  - capRawEmail 100KB strip per NFR-1.4/D-17
  - Fixture corpus covering credit/NIP/UP-IB/charge/debit and pipeline integration tests T-2.1..T-3.5
affects: [01-zenith-ingestion-03, 01-zenith-ingestion-04, worker, matching]

actuals:
  tokens: 62000
  tasks: 3
  commits: 0

tech-stack:
  added: []
  patterns: [cheerio table tr/td kv map per-field regex not monolithic, ParseFailure field-named throw, D-10 UNKNOWN lenient-safe store raw, capRawEmail byte-length truncate with suffix, zod transform+refine amount>0 max2decimals]

key-files:
  created:
    - tests/fixtures/zenith-samples.ts
    - tests/fixtures/zenith-debit-sample.eml
    - tests/fixtures/zenith-nip-sample.eml
    - tests/fixtures/zenith-upib-sample.eml
    - tests/fixtures/zenith-bankcharge-sample.eml
    - tests/unit/decode.test.ts
    - tests/unit/parser.test.ts
    - tests/unit/sender.test.ts
    - tests/unit/classifier.test.ts
    - tests/unit/validation.test.ts
    - tests/integration/pipeline.test.ts
  modified:
    - src/zenith/decode.ts
    - src/zenith/parser.ts
    - src/zenith/classifier.ts
    - src/zenith/validation.ts
    - src/zenith/sender.ts
    - src/db/transactions.ts
    - src/db/suspicious.ts
    - src/worker.ts

key-decisions:
  - "D-10 lenient-safe UNKNOWN: store raw description as senderName family UNKNOWN, warn log, alert as format drift — avoids mis-attribution while preserving legitimate credits with new narration"
  - "Parser throws ParseFailure with field name on missing/truncated table rather than partial object per T-1.9 (T-02-01)"
  - "Sender extractor per spec: CIP CR between slashes, NIP token between bank code and second slash, UP-IB channel label (MOB/UTO handling), CHARGE set lookup"
  - "Classifier: isCreditTransaction CREDIT wins via includes (Fwd: handling), fallback to Transaction Type field; isTransactionAlert requires alert subject + table evidence to avoid OTP alert storms"
  - "Validation: date-fns parse dd/MM/yyyy + isValid + 5min future tolerance, amount regex N{,}NNN.NN comma-strip to number >0, capRawEmail byteLength 100KB with suffix and image stripping"

requirements-completed: [FR-1.5, FR-1.6, FR-1.7, FR-1.10, NFR-1.4]

coverage:
  - id: D1
    description: "Strict base64url->QP->HTML decodeStrict with dash/underscore normalization and strict-decode throws per D-09"
    requirement: "FR-1.6"
    verification:
      - kind: unit
        ref: "tests/unit/decode.test.ts#decodes base64url with -/_ and missing padding / throws on invalid"
        status: pass
    human_judgment: false
  - id: D2
    description: "Cheerio table parser extracts every Zenith column per spec via per-field regexes, ParseFailure on missing Description/truncated HTML"
    requirement: "FR-1.6"
    verification:
      - kind: unit
        ref: "tests/unit/parser.test.ts#T-1.6 well-formed CIP CR / T-1.7 comma amount / T-1.9 ParseFailure / NIP amount"
        status: pass
    human_judgment: false
  - id: D3
    description: "Sender extraction for four families CIP_CR/NIP/UP_IB/CHARGE per spec, UNKNOWN lenient-safe without mis-attribution"
    requirement: "FR-1.6"
    verification:
      - kind: unit
        ref: "tests/unit/sender.test.ts#CIP CR HAFSAT / NIP SAMPLE SENDER / UP-IB USSD-NIP / VAT / UNKNOWN"
        status: pass
    human_judgment: false
  - id: D4
    description: "Credit-only classifier routes CREDIT pass, DEBIT/OTP ignored at debug with no alert per D-06/Pitfall7"
    requirement: "FR-1.5"
    verification:
      - kind: unit
        ref: "tests/unit/classifier.test.ts#isCreditTransaction Fwd credit / debit false / OTP not alert"
        status: pass
    human_judgment: false
  - id: D5
    description: "Zod validation rejects negative amount, bad currency, future date, missing reference; good fixture passes with 100,000.00→100000"
    requirement: "FR-1.7"
    verification:
      - kind: unit
        ref: "tests/unit/validation.test.ts#T-1.10 negative / T-1.11 currency / T-1.12 future / T-1.13 valid / T-3.5 empty reference"
        status: pass
    human_judgment: false
  - id: D6
    description: "raw_email capping ≤100KB after CID/image stripping per NFR-1.4/D-17"
    requirement: "NFR-1.4"
    verification:
      - kind: unit
        ref: "tests/unit/validation.test.ts#large inline image stripped and capped"
        status: pass
    human_judgment: false
  - id: D7
    description: "Pipeline integration routing: credit inserts+heartbeat, spoof→suspicious, parse-fail→validation_failed distinct, duplicate idempotent, large image capped, two same-amount diff-refs both stored"
    requirement: "FR-1.10"
    verification:
      - kind: integration
        ref: "tests/integration/pipeline.test.ts#T-2.1 verified credit / T-2.2 spoof / T-2.3 parse-fail vs ignored / T-2.4 duplicate / T-3.2 cap / T-3.4 diff refs"
        status: pass
    human_judgment: false

duration: 23 min
completed: 2026-09-09
status: complete
---

# Phase 01 Plan 02: Zenith Parsing Hardening Summary

**Cheerio per-field table parser with ParseFailure, four-family sender extraction with D-10 UNKNOWN lenient-safe, credit-only classifier with OTP-aware alert gate, zod comma/date validation and 100KB capRawEmail, fixture-backed pipeline integration covering all documented Zenith narrations**

## Performance

- **Duration:** 23 min
- **Started:** 2026-09-09T12:22:32Z
- **Completed:** 2026-09-09T12:45:00Z
- **Tasks:** 3
- **Files modified:** 14 (8 modified, 6 created fixtures/tests)

## Accomplishments

- Hardened strict pipeline: base64UrlToBase64 dash/underscore normalization + padding, decodeStrict throws strict-decode: base64 fail/quopri fail with no silent fallback per D-09; supports Gmail payload.parts[].body.data base64url and standard base64 with padding
- Implemented src/zenith/parser.ts as cheerio per-field extractor with ParsedFields interface (accountNumber, transactionDateStr, amountStr, currency, description, referenceCode, branch, transactionType, availableBalanceStr, rawTable), ParseFailure class with field name, regex on kv values not raw HTML per Section 7.4, truncated/missing-row detection per T-1.9
- Built fixture corpus tests/fixtures/zenith-samples.ts helper (QP encode → base64url), plus .eml samples for debit, NIP cooperative, UP-IB USSD-NIP, bank charge VAT covering all four description families from zenith_bank_email_format.md without invented fields
- Implemented src/zenith/sender.ts extractSender for CIP_CR (between first slashes), NIP (bank code→second slash), UP_IB channel label (USSD-NIP/MOB/UTO), CHARGE verbatim, UNKNOWN lenient-safe storing raw description per D-10; masked 999****999 preserved per D-08
- Hardened src/zenith/classifier.ts isCreditTransaction (includes handles Fwd:/Re:, fallback to Transaction Type) and isTransactionAlert (alert subject + table evidence check for OTP/statement suppression per Pitfall 7)
- Implemented src/zenith/validation.ts zod schemas: amount /^[\d,]+\.\d{2}$/ comma-strip → number >0 + max2decimals refine, currency enum uppercased, reference non-empty, date DD/MM/YYYY via date-fns parse+isValid +5min future, available_balance nullable numeric, plus exported capRawEmail stripping data:image/Content-Type:image/--boundary blocks and truncating to 100KB with suffix [...truncated N bytes]
- Updated src/db/transactions.ts and suspicious.ts to import capRawEmail, atomic TX + heartbeat preserved, branch/available_balance columns written, UTC TIMESTAMPTZ via now()
- Wired src/worker.ts to use parseZenithEmail strict + extractSender families, ParseFailure→validation_failed (format drift), UNKNOWN warn log, credit-only debug ignore per D-06
- Green suite: decode (8), parser (14), sender (13), classifier (16), validation (18), pipeline integration (11) — 110 tests total including tracer (7) and authenticity (8)

## Task Commits

Each task was committed atomically (gitless workspace — no commit hash per 01-01-SUMMARY note):

1. **Task 2.1: Cheerio table parser + strict decode hardening + fixture corpus** - scaffold (no git hash — file creation)
2. **Task 2.2: Sender extraction for four description families + credit-only classifier + D-10 unknown-description policy** - sender/classifier (no git hash — file creation)
3. **Task 2.3: Zod validation module + raw_email capping + pipeline integration wiring** - validation/pipeline (no git hash — file creation)

**Plan metadata:** `01-02-SUMMARY.md` (docs: complete plan) — no git repo at project root, so no commit hash (commit_docs disabled / gitless workspace)

_Note: TDD tasks may have multiple commits (test → feat → refactor)_

## Files Created/Modified

- `src/zenith/decode.ts` — already strict, preserved base64UrlToBase64 + decodeStrict with regex validation and re-encode empty check, throws strict-decode: base64 fail/quopri fail per D-09
- `src/zenith/parser.ts` — cheerio load + table tr/td kv map + per-field extractors (accountNumber /\d+\*+\d+/, amountStr /[\d,]+\.\d{2}/, currency NGN|USD|EUR|GBP, reference/branch/transactionType trimmed, availableBalance), ParseFailure on missing required, rawTable preserved
- `src/zenith/sender.ts` — extractSender with D-10 lenient-safe UNKNOWN header comment, four families per spec, MOB/UTO handling, CHARGE keyword set, masked account preservation
- `src/zenith/classifier.ts` — isCreditTransaction + isTransactionAlert with includes + regex /(CREDIT|DEBIT)\s+TRANSACTION\s+NOTIFICATION/i and kv/html hasTable checks
- `src/zenith/validation.ts` — zod transactionSchema with amount/currency/reference/date transforms + refines, isValid date check, 5min future tolerance, capRawEmail byteLength 100KB image strip + truncate suffix
- `src/db/transactions.ts` — imports capRawEmail from validation, logs stripped meta, ON CONFLICT DO NOTHING + heartbeat TX, amount/balance string normalization
- `src/db/suspicious.ts` — imports capRawEmail, dedup ON CONFLICT
- `src/worker.ts` — processEmail now uses parseZenithEmail strict, extractSender families, UNKNOWN warn, ParseFailure→validation_failed, credit-only gate, buildValidationInput from ParsedFields, senderAccount override, capRawEmail path
- `tests/fixtures/zenith-samples.ts` — buildBodyB64 + buildRawHtmlTable + htmlFixtures (creditCipCr/nipCooperative/upIbUssdNip/upIbMobUto/bankChargeVat/debit) + fixtures + makeGmailMessageMock helper
- `tests/fixtures/zenith-debit-sample.eml` — DEBIT sample with CIP CR/JOHN DOE/100,000.00
- `tests/fixtures/zenith-nip-sample.eml` — NIP/FCMB/SAMPLE SENDER cooperative narration
- `tests/fixtures/zenith-upib-sample.eml` — UP-IB USSD-NIP channel
- `tests/fixtures/zenith-bankcharge-sample.eml` — VAT debit charge
- `tests/unit/decode.test.ts` — 8 tests: base64url -/_ padding, standard base64, invalid throws strict-decode, plain HTML rejection, round-trip fixture
- `tests/unit/parser.test.ts` — 14 tests: T-1.6 all fields, comma amounts, NIP description, UP-IB, four families, T-1.9 ParseFailure missing Description/truncated, non-English chars, decode integration, currency variants, Current Balance label
- `tests/unit/sender.test.ts` — 13 tests: CIP CR, NIP variants, UP-IB USSD-NIP/MOB/UTO, VAT/CHARGE, UNKNOWN raw, masked preservation
- `tests/unit/classifier.test.ts` — 16 tests: credit/debit/Fwd case-insensitive, missing type fallback, isTransactionAlert OTP/table/kv, forwarded credit
- `tests/unit/validation.test.ts` — 18 tests: T-1.10 negative/zero, T-1.11 currency, T-1.12 future/invalid date, T-1.13 valid+comma strip, T-3.5 missing reference, case uppercasing, available_balance, masked, capRawEmail strip/cap/null/data:image
- `tests/integration/pipeline.test.ts` — 11 tests: T-2.1 credit+NIP inserts+heartbeat UTC, T-2.2 spoof suspicious, T-2.3 parse-fail vs non-Zenith ignored, T-2.4 duplicate, T-3.5 missing ref, T-3.4 two same-amount diff-refs, T-3.2 large image cap, DEBIT ignored, UP-IB sender, UTC timestamp Z

## Decisions Made

- D-10 choice documented in sender.ts header: lenient-but-safe UNKNOWN (store raw description, family UNKNOWN, warn log, alertable as format drift) over strict drop — prevents losing legitimate credits with new narration while avoiding mis-attribution (high-severity T-02-02 mitigation)
- ParseFailure field-named throw instead of partial object satisfies T-02-01 tampering mitigation and T-1.9; caller maps to validation_failed not crash per D-09 strictness
- NIP split on '/' with parts[2] as sender per spec token-between-bank-code-and-second-slash; handles TRF BO multi-word case without guessing
- UP-IB channel extraction special-cases MOB/UTO (two segments) vs USSD-NIP single label; fallback UP-IB if empty
- CHARGE detection via Set + substring heuristic for VAT/value added tax/cot without inventing patterns beyond spec table
- capRawEmail lives in zenith/validation.ts per plan but also imported by db layer — single implementation, byteLength via Buffer, suffix includes truncated byte count, stripped paths for data:image and MIME image/* boundaries
- Worker maps decodeStrict throw to validation_failed return (not unhandled exception) so worker loop stays alive; ParseFailure also maps to validation_failed distinct from suspicious/ignored

## Deviations from Plan

None - plan executed exactly as written. All per-field extractors, four families, unknown lenient policy, credit-only gate, zod schema, cap, fixtures and integration tests implemented per acceptance criteria.

## Issues Encountered

- Gitless workspace (no .git at C:/Users/user/Documents/Example Project) — per 01-01-SUMMARY, sequential executor creates files without git commits; metadata commit skipped. Verified via npm test 110/110 green and npx tsc --noEmit clean.
- Host Node 24.14.0 vs Railway node:20-slim engines >=20 already set in 01-01 — no change needed.
- Existing watcher/poll unit tests (watch.test.ts, poll.test.ts) from 01-03 pre-existing passed unchanged (110 total includes them).

## User Setup Required

None - no external service configuration required for this plan's verification (pure compute: cheerio, quoted-printable, zod, date-fns). For live Railway run, configure via env vars per .env.example: DATABASE_URL, GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN, ZENITH_SENDER_DOMAINS.

## Next Phase Readiness

- Parser/validator/classifier suite now covers every documented Zenith narration family and every table column, validates per FR-1.7, caps raw_email per NFR-1.4, and distinguishes credit alerts from non-alert Zenith mail per FR-1.5/D-06 — ready for 01-03 push/pubsub and 01-04 alerting/staleness
- Pipeline integration tests prove T-2.1..T-2.4 and T-3.x semantics; live verification with DATABASE_URL can run: `npm run migrate && npm test`
- No blockers; next plan 01-03 expects hardened parser/validation as foundation for its push handler

---
*Phase: 01-zenith-ingestion*
*Plan: 02*
*Completed: 2026-09-09*

## Self-Check: PASSED

- Found: src/zenith/parser.ts cheerio per-field + ParseFailure
- Found: src/zenith/sender.ts four families + UNKNOWN
- Found: src/zenith/classifier.ts credit-only gate
- Found: src/zenith/validation.ts zod + capRawEmail
- Found: tests/fixtures/zenith-samples.ts + 4 .eml fixtures
- Found: tests/unit/decode/parser/sender/classifier/validation + integration pipeline
- Verified: npm test 110/110 passing, npx tsc --noEmit clean
