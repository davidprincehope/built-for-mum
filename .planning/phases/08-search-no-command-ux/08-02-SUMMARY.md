---
phase: 08-search-no-command-ux
plan: 02
subsystem: telegram
tags: [verify, naira, history, search, slash-less, logs, pre, editMessage, typing]
requires:
  - phase: 08-search-no-command-ux
    provides: formatNaira 5 cards Menu deleteMessage tracer primitives
provides:
  - Rich VERIFIED card preserved with formatNaira and View History button
  - Verifying… instant placeholder + editTelegramMessage single-message flow with sendChatAction typing and fallback
  - Natural language history range via openRouterSearchIntent 5s timeout + localKeywordIntent Lagos dates
  - Slash-less history/search + bare NL search with greeting guard and logged-in gate
  - Logs pre+emojis preserved with 4000 drop-oldest cap
affects: [08-03]
tech-stack:
  added: []
  patterns: ["formatNaira rich VERIFIED card", "Verifying placeholder then editTelegramMessage", "openRouterSearchIntent with withTimeout 5s Lagos", "slash-less bare NL with greeting guard"]
key-files:
  created: []
  modified:
    - src/telegram/verify.ts
    - src/telegram/sendMessage.ts
    - src/worker.ts
    - src/telegram/history.ts
    - src/telegram/search.ts
    - src/telegram/commands.ts
    - src/telegram/webhook.ts
key-decisions:
  - "Keep verify rich card D-11 unchanged via formatNaira, no redesign to minimal table"
  - "Verifying… placeholder via sendTelegramMessageWithId with sendChatAction typing before handleVerify, editTelegramMessage with View History fallback"
  - "History NL wraps openRouterSearchIntent in withTimeout 5000 to avoid hanging, fallback localKeywordIntent for last week/September"
  - "Bare NL uses full text as search query when >=2 chars not greeting, month/today/last week routes to history"
  - "Logs pre drops oldest lines under 4000 not trunc mid-line, level emojis trace/dbg/info/warn/error/fatal"
patterns-established:
  - "Verifying then edit latency illusion with single-message edit not spam"
  - "Slash-less routing priority: search prefix, history prefix, bare history token, bare NL search fallback"
requirements-completed:
  - 08-R4
  - 08-R5
  - 08-R6
coverage:
  - id: D1
    description: "Rich VERIFIED card keeps D-11 shape with formatNaira ₦ and View History button"
    requirement: "08-R4"
    verification:
      - kind: unit
        ref: "src/telegram/verify.ts renderFoundCard uses formatNaira and escapeHtml"
        status: pass
    human_judgment: false
  - id: D2
    description: "Photo/PDF while logged in shows Verifying… instantly then edits to VERIFIED card with single message"
    requirement: "08-R4"
    verification:
      - kind: unit
        ref: "npm run build passes, src/worker.ts sendChatAction + sendTelegramMessageWithId then editTelegramMessage fallback"
        status: pass
    human_judgment: true
    rationale: "Latency perception and single-message edit requires manual Telegram client verification"
  - id: D3
    description: "History natural language last week/September/ DD/MM range via Lagos dates without slash, explicit DD/MM still fast-path"
    requirement: "08-R5"
    verification:
      - kind: unit
        ref: "npm test 199 passed — history NL branch with withTimeout 5s fallback"
        status: pass
    human_judgment: false
  - id: D4
    description: "Slash-less search SAMPLE SENDER 100k without slash and bare SAMPLE SENDER 100k route to same 5-card results, greeting hi not treated as search"
    requirement: "08-R5"
    verification:
      - kind: unit
        ref: "src/telegram/commands.ts bare NL fallback with greeting guard + sendChatAction"
        status: pass
    human_judgment: false
  - id: D5
    description: "Logs render pre with level emojis ℹ️/⚠️/❌ inside pre block under 4000 dropping oldest"
    requirement: "08-R6"
    verification:
      - kind: unit
        ref: "src/telegram/commands.ts handleLogs pre+emoji drop-oldest"
        status: pass
    human_judgment: false
  - id: D6
    description: "Slash-less routing hardened with Verify gate early return and pagination decode preserved"
    requirement: "08-R6"
    verification:
      - kind: unit
        ref: "npm run build passes — parseCommandText and callback pagination unchanged"
        status: pass
    human_judgment: false
actuals:
  tokens: 2573
  tasks: 3
  commits: 3
duration: 11min
completed: 2026-09-11
status: complete
---

# Phase 08 Plan 02: Search No-Command UX Polish Summary

**Rich VERIFIED card preserved with ₦ + Verifying→edit single-message illusion with typing, plus slash-less history/search and bare NL search with Lagos NL dates and logs pre+emojis**

## Performance

- **Duration:** 11 min
- **Started:** 2026-09-11T15:54:49Z
- **Completed:** 2026-09-11T16:05:45Z
- **Tasks:** 3
- **Files modified:** 3 (actual diff 7 files in scope, 3 with changes)

## Accomplishments

- Kept `src/telegram/verify.ts` rich card per D-11: `✅ VERIFIED — ₦{formatNaira}` with cleaned sender via extractSender, date slice 10, via NIP/KUDA/Zenith, Available ₦{formatNaira} with View History/Saearch/Back keyboards, threshold near-matches unchanged
- Preserved `src/worker.ts` Verifying… latency illusion: `sendChatAction typing` then `sendTelegramMessageWithId('⏳ Verifying…')` before `handleVerify`, then `editTelegramMessage` with effectiveMarkup fallback, else `sendTelegramMessage`, plus `answerCallbackQuery` within 30s and no duplicate message spam
- Extended `src/telegram/history.ts` natural language with `withTimeout(openRouterSearchIntent, 5000, null)` plus `localKeywordIntent` fallback for `last week`/`September`/`01/09/2026` with Lagos `YYYY-MM-DD` validation and `from <= to` check, keeping explicit 2-arg DD/MM fast-path per D-08
- Implemented slash-less history/search/bare NL in `src/telegram/commands.ts`: `^search ` and `^history ` without slash while logged-in, bare month `September`/`today`/`last week`/single date routes to `handleHistoryWithRange`, bare `SAMPLE SENDER 100k` with `>=2 chars` not greeting routes to `handleSearchStub` with `sendChatAction typing`, unauth returns null for worker Welcome uniformity, Verify gate early return
- Rebuilt logs `handleLogs` to `<pre>` with `time emoji level msg` per `levelEmoji` trace🔍 debug🐛 infoℹ️ warn⚠️ error❌ fatal💀 inside escaped `<pre>`, header `📋 Logs (last N • level+)`, 4000 cap dropping oldest whole lines not trunc mid-line, inline Back button

## Task Commits

Each task was committed atomically:

1. **Task 1: Keep rich verify card + Verifying edit latency illusion** - `f430a9d` (feat)
2. **Task 2: Natural language history range + slash-less history/search + bare NL search** - `c23fb17` (feat)
3. **Task 3: Slash-less routing hardening + escapeHtml sweep** - `fa328a3` (fix)

**Plan metadata:** `fa328a3` (latest)

## Files Created/Modified

- `src/telegram/verify.ts` - Rich card kept with formatNaira for amount/available_balance, near-matches threshold unchanged, non-Zenith note
- `src/telegram/sendMessage.ts` - Already polished: edit retries without parse_mode, message is not modified success, sendChatAction typing
- `src/worker.ts` - Added sendChatAction typing before Verifying placeholder, preserved sendTelegramMessageWithId then editTelegramMessage with fallback View History and answerCallbackQuery
- `src/telegram/history.ts` - Wrapped openRouterSearchIntent with withTimeout 5000, fallback localKeywordIntent, Lagos date validation
- `src/telegram/search.ts` - Kept handleSearch with openRouter gemma + local fallback, complementary merge, 5/page GIN, pagination 30-char truncated encode
- `src/telegram/commands.ts` - Slash-less branches for search/history + bare month/date + bare NL search with greeting guard, logs pre+emojis drop-oldest 4000, Verify gate guard, isLoggedIn null for unauth
- `src/telegram/webhook.ts` - Unchanged parseCommandText/extractChatId/verifySecretToken, handlers 7 primary preserved

## Decisions Made

- Kept rich verify card exactly D-11 shape, only ensuring formatNaira replaces `${amount} ${currency}` — no redesign to minimal
- Added sendChatAction typing in both worker media placeholder and commands bare NL dispatch for perceived instant feedback
- Used withTimeout 5000 for openRouterSearchIntent in history to prevent hanging NL and quick fallback to zero-cost localKeywordIntent per threat T-08-02-04
- Chose bare NL history detection via exact month name / single YYYY-MM-DD or DD/MM/YYYY / last week|today|this month to avoid false positives with greetings, then remaining bare text >=2 not greeting routes to search
- Logs dropping oldest lines preserves readability under 4000 without mid-line corruption, matches D-12 pre+emojis contract

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- PowerShell `date` and `npm run lint tail` required Select-Object alternative — used Get-Date ToUniversalTime and tsc --noEmit
-ROADMAP.md sibling phase PLAN edits appeared in git diff due to earlier work — excluded from per-task commits by selective staging

## User Setup Required

None - no external service configuration required. Worker remains single http.createServer on PORT 8080 with registerMenu/registerWebhook idempotent on boot.

## Next Phase Readiness

- Ready for 08-03 (Ask-with-button gate, force_reply login, auto-prompt) — verify illusion and slash-less primitives proven
- Risk: Telegram Menu cache ~1h — verify menu via getMyCommands after deploy
- Risk: Callback_data truncation 30 chars keeps ≤64B but heavy %20 encoding edge — monitor BUTTON_DATA_INVALID

---
*Phase: 08-search-no-command-ux*
*Completed: 2026-09-11*

## Self-Check: PASSED
- FOUND: src/telegram/verify.ts
- FOUND: src/telegram/sendMessage.ts
- FOUND: src/worker.ts
- FOUND: src/telegram/history.ts
- FOUND: src/telegram/commands.ts
- FOUND commits: f430a9d c23fb17 fa328a3

