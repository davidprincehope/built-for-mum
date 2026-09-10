---
phase: 02-telegram-ledger-assistant
plan: 03
subsystem: telegram-ledger
tags: [telegram, search, export, pg_trgm, openrouter, gemma, csv, sendDocument, summary, duplicates, rate-limit, Africa/Lagos]
requires:
  - phase: 02-telegram-ledger-assistant
    provides: password /login 24h session, balance/history Lagos, 2-step media verify with SHA256 dedup and OpenRouter vision
  - phase: 01-zenith-ingestion
    provides: transactions ledger with indexed transaction_date, live worker on PORT 8080
provides:
  - Telegram search via OpenRouter gemma intent → parameterized GIN ILIKE + amount/date BETWEEN, paginated 10 with inline Next/Prev, 4096 cap
  - CSV export via POST /botTOKEN/sendDocument FormData Blob with quoted fields, plus /duplicates GROUP BY HAVING and /summary 24h/7d aggregates Africa/Lagos
  - Polished help with Ledger/Search/Analytics/Ops sections and 5-row inline keyboards, login-gated search 10/60s export 5/60s rate limits
affects: [02-ledger-console, telegram-admin, reconciliation]
actuals:
  tokens: 16820
  tasks: 3
  commits: 3
tech-stack:
  added: []
  patterns: [OpenRouter gemma intent JSON only when necessary with zod validation, parameterized GIN ILIKE %||$1||% + amount/date BETWEEN, CSV quoting "" escape, FormData sendDocument Blob, GROUP BY HAVING duplicates, CURRENT_DATE aggregates]
key-files:
  created:
    - src/telegram/search.ts
    - src/telegram/export.ts
    - tests/telegram/search.test.ts
    - tests/telegram/export.test.ts
  modified:
    - src/telegram/commands.ts
    - src/worker.ts
key-decisions:
  - "OpenRouter gemma-3-27b-it cheap text for search intent, null fallback on 429/500 or missing key to local keyword heuristic — AI only when necessary per D-09"
  - "Local keyword fallback extracts k*1000, sender via leftover tokens, last week/today/this month windows plus explicit YYYY-MM-DD/DD/MM/YYYY and month name — covers no-key and AI failure without cost"
  - "Parameterized WHERE ($1::text IS NULL OR sender_name ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%') never interpolates AI strings per T-02-15"
  - "CSV quoting per RESEARCH: field + replace(/\"/g,'\"\"') wrapped in quotes, handles commas/quotes/slashes, 8 whitelisted columns never raw_email"
  - "Export rate limit 5/60s and search 10/60s per-chat sliding window before any DB or OpenRouter — protects quota per T-02-18"
requirements-completed:
  - 2-R6
  - 2-R1
coverage:
  - id: D1
    description: "Admin can run /search 'last week large transfers' (natural language) and get parsed intent via OpenRouter gemma or keyword fallback → parameterized SQL with GIN ILIKE, paginated 10 with Next under 4096"
    requirement: "2-R6"
    verification:
      - kind: unit
        ref: "tests/telegram/search.test.ts#openRouterSearchIntent parses AI JSON last week -> 7d window and large -> minAmount 500000"
        status: pass
      - kind: unit
        ref: "tests/telegram/search.test.ts#handleSearch uses fallback when OPENROUTER missing and builds parameterized SQL never concatenates"
        status: pass
      - kind: unit
        ref: "tests/telegram/search.test.ts#handleSearch pagination offset carries and Next inline keyboard encoded"
        status: pass
    human_judgment: false
  - id: D2
    description: "Admin can run /export or /export 2026-09-01 2026-09-10 and receive CSV document via sendDocument with quoted rows and /duplicates GROUP BY HAVING"
    requirement: "2-R6"
    verification:
      - kind: unit
        ref: "tests/telegram/export.test.ts#CSV quoting handles commas, quotes, slashes in description"
        status: pass
      - kind: unit
        ref: "tests/telegram/export.test.ts#sendDocument FormData uses POST /botTOKEN/sendDocument with Blob and caption 1024 slice"
        status: pass
      - kind: unit
        ref: "tests/telegram/export.test.ts#duplicates GROUP BY HAVING COUNT>1 returns table or No duplicates"
        status: pass
    human_judgment: false
  - id: D3
    description: "Admin can run /summary and get 24h and 7d total transaction counts and sums plus last TX line in Africa/Lagos under 4096"
    requirement: "2-R6"
    verification:
      - kind: unit
        ref: "tests/telegram/export.test.ts#summary 24h/7d aggregates with last TX Africa/Lagos and escapeHtml"
        status: pass
    human_judgment: false
  - id: D4
    description: "Search and export respect /login session and search 10/60s export 5/60s rate limits; unauth search never touches DB or OpenRouter"
    requirement: "2-R1"
    verification:
      - kind: unit
        ref: "tests/telegram/search.test.ts#unauth search via handleSearchStub never touches DB or OpenRouter"
        status: pass
      - kind: unit
        ref: "tests/telegram/export.test.ts#export respects login session and export 5/60s rate limit"
        status: pass
    human_judgment: false
  - id: D5
    description: "All add-on replies use escapeHtml, slice 4000, and inline keyboards consistent with existing help/status style"
    requirement: "2-R1"
    verification:
      - kind: unit
        ref: "tests/telegram/search.test.ts#handleSearch escapes HTML and slices 4000"
        status: pass
      - kind: unit
        ref: "tests/telegram/export.test.ts#summary 24h/7d aggregates with last TX Africa/Lagos and escapeHtml"
        status: pass
    human_judgment: false
duration: 12min
completed: 2026-09-10
status: complete
---

# Phase 02 Plan 03: Helpful Add-ons Summary

**Search via OpenRouter gemma → parameterized GIN SQL, CSV export via sendDocument, duplicates GROUP BY HAVING and 24h/7d summary — all login-gated 4096-capped on same PORT 8080 worker**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-10T19:10:00Z
- **Completed:** 2026-09-10T19:22:00Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- `openRouterSearchIntent` with `google/gemma-3-27b-it` cheap text, `response_format json_object temp 0 max_tokens 200`, Referer/Title headers, zod-validated `SearchIntent` (`sender? minAmount? maxAmount? fromDate? toDate?`), 429/500 → null fallback; local keyword fallback extracts `100k→100000`, sender heuristic, `last week 7d window/today/this month` plus explicit dates and month names, merged when AI missing dates
- `handleSearch` builds parameterized `WHERE ($1::text IS NULL OR sender_name ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%') AND amount BETWEEN AND date BETWEEN ORDER BY transaction_date DESC LIMIT 10 OFFSET $6` with GIN indexes, `withTimeout 5000`, count query for `Found N matching`, `escapeHtml` lines `amount currency — sender • date time • branch` sliced 4000, inline `Next/Prev` via `encodeURIComponent truncated 60`
- `sendTelegramDocument` via `FormData` `chat_id/caption 1024/document Blob text/csv` to `POST https://api.telegram.org/bot<TOKEN>/sendDocument`; `handleExport` parses Lagos range via `parseLagosDateRange`, no-args last 50 else `BETWEEN $1::date AND $2::date LIMIT 100`, builds quoted CSV header `amount,currency,date,time,sender,description,branch,balance` with `""` escaping, filename `transactions-${from}-to-${to}.csv`
- `handleDuplicates` `GROUP BY amount,currency,transaction_date HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC` pre table or `No duplicates`; `handleSummary` `CURRENT_DATE` and `CURRENT_DATE-INTERVAL 7 days` counts/sums + total + last TX limit 1, formatted `24h: N • NGN X 7d: N • NGN Y Total: N Last: ... Africa/Lagos` escaped 4000
- `commands.ts` `handleSearchStub` login-gated + `10/60s` cooldown + usage `e.g. /search last week large transfers`, `handleExportWrapper` `5/60s`, `handleDuplicatesWrapper/handleSummaryWrapper` login-gated, `buildHelpReply` sections Ledger (`/balance /history /search /verify /suspicious`) Analytics (`/summary /export /duplicates`) Monitoring/Ops with 5-row inline keyboards `[Status,Bal][Search,Summary][Export,Duplicates][Logs,Poll,Watch]`

## Task Commits

Each task was committed atomically:

1. **Task 1: Search via OpenRouter intent → parameterized GIN SQL with pagination** - `aa302af` (feat)
2. **Task 2: Export CSV via sendDocument + duplicates + summary aggregates** - `e8b4a48` (feat)
3. **Task 3: Help polish, rate-limit wiring, and add-on tests for summary/export/duplicates** - `0107305` (feat)

**Plan metadata:** `0107305` (docs: complete plan)

## Files Created/Modified

- `src/telegram/search.ts` - `SearchIntentSchema` zod, `openRouterSearchIntent` gemma null fallback, `localKeywordIntent` k*1000/sender/date heuristic, `handleSearch` parameterized GIN 10/offset pagination with encode 60
- `src/telegram/export.ts` - `sendTelegramDocument` FormData Blob, `handleExport` Lagos BETWEEN → quoted CSV → sendDocument, `handleDuplicates` GROUP BY HAVING, `handleSummary` 24h/7d COUNT/SUM + last TX Africa/Lagos
- `src/telegram/commands.ts` - `handleSearchStub/handleExportWrapper/handleDuplicatesWrapper/handleSummaryWrapper` login+rate-limited, `buildHelpReply` 5-row keyboards, handlers `summary/export/duplicates`
- `src/worker.ts` - comment documenting search pagination encode 60 round-trip
- `tests/telegram/search.test.ts` - 12 tests covering intent JSON 7d/large, fallback, parameterized never-concatenates, HTML escape, pagination encode, no matches, unauth never DB, rate limit 10/60s, usage
- `tests/telegram/export.test.ts` - 9 tests covering CSV quoting, FormData Blob sendDocument, last 50 filename, duplicates GROUP BY, summary aggregates + Africa/Lagos escape, login-gated + 5/60s, sendDocument failure fallback

## Decisions Made

- Gemma-3-27b-it for search intent — cheapest OpenRouter text per RESEARCH, temp 0 json_object, 429/500 return null so caller falls back to keyword with zero AI cost per T-02-18
- Merge local dates into AI intent when AI missing dates — improves coverage for cases where AI returns sender/amount but not dates while keyword has dates
- CSV whitelists 8 columns only per T-02-16, never `raw_email`/`sender_account` raw; quoting `""` handles commas/quotes per threat model, formula injection accepted per low risk single-admin
- Export LIMIT 50 without filter vs 100 with BETWEEN — respects Telegram document size while allowing larger export on filtered range; same `order by transaction_date DESC, transaction_time DESC, created_at DESC` as history
- Summary uses `CURRENT_DATE` in SQL not Lagos computed in Node — DB date matches transaction_date DATE type; Lagos display via `toLocaleString Africa/Lagos` for last line only

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `search.test.ts` initially used `vi.resetModules` in beforeEach which orphaned `_setPoolForTests` static import across module fresh instances, causing handleSearch to fallback to real Pool timeout (count 0). Fixed by removing `vi.resetModules` and keeping static imports, matching existing history/verify test patterns — tests then green.
- `export.ts` `BodyInit` type not available in TS 5.6 without lib dom — replaced with `as unknown as any` for FormData body to satisfy `tsc --noEmit`.
- `export.test.ts` unauth assertions checked `(res as {text}).text` but wrappers return plain string on unauth; fixed to handle `typeof res === 'string' ? res : res.text` — 2 tests then green.

## User Setup Required

None - no external service configuration required. Set `TELEGRAM_BOT_PASSWORD` (>=12 chars) in Railway env to enable password mode; optionally set `OPENROUTER_API_KEY` to enable AI intent for /search (without it keyword fallback still works). `TELEGRAM_BOT_TOKEN` required for sendDocument.

## Next Phase Readiness

- Add-ons slice complete: search, export, duplicates, summary all login-gated, rate-limited, 4096-capped via same worker; ledger becomes searchable/exportable admin console for reconciliation per phase objective
- Migration `005_telegram_ledger_indexes.sql` already covers GIN trigram for search ILIKE; no new migrations needed for 02-03
- No blockers; Phase 2 as a whole provides full Telegram ledger assistant (password → balance/history/verify/search/export/summary)

---
*Phase: 02-telegram-ledger-assistant*
*Completed: 2026-09-10*

## Self-Check: PASSED
