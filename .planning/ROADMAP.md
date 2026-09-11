# Roadmap: Payment Receipt Verification System

## Overview

WhatsApp-based payment verification with Zenith Bank as source of truth: Gmail ingestion → WhatsApp gating → OCR → matching → retry → hardening.

## Phases

- [x] **Phase 1: Zenith Email Ingestion** - Trustworthy transaction ledger from Zenith alerts (live on Railway)
- [x] **Phase 1.1: Telegram Admin (INSERTED)** - Admin Telegram bot: history, worker status, logs, manual poll/history triggers
- [x] **Phase 2: Telegram Ledger Assistant** - Admin via Telegram: verify via images/text/PDFs, balance, history with date ranges, security
- [ ] **Phase 3: Receipt Processing + OCR** - Media intake, Mistral OCR, confidence handling
- [ ] **Phase 4: Matching Engine** - Deterministic reference/amount/date matching with atomic claim
- [ ] **Phase 5: Retry & Reconciliation** - 60s retry, 5-min agent window, 48h background reconciliation
- [ ] **Phase 6: Production Hardening** - Rate limiting, validation, monitoring, admin tools
- [x] **Phase 7: UX Overhaul** - Drastically improve horrible UX — polished with cards, menu, Verifying edit, natural language history
- [ ] **Phase 8: Search & No-Command UX** - Make search much better and bot usable without typing commands
- [ ] **Phase 8: Search & No-Command UX** - Make search much better and bot usable without typing commands

## Phase Details

### Phase 1: Zenith Email Ingestion

**Goal**: Trustworthy, continuously-monitored `transactions` ledger populated exclusively from genuine Zenith Bank transaction alert emails
**Depends on**: Nothing (first phase)
**Requirements**: FR-1.1..FR-1.12, NFR-1.1..NFR-1.6
**Success Criteria**:

  1. Every valid Zenith credit alert becomes one correct `transactions` row within 15 min (2 min via push)
  2. Spoofed email never reaches `transactions`, lands in `suspicious_emails` with alert
  3. Same email processed twice never duplicates
  4. Parse failure distinct from non-Zenith, staleness fires after 60m during 07:00-21:00 Africa/Lagos

**Plans**: 4 plans (01-01 tracer, 01-02 parsing, 01-03 gmail, 01-04 monitoring) — all executed, 134 tests green, live on Railway example.com

Plans:

- [x] 01-01: Tracer — Railway + Postgres + migrations + OAuth + processEmail
- [x] 01-02: Parsing — cheerio table, 4 description families, credit-only, zod, 100KB cap
- [x] 01-03: Gmail — users.watch + Pub/Sub push + 15-min poll
- [x] 01-04: Monitoring — heartbeat, staleness 60s, Telegram alerter

### Phase 1.1: Telegram Admin (INSERTED)

**Goal**: Telegram bot supports admin operations for the live ledger — query history, check worker health, view logs, trigger manual poll/history
**Depends on**: Phase 1
**Requirements**: Telegram command handling (history, status, logs, poll, watch, health), admin allowlist, worker status via pipeline_health + DB count, log tail via Railway logs, manual poll/history trigger
**Success Criteria**:

  1. Admin can query recent transactions and pipeline health via Telegram
  2. Admin can check worker status and tail logs via Telegram
  3. Admin can manually trigger poll/history sweep via Telegram and see result

**Plans**: 1 plan

Plans:

- [x] 01.1-01 — Telegram admin webhook + 7 commands + ring buffer 500 + allowlist/rate-limit + poll/watch triggers on existing worker (wave 1) — 2026-09-10

### Phase 2: Telegram Ledger Assistant

**Goal**: Admin via Telegram can verify transactions via images/text/PDFs (multi-modal deterministic match on live transactions via OpenRouter vision only when necessary), check current available_balance + current_balance + last TX, and query history with Lagos date ranges description-first capped 50 with full-text AI search (well-researched GIN trigram DB architecture, 4096 cap), secured by Telegram webhook secret + password /login 24h session (no allowlist, replacing WhatsApp) with rate-limit, no PII logs, temp 24h
**Depends on**: Phase 1
**Requirements**: 2-R1 Telegram webhook secret + password /login 24h (no allowlist) + rate limit + no PII, 2-R2 verify via text/media (image/PDF/free-form) deterministically on transactions, 2-R3 balance from available_balance (both balances + last TX), 2-R4 history date range description-first Lagos capped 50, 2-R5 security (secret, no allowlist, 24h session, rate limit, no PII, temp 24h), 2-R6 helpful add-ons (summary, suspicious, export CSV sendDocument, duplicates, search AI very important)
**Success Criteria**:

  1. Only authenticated Telegram session (after /login <TELEGRAM_BOT_PASSWORD> with timingSafeEqual, 24h Map TTL) with valid X-Telegram-Bot-Api-Secret-Token can trigger ledger reads; unauthenticated gets login prompt with no DB touch and no password logged (D-11, D-12)
  2. Webhook secret header timingSafeEqual lowercased before parse; /balance reads bank's own balances ORDER BY transaction_date DESC, transaction_time DESC, created_at DESC; /history supports DD/MM/YYYY + YYYY-MM-DD Lagos inclusive BETWEEN capped 50 description-first via extractSender with 4096 pagination (D-07, D-08, D-10)
  3. /verify handles image/PDF/free-form text via 2-step getFile 20MB SHA256 24h tmp dedup + pdf-parse local-first then OpenRouter vision/file only when necessary + deterministic SELECT + near-matches threshold + non-Zenith note (D-01..D-06, D-13)
  4. Search full-text via OpenRouter AI intent→parameterized GIN SQL, plus summary 24h/7d, export CSV sendDocument, duplicates GROUP BY HAVING all on existing PORT 8080 worker reusing pino ring 500 + rateLimit, no new runtime deps beyond pdf-parse (D-09, D-14)

**Plans**: 3/3 plans executed (02-01 tracer, 02-02 verify, 02-03 add-ons) — Phase 2 complete

Plans:

- [x] 02-01-PLAN.md
- [x] 02-02-PLAN.md
- [x] 02-03-PLAN.md
- [x] 02-01: Tracer — Telegram password /login 24h session replacing allowlist + webhook secret on PORT 8080 + balance + history Lagos DD/MM|ISO cap 50 description-first + GIN indexes (2-R1,2-R3,2-R4,2-R5)
- [x] 02-02: Verify via text + media 2-step getFile→/file 20MB + SHA256 24h tmp dedup + pdf-parse first then OpenRouter vision only when necessary → deterministic SELECT + near-matches (2-R2,2-R5)
- [x] 02-03: Helpful add-ons — summary 24h/7d, search AI intent→GIN SQL, export CSV via sendDocument, duplicates hunt (2-R6)

### Phase 3: Receipt Processing + OCR

**Goal**: Receipt images/PDFs reliably converted into structured transaction data
**Depends on**: Phase 2
**Requirements**: Media download, content_hash, Mistral OCR 4.1 + fallback vision, confidence scoring, file validation
**Success Criteria**:

  1. Receipt images are reliably converted into structured transaction data with strict schema
  2. Low-confidence cases routed to fallback or clearer-image request

**Plans**: TBD

### Phase 8: Search & No-Command UX

**Goal**: Make search much better and make the bot usable without typing any commands — every interaction via buttons, menus, and natural language
**Depends on**: Phase 7
**Requirements**: Full-text AI search with DB GIN trigram + amount/date, inline keyboards and persistent menu for all commands, natural language entry
**Success Criteria**:

  1. Admin can find any transaction via natural language search with accurate results
  2. Admin never needs to type a slash command — all actions via buttons/menu

**Plans**: 3/3 plans executed

- [x] 08-01-PLAN.md
- [x] 08-02-PLAN.md
- [x] 08-03-PLAN.md

### Phase 4: Matching Engine

**Goal**: Backend reliably distinguishes Confirmed / Needs Review / Mismatch / Not Received and prevents double-claim
**Depends on**: Phase 3
**Requirements**: Level 1 (reference+amount→CONFIRMED), Level 2/3→NEEDS_REVIEW, atomic claim, content_hash reuse block
**Success Criteria**:

  1. Same real transaction never confirms two different receipts
  2. Level 1 only path to automatic CONFIRMED

**Plans**: TBD

### Phase 8: Search & No-Command UX

**Goal**: Make search much better and make the bot usable without typing any commands — every interaction via buttons, menus, and natural language
**Depends on**: Phase 7
**Requirements**: Full-text AI search with DB GIN trigram + amount/date, inline keyboards and persistent menu for all commands, natural language entry
**Success Criteria**:

  1. Admin can find any transaction via natural language search with accurate results
  2. Admin never needs to type a slash command — all actions via buttons/menu

**Plans**: TBD

### Phase 5: Retry & Reconciliation Engine

**Goal**: Receipt arriving before Zenith email can still become automatically confirmed, including after NOT_RECEIVED
**Depends on**: Phase 4
**Requirements**: next_check_at 60s intervals, 5-min agent window, 24-48h background reconciliation, CONFIRMED_MANUAL audited
**Success Criteria**:

  1. Receipt before email becomes confirmed when email later appears

**Plans**: TBD

### Phase 8: Search & No-Command UX

**Goal**: Make search much better and make the bot usable without typing any commands — every interaction via buttons, menus, and natural language
**Depends on**: Phase 7
**Requirements**: Full-text AI search with DB GIN trigram + amount/date, inline keyboards and persistent menu for all commands, natural language entry
**Success Criteria**:

  1. Admin can find any transaction via natural language search with accurate results
  2. Admin never needs to type a slash command — all actions via buttons/menu

**Plans**: TBD

### Phase 6: Production Hardening

**Goal**: Production-ready with monitoring, rate limiting, and admin tools
**Depends on**: Phase 5
**Requirements**: Webhook signature validation, rate limiting, file validation, monitoring, backup, audit dashboard, manual verification, data retention
**Success Criteria**:

  1. System handles abuse, retains audit trail, and is operable via dashboard

**Plans**: TBD

### Phase 8: Search & No-Command UX

**Goal**: Make search much better and make the bot usable without typing any commands — every interaction via buttons, menus, and natural language
**Depends on**: Phase 7
**Requirements**: Full-text AI search with DB GIN trigram + amount/date, inline keyboards and persistent menu for all commands, natural language entry
**Success Criteria**:

  1. Admin can find any transaction via natural language search with accurate results
  2. Admin never needs to type a slash command — all actions via buttons/menu

**Plans**: TBD

### Phase 7: UX Overhaul

**Goal**: Drastically improve horrible UX at every point of interaction — display to use, more intuitive
**Depends on**: Phase 2
**Requirements**: D-01 card-per-TX 10/page, D-02 status card, D-04 help+keyboard, D-05/D-15 Menu Button, D-06 login, D-07 any image=verify, D-08 NL history, D-09 rich FOUND, D-10 near-matches, D-11 cleaned sender, D-12 Verifying edit, D-13 Welcome, D-14 friendly errors, D-16 slash-less search, D-17 deleteMessage
**Success Criteria**:

  1. Every Telegram interaction is intuitive, professional, and requires minimal admin effort
  2. Display is clean, consistent, and guides the admin naturally

**Plans**: 3/3 plans executed (07-01 tracer, 07-02 verify polish, 07-03 NL history + slash-less + pagination) — Phase 7 complete

Plans:

- [x] 07-01-PLAN.md — Tracer: deleteMessage for /login, card-per-TX history 10/page, Welcome card, friendly errors, Menu Button on PORT 8080
- [x] 07-02-PLAN.md — Verify polish: rich FOUND/NOT_FOUND cards, Verifying… then edit, cleaned sender, near-matches threshold
- [x] 07-03-PLAN.md — NL history via gemma + slash-less search/history + inline pagination 10/page
