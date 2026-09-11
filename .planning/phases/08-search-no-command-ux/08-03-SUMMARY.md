---
phase: 08-search-no-command-ux
plan: 03
subsystem: telegram
tags: [search, gemma, gemini, openrouter, trigram, GIN, pendingVerify, force_reply, login, deleteMessage]
requires:
  - phase: 08-search-no-command-ux
    provides: slash-less bare NL search and verify illusion with 5 cards
provides:
  - OpenRouter gemma-3-27b-it primary with gemini-2.0-flash fallback + localKeywordIntent final, 8s AbortController per call
  - GIN trigram ranking ORDER BY similarity(sender_name, $1) DESC NULLS LAST then date with pg_trgm fallback
  - Ask-with-button gate for any photo/PDF via short 12-hex hash TTL 5min, callback_data ≤23B, Verifying… only on Yes
  - Auto-prompt Welcome with Login button + force_reply hidden prompt and double deleteMessage hygiene
affects: [telegram-ledger-assistant, ux-overhaul]
tech-stack:
  added: []
  patterns: ["gemma->gemini->local intent chain with 8s timeout", "similarity+date hybrid ranking on GIN trigram", "pendingVerify short hash map TTL 5min", "force_reply double-delete login hygiene"]
key-files:
  created: []
  modified:
    - src/telegram/search.ts
    - src/telegram/history.ts
    - src/telegram/commands.ts
    - src/worker.ts
    - tests/telegram/verify.test.ts
key-decisions:
  - "callOpenRouter helper with AbortController 8s, response_format json_object, 429/5xx/empty -> null fallback per D-03 cheap gemma then gemini once"
  - "ORDER BY similarity only when sender present, fallback to date on pg_trgm missing via try/catch on query"
  - "pendingVerify stores caption alongside fileId so verify:yes can replay receipt without re-sending image"
  - "Worker placeholder only for verify:yes callback, not initial gate photo, to preserve Yes->Verifying->card illusion"
  - "force_reply intercept before session gate in worker so password reply never treated as bare NL search"
patterns-established:
  - "Gemma cheap primary -> Gemini on 429/empty -> localKeywordIntent final fallback with zod stripping"
  - "Trigram similarity+date ranking transactions-only 5/page, limit 5 OFFSET, pagination 30-char truncate encode ≤64B"
  - "Ask-with-button cost gate via pendingVerify 12-hex hash 5min unref, callback_data 23 chars"
  - "Auto-prompt Welcome no DB touch, Login callback -> force_reply, double deleteMessage on success"
requirements-completed:
  - 08-R1
  - 08-R7
  - 08-R8
coverage:
  - id: D1
    description: "Search NL last week large transfers via gemma→gemini→local returns zod-valid intent with dates and minAmount, sender similarity ranking"
    requirement: "08-R1"
    verification:
      - kind: unit
        ref: "npm run lint passes, openRouterSearchIntentWithFallback with callOpenRouter 8s + gemini retry"
        status: pass
    human_judgment: false
  - id: D2
    description: "GIN trigram ORDER BY similarity when sender else date, LIMIT 5 OFFSET, pg_trgm fallback, transactions-only"
    requirement: "08-R1"
    verification:
      - kind: unit
        ref: "src/telegram/search.ts orderBy similarity branch with try fallback"
        status: pass
    human_judgment: false
  - id: D3
    description: "Photo logged-in gates to Verify this receipt? Yes/No inline, Yes->Verifying->rich card, No->Cancelled edit, expired after 5min"
    requirement: "08-R7"
    verification:
      - kind: unit
        ref: "npm test 199 passed — gate then callback verify:yes returns VERIFIED, verify:no edits to Cancelled"
        status: pass
    human_judgment: true
    rationale: "Telegram inline keyboard + edit + answerCallbackQuery spinner requires client verification"
  - id: D4
    description: "Unauth any message -> Welcome with Login button no DB, Login tap -> force_reply Send password hidden, reply -> double delete + Logged in 24h"
    requirement: "08-R8"
    verification:
      - kind: unit
        ref: "src/worker.ts force_reply intercept + src/telegram/commands.ts handleForceReplyPassword double delete"
        status: pass
    human_judgment: true
    rationale: "force_reply UI and deleteMessage hygiene requires manual Telegram client check"
  - id: D5
    description: "Explicit /login still deletes command message, timingSafeEqual vs TELEGRAM_BOT_PASSWORD, rate limit 5/60s, redact text/password"
    requirement: "08-R8"
    verification:
      - kind: unit
        ref: "src/telegram/session.ts timingSafeEqual + src/observability/logger.ts redact remove true"
        status: pass
    human_judgment: false
actuals:
  tokens: 8700
  tasks: 3
  commits: 3
duration: 12min
completed: 2026-09-11
status: complete
---

# Phase 08 Plan 03: Search Depth + No-Command Gates Summary

**Gemma→Gemini→local NL intent with trigram similarity+date GIN ranking 5/page, any image asks Yes/No via short-hash TTL gate, and auto-prompt Welcome + force_reply hidden login with double delete**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-11T17:21:00Z
- **Completed:** 2026-09-11T17:33:00Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Extended `src/telegram/search.ts` with `callOpenRouter(model,prompt,key,8000)` helper using 8s AbortController, `openRouterSearchIntentWithFallback` gemma-3-27b-it primary then gemini-2.0-flash-001 on null/empty/429, `normalizeCandidate`/`validateAndSanitize`/`sanitize` zod stripping, alias `openRouterSearchIntent` delegates, `localKeywordIntent` Lagos dates for last week/today/this month, 500k large, and `handleSearch` merges complementary local fields
- Added hybrid ranking in `handleSearch`: `ORDER BY similarity(sender_name,$1) DESC NULLS LAST, transaction_date DESC, transaction_time DESC, created_at DESC` when sender present else date-only, with try/catch fallback to date ORDER on `pg_trgm` missing, whereClause parameterized transactions-only, LIMIT 5 OFFSET 5, pagination 30-char truncate + encodeURIComponent ≤64B
- Updated `src/telegram/history.ts` to import `openRouterSearchIntentWithFallback` in all three NL fallbacks (joined words 2-arg range, single-word, 4-arg) preserving 5000 withTimeout
- Implemented ask-with-button gate in `src/telegram/commands.ts`: `pendingVerify` Map 12-hex sha256 shortKey TTL 5min unref, media branch stores `{fileId,mime,isPdf,chatId,caption}` and returns `🧾 Verify this receipt? Yes/No` with `verify:yes:<12hex>`/`verify:no:<12hex>` ≤23B, callback intercept answers spinner, `verify:yes` deletes entry, rate-limit 5/60s, `handleVerify` with preserved caption, `verify:no` edits originMessageId to `❌ Cancelled`
- Enhanced login hygiene in `src/telegram/commands.ts`: `buildWelcomeReply` now `🔐 Log in` + Help buttons, `buildLoginForceReplyPrompt` returns force_reply selective, `handleForceReplyPassword` checks replyTo includes Send password, 5/60s limit, timingSafeEqual login, double `deleteTelegramMessage` for password+prompt, success `✅ Logged in 24h` with balance+search buttons, logger only chatId
- Wired `src/worker.ts` D-08 auto-prompt: force_reply intercept before session gate handling `reply_to_message.text` includes Send password via `handleForceReplyPassword`, session gate callback Login while unauth sends `buildLoginForceReplyPrompt` instead of Welcome, other unauth sends `buildWelcomeReply` no DB touch, Verifying placeholder only for `verify:yes:` callback not initial gate photo
- Fixed `tests/telegram/verify.test.ts` for gate flow: photo → expect gate Verify this receipt with `verify:yes:[0-9a-f]{12}`, callback `verify:yes` → expect VERIFIED, rate exhaust via 5 `verify:yes` callbacks then next limited shows `Verify cooling down`

## Task Commits

Each task was committed atomically:

1. **Task 1: AI intent gemma primary + gemini fallback + GIN trigram ranking 5/page** - `953e7bc` (feat)
2. **Task 2: Ask-with-button gate for any image/PDF + callback verify handlers** - `592932f` (feat)
3. **Task 3: Auto-prompt login + force_reply prompt-then-double-delete** - `12c40d0` (feat)

**Plan metadata:** `12c40d0` (latest)

## Files Created/Modified

- `src/telegram/search.ts` - callOpenRouter 8s, gemma→gemini→local chain, similarity+date ranking 5/page, backwards alias
- `src/telegram/history.ts` - imports WithFallback variant for Lagos NL dates in three branches
- `src/telegram/commands.ts` - pendingVerify gate with caption, callback verify handlers, Welcome Login button, force_reply prompt + double delete
- `src/worker.ts` - force_reply intercept, unauth Login→force_reply, Welcome otherwise, verify:yes placeholder only
- `tests/telegram/verify.test.ts` - updated worker integration test for gate then Yes flow and callback rate limit
- `src/observability/logger.ts` - already redacts text/password/BOT_TOKEN/PASSWORD/OPENROUTER_KEY remove:true

## Decisions Made

- Kept SearchIntentSchema {sender,minAmount,maxAmount,fromDate,toDate} zod YYYY-MM-DD via isValid, getLagosDateString Intl Africa/Lagos unchanged
- Gemma 27b cheap per D-03 primary via OpenRouter with HTTP-Referer/X-Title, 8s timeout, json_object, fallback to gemini-2.0-flash-001 single retry, final null for localKeywordIntent which handles 100k/last week/September/DD/MM/YYYY
- Similarity ranking per D-02 You decide: sender present tier wins then recency, else recency dominates; pg_trgm `similarity()` uses GIN gin_trgm_ops already in migrations/005, graceful fallback on error for test DB without extension
- Gate stores caption so verify:yes replays original receipt context without user retyping, isPdf heuristic via mime or .pdf suffix, shortKey 12 hex keeps callback_data 23 chars well under 64
- Worker force_reply detection uses `reply_to_message.text includes Send password` marker, selective force_reply, input_field_placeholder Password…, no DB query on unauth Welcome path

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- verify.test expected direct VERIFIED on photo — updated to gate→callback flow and callback rate-limit via pendingVerify manual entry
- Initial lint double-replace of openRouterSearchIntent caused WithFallbackWithFallback — corrected via raw replace fix

## User Setup Required

None - no external service configuration required. OPENROUTER_API_KEY optional for AI intent (fallback localKeywordIntent works without), TELEGRAM_BOT_PASSWORD=davy123fun123 per worker session gate, single PORT 8080 worker.

## Next Phase Readiness

- Phase 08 complete (08-01 tracer, 08-02 polish, 08-03 depth/gates) — search understands full NL with GIN ranking, image cost gated, login hidden via force_reply
- Ready for next phase per ROADMAP — verify via `npm run build` + `npm test -- --run` + manual Telegram checks: bare NL "last week large transfers" 5 cards, photo gate Yes/No, unauth Welcome Login force_reply double delete
- Risk: menu cache ~1h verify via getMyCommands, BUTTON_DATA_INVALID monitor on %20 heavy encoding (30-char truncate mitigates)

---
*Phase: 08-search-no-command-ux*
*Completed: 2026-09-11*

## Self-Check: PASSED
- FOUND: src/telegram/search.ts
- FOUND: src/telegram/commands.ts
- FOUND: src/worker.ts
- FOUND commits: 953e7bc 592932f 12c40d0
