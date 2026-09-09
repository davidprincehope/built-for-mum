---
phase: 01
slug: zenith-ingestion
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-09-09
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest@3.x |
| **Config file** | vitest.config.ts (Wave 0 installs) |
| **Quick run command** | `npm test -- --run` |
| **Full suite command** | `npm run test:coverage` |
| **Estimated runtime** | ~10 seconds (unit) / ~30 seconds (full with integration) |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- --run`
- **After every plan wave:** Run `npm run test:coverage`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01-01 | 1 | FR-1.4/T-1.1 dkim pass matching | T-01-01 | DKIM pass + d=zenithbank.com passes | unit | `vitest run tests/unit/authenticity.test.ts -t "dkim pass matching"` | ❌ W0 | ⬜ pending |
| 01-01-01 | 01-01 | 1 | FR-1.4/T-1.2 wrong domain | T-01-01 | dkim pass wrong domain fails | unit | `vitest run tests/unit/authenticity.test.ts -t "domain mismatch"` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01-01 | 1 | FR-1.4/T-1.5 display spoof | T-01-01 | Display-name spoof rejected | unit | `vitest run tests/unit/authenticity.test.ts -t "display-name spoof"` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01-01 | 1 | FR-1.6/T-1.6 well-formed credit | T-01-02 | All fields extracted via cheerio | unit | `vitest run tests/unit/parser.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-01 | 01-02 | 2 | FR-1.6 decode strict | T-01-02 | B64→QP strict no fallback throws | unit | `vitest run tests/unit/decode.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-02 | 01-02 | 2 | FR-1.5/T-1.8 non-alert ignored | — | OTP/marketing classified not-alert | unit | `vitest run tests/unit/classifier.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-02 | 01-02 | 2 | FR-1.7 validation | V5 | zod rejects bad amount/currency/date | unit | `vitest run tests/unit/validation.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01-01 | 1 | FR-1.8 dedup + FR-1.11 heartbeat | T-01-05/T-4.3 | ON CONFLICT DO NOTHING atomic TX | integration | `vitest run tests/tracer.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-01 | 01-03 | 2 | FR-1.1 OAuth refresh | V2 | refresh_token in-memory only | integration | `vitest run tests/integration/gmail.test.ts -t "watch"` | ❌ W0 | ⬜ pending |
| 01-03-02 | 01-03 | 2 | FR-1.2 push + poll | — | history.list 404 fallback to messages.list | integration | `vitest run tests/integration/gmail.test.ts -t "poll"` | ❌ W0 | ⬜ pending |
| 01-04-01 | 01-04 | 3 | FR-1.10 staleness NFR-1.1 | — | 60min threshold Africa/Lagos cooldown | unit | `vitest run tests/unit/staleness.test.ts` | ❌ W0 | ⬜ pending |
| 01-04-02 | 01-04 | 3 | FR-1.10 alert Telegram+fallback | V9 | Telegram primary email fallback once | integration | `vitest run tests/integration/alerting.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.ts` — vitest config with ts path + setup
- [ ] `tests/unit/authenticity.test.ts` — covers FR-1.4 T-1.1–1.5
- [ ] `tests/unit/decode.test.ts` + `tests/unit/parser.test.ts` — strict pipeline + cheerio extraction
- [ ] `tests/unit/validation.test.ts` + `tests/unit/classifier.test.ts` — FR-1.5/1.7
- [ ] `tests/unit/staleness.test.ts` — business-hours window (vi.useFakeTimers)
- [ ] `tests/tracer.test.ts` — end-to-end happy path + dedup + spoof
- [ ] `tests/integration/pipeline.test.ts` — full pipeline with pg test DB
- [ ] `tests/integration/gmail.test.ts` — watch renewal + poll sweep mock
- [ ] `tests/integration/alerting.test.ts` — Telegram cooldown + fallback
- [ ] `migrations/*.sql` — schema for transactions/suspicious_emails/pipeline_health
- [ ] Framework install: `npm install -D vitest@3 @types/node tsx` + test scripts

*Wave 0 must schedule test infra before implementation waves.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real forwarded Zenith alert → ledger row within budget | FR-1.6 NFR-1.1 | Requires live Gmail inbox | Run `npm run worker:dev`, forward real Zenith credit alert, `SELECT * FROM transactions WHERE email_message_id=?` |
| Kill/restart worker mid-batch → no dup/loss | NFR-1.3 | Requires process kill | Railway restart worker during 5-message batch, verify `SELECT count(*) WHERE email_message_id IN (...)` =5 |
| Telegram alert delivery | FR-1.10 | Requires live Telegram bot token | Trigger spoof fixture, verify Telegram message received, check cooldown prevents duplicate |

*All other behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
