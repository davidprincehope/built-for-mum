# Roadmap: Payment Receipt Verification System

## Overview

WhatsApp-based payment verification with Zenith Bank as source of truth: Gmail ingestion → WhatsApp gating → OCR → matching → retry → hardening.

## Phases

- [x] **Phase 1: Zenith Email Ingestion** - Trustworthy transaction ledger from Zenith alerts (live on Railway)
- [x] **Phase 1.1: Telegram Admin (INSERTED)** - Admin Telegram bot: history, worker status, logs, manual poll/history triggers
- [ ] **Phase 2: WhatsApp** - Business API webhook, sender gating, VERIFY PAYMENT sessions
- [ ] **Phase 3: Receipt Processing + OCR** - Media intake, Mistral OCR, confidence handling
- [ ] **Phase 4: Matching Engine** - Deterministic reference/amount/date matching with atomic claim
- [ ] **Phase 5: Retry & Reconciliation** - 60s retry, 5-min agent window, 48h background reconciliation
- [ ] **Phase 6: Production Hardening** - Rate limiting, validation, monitoring, admin tools

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

### Phase 2: WhatsApp
**Goal**: Authorized WhatsApp senders can explicitly trigger payment verification and create verification sessions
**Depends on**: Phase 1
**Requirements**: WhatsApp Business Cloud API webhook verification, sender gating, VERIFY PAYMENT trigger, session management (WAITING_FOR_RECEIPT 15m expiry)
**Success Criteria**:
  1. Only authorized users with active verification session can initiate receipt verification
  2. Webhook verified, sender identified, session created/expired correctly
  3. Unauthorized senders do not trigger OCR/matching
**Plans**: TBD

Plans:
- [ ] 02-01: API/webhook service + sender authorization
- [ ] 02-02: VERIFY PAYMENT trigger + session lifecycle

### Phase 3: Receipt Processing + OCR
**Goal**: Receipt images/PDFs reliably converted into structured transaction data
**Depends on**: Phase 2
**Requirements**: Media download, content_hash, Mistral OCR 4.1 + fallback vision, confidence scoring, file validation
**Success Criteria**:
  1. Receipt images are reliably converted into structured transaction data with strict schema
  2. Low-confidence cases routed to fallback or clearer-image request
**Plans**: TBD

### Phase 4: Matching Engine
**Goal**: Backend reliably distinguishes Confirmed / Needs Review / Mismatch / Not Received and prevents double-claim
**Depends on**: Phase 3
**Requirements**: Level 1 (reference+amount→CONFIRMED), Level 2/3→NEEDS_REVIEW, atomic claim, content_hash reuse block
**Success Criteria**:
  1. Same real transaction never confirms two different receipts
  2. Level 1 only path to automatic CONFIRMED
**Plans**: TBD

### Phase 5: Retry & Reconciliation Engine
**Goal**: Receipt arriving before Zenith email can still become automatically confirmed, including after NOT_RECEIVED
**Depends on**: Phase 4
**Requirements**: next_check_at 60s intervals, 5-min agent window, 24-48h background reconciliation, CONFIRMED_MANUAL audited
**Success Criteria**:
  1. Receipt before email becomes confirmed when email later appears
**Plans**: TBD

### Phase 6: Production Hardening
**Goal**: Production-ready with monitoring, rate limiting, and admin tools
**Depends on**: Phase 5
**Requirements**: Webhook signature validation, rate limiting, file validation, monitoring, backup, audit dashboard, manual verification, data retention
**Success Criteria**:
  1. System handles abuse, retains audit trail, and is operable via dashboard
**Plans**: TBD
