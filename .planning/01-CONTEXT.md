# Phase 1: Zenith Email Ingestion — Context

**Gathered:** 2026-09-09
**Status:** Ready for planning

## Phase Boundary

Phase 1 delivers a trustworthy, continuously-monitored `transactions` transaction ledger populated exclusively from genuine Zenith Bank transaction alert emails. No WhatsApp, OCR, matching, or customer-facing code ships in this phase. Success is a live ledger you can query (one correct `transactions` row per verified Zenith credit alert within latency budget, spoofed emails never reach the ledger, duplicates never create extra rows, and pipeline silence/breakage is surfaced automatically).

---

## Implementation Decisions

### Gmail Auth & Delivery

- **D-01:** Personal Gmail OAuth (not Workspace service account) — access token + refresh token already obtained. Worker auto-refreshes access token in memory using the refresh token on expiry. No DB/env persistence of rotated tokens required. — **Reversibility:** reversible — switching to Workspace service account later is a config/auth-module swap.
- **D-02:** Delivery is **push as target, polling as continuous safety net** (FR-1.2). A 15-minute polling sweep runs regardless of push health and is the safety net for missed Pub/Sub deliveries — not a cold-start fallback. Polling is the first working cut; push is wired in the same phase.
- **D-03:** GCP Pub/Sub scaffolding is planned **now** (not deferred). Requires a Google Cloud Project with Pub/Sub API enabled, a topic (e.g. `gmail-zenith-notifications`) that Gmail can publish to via `users.watch()`, and a push subscription pointing at the Railway worker. `users.watch()` expires ~every 7 days and the worker must auto-renew it. Access + refresh token already cover the Gmail OAuth scope; GCP project/topic/subscription are the additional manual setup.
- **D-04:** Polling interval stays **15 minutes** as spec'd (`POLL_INTERVAL_MINUTES=15`). Do not shorten to 5 minutes for Phase 1 — lower latency is achieved via Pub/Sub push rather than aggressive polling (still within Gmail API quota, and staleness alerting covers silent failures).

### Zenith Samples & Verification

- **D-05:** Canonical corpus is `zenith_bank_email_format.md` (project root: `Example Project/zenith_bank_email_format.md`). It locks: `From` domain `@zenithbank.com`, subject markers `CREDIT TRANSACTION NOTIFICATION` / `DEBIT TRANSACTION NOTIFICATION` (credit-only in Phase 1, see D-06), HTML table body with fields `Account Number` (masked `999****999`), `Date of Transaction` (`DD/MM/YYYY`), `Amount` (`N{,}NNN.NN`), `Currency` (`NGN`/`USD`/`EUR`/`GBP`), `Description`, `Reference Code`, `Branch`, `Transaction Type`, `Available Balance`, plus outer `Base64` → inner `Quoted-Printable` → UTF-8 HTML decoding. Four description families are documented: `CIP CR/`, `NIP/`, `UP-IB Online Transfer|` (`USSD-NIP`/`MOB/UTO`), and bank charges (`VAT`, `COT`, etc.). Researcher/planner must build against this document, not reinvent patterns.
- **D-06:** **Credit-only scope** for Phase 1 ledger. Only `CREDIT TRANSACTION NOTIFICATION` emails that pass authenticity verification enter `transactions`. `DEBIT TRANSACTION NOTIFICATION` is treated as a non-alert and ignored (logged at debug only), same as statements/marketing/OTPs. — **Reversibility:** reversible — inserting debits later is a classifier flag change, no migration.
- **D-07:** Authenticity verification is **DKIM-only** as spec'd: require `dkim=pass` **and** DKIM signing domain `d=zenithbank.com` from `Authentication-Results`. SPF is not required. Display-name spoofing (`From` display "Zenith Bank" with non-Zenith DKIM domain) must fail and route to `suspicious_emails`.
- **D-08:** Masked account `999****999` is **stored masked as-is** in `sender_account`. No attempt to de-mask, no normalization to last-3 digits, and not relied upon for decisions in Phase 1. — **Reversibility:** reversible.
- **D-09:** Body decoding follows the **strict documented pipeline** (`raw_body → base64_decode → quopri_decode → UTF-8 HTML`) with no silent fallback decoders. Emails using other encodings (7bit, plain HTML) are treated as parse/validation failures and alerted with enough context to diagnose — not silently handled via fallback heuristics.
- **D-10:** Handling of unknown description formats (outside the four families) is **agent discretion** — user said "You decide". Planner should choose between strict (alert on unknown, avoid mis-attributing sender) and lenient (store raw description, flag for review) based on corpus review.

### Tech Stack & Infra

- **D-11:** No hard tech-stack preference — planner/researcher should prioritize **ease of use, troubleshooting, performance, and Railway deployment simplicity**. Agent-built, so choose what is most operable on Railway (expected: Node.js + TypeScript for typing benefits, but researcher may justify JS if build-step avoidance outweighs it). — **Reversibility:** reversible before implementation; one-way after code is written.
- **D-12:** **Fresh Railway project** — new `payment-verification` project with PostgreSQL + single long-running worker service. No API/webhook service in Phase 1 (nothing consumes the ledger externally yet). Secrets via Railway env vars only (NFR-1.2). — **Reversibility:** one-way — project naming/region choice is cheap to rename but infra creation is not free to unwind.
- **D-13:** Worker scheduling via **in-process timers (`setInterval`)** in the single worker process for both the 15-minute poll sweep and the staleness checker. No Postgres-based scheduling or external queue in Phase 1.
- **D-14:** Structured logging is **JSON to stdout** (Railway logs) with `email_message_id` as correlation key across every pipeline stage (received → auth result → parse → validation → dedup → insert). No file rotation or external aggregator in Phase 1.

### Alerting & Monitoring

- **D-15:** Alert channel is **Telegram primary, email fallback** for all FR-1.10 triggers: (a) any email landing in `suspicious_emails` (possible spoof), (b) Zenith-domain + authenticity-verified email that fails parsing/validation (format drift), (c) staleness. `ALERT_WEBHOOK_URL` / env should point at Telegram bot webhook first; email is secondary.
- **D-16:** Staleness check threshold is **60 minutes** (`STALENESS_THRESHOLD_MINUTES=60`) within **business hours 07:00–21:00 Africa/Lagos, every day** (no weekend suppression). Implemented via lightweight scheduled job reading `pipeline_health.last_zenith_email_processed_at`, firing once (not spamming) until a new transaction arrives. — **Reversibility:** reversible — env-var tuning.
- **D-17:** `raw_email` storage is **stripped + capped**: strip large inline images before persistence and enforce a per-row size cap (~100KB) per NFR-1.4. Headers + body kept; attachments dropped.

### Agent's Discretion

- Unknown-description-format policy (D-10) — researcher/planner decides strict vs lenient after reviewing `zenith_bank_email_format.md` samples.
- Concrete Node.js version, TypeScript vs JavaScript final call, library choices (`googleapis`, `pg`, HTML parser), and Railway service sizing — left to researcher/planner under D-11's "ease of use / troubleshooting / performance / deployment" guidance.
- Single vs comma-separated `ZENITH_SENDER_DOMAINS` matching nuance and exact regex construction for subject/body classifiers — use `zenith_bank_email_format.md` regex table as starting point, researcher refines against real headers.

---

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 1 Scope & Architecture

- `.planning/plan.md` — Master architecture plan (Sections 1–6, 24 Phase 1 definition, schema Sections 5.1–5.5, Gmail pipeline Section 6.1–6.2, env vars Section 21). Phase 1 boundary: ledger only, no WhatsApp/OCR/matching.
- `.planning/phase-1-zenith-ingestion-plan.md` — Phase 1 detailed plan (FR-1.1–1.12, NFR-1.1–1.6, data model Section 6, component design Section 7, config Section 8, test plan Section 10). Requirements locked for Phase 1.
- `zenith_bank_email_format.md` — **Critical**: authoritative Zenith email format spec — subject markers, HTML table layout, Base64→QP→HTML decoding, four description families and extraction rules, field regex table, masked account pattern, full crediting example. Parser MUST be built against this.

### Configuration & Environment

- `envExample.example` — Grouped env vars by phase; Phase 1 block defines `DATABASE_URL`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`, `GOOGLE_PUBSUB_TOPIC`/`GOOGLE_PUBSUB_SUBSCRIPTION`, `ZENITH_SENDER_DOMAINS`, `ALERT_WEBHOOK_URL`, `STALENESS_THRESHOLD_MINUTES`, `BUSINESS_HOURS_*`, `POLL_INTERVAL_MINUTES`, plus Phase 2–6 placeholders.

### External Docs Referenced During Discussion

- No additional ADRs or external specs referenced beyond the files above. Gmail Pub/Sub push (`users.watch()` + Cloud Pub/Sub) is documented in plan Section 6.2 / FR-1.2; DKIM verification approach is locked in Section 6.1 / FR-1.4.

---

## Existing Code Insights

### Reusable Assets

- **None** — greenfield project. No codebase exists yet (scout found only `.planning/plan.md`, `.planning/phase-1-zenith-ingestion-plan.md`, and `envExample.example`). No components, patterns, or utilities to reuse.

### Established Patterns

- **None yet** — first phase establishes the project's patterns. Researcher should propose idiomatic Node.js + Railway conventions (env-driven config, JSON logging, UTC timestamps, parameterized Postgres queries) that later phases (WhatsApp, OCR, matching, retry) will inherit.

### Integration Points

- **New integrations introduced in this phase:** Gmail API (OAuth refresh → watch + list/history), Google Cloud Pub/Sub (topic + push subscription for Gmail notifications), PostgreSQL (Railway) with tables `transactions`, `suspicious_emails`, `pipeline_health`. Later phases consume `transactions` as the source of truth but Phase 1 has no downstream consumers yet.

---

## Specific Ideas

- Cooperative name surfaces in NIP narration examples (e.g. `App To Zenith Bank EXAMPLE COOPERATIVE SOCIETY`, `To EXAMPLE S.`, `KIP ZENITH/9999999999`) — confirms the connected inbox belongs to Example Project Cooperative Society; filter logic should not assume narration always contains that string, but examples suggest it often will.
- Description sender extraction examples are literal: `CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER` → sender is text between `CIP CR/` and first `/`; important edge cases include amounts like `100,000.00` with commas, date `DD/MM/YYYY`, and masked accounts.
- No specific UI/UX references — Phase 1 is backend-only (worker + DB), no user-visible surface.

---

## Deferred Ideas

None — discussion stayed within Phase 1 scope. Explicitly out of scope for Phase 1 and deferred to later phases:

- WhatsApp Business Cloud API webhook, sender gating, and `VERIFY PAYMENT` sessions → Phase 2.
- Receipt intake (image/PDF), `content_hash`, Mistral OCR, confidence thresholds, fallback vision model → Phase 3.
- Deterministic matching engine (Level 1 reference+amount → CONFIRMED, Level 2/3 → NEEDS_REVIEW), atomic claim (`matched_receipt_id`), receipt-reuse blocking → Phase 4.
- Retry/reconciliation (`next_check_at`, 60s intervals, 5-min agent window, 24–48h background reconciliation, `CONFIRMED_MANUAL`) → Phase 5.
- Webhook signature validation, rate limiting, admin dashboard, monitoring hardening beyond Phase 1 staleness → Phase 6.
- Multi-bank support and parser framework — noted as future enhancement, not Phase 1.
- Redis/BullMQ queue upgrade and object storage for receipt media — deferred until volume requires it.

---

*Phase: 1-Zenith Ingestion*
*Context gathered: 2026-09-09*
