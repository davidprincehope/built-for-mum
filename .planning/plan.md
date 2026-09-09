# Payment Receipt Verification System — Implementation Plan

## 1. Objective

Build a WhatsApp-based payment verification system that:

1. Receives official Zenith Bank transaction alerts through Gmail.
2. Parses valid Zenith transaction emails and stores normalized transaction data in PostgreSQL.
3. Allows authorized WhatsApp senders to explicitly trigger payment verification.
4. Accepts a receipt image/PDF through WhatsApp.
5. Uses OCR to extract transaction details from the receipt.
6. Uses the Zenith transaction database as the source of truth.
7. Matches the receipt against an actual Zenith transaction.
8. If no match exists immediately, retries periodically for a limited period.
9. Sends a final WhatsApp confirmation or a message explaining that the corresponding alert has not been received.
10. Keeps an audit trail of every receipt, matching attempt, and outcome.

### Core principle

> A customer-supplied receipt never proves payment by itself. Only a corresponding Zenith Bank transaction alert stored in the database can result in `CONFIRMED`.

---

# 2. Target Architecture

```text
                         ZENITH BANK
                              |
                     Transaction Alert
                              |
                              v
                           GMAIL
                              |
                              v
                      +---------------+
                      | Gmail Worker  |
                      +-------+-------+
                              |
                              v
                      +---------------+
                      | Zenith Parser |
                      +-------+-------+
                              |
                              v
                      +---------------+
                      |  PostgreSQL   |
                      | Transactions  |
                      +-------^-------+
                              |
                              |
CUSTOMER                      |
   |                          |
   | WhatsApp                 |
   v                          |
+-----------+                 |
| WhatsApp  |                 |
| Business  |                 |
+-----+-----+                 |
      |                       |
      | Webhook               |
      v                       |
+-------------------------------------------+
|                  RAILWAY                  |
|                                           |
|  +-------------+     +----------------+  |
|  | API/Webhook |---->|     Worker     |  |
|  +-------------+     +--------+-------+  |
|                               |           |
|                        +------+-------+   |
|                        | OCR / AI     |   |
|                        +------+-------+   |
|                               |           |
|                        +------+-------+   |
|                        | Match Engine |<--+
|                        +------+-------+
|                               |
|                        +------+-------+
|                        | PostgreSQL   |
|                        +--------------+
+-------------------------------------------+
                              |
                              v
                          WHATSAPP
                              |
                              v
                           CUSTOMER
```

---

# 3. Technology Stack

| Component | Initial Choice | Purpose |
|---|---|---|
| Hosting | Railway | API, workers, database, later dashboard |
| Database | PostgreSQL | Transactions, sessions, receipts, audit logs |
| WhatsApp | WhatsApp Business Cloud API | Incoming/outgoing messages and media |
| Email | Gmail API | Zenith transaction alert ingestion |
| Primary OCR | Mistral OCR 4.1 | Receipt/document OCR |
| OCR/vision fallback | Gemini or OpenAI vision model | Handle low-confidence OCR cases |
| Queue | PostgreSQL initially | Delayed verification/retry jobs |
| Queue upgrade | Redis/BullMQ or equivalent | Add when volume requires it |

---

# 4. Railway Project Structure

Initial Railway project:

```text
payment-verification
|
+-- api
+-- worker
+-- postgres
```

### API service

Responsibilities:

- WhatsApp webhook verification
- WhatsApp incoming message handling
- Sender authorization
- Verification-session management
- Fast webhook acknowledgements
- Internal API endpoints

Public endpoints:

```text
GET  /webhooks/whatsapp
POST /webhooks/whatsapp
GET  /health
```

### Worker service

Responsibilities:

- Gmail polling/processing
- Zenith email parsing
- Receipt processing
- OCR
- Matching
- Retry checks
- WhatsApp responses

### PostgreSQL

Stores all persistent application state.

---

# 5. Database Schema

## 5.1 customers

```text
customers
----------
id
phone_number UNIQUE
name
active
created_at
updated_at
```

Purpose:

- Identify authorized WhatsApp users.
- Associate multiple verification sessions with a customer.

---

## 5.2 verification_sessions

```text
verification_sessions
----------------------
id
customer_id
status
created_at
expires_at
updated_at
```

Statuses:

```text
WAITING_FOR_RECEIPT
PROCESSING
AWAITING_CONFIRMATION
CONFIRMED
CONFIRMED_MANUAL
NEEDS_REVIEW
NOT_RECEIVED
MISMATCH
ERROR
EXPIRED
```

`CONFIRMED_MANUAL` and `NEEDS_REVIEW` are new — see Sections 13.1 and 15.1.

Purpose:

Prevent random messages from triggering OCR or the payment workflow.

---

## 5.3 receipts

```text
receipts
--------
id
session_id
whatsapp_message_id UNIQUE
media_id
media_type
storage_reference
content_hash
amount
currency
transaction_reference
transaction_date
transaction_time
sender_name
sender_account
ocr_confidence
ocr_raw_data
status
created_at
updated_at
```

Purpose:

Store the receipt and the structured information extracted from it.

`content_hash` (SHA-256 of the media file) protects against receipt reuse:
if the same image later appears attached to a different, unrelated
`CONFIRMED` session, it should be blocked and routed to review rather than
silently confirmed again.

---

## 5.4 transactions

This is the authoritative transaction ledger populated from Zenith Bank alerts.

```text
transactions
------------
id
amount
currency
transaction_reference
transaction_date
transaction_time
sender_name
sender_account
description
bank
email_message_id UNIQUE
email_auth_result
raw_email
matched_receipt_id NULLABLE
matched_at NULLABLE
created_at
```

Potential uniqueness constraints:

```text
email_message_id UNIQUE
transaction_reference UNIQUE
```

The exact uniqueness rule for `transaction_reference` should be validated against the real Zenith email format.

`email_auth_result` stores the DKIM/SPF verdict and signing domain pulled
from the email's `Authentication-Results` header (see Section 6.1). Only
emails that pass this check should ever reach this table.

`matched_receipt_id` / `matched_at` mark a transaction as **claimed** once
it has been used to confirm a receipt. The matching engine only searches
`WHERE matched_receipt_id IS NULL`, which prevents the same bank transaction
from confirming two different receipts (see Section 13.1).

---

## 5.4.1 suspicious_emails (new)

```text
suspicious_emails
------------------
id
email_message_id
from_address
subject
auth_result
reason
raw_email
created_at
```

Purpose:

Zenith-domain-looking emails that fail the DKIM/SPF/domain check land here
instead of `transactions`, so nothing unverified can ever enter the
authoritative ledger, while still preserving the email for investigation.

---

## 5.5 verification_attempts

```text
verification_attempts
---------------------
id
receipt_id
attempt_number
result
matched_transaction_id
checked_at
details
```

Possible results:

```text
FOUND
NOT_FOUND
MISMATCH
ERROR
```

Purpose:

Provide a complete audit trail of every database lookup.

---

# 6. Gmail → Zenith Transaction Pipeline

Flow:

```text
Gmail
  |
  v
New email
  |
  v
Is it a Zenith email?
  |
  +-- NO --> Ignore
  |
  +-- YES
       |
       v
Is it a transaction alert?
       |
       +-- NO --> Ignore
       |
       +-- YES
            |
            v
       DKIM/SPF/domain check passes?
            |
            +-- NO --> Store in suspicious_emails, alert
            |
            +-- YES
                 |
                 v
            Zenith Parser
                 |
                 v
            Did it parse successfully?
                 |
                 +-- NO --> Alert (format likely changed)
                 |
                 +-- YES
                      |
                      v
                 Validate fields
                      |
                      v
                 Deduplicate
                      |
                      v
                 PostgreSQL
```

## 6.1 Trusting the email (critical)

A display name of "Zenith Bank" costs nothing to forge, and this pipeline
is the system's entire source of financial truth — so "is it a Zenith
email" must be a cryptographic check, not a text match:

- Read the `Authentication-Results` header Gmail attaches to every message.
- Require `dkim=pass` **and** that the DKIM signing domain (`d=` value) is
  Zenith's actual sending domain — not the display name.
- Anything that fails this check must never reach `transactions`. Route it
  to `suspicious_emails` instead (Section 5.4.1) and alert, so a spoofed
  email can never confirm a payment.
- Store the auth result on the transaction row (`email_auth_result`) so any
  confirmed payment can be traced back to a passing verification.

## 6.2 Making the integration resilient

Email scraping is inherently a workaround, so failures need to be loud
rather than silent:

- Prefer Gmail push notifications (`watch()` via Google Cloud Pub/Sub) over
  pure polling, for lower latency — but keep a polling reconciliation sweep
  every 15–30 minutes as a safety net, since push delivery can be missed.
- Track `last_zenith_email_processed_at`. Alert (Slack/email) if it goes
  stale during business hours — this is what catches OAuth token
  revocation, API quota exhaustion, or Gmail outages before a customer
  notices.
- Treat "Zenith-domain email that failed to parse" as a distinct, urgent
  case from "not a Zenith email at all" — a parse failure almost always
  means Zenith changed their email format, and every transaction is
  silently being dropped until someone fixes it.
- If run under a Google Workspace account, prefer a service account with
  domain-wide delegation over a personal OAuth consumer app — it doesn't
  degrade from periodic re-consent or unverified-app warnings.
- Before committing further to email scraping, worth checking directly
  with Zenith's business banking team whether a corporate/merchant
  transaction API or webhook is available — some Nigerian banks offer
  this, and separately, payment aggregators (Paystack, Flutterwave,
  Monnify) offer dedicated/reserved virtual accounts that issue signed
  webhooks the moment a transfer lands, with no email parsing at all. This
  could replace the Gmail pipeline entirely if the business model allows
  routing payments through a dedicated account number.

## Zenith parser

The parser should normalize the actual Zenith email into:

```json
{
  "bank": "Zenith Bank",
  "amount": 150000,
  "currency": "NGN",
  "transaction_reference": "ABC123456",
  "transaction_date": "2026-09-09",
  "transaction_time": "08:14:32",
  "sender_name": "JOHN DOE",
  "sender_account": "0123456789"
}
```

The exact fields should be finalized after examining real Zenith transaction-alert emails.

## Critical requirement

Store the Gmail message ID.

This prevents the same bank email from creating duplicate transactions.

---

# 7. WhatsApp Sender Gating

Every incoming WhatsApp message goes through:

```text
Incoming message
      |
      v
Identify sender
      |
      v
Authorized?
   /       \
 NO         YES
 |           |
Ignore     Continue
```

Unknown senders should not trigger:

- OCR
- AI
- transaction lookup
- verification workers

Optionally, the system can send a generic response, but silently ignoring unauthorized messages is also possible.

---

# 8. Explicit Trigger

Authorized senders must explicitly initiate payment verification.

Recommended initial command:

```text
VERIFY PAYMENT
```

Other possible commands:

```text
VERIFY
CHECK PAYMENT
```

The preferred implementation is eventually a WhatsApp interactive button:

```text
+-----------------------------+
| What would you like to do?  |
|                             |
| [ Verify Payment ]          |
+-----------------------------+
```

When the trigger is received:

```text
VERIFY PAYMENT
      |
      v
Create verification session
      |
      v
WAITING_FOR_RECEIPT
      |
      v
"Please send your transaction receipt."
```

The session should expire after a configurable period, e.g. 10–15 minutes.

---

# 9. Receipt Intake

When a customer sends an image/PDF:

```text
WhatsApp receipt
      |
      v
Webhook
      |
      v
Authorized sender?
      |
      v
Active verification session?
      |
      +-- NO --> Ignore / ask user to start verification
      |
      +-- YES
            |
            v
       Save receipt
            |
            v
       Reply immediately
```

Initial response:

> Receipt received. Awaiting confirmation.

The webhook should acknowledge WhatsApp quickly and not hold the HTTP request open while OCR or verification occurs.

---

# 10. OCR Pipeline

Primary OCR:

**Mistral OCR 4.1**

The OCR system should extract information rather than make the payment decision.

Expected structured output:

```json
{
  "document_type": "bank_transfer_receipt",
  "bank": "Zenith Bank",
  "amount": 150000,
  "currency": "NGN",
  "transaction_reference": "ABC123456",
  "transaction_date": "2026-09-09",
  "transaction_time": "08:14:32",
  "sender_name": "JOHN DOE",
  "sender_account": "0123456789",
  "confidence": {
    "amount": 0.99,
    "reference": 0.97,
    "date": 0.98,
    "time": 0.91
  }
}
```

The actual JSON schema should be strict and validated before entering the matching engine.

---

# 11. OCR Confidence Handling

Recommended logic:

```text
Mistral OCR
     |
     v
Confidence check
     |
     +-- HIGH --> Continue
     |
     +-- MEDIUM --> Secondary OCR/vision model
     |
     +-- LOW --> Ask customer for clearer receipt
```

Example thresholds:

```text
>= 0.90  -> automatic processing
0.70-0.89 -> fallback OCR/vision
< 0.70 -> request clearer image
```

These thresholds should be tuned against real receipt samples.

---

# 12. OCR Cost Optimization

Do not send every message to an expensive AI/OCR provider.

Only run OCR when:

```text
sender is authorized
AND
verification session is active
AND
message contains an accepted receipt attachment
```

Random messages should stop before OCR.

Primary OCR should run first.

Fallback OCR should only run when confidence is insufficient.

---

# 13. Transaction Matching Engine

The matching engine is deterministic backend code.

It should not ask an LLM:

> "Does this payment look legitimate?"

Instead it receives structured OCR data and searches the actual transaction ledger.

## Matching priority

### Level 1 — strongest (only path to automatic CONFIRMED)

```text
transaction_reference matches
AND
amount matches
```

### Level 2 (routes to NEEDS_REVIEW, not CONFIRMED)

```text
amount matches
AND
sender/account matches
AND
date/time is reasonable
```

### Level 3 (routes to NEEDS_REVIEW, not CONFIRMED)

```text
amount matches
AND
date matches
AND
transaction is within an acceptable time window
```

### Never

Do not confirm based on amount alone.

Do not auto-confirm on Level 2 or Level 3 alone. Without an exact
transaction-reference match, two customers paying the same amount on the
same day are indistinguishable — that ambiguity should go to a human, not
to an automatic `CONFIRMED`.

---

## 13.1 Claiming a transaction (preventing double-match)

Without an explicit claim step, two receipts could both match the same
Zenith transaction — e.g. a retry racing a manual review, or two workers
polling concurrently. The matcher must atomically claim the transaction it
matches against, not just read it:

```sql
UPDATE transactions
SET matched_receipt_id = $receipt_id, matched_at = NOW()
WHERE id = $transaction_id
  AND matched_receipt_id IS NULL
RETURNING *;
```

If this returns zero rows, another process already claimed that
transaction first — treat it as not-found and continue to the next
candidate (or fall through to retry/`NOT_RECEIVED`). Candidate transactions
are only ever selected `WHERE matched_receipt_id IS NULL`.

Separately, guard against **receipt reuse**: if an incoming receipt's
`content_hash` (Section 5.3) already belongs to a different, already-
`CONFIRMED` session, block it and route to review rather than allowing a
second confirmation from the same image.

---

# 14. Matching Outcomes

## CONFIRMED

A reliable transaction match exists.

Database:

```text
receipt.status = CONFIRMED
verification_session.status = CONFIRMED
matched_transaction_id = <transaction>
confirmed_at = <timestamp>
```

WhatsApp:

> Transaction confirmed. ✅

---

## NEEDS_REVIEW

A Level 2 or Level 3 match exists (amount + sender/date, no exact
reference), but the system will not auto-confirm on this alone.

Database:

```text
receipt.status = NEEDS_REVIEW
verification_session.status = NEEDS_REVIEW
candidate_transaction_id = <transaction>
```

WhatsApp:

> We're reviewing your payment — this can take a little longer than usual.
> We'll confirm shortly.

The candidate goes into an admin review queue (Phase 6 tooling). A human
either confirms it (see `CONFIRMED_MANUAL`, Section 15.1) or rejects it,
in which case the transaction remains unclaimed for other candidates.

---

## NOT_RECEIVED

No corresponding Zenith transaction has been found yet.

Do not immediately claim the customer did not pay.

Use:

> We have not received the corresponding transaction alert yet. Please try again shortly.

The system should continue retrying until the maximum retry window is reached.

---

## MISMATCH

A transaction exists but important details do not match.

Example:

```text
Receipt: ₦150,000
Bank alert: ₦100,000
```

Result:

```text
MISMATCH
```

Suggested response:

> We received your receipt, but we couldn't match it to a corresponding transaction alert. Please contact support for assistance.

---

# 15. Retry System

Initial retry schedule:

```text
Attempt 1: immediately
Attempt 2: +60 seconds
Attempt 3: +120 seconds
Attempt 4: +180 seconds
Attempt 5: +240 seconds
Attempt 6: +300 seconds
```

Maximum **agent-facing** verification period:

```text
5 minutes
```

This should be configurable.

This 5-minute window only governs how long the WhatsApp agent keeps the
customer waiting with active retries before sending a `NOT_RECEIVED`
message — it is not a hard cutoff on verification itself. See Section
15.1: the backend continues reconciling in the background afterward, and a
human can manually confirm a receipt that hasn't matched yet.

Do not use a long `sleep()` inside an HTTP request.

Instead store:

```text
status = AWAITING_CONFIRMATION
attempt_count = 1
next_check_at = <timestamp>
```

The worker periodically queries:

```sql
SELECT *
FROM receipts
WHERE status = 'AWAITING_CONFIRMATION'
  AND next_check_at <= NOW();
```

Then it performs the next verification attempt.

---

# 16. Retry State Machine

```text
RECEIVED
    |
    v
PROCESSING
    |
    v
AWAITING_CONFIRMATION
    |
    +----> FOUND ------> CONFIRMED
    |
    +----> MISMATCH ---> MISMATCH
    |
    +----> NOT FOUND
              |
              v
        Retry scheduled
              |
              v
        Check database
              |
              +----> FOUND -> CONFIRMED
              |
              +----> NOT FOUND
                         |
                         v
                   More retries?
                    /       \
                  YES        NO
                   |          |
                   v          v
                Retry     NOT_RECEIVED
```

---

## 15.1 Manual Confirmation and Background Reconciliation

Sending `NOT_RECEIVED` to the customer after the 5-minute window is a
messaging decision, not the end of verification:

- A **background reconciliation job** keeps checking `NOT_RECEIVED` (and
  `NEEDS_REVIEW`) receipts against new transactions for a longer window
  (e.g. 24–48 hours), since bank alert emails can lag well behind the
  agent's short retry cadence. If a match later appears, the system can
  auto-confirm and follow up with the customer even though the initial
  message said "not received."
- A human can manually confirm a receipt that hasn't matched yet. This is
  a **break-glass action**, not a quiet bypass of the "only Zenith data
  confirms payment" principle, so it must be:
  - a distinct status, `CONFIRMED_MANUAL`, never conflated with the
    automatic `CONFIRMED`, so reporting can always tell which payments were
    machine-verified versus human-judgment calls;
  - logged the same way an automatic match is — actor, timestamp, and a
    required reason, written to `verification_attempts`
    (`result = MANUAL_OVERRIDE`);
  - still cross-checked against reality: if the background job later finds
    a real Zenith transaction that *doesn't* match what was manually
    confirmed (wrong amount, wrong reference), that discrepancy should be
    flagged for review rather than silently ignored.

---

# 17. WhatsApp Conversation Example

### Customer

```text
VERIFY PAYMENT
```

### Agent

```text
Please send your transaction receipt.
```

### Customer

```text
[Receipt image]
```

### Agent

```text
Receipt received. Awaiting confirmation.
```

Backend:

```text
OCR
 ↓
Amount = ₦150,000
Reference = ABC123
 ↓
Database search
 ↓
Not found
 ↓
Retry in 60 seconds
```

Later:

```text
Zenith email arrives
 ↓
Gmail worker processes it
 ↓
Transaction stored
 ↓
Retry finds transaction
 ↓
Match succeeds
```

### Agent

```text
Transaction confirmed. ✅
```

---

# 18. Important Race Condition

The system must handle this situation:

```text
Customer receipt arrives
          |
          v
Database lookup
          |
       NOT FOUND
          |
          v
Schedule retry
          |
          |
          +---- Zenith email arrives
```

The Gmail worker and WhatsApp verification worker operate independently.

That is intentional.

Whichever arrives first does not matter.

The database eventually contains the bank transaction, and the next verification attempt can find it.

---

# 19. Duplicate Handling

Protect against duplicate events.

### Gmail

Use:

```text
email_message_id UNIQUE
```

### WhatsApp

Use:

```text
whatsapp_message_id UNIQUE
```

### Receipt processing

Before starting processing:

```text
Does this WhatsApp message ID already exist?
       |
       +-- YES --> Do not process again
       |
       +-- NO --> Process
```

This prevents duplicate confirmations.

---

# 20. Security

All external data must be treated as untrusted.

## WhatsApp

- Verify webhook authenticity/signatures.
- Validate sender.
- Validate media type.
- Validate file size.
- Prevent replayed messages.

## Gmail

- OAuth credentials only (prefer a Workspace service account with
  domain-wide delegation where available — see Section 6.2).
- Store secrets in Railway environment variables.
- Never hard-code credentials.
- Verify DKIM/SPF and the signing domain on every "Zenith" email before it
  can enter `transactions` (Section 6.1). A display name is not
  authentication.
- Monitor for pipeline staleness (`last_zenith_email_processed_at`) and
  for Zenith-domain emails that fail to parse — both should alert, not
  fail silently.

## Database

- Use private networking where possible.
- Use parameterized queries.
- Restrict database access.

## AI/OCR

- Validate model output against a strict schema.
- Never allow AI output to directly set `CONFIRMED`.
- Backend matching rules make the final decision.

---

# 21. Environment Variables

Expected Railway secrets:

```text
DATABASE_URL=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=

WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=

MISTRAL_API_KEY=

AI_FALLBACK_API_KEY=
```

Exact variables depend on the final providers and implementation.

---

# 22. Logging and Audit Trail

Every major operation should generate a structured log.

Example:

```text
2026-09-09 08:14:03
WHATSAPP_RECEIPT_RECEIVED
customer=8273
receipt=RCP123
```

```text
2026-09-09 08:14:05
OCR_COMPLETED
receipt=RCP123
amount=150000
reference=ABC123
confidence=0.97
```

```text
2026-09-09 08:14:06
MATCH_ATTEMPT
receipt=RCP123
result=NOT_FOUND
attempt=1
```

```text
2026-09-09 08:15:06
MATCH_ATTEMPT
receipt=RCP123
result=FOUND
transaction=TX456
```

```text
2026-09-09 08:15:07
PAYMENT_CONFIRMED
receipt=RCP123
transaction=TX456
```

This becomes extremely useful when investigating disputes.

---

# 23. Recommended Project Structure

```text
payment-verification/
|
+-- src/
|   |
|   +-- api/
|   |   +-- server.js
|   |   +-- whatsapp-webhook.js
|   |
|   +-- workers/
|   |   +-- gmail-worker.js
|   |   +-- receipt-worker.js
|   |   +-- confirmation-worker.js
|   |
|   +-- integrations/
|   |   +-- gmail.js
|   |   +-- whatsapp.js
|   |   +-- mistral.js
|   |
|   +-- parsers/
|   |   +-- zenith.js
|   |   +-- receipt.js
|   |
|   +-- matching/
|   |   +-- transaction-matcher.js
|   |
|   +-- database/
|   |   +-- customers.js
|   |   +-- transactions.js
|   |   +-- receipts.js
|   |   +-- sessions.js
|   |
|   +-- services/
|       +-- verification.js
|       +-- retry.js
|       +-- authorization.js
|
+-- migrations/
+-- package.json
+-- Dockerfile
+-- README.md
+-- .env.example
```

---

# 24. Implementation Phases

Phases are ordered around the fact that the Zenith transaction ledger is
the system's single source of truth: nothing else can be trusted or tested
against real data until it exists and is reliably fed. Everything else —
WhatsApp, OCR, matching — depends on it, so it goes first rather than
being treated as a foundation-adjacent afterthought.

## Phase 1 — Zenith Email Ingestion (the source of truth)

Tasks:

- Create Railway project, PostgreSQL, and a single worker service (just
  enough infra to run this pipeline — no API/webhook service needed yet).
- Configure environment variables, add database migrations, add logging.
- Connect Gmail API (prefer a service account + domain-wide delegation if
  on Workspace).
- Retrieve Zenith emails; identify transaction alerts.
- Verify DKIM/SPF and signing domain; route failures to
  `suspicious_emails` (Section 6.1) — never trust a display name.
- Build the Zenith parser; normalize transaction data; store in
  `transactions`.
- Add deduplication on `email_message_id`.
- Add `last_zenith_email_processed_at` heartbeat and staleness alerting.
- Alert on Zenith-domain emails that fail to parse.

### Completion criteria

```text
Worker running
+
PostgreSQL connected
+
Every valid, authenticity-verified Zenith alert becomes a clean
transactions record
+
A break in the pipeline (auth failures, parser failures, or silence)
is surfaced automatically
```

At the end of this phase, you have a live, trustworthy transaction ledger
you can query and inspect — independent of WhatsApp, OCR, or anything
customer-facing existing yet. Everything downstream matches against this.

---

## Phase 2 — WhatsApp

Tasks:

- Create the API/webhook service (the piece deliberately deferred from
  Phase 1).
- Create/configure WhatsApp Business API.
- Create and verify webhook.
- Receive messages; identify sender.
- Create authorized sender list.
- Implement `VERIFY PAYMENT`.
- Create verification sessions.

### Completion criteria

Only authorized users with an active verification session can initiate receipt verification.

---

## Phase 3 — Receipt Processing + OCR

Tasks:

- Receive WhatsApp media.
- Download receipt; compute `content_hash`.
- Store receipt reference.
- Integrate Mistral OCR.
- Define strict extraction schema.
- Validate OCR output.
- Add confidence scoring.
- Add fallback OCR/vision model.
- Handle unreadable receipts.

### Completion criteria

Receipt images are reliably converted into structured transaction data.

---

## Phase 4 — Matching Engine

Tasks:

- Implement reference matching.
- Implement amount matching.
- Implement date/time matching.
- Implement sender/account matching.
- Implement confidence/ranking rules.
- Implement atomic transaction claiming (Section 13.1) so a transaction can
  confirm only one receipt.
- Implement `content_hash` check to block reused receipts.
- Implement `CONFIRMED` (Level 1 matches only).
- Implement `NEEDS_REVIEW` (Level 2/3 matches).
- Implement `MISMATCH`.
- Implement `NOT_RECEIVED`.

### Completion criteria

The backend can reliably distinguish:

```text
Confirmed
Needs review
Mismatch
Not received
```

...and the same real transaction can never be used to confirm two
different receipts.

---

## Phase 5 — Retry & Reconciliation Engine

Tasks:

- Add `next_check_at`.
- Add retry attempts.
- Implement 60-second intervals.
- Implement agent-facing maximum retry window (Section 15).
- Implement background reconciliation job for a longer window after
  `NOT_RECEIVED`/`NEEDS_REVIEW` (Section 15.1).
- Implement manual confirmation (`CONFIRMED_MANUAL`) with required actor
  and reason, logged to `verification_attempts`.
- Handle worker restarts.
- Prevent duplicate retries.

### Completion criteria

A receipt that arrives before the Zenith email can still become
automatically confirmed when the email later appears — including after the
customer has already been told `NOT_RECEIVED`. A reviewer can manually
confirm a stuck receipt, with the override fully audited.

---

## Phase 6 — Production Hardening

Tasks:

- Webhook signature validation.
- Rate limiting.
- File validation.
- Better error handling.
- Monitoring.
- Alerting.
- Database backups.
- Audit dashboard.
- Manual verification tools.
- Admin authentication.
- Data retention policy.

---

# 25. MVP Success Criteria

The MVP is ready when this complete scenario works:

```text
1. Zenith sends transaction email.
2. Gmail receives it.
3. Worker detects it.
4. Zenith parser extracts transaction.
5. Transaction enters PostgreSQL.

6. Authorized WhatsApp user sends:
   VERIFY PAYMENT

7. System asks:
   Please send your transaction receipt.

8. User sends receipt.

9. System responds:
   Receipt received. Awaiting confirmation.

10. OCR extracts:
    amount/reference/date/time.

11. Matcher searches PostgreSQL.

12. If found:
    Transaction confirmed. ✅

13. If not found:
    Retry after 60 seconds.

14. If Zenith alert arrives:
    Database is updated.

15. Next retry finds transaction.

16. System sends:
    Transaction confirmed. ✅

17. If no matching alert exists after the retry window:
    Alert not received message is sent.

18. Every action is recorded in the database.
```

---

# 26. Future Enhancements

Once the core system is stable:

- Admin dashboard
- Multiple bank parsers
- Multiple WhatsApp numbers
- Customer account management
- Payment reference generation
- Automatic payment reconciliation
- Daily reconciliation reports
- Failed-payment alerts
- Slack/email admin notifications
- Manual review queue
- Redis/BullMQ queue
- Object storage for receipts
- Advanced fraud/anomaly detection
- Analytics
- Multiple OCR providers
- Bank-specific parser framework

---

# 27. Final Architecture Principle

The system should maintain a strict separation:

```text
CUSTOMER
  |
  | receipt
  v
WHATSAPP
  |
  v
OCR
  |
  | "This receipt says ₦150,000 / REF123"
  v
MATCHING ENGINE
  |
  | "Does Zenith confirm this?"
  v
POSTGRESQL
  ^
  |
ZENITH BANK EMAIL
```

The customer-provided receipt is **evidence to search with**.

The Zenith transaction alert is **the evidence used to confirm payment**.

That separation is the foundation of a reliable payment verification system.
