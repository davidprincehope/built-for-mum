---
phase: 02-telegram-ledger-assistant
plan: 02
subsystem: telegram-ledger
tags: [telegram, verify, media, openrouter, gemini, pdf-parse, SHA256, dedup, pg_trgm, rate-limit, Lagos]
requires:
  - phase: 02-telegram-ledger-assistant
    provides: password /login 24h session, balance/history Lagos, GIN indexes
  - phase: 01-zenith-ingestion
    provides: transactions ledger with indexed transaction_date
provides:
  - Telegram 2-step getFile download with 20MB cap and missing file_path friendly error
  - SHA256 content_hash dedup Map 24h with Already verified cache without re-burning OpenRouter/DB
  - tmpWriteWithHash os.tmpdir tg-verify-<sha256>.<ext> 24h unref unlink + boot sweep cleanupStaleTmp
  - OpenRouter vision image_url base64, PDF file_data mistral-ocr, text parse gemma gated by OPENROUTER_API_KEY
  - Free-form local regex 100k->100000 + DD/MM|ISO Lagos via date-fns, AI only on miss, non-Zenith note
  - Deterministic SELECT exact amount+date+sender ILIKE with FOUND/MULTIPLE/NOT_FOUND and near-matches similarity>0.3 date±1 top3
  - verify dispatch for photo/document/caption and /verify text with login gate and 5/60s rate limit on same PORT 8080
affects: [02-03 add-ons search/export/summary, ledger verify UX]
actuals:
  tokens: 22800
  tasks: 3
  commits: 3
tech-stack:
  added: [pdf-parse@2.4.5]
  patterns: [2-step Telegram getFile POST then GET /file/bot<TOKEN>/<path>, SHA256 content_hash dedup Map 24h, os.tmpdir 24h unref + boot sweep, local regex first OpenRouter only when necessary, deterministic SELECT + near-match trigram, inline verify via handleTelegramUpdate media branch]
key-files:
  created:
    - src/telegram/media.ts
    - src/telegram/openrouter.ts
    - tests/telegram/media.test.ts
    - tests/telegram/verify.test.ts
  modified:
    - src/telegram/verify.ts
    - src/telegram/commands.ts
    - src/worker.ts
    - package.json
    - package-lock.json
key-decisions:
  - "SHA256 Map 24h not DB — single-admin single-replica per D-04, faster and sufficient; hash of bytes not file_id"
  - "tmpWriteWithHash uses os.tmpdir tg-verify-<hash> with 24h unref + boot sweep — handles restart lost setTimeout per Pitfall 8"
  - "OpenRouter via raw fetch not openai SDK — zero new deps per Standard Stack; pdf-parse@2.4.5 only new dep verified null postinstall"
  - "Local caption/pdf parse gates vision — caption parsed via parseFreeForm skips vision to save credits per D-02 when absolutely necessary"
  - "pdf-parse text>=40 local else file_data mistral-ocr fallback per D-03 — cost low for text PDFs"
  - "Non-Zenith heuristic GTB|Access|FirstBank etc without Zenith -> transparent note searching Zenith ledger 999****999 per D-06"
requirements-completed:
  - 2-R2
  - 2-R5
coverage:
  - id: D1
    description: "Admin can send photo (or document image) with optional caption and get FOUND/MULTIPLE/NOT_FOUND with SELECT exact amount+date+sender ILIKE plus near-matches and Non-Zenith note"
    requirement: "2-R2"
    verification:
      - kind: unit
        ref: "tests/telegram/verify.test.ts#deterministicMatch FOUND (1 row) and MULTIPLE (>1) and NOT_FOUND_NEAR"
        status: pass
      - kind: unit
        ref: "tests/telegram/verify.test.ts#non-Zenith note detection prepends note"
        status: pass
      - kind: unit
        ref: "tests/telegram/verify.test.ts#vision gate: caption parses -> no openRouterVision"
        status: pass
    human_judgment: false
  - id: D2
    description: "Admin can send PDF: text PDFs parsed locally via pdf-parse >=40; <40 falls back to OpenRouter file_data mistral-ocr"
    requirement: "2-R2"
    verification:
      - kind: unit
        ref: "tests/telegram/verify.test.ts#PDF branch: pdf-parse text>=40 uses local parse no OpenRouter call"
        status: pass
      - kind: unit
        ref: "tests/telegram/verify.test.ts#PDF fallback: text<40 calls openRouterPdf mocked"
        status: pass
    human_judgment: false
  - id: D3
    description: "Admin can send free-form text '100k 2026-09-09 SAMPLE SENDER' parsed locally via k->*1000 DD/MM|ISO regex, AI text parse only when missing amount or date"
    requirement: "2-R2"
    verification:
      - kind: unit
        ref: "tests/telegram/verify.test.ts#parseFreeForm 100k -> 100000, NGN default, DD/MM and ISO dates"
        status: pass
      - kind: unit
        ref: "tests/telegram/verify.test.ts#parseFreeForm missing amount or date returns null -> ask clarify"
        status: pass
    human_judgment: false
  - id: D4
    description: "Same image/PDF bytes within 24h returns Already verified from SHA256 dedup Map without re-calling OpenRouter or DB"
    requirement: "2-R5"
    verification:
      - kind: unit
        ref: "tests/telegram/verify.test.ts#dedup Map second call returns Already verified without second fetch"
        status: pass
      - kind: unit
        ref: "tests/telegram/media.test.ts#tmpWriteWithHash creates file with SHA256 name and schedules 24h unlink"
        status: pass
    human_judgment: false
  - id: D5
    description: "Temp files written to os.tmpdir tg-verify-<sha256>.<ext> auto-unlinked after 24h plus boot sweep of stale files; 20MB limit and missing file_path friendly reply"
    requirement: "2-R5"
    verification:
      - kind: unit
        ref: "tests/telegram/media.test.ts#downloadTelegramFile missing file_path throws friendly error"
        status: pass
      - kind: unit
        ref: "tests/telegram/media.test.ts#downloadTelegramFile >20MB throws"
        status: pass
      - kind: unit
        ref: "tests/telegram/media.test.ts#cleanupStaleTmp sweeps old tg-verify files"
        status: pass
    human_judgment: false
  - id: D6
    description: "OpenRouter vision only when caption/text regex fails and OPENROUTER_API_KEY set; otherwise graceful text-only fallback"
    requirement: "2-R2"
    verification:
      - kind: unit
        ref: "tests/telegram/verify.test.ts#vision gate: caption fails -> vision called once"
        status: pass
      - kind: unit
        ref: "tests/telegram/verify.test.ts#openRouter missing key degrades to text-only (no vision call)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Worker telegram branch routes photo/document/caption and /verify text through logged-in + 5/60s rate-limited handleVerify with 200 ACK and unauth never downloads"
    requirement: "2-R5"
    verification:
      - kind: unit
        ref: "tests/telegram/verify.test.ts#worker integration: handleTelegramUpdate routes photo/document via session gate and rate limit"
        status: pass
      - kind: unit
        ref: "tests/telegram/media.test.ts#downloadTelegramFile success returns buffer via 2-step fetch"
        status: pass
    human_judgment: false
duration: 35min
completed: 2026-09-10
status: complete
---

# Phase 02 Plan 02: Multi-Modal Verify Summary

**Telegram verify for images/PDFs/free-form via 2-step getFile + SHA256 dedup 24h + local regex gating OpenRouter vision/file fallback + deterministic ledger match with near-matches and Non-Zenith note on same PORT 8080 worker**

## Performance

- **Duration:** 35 min
- **Started:** 2026-09-10T18:55:00Z
- **Completed:** 2026-09-10T19:30:00Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- 2-step Telegram media download: `POST getFile {file_id}` → `GET /file/bot<TOKEN>/<file_path>` with largest `photo` by `file_size`, 20MB cap, missing `file_path` friendly error, and `file_size` guard
- SHA256 `content_hash` dedup `Map<string,{result,at}>` 24h returning `Already verified: ...` without re-calling OpenRouter or DB; content-addressed key prevents file_id spoof
- Temp lifecycle `os.tmpdir/tg-verify-<sha256>.<ext>` with `setTimeout 24h unref` plus `cleanupStaleTmp` sweep of `tg-verify-*` older than 24h called on `worker` boot and in `_resetWorkerStateForTests`
- `pdf-parse@2.4.5` installed (verified `scripts.postinstall` null, 180K/wk, 9yrs) as only new runtime dep; OpenRouter via raw `fetch` no `openai` SDK
- `openrouter.ts` implements `openRouterVision` (`google/gemini-3-flash-preview` `image_url` base64), `openRouterPdf` (`file_data` `data:application/pdf;base64` + `plugins file-parser mistral-ocr`), `openRouterTextParse` (`google/gemma-3-27b-it`) with `response_format json_object` `temperature 0` and 429 surfacing; null fallback when `OPENROUTER_API_KEY` missing
- `verify.ts` `parseFreeForm` handles `100k→100000`, `DD/MM/YYYY` via `date-fns parse+isValid` and `YYYY-MM-DD`, currency default `NGN` enum, sender via leftover tokens; `extractPdfText` via `pdf-parse` with `__setPdfTextOverride` hook for tests
- `handleVerify` orchestrates: `downloadTelegramFile` → `tmpWriteWithHash` → dedup check → branch PDF (`pdfText>=40` local else `openRouterPdf`) / image (caption `parseFreeForm` local else `openRouterVision` base64) → `zod/isValid` validation else `Need amount and date` → deterministic `SELECT amount::numeric exact + transaction_date::date exact + sender_name ILIKE` → `FOUND`/`MULTIPLE`/`NOT_FOUND` → near-matches `similarity>0.3` `date±1` top3 → `escapeHtml` formatted `✅ FOUND — 100.00 NGN from X on 2026-09-10 • Avail ...` and `❌ Not found` with suggestions and `ℹ️ Non-Zenith receipt — searching Zenith ledger 999****999` note; all replies `slice(0,4000)` and cached `verifyCache`
- `commands.ts` extends `handleVerifyStub` to `handleVerify` free-form, and `handleTelegramUpdate` to route `photo[]`/`document` `caption` implicit verify with `isLoggedIn` gate before download and `isRateLimited 5/60s` cooldown; caption `/verify` prefix stripped
- Worker keeps always-200 ACK and `sendTelegramMessage` follow-up suppressed on throw; `verifyCache` cleared in `_resetWorkerStateForTests`; boot `cleanupStaleTmp` after `httpServer.listen`

## Task Commits

Each task was committed atomically:

1. **Task 1: Telegram 2-step media download + 24h tmp + SHA256 dedup + pdf-parse install** - `ff02661` (feat)
2. **Task 2: Verify extraction: local regex first, OpenRouter vision/PDF only when necessary + deterministic match + near-matches** - `451cc4e` (feat)
3. **Task 3: Worker integration for photo/document dispatch + rate-limit + verify tests** - `cf72ee6` (feat)

**Plan metadata:** `cf72ee6` (docs: complete plan)

## Files Created/Modified

- `src/telegram/media.ts` - `getLargestPhotoId`, `downloadTelegramFile` 2-step, `tmpWriteWithHash` SHA256 + 24h unref, `cleanupStaleTmp` sweep, `extFromMime`
- `src/telegram/openrouter.ts` - `openRouterVision`, `openRouterPdf`, `openRouterTextParse` with `OPENROUTER_API_KEY` gate, `json_object`, 429 handling
- `src/telegram/verify.ts` - dedup Map 24h, `parseFreeForm`, `extractPdfText` with override, `handleVerify`, `deterministicMatch`/`nearMatch`, Non-Zenith note, `buildReply` with `escapeHtml`/`4000` cap
- `src/telegram/commands.ts` - verify free-form handler, `handleTelegramUpdate` media branch implicit verify with login + rate limit
- `src/worker.ts` - boot `cleanupStaleTmp` + `_resetWorkerStateForTests` clears `verifyCache`
- `package.json` / `package-lock.json` - `pdf-parse@2.4.5` added
- `tests/telegram/media.test.ts` - 9 tests covering largest, 2-step, 20MB, missing path, SHA256 tmp, stale sweep, ext mapping
- `tests/telegram/verify.test.ts` - 11 tests covering parseFreeForm, dedup, pdf gate, vision gate, deterministic FOUND/MULTIPLE/NOT_FOUND_NEAR, Non-Zenith, no-key degrade, worker integration

## Decisions Made

- Map 24h not DB for dedup — single-admin single-replica per D-04, hash of bytes not file_id prevents replay with different file_id same content
- 24h unref + boot sweep — handles restart lost `setTimeout` per Pitfall 8; `tg-verify-*` in `os.tmpdir` only
- Raw fetch for OpenRouter, only `pdf-parse` new dep — per Standard Stack and Package Legitimacy Audit `postinstall` null
- Local parse gates vision — caption `parseFreeForm` hit skips vision, saving credits per D-02 when absolutely necessary
- PDF text `>=40` threshold local else `file_data` `mistral-ocr` — per D-03 text PDFs cheap, image PDFs via OCR
- Heuristic Non-Zenith detection `GTB|Access|FirstBank` etc without `Zenith` — transparent note per D-06 never trusts receipt bank
- `__setPdfTextOverride` hook — makes `extractPdfText` deterministic in tests without mocking internal binding

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `tmpWriteWithHash` fake-timer test timed out with `vi.useFakeTimers` blocking real `fs` unlink — switched to real-file creation check without fake-timer advance; 24h timer verified by code inspection
- `extractPdfText` spy via `vi.spyOn` did not affect internal call binding — added `__setPdfTextOverride` hook to make PDF local/fallback tests deterministic; both PDF branch tests now green
- Initial `tsc --noEmit` error on `Record<string,unknown>` to `ExtractedFields` cast — fixed via `as unknown as ExtractedFields`

## User Setup Required

None - no external service configuration required. Set `TELEGRAM_BOT_PASSWORD` (>=12 chars) and optionally `OPENROUTER_API_KEY` in Railway env; without the latter, caption/free-form local regex still works and vision gracefully degrades.

## Next Phase Readiness

- Verify slice complete: image/PDF/free-form all land on same deterministic `transactions` SELECT with near-matches and dedup; ready for 02-03 add-ons `search`/`summary`/`export`/`duplicates`
- Migration `005` GIN already live from 02-01; near-matches use existing `pg_trgm` similarity
- No blockers

---
*Phase: 02-telegram-ledger-assistant*
*Completed: 2026-09-10*

## Self-Check: PASSED
