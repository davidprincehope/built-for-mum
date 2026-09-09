# STALENESS.md — On-Call One-Pager (01-04)

## What it is
Staleness fires when **no successful Zenith `transactions` insert** has advanced `pipeline_health.last_zenith_email_processed_at` for **≥ 60 minutes** during business hours. Silence is failure.

## Window
- **Business hours:** `07:00–21:00` wall time in `Africa/Lagos` (WAT, UTC+1, no DST), **every day** — no weekend suppression (D-16).
- Outside `07:00–21:00` → checker returns `outside_hours` and does **not** alert. At `22:00 WAT` the same staleness is intentionally silent.
- Conversion uses `date-fns-tz` `formatInTimeZone(now, 'Africa/Lagos', 'HH:mm')` with lexicographic `HH:mm` comparison. Never use server `getHours()` (Railway is UTC).

## Threshold & Cooldown
- **Threshold:** `STALENESS_THRESHOLD_MINUTES` env (default `60`). Measured as `Date.now() - lastHeartbeat`.
- **Interval:** `60s` pinned `setInterval` (`startStalenessChecker(60_000)`). Overlap guard `checkerRunning` prevents concurrent ticks; `unref()` so timers don't block graceful shutdown.
- **Dedup:** `sendOnce('staleness', …, 60*60*1000)` + local `lastStalenessFiredAt` guard. Fires **once per staleness window** (transition into stale), not every tick. Second tick 30s later is suppressed until 60 min cooldown expires. No Telegram 30/sec spam (#15).
- **Never seeded:** Fresh DB with `last_zenith_email_processed_at = null` returns `never_seeded` and does **not** alert until first insert lands.

## Trail
```
insertTransactionAtomically COMMIT → pipeline_health.value = now()
        ↓ (single TX, only on committed transactions row — never on suspicious/parse-failure)
checkStaleness reads same row → isBusinessHours → elapsed > 60m → alerter.sendOnce('staleness', …)
        ↓
Telegram primary: POST https://api.telegram.org/bot{token}/sendMessage {chat_id,text}
  on non-2xx/throw → fallback POST ALERT_FALLBACK_WEBHOOK_URL if set, else log error
  cooldown retained so retry occurs after window
```

## Heartbeat honesty
Heartbeat is **only** advanced inside the `transactions` TX `COMMIT`. Duplicate `ON CONFLICT DO NOTHING` rolls back without touching heartbeat; `suspicious_emails` and `validation_failed` paths never touch it. A stale signal is therefore honest: either genuine silence or format drift, not a missed update.

## Env overrides (all in env.ts per NFR-1.6)
- `STALENESS_THRESHOLD_MINUTES=60`
- `BUSINESS_HOURS_TIMEZONE=Africa/Lagos`
- `BUSINESS_HOURS_START=07:00`
- `BUSINESS_HOURS_END=21:00`
- `ALERT_WEBHOOK_URL` → Telegram bot webhook (`https://api.telegram.org/bot{token}/sendMessage`)
- `ALERT_FALLBACK_WEBHOOK_URL` → secondary webhook/email
- `TELEGRAM_CHAT_ID` / `ALERT_CHAT_ID`

## What on-call should do
1. `stale` during business hours → check Gmail inbox for new Zenith credit mail, Railway worker logs (`email_message_id` correlation), Gmail OAuth/watch health, and DB `pipeline_health` row.
2. `Possible spoof: …` → lookup `suspicious_emails` row by `email_message_id`, verify `Authentication-Results` and `From` domain.
3. `Zenith format drift: failed to parse …` → Zenith template changed; inspect `raw_email` capped 100KB and update parser.
4. `outside_hours` is not an incident — no page.

## Verify locally
```bash
# Inside business hours, simulate staleness with an old heartbeat
STALENESS_THRESHOLD_MINUTES=1 BUSINESS_HOURS_TIMEZONE=Africa/Lagos npm test -- tests/unit/staleness.test.ts --run
```
