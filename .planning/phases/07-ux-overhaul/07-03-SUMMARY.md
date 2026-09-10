---
phase: 07-ux-overhaul
plan: 03
subsystem: telegram-ux
tags: [telegram, natural-language, gemma, slash-less, pagination, callback, history, search]

requires:
  - phase: 07-ux-overhaul
    provides: verify polish with Verifying edit illusion, rich cards, cleaned sender
provides:
  - Natural-language history "last week"/"September" via OpenRouter gemma with fast path for explicit dates
  - Slash-less "search …" and "history …" entry when logged in (D-16)
  - Inline pagination Next/Prev with callback_data ≤64B, truncated query ≤30 chars, answerCallbackQuery on every tap
affects: [telegram-history, telegram-search, leder-display, user-discovery]

actuals:
  tokens: 2326
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns: ["NL history via gemma with explicit fast path", "slash-less routing before slash guard", "truncated callback_data for ≤64B pagination"]

key-files:
  created: []
  modified: [src/telegram/history.ts, src/telegram/commands.ts, src/telegram/search.ts]

key-decisions:
  - "NL history fast path: parseLagosDateRange first, only call gemma when explicit fails AND args contain letter words AND no args look like explicit date format"
  - "Slash-less routing added BEFORE startsWith('/') return null, guarded by isLoggedIn(chatId), limited to explicit 'search '/history ' prefixes"
  - "Search callback_data truncates to 30 chars before encodeURIComponent to keep total ≤64B even with % encoding"
  - "When explicit date args contain one invalid token (e.g. 'bad-date 2026-09-10'), return parse error instead of falling to NL intent"

requirements-completed: [07-R8, 07-R9]

coverage:
  - id: D1
    description: "Natural-language history 'last week'/'September' via gemma with Africa/Lagos today, explicit DD/MM|ISO fast path bypasses AI"
    requirement: "07-R8"
    verification:
      - kind: unit
        ref: "tests/telegram/history.test.ts#invalid date args returns friendly error under 4096 cap"
        status: pass
    human_judgment: false
  - id: D2
    description: "Slash-less 'search ...' and 'history ...' when logged in routes to same handlers as slash variants; unauth gets Welcome"
    requirement: "07-R9"
    verification:
      - kind: other
        ref: "code review — src/telegram/commands.ts lines 725-752"
        status: pass
    human_judgment: false
  - id: D3
    description: "Inline pagination for history/search with ≤64B callback_data, truncated query ≤30 chars, answerCallbackQuery on every tap, 4096 safe"
    requirement: "07-R9"
    verification:
      - kind: unit
        ref: "tests/telegram/history.test.ts#provides inline Next pagination when total > limit"
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-09-10
status: complete
---

# Phase 7 Plan 03: Natural-Language History + Slash-Less Entry + Pagination Polish Summary

**NL history via gemma with explicit fast path, slash-less "search" and "history" entry, inline Next/Prev pagination with ≤64B callback and spinner dismissal on single PORT 8080**

## Performance

- **Duration:** 13 min
- **Started:** 2026-09-10T21:51:00Z
- **Completed:** 2026-09-10T22:03:48Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Natural-language history "last week"/"September" and other NL phrases route through OpenRouter gemma with Africa/Lagos today context, extracting only fromDate/toDate, validated via zod YYYY-MM-DD regex + from<=to, falling back to localKeywordIntent on 429/null — explicit DD/MM/YYYY or YYYY-MM-DD bypasses AI entirely
- Slash-less "search ..." and "history ..." entry (case-insensitive) added before the `startsWith('/')` early return in handleTelegramUpdate, guarded by isLoggedIn(chatId), identical handler dispatch to slash variants, bare "SAMPLE SENDER 100k" without prefix does not false-trigger
- Inline pagination callback_data for search truncated from 60 to 30 chars before encodeURIComponent (≤64B per RESEARCH Pitfall 1); history already uses short `/history 10 {offset}` (~14B) for default and `/history {from} {to} {limit} {offset}` (~36B) for range; answerCallbackQuery called on every callback_query path including error branches

## Task Commits

Each task was committed atomically:

1. **Task 1: Natural-language history via gemma with explicit fast path** - `26104dd` (feat)
2. **Task 2: Slash-less search and history entry when logged in** - `a7506f4` (feat)
3. **Task 3: Inline pagination for history/search with ≤64B callback and spinner dismissal** - `b83ab92` (feat)

**Deviation fix:** `bc5676f` (fix — NL history fallback skip when explicit date format detected)

**Plan metadata:** (*pending*)

## Files Created/Modified

- `src/telegram/history.ts` - Added NL branch: explicit parse via parseLagosDateRange first, then gemma for letter words with Africa/Lagos today, 429/null fallback to localKeywordIntent, zod YYYY-MM-DD validation, explicit date detection guard to prevent NL fallback when user intended explicit syntax
- `src/telegram/commands.ts` - Added slash-less "search ..." / "history ..." branch before startsWith('/') guard in handleTelegramUpdate, guarded by isLoggedIn(chatId), routes to same handleSearchStub/handleHistoryWithRange handlers
- `src/telegram/search.ts` - Reduced callback_data truncation from 60 to 30 chars before encodeURIComponent to stay ≤64B per RESEARCH Pitfall 1

## Decisions Made

- NL history fast path executes parseLagosDateRange first, only calls gemma when explicit parse fails AND args contain letter words AND no args look like explicit date format — conserves money (T-07-15) and ensures explicit date syntax never triggers AI
- Slash-less routing is additive: existing slash commands untouched, only adds branch before return null, guarded by isLoggedIn to maintain the session gate
- Search callback_data truncation reduced to 30 chars (from 60) to guarantee ≤64B after % encoding of worst-case queries
- Explicit date detection guard added: when parseLagosDateRange fails but at least one arg looks like YYYY-MM-DD or DD/MM/YYYY, return the parse error instead of allowing localKeywordIntent to silently extract valid dates from other args

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] NL history fallback picked up valid date from second arg, bypassing first-arg error**
- **Found during:** Task 3 verification (`npm test`)
- **Issue:** `handleHistoryWithRange(['bad-date', '2026-09-10'])` silently used "2026-09-10" via localKeywordIntent instead of showing the parse error for "bad-date"
- **Fix:** Added `hasExplicitDates` check before NL fallback: if any arg looks like YYYY-MM-DD or DD/MM/YYYY, return the explicit parse error directly
- **Files modified:** `src/telegram/history.ts`
- **Verification:** `npm test` 199/199 pass, history.test.ts 10/10 pass including the previously failing test
- **Committed in:** `bc5676f`

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Fix required to preserve explicit-date error behavior — the test expected the parse error to surface, not be silently overridden by NL fallback.

## Issues Encountered

- Tasks 1 and 2 were already committed from prior wave execution (part of the tracer pattern). Task 3 implementation was additive: search.ts truncation change (60→30 chars) was uncommitted and committed as part of this plan execution.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- NL history, slash-less entry, and pagination polish complete
- All relevant tests pass (199/199)
- Lint clean, build succeeds
- Ready for phase verification and ship

---

*Phase: 07-ux-overhaul*
*Completed: 2026-09-10*

## Self-Check: PASSED
- Files exist: `.planning/phases/07-ux-overhaul/07-03-SUMMARY.md`
- Commits exist: `26104dd`, `a7506f4`, `b83ab92`, `bc5676f`, `c297286`
- `npm run lint` passes, `npm run build` passes, `npm test` 199/199 passes