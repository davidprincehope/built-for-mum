# Phase 1 — Zenith Email Ingestion: Detailed Plan

Companion document to the master architecture plan. This expands **Phase 1**
into concrete requirements, component design, and a test plan — everything
needed to build and sign off on the transaction ledger before any
customer-facing work begins.

---

## 1. Goal

Produce a trustworthy, continuously-monitored `transactions` table that is
populated exclusively from genuine Zenith Bank transaction alert emails,
with nothing downstream (WhatsApp, OCR, matching) yet depending on it.

At the end of Phase 1, it should be possible to:

- Forward or receive a real Zenith transaction alert and see a correct,
  deduplicated row appear in `transactions` within a defined latency
  budget.
- Trust that every row in `transactions` passed cryptographic sender
  verification — not a display-name check.
- Know, without manually checking the inbox, whether the pipeline is
  currently healthy or has gone silent/broken.

---

## 2. Scope

### In scope

- Minimal Railway infrastructure: PostgreSQL + one worker service (no
  API/webhook service yet — nothing consumes this data externally in
  Phase 1).
- Gmail API connection and email retrieval (push preferred, poll as
  fallback/reconciliation).
- Zenith sender/domain identification.
- DKIM/SPF/domain-based authenticity verification.
- Zenith transaction-alert parser (email → structured JSON).
- Field validation against a strict schema.
- Deduplication on `email_message_id`.
- Persistence to `transactions`.
- Persistence of failed-authenticity emails to `suspicious_emails`.
- Heartbeat/staleness monitoring and alerting.
- Parse-failure alerting (distinct from "not a Zenith email").
- Structured logging for every step.
- Full unit/integration/edge-case test suite for the above.

### Out of scope (explicit non-goals for Phase 1)

- WhatsApp, OCR, matching engine, retry/reconciliation logic — all later
  phases.
- Admin dashboard / UI for browsing transactions (Phase 6).
- Multi-bank support.
- Push-based Gmail via Pub/Sub is *included as the target*, but a working
  polling-only version is an acceptable first cut if push setup is
  blocked — see FR-1.2.

---

## 3. Success Definition / Exit Criteria

Phase 1 is done when **all** of the following hold:

1. A real Zenith transaction alert, forwarded or received into the
   connected Gmail account, results in exactly one correct row in
   `transactions` without manual intervention.
2. A forged/spoofed email that merely *looks* like it's from Zenith
   (wrong DKIM domain) never reaches `transactions` and instead lands in
   `suspicious_emails` with an alert fired.
3. The same email processed twice (e.g. due to a worker restart mid-poll)
   never produces a duplicate `transactions` row.
4. A Zenith-domain email that the parser cannot extract fields from
   triggers an alert distinguishable from "not a Zenith email."
5. If no Zenith email is processed for longer than the configured
   staleness threshold during business hours, an alert fires automatically.
6. The full test suite in Section 10 passes, including the negative and
   security cases.

---

## 4. Functional Requirements

Each requirement has an ID for traceability into the test plan (Section 10).

### FR-1.1 — Gmail connection
The worker must authenticate to the target Gmail account and be able to
read new mail. Prefer a Google Workspace service account with
domain-wide delegation; fall back to a standard OAuth2 client with a
long-lived refresh token if the account is not on Workspace.

### FR-1.2 — Ingestion mechanism
New mail must be detected via Gmail push notifications (`users.watch` +
Cloud Pub/Sub). A polling sweep must run independently every 15 minutes
regardless of push, as a safety net for missed push deliveries — polling
is not purely a fallback, it runs continuously alongside push.

### FR-1.3 — Zenith email identification
An incoming email is a *candidate* Zenith alert if its `From` address
domain matches Zenith's known sending domain(s) (configurable list, not
hardcoded to one string). This is only a candidate filter — it does **not**
by itself authorize entry into `transactions` (see FR-1.4).

### FR-1.4 — Authenticity verification (critical path)
For every candidate email, the worker must parse the `Authentication-Results`
header (or equivalent Gmail-provided metadata) and confirm:
- `dkim=pass`
- The DKIM signing domain (`d=` value) matches Zenith's actual sending
  domain — not merely the visible `From` display name.

If verification fails, the email must **not** be parsed into
`transactions` under any circumstance. It is stored in
`suspicious_emails` with the failure reason, and an alert is fired
(Section 4, FR-1.9).

### FR-1.5 — Transaction-alert classification
Among authenticity-verified Zenith emails, distinguish actual transaction
alerts from other Zenith correspondence (statements, marketing, OTPs,
etc.) using subject-line/body pattern matching. Non-alert emails are
ignored (not stored), logged at debug level only.

### FR-1.6 — Parsing
Extract the following fields from a verified transaction-alert email:

```
bank                    (fixed: "Zenith Bank")
amount                  (decimal)
currency                (ISO code, e.g. "NGN")
transaction_reference   (string)
transaction_date        (date)
transaction_time        (time)
sender_name             (string)
sender_account          (string, may be masked per bank format)
description             (string, optional)
```

The exact regex/extraction rules must be built and tuned against a
corpus of real (or realistically reconstructed) Zenith alert emails —
see Section 9, Task 1.6.1.

### FR-1.7 — Field validation
Parsed output must be validated against a strict schema before
persistence:
- `amount` > 0, numeric, max 2 decimal places.
- `currency` is a known 3-letter ISO code.
- `transaction_reference` non-empty, matches Zenith's known reference
  format if one can be established.
- `transaction_date`/`transaction_time` parse to valid date/time and are
  not in the future beyond a small clock-skew tolerance.
- `sender_account` non-empty.

An email that fails validation after successfully parsing is treated the
same as a parse failure (FR-1.10): alert, do not silently drop.

### FR-1.8 — Deduplication
Before insert, check `email_message_id` (Gmail's immutable message ID)
against existing `transactions` and `suspicious_emails` rows. If it
already exists, skip processing entirely — this must be safe to run
concurrently (unique constraint at the DB level, not just an
application-level check, to close the race between a push-triggered run
and the 15-minute poll sweep).

### FR-1.9 — Suspicious email storage
Emails failing FR-1.4 are inserted into `suspicious_emails` with:
`email_message_id`, `from_address`, `subject`, `auth_result`, `reason`,
`raw_email`, `created_at`. This insert must also be deduplicated on
`email_message_id`.

### FR-1.10 — Alerting
The worker must emit alerts (initially: a webhook to Slack or email, per
whatever channel is configured) for:
- Any email landing in `suspicious_emails` (possible spoofing attempt).
- Any Zenith-domain, authenticity-verified email that fails parsing or
  validation (format likely changed).
- Staleness: no successful `transactions` insert within the configured
  threshold (default: 60 minutes) during configured business hours.

### FR-1.11 — Heartbeat tracking
Maintain `last_zenith_email_processed_at` as a single queryable value
(table row or key-value entry), updated on every successful
`transactions` insert. The staleness check in FR-1.10 reads this value.

### FR-1.12 — Structured logging
Every stage (email received, authenticity check result, parse result,
validation result, dedup result, insert result) emits a structured log
line with `email_message_id` as a correlation key, so a single email's
full journey can be traced.

---

## 5. Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1.1 | A verified Zenith transaction alert should produce a `transactions` row within 2 minutes of arrival under push delivery, and within 15 minutes under polling-only fallback. |
| NFR-1.2 | No plaintext credentials in source control; all secrets via Railway environment variables. |
| NFR-1.3 | The worker must recover cleanly from a mid-processing crash/restart with no duplicate inserts and no permanently lost emails (idempotent reprocessing). |
| NFR-1.4 | `raw_email` storage must not exceed a reasonable size cap per row (define and enforce, e.g. strip large inline images before storage). |
| NFR-1.5 | All timestamps stored in UTC; display/formatting concerns deferred to later phases. |
| NFR-1.6 | The pipeline must be operable by someone other than its author — configuration (domains, thresholds, business hours) lives in environment variables/config, not hardcoded. |

---

## 6. Data Model (Phase 1 subset)

```
transactions
------------
id                      UUID PK
amount                  NUMERIC(14,2) NOT NULL
currency                CHAR(3) NOT NULL
transaction_reference   TEXT
transaction_date        DATE NOT NULL
transaction_time        TIME
sender_name             TEXT
sender_account          TEXT
description             TEXT
bank                    TEXT NOT NULL DEFAULT 'Zenith Bank'
email_message_id        TEXT NOT NULL UNIQUE
email_auth_result       TEXT NOT NULL
raw_email                TEXT
matched_receipt_id      UUID NULL         -- unused until Phase 4
matched_at              TIMESTAMPTZ NULL  -- unused until Phase 4
created_at              TIMESTAMPTZ NOT NULL DEFAULT now()

suspicious_emails
------------------
id                  UUID PK
email_message_id    TEXT NOT NULL UNIQUE
from_address        TEXT NOT NULL
subject              TEXT
auth_result          TEXT NOT NULL
reason               TEXT NOT NULL
raw_email            TEXT
created_at           TIMESTAMPTZ NOT NULL DEFAULT now()

pipeline_health (new — needed for FR-1.11)
-------------------------------------------
key                  TEXT PK           -- e.g. 'last_zenith_email_processed_at'
value                TIMESTAMPTZ
updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
```

`transaction_reference UNIQUE` from the master plan is deliberately **not**
enforced yet in Phase 1 — the master plan flags this needs validating
against real Zenith email samples first (some banks reuse references
across days/products). Revisit once Task 1.6.1 produces real samples.

---

## 7. Component Design

### 7.1 Infrastructure
Single Railway project, PostgreSQL instance, and one worker service (a
long-running Node.js process). No public-facing endpoint required for
Phase 1 — the worker only needs outbound access to the Gmail API and
Postgres.

### 7.2 Gmail ingestion worker
Two entry points into the same processing pipeline:
- **Push listener**: subscribes to a Pub/Sub topic per `users.watch`;
  on notification, calls `users.messages.list` with `historyId` to fetch
  new messages since last processed history point.
- **Poll sweep**: runs on a 15-minute interval, lists messages matching
  the Zenith sender-domain filter received since the last successful
  poll checkpoint, independent of push state.

Both converge on a single `processEmail(messageId)` function so
authenticity checking, parsing, validation, and persistence logic exists
in exactly one place.

### 7.3 Authenticity verification module
A pure function: `verifyAuthenticity(rawHeaders) -> { pass: bool, domain: string, reason?: string }`.
Testable in isolation without any Gmail API dependency (see Section 10.1).

### 7.4 Zenith parser
A pure function: `parseZenithEmail(bodyText) -> ParsedTransaction | ParseFailure`.
Built against a small corpus of real/reconstructed sample emails (Task
1.6.1). Should be structured so new field patterns can be added without
rewriting the whole parser (e.g. one extraction rule per field, not one
giant regex).

### 7.5 Validation module
A pure function applying FR-1.7's rules, returning either a validated
object or a list of validation errors.

### 7.6 Persistence layer
Wraps the insert into `transactions` (or `suspicious_emails`) in a single
transaction alongside the `pipeline_health` update, relying on the
`email_message_id UNIQUE` constraint for dedup rather than a separate
existence check (avoids a check-then-insert race).

### 7.7 Alerting module
Thin wrapper around a configured webhook (Slack incoming webhook to
start). Takes `(level, message, context)` and is the single call site
used by FR-1.10's three alert triggers plus generic worker-crash
alerting.

### 7.8 Staleness checker
A separate lightweight scheduled job (can run in the same worker
process on its own timer) that reads `pipeline_health` and fires an
alert if `now() - last_zenith_email_processed_at > threshold` during
configured business hours.

---

## 8. Configuration / Environment Variables (Phase 1 subset)

```
DATABASE_URL=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
# or, for a Workspace service account:
GOOGLE_SERVICE_ACCOUNT_JSON=
GOOGLE_DELEGATED_USER=

ZENITH_SENDER_DOMAINS=            # comma-separated, not a single string
ALERT_WEBHOOK_URL=

STALENESS_THRESHOLD_MINUTES=60
BUSINESS_HOURS_START=07:00
BUSINESS_HOURS_END=21:00
BUSINESS_HOURS_TIMEZONE=Africa/Lagos

POLL_INTERVAL_MINUTES=15
```

---

## 9. Build Task Breakdown

1. **Infra**
   1.1. Create Railway project, Postgres instance, single worker service.
   1.2. Add migrations for `transactions`, `suspicious_emails`,
        `pipeline_health`.
   1.3. Wire structured logging (JSON logs with correlation key support).

2. **Gmail connection**
   2.1. Implement OAuth2/service-account auth module.
   2.2. Implement `users.watch` + Pub/Sub subscription setup.
   2.3. Implement push-triggered message fetch via `historyId`.
   2.4. Implement independent 15-minute poll sweep with its own
        checkpoint.

3. **Trust verification**
   3.1. Implement `verifyAuthenticity()` against real Gmail header data.
   3.2. Confirm Zenith's actual DKIM signing domain (requires a real
        sample email — flag as a blocking dependency, not assumed).

4. **Parsing**
   4.1. Collect a corpus of real/reconstructed Zenith transaction-alert
        emails (as many variations as available: transfer in, transfer
        out, different amount formats).
   4.2. Build the field-by-field extraction rules.
   4.3. Build the transaction-alert-vs-other-Zenith-email classifier.

5. **Validation & persistence**
   5.1. Implement the validation module against FR-1.7.
   5.2. Implement the persistence layer with unique-constraint-based
        dedup.
   5.3. Implement `suspicious_emails` persistence path.

6. **Monitoring**
   6.1. Implement `pipeline_health` heartbeat updates.
   6.2. Implement the staleness checker job.
   6.3. Implement the alerting module and wire it into all three
        FR-1.10 triggers.

7. **Test suite**
   7.1–7.6. Build out Section 10 in full (unit → integration → edge
        case → security → resilience → manual checklist).

---

## 10. Test Plan

### 10.1 Unit tests (no external services; pure functions)

| ID | Test | Expected result |
|---|---|---|
| T-1.1 | `verifyAuthenticity()` with a header showing `dkim=pass` and matching signing domain | `pass: true` |
| T-1.2 | `verifyAuthenticity()` with `dkim=pass` but signing domain **not** Zenith's | `pass: false`, reason includes domain mismatch |
| T-1.3 | `verifyAuthenticity()` with `dkim=fail` | `pass: false` |
| T-1.4 | `verifyAuthenticity()` with missing `Authentication-Results` header entirely | `pass: false` (fail closed, not open) |
| T-1.5 | `verifyAuthenticity()` with a `From` display name of "Zenith Bank" but a non-Zenith DKIM domain | `pass: false` — confirms display-name spoofing is caught |
| T-1.6 | `parseZenithEmail()` on a well-formed sample transaction alert | Returns all fields (FR-1.6) correctly extracted |
| T-1.7 | `parseZenithEmail()` on a sample with an unusual amount format (e.g. comma thousands separators, kobo) | Amount parsed correctly as a decimal |
| T-1.8 | `parseZenithEmail()` on a non-transaction Zenith email (e.g. OTP email) | Returns "not a transaction alert" classification, not a parse failure |
| T-1.9 | `parseZenithEmail()` on a transaction alert with a field the parser doesn't recognize (simulated format drift) | Returns a `ParseFailure` with enough context to debug, not a partial/garbage object |
| T-1.10 | Validation module with a negative amount | Rejected with a specific validation error |
| T-1.11 | Validation module with a currency not in the known list | Rejected |
| T-1.12 | Validation module with a `transaction_date` in the future beyond tolerance | Rejected |
| T-1.13 | Validation module with all fields correct | Passes, returns normalized object |
| T-1.14 | Staleness checker with `last_zenith_email_processed_at` older than threshold, during business hours | Fires alert |
| T-1.15 | Staleness checker with the same stale timestamp, but **outside** configured business hours | Does not fire |

### 10.2 Integration tests (real or sandboxed Postgres + mocked Gmail API)

| ID | Test | Expected result |
|---|---|---|
| T-2.1 | Full pipeline run on a verified, well-formed transaction alert | Exactly one row in `transactions`; `pipeline_health` heartbeat updated |
| T-2.2 | Full pipeline run on a spoofed email (fails FR-1.4) | Zero rows in `transactions`; one row in `suspicious_emails`; one alert fired |
| T-2.3 | Full pipeline run on a Zenith-domain email that fails parsing | Zero rows in `transactions`; alert fired distinguishing "parse failure" from "not Zenith" |
| T-2.4 | Same `email_message_id` processed twice (simulating push + poll both picking it up) | Only one row ever exists; second attempt is a no-op, not an error |
| T-2.5 | Poll sweep run when there are no new emails | No-op, no errors, checkpoint still advances correctly |
| T-2.6 | Push notification for a message ID that was already processed by the prior poll sweep | No duplicate; dedup constraint holds |

### 10.3 Edge case / negative tests

| ID | Test | Expected result |
|---|---|---|
| T-3.1 | Email from a domain merely *similar* to Zenith's (typosquat) | Fails FR-1.3 candidate filter; never reaches authenticity check; ignored (or logged at debug, not treated as suspicious unless it also claims to be Zenith in content) |
| T-3.2 | Extremely large email (large inline image attachment) | Processed without crashing; `raw_email` storage respects NFR-1.4 size cap |
| T-3.3 | Malformed/truncated email body (partial fetch failure) | Treated as a parse failure, not a crash; alert fired |
| T-3.4 | Two genuinely different transactions with identical amount, same day, different references | Both stored as separate `transactions` rows — Phase 1 does not attempt matching, so this should just work |
| T-3.5 | Email arrives with a `transaction_reference` that's empty/missing from the alert body | Field validation catches it per FR-1.7; does not silently store a null reference as if valid |
| T-3.6 | Non-English or unexpected character encoding in the email body | Parser handles or fails gracefully; does not corrupt stored data |

### 10.4 Security tests

| ID | Test | Expected result |
|---|---|---|
| T-4.1 | Crafted email with `From: alerts@zenithbank.com` (display/header spoof) but no valid DKIM signature at all | Rejected — lands in `suspicious_emails` |
| T-4.2 | Crafted email with a **valid** DKIM signature from an attacker-controlled domain that merely resembles Zenith's | Rejected — signing domain check (not just DKIM pass/fail) catches this |
| T-4.3 | Replay of a previously-processed, legitimately-signed email (attacker resends the exact same message) | Blocked by `email_message_id` dedup — confirms dedup is also a security control, not just a data-hygiene one |
| T-4.4 | Attempt to insert directly into `transactions` bypassing the worker (manual DB access) is out of scope for application-level tests but should be confirmed at the infra level: DB credentials are scoped/private-networked per the master plan's Security section | Documented as an infra check, not an automated test |

### 10.5 Resilience tests

| ID | Test | Expected result |
|---|---|---|
| T-5.1 | Kill the worker process mid-way through processing a batch of 5 new emails, then restart | On restart, no duplicates are created for the ones already inserted; the remaining ones are picked up and processed |
| T-5.2 | Postgres briefly unavailable during an insert attempt | Worker retries/backs off rather than dropping the email silently; email is not lost |
| T-5.3 | Gmail API returns a rate-limit error | Worker backs off and retries rather than crashing or skipping the message |
| T-5.4 | Push notification delivery is simulated as "missed" entirely for a given email | The 15-minute poll sweep still picks it up (this is the core reason polling runs independently, not just as a cold-start fallback) |

### 10.6 Monitoring/alerting tests

| ID | Test | Expected result |
|---|---|---|
| T-6.1 | Simulate no `transactions` insert for longer than `STALENESS_THRESHOLD_MINUTES` during business hours | Alert fires exactly once (not repeatedly spamming) until a new email is processed |
| T-6.2 | A new valid email arrives after a staleness alert has fired | Heartbeat updates; subsequent staleness checks pass again |
| T-6.3 | Simulate a batch of Zenith-domain emails that all fail parsing (format-drift scenario) | Alert content is specific enough to identify "the parser is broken," not a generic error |
| T-6.4 | Simulate a spoofed email | Alert clearly distinguishes "possible spoofing attempt" from "parser broke" — on-call response differs for each |

### 10.7 Manual / staging validation checklist

Before Phase 1 is signed off, run through this manually against the real
Gmail account and (ideally) a real or realistic Zenith transaction alert:

- [ ] Send/forward a real Zenith transaction alert to the connected inbox
      and confirm a correct row appears in `transactions` within the
      latency budget (NFR-1.1).
- [ ] Confirm the `email_auth_result` stored on that row shows a passing
      DKIM check against Zenith's real domain.
- [ ] Manually craft (e.g. via a test SMTP tool) an email with a spoofed
      `From` display name and confirm it lands in `suspicious_emails`
      and triggers the configured Slack/email alert.
- [ ] Kill the worker process on Railway mid-processing and confirm it
      recovers cleanly on redeploy/restart with no data loss or
      duplication.
- [ ] Temporarily lower `STALENESS_THRESHOLD_MINUTES` to a small value
      and confirm the alert fires as expected, then restore it.
- [ ] Confirm secrets are only present as Railway environment variables,
      not committed anywhere in the repo.

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Real Zenith email samples aren't available yet to build/tune the parser against | Treat sample collection (Task 4.1) as a blocking dependency identified up front, not discovered mid-build; if unavailable, use structurally similar Nigerian bank alert formats to build the parser skeleton and swap in real patterns once samples arrive. |
| Zenith's actual DKIM signing domain isn't confirmed | Task 3.2 flags this explicitly — must be verified against a real received email's headers before FR-1.4 can be considered correctly implemented, not assumed from documentation. |
| OAuth refresh token gets revoked in production with no warning | Directly covered by FR-1.10's staleness alerting — this is precisely the failure mode that monitoring exists to catch. |
| Zenith changes their email template after launch | Covered by the parse-failure alert (FR-1.10) being distinct from generic errors, so it's diagnosable quickly rather than silently dropping transactions. |

---

## 12. Definition of Done

Phase 1 is complete when Section 3's exit criteria are met, the full
Section 10 test suite passes (automated tests green, manual checklist
signed off), and the transaction ledger has been running against real
mail for a sustained observation period (recommended: at least a few
days of live traffic) with zero unexplained gaps or duplicates.
