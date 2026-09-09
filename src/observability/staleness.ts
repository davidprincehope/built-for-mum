import { formatInTimeZone } from 'date-fns-tz';
import { getLastProcessedAt } from '../db/health';
import { sendOnce } from '../alerts/alerter';
import { logger as defaultLogger } from './logger';

export function isBusinessHours(
  now: Date,
  tz: string = process.env.BUSINESS_HOURS_TIMEZONE ?? 'Africa/Lagos',
  start: string = process.env.BUSINESS_HOURS_START ?? '07:00',
  end: string = process.env.BUSINESS_HOURS_END ?? '21:00',
): boolean {
  // Convert now to wall time in tz, compare HH:mm inclusive [start, end]
  const hhmm = formatInTimeZone(now, tz, 'HH:mm');
  // Lexicographic compare works for HH:mm padded
  return hhmm >= start && hhmm <= end;
}

function parseThresholdMinutes(): number {
  const raw = process.env.STALENESS_THRESHOLD_MINUTES;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60;
}

function parseBusinessHoursConfig(): { tz: string; start: string; end: string } {
  return {
    tz: process.env.BUSINESS_HOURS_TIMEZONE ?? 'Africa/Lagos',
    start: process.env.BUSINESS_HOURS_START ?? '07:00',
    end: process.env.BUSINESS_HOURS_END ?? '21:00',
  };
}

// In-memory dedup for staleness: last fired timestamp (ms) — prevents spam even if alerter cooldown drift
let lastStalenessFiredAt: number | null = null;

export function _resetStalenessStateForTests(): void {
  lastStalenessFiredAt = null;
}

export type CheckStalenessResult = 'ok' | 'stale' | 'outside_hours' | 'never_seeded';

export interface CheckStalenessDeps {
  logger?: typeof defaultLogger;
  now?: Date;
}

export async function checkStaleness(deps: CheckStalenessDeps = {}): Promise<CheckStalenessResult> {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? new Date();
  const { tz, start, end } = parseBusinessHoursConfig();

  const last = await getLastProcessedAt();
  if (!last) {
    log.debug('staleness: never_seeded — no heartbeat yet');
    return 'never_seeded';
  }

  if (!isBusinessHours(now, tz, start, end)) {
    log.debug({ tz, start, end, now: now.toISOString() }, 'staleness: outside_hours — skip alert');
    return 'outside_hours';
  }

  const thresholdMs = parseThresholdMinutes() * 60 * 1000;
  const minutesSince = (now.getTime() - last.getTime()) / 60000;
  const elapsedMs = now.getTime() - last.getTime();

  if (elapsedMs <= thresholdMs) {
    return 'ok';
  }

  // Stale: fire once per window via alerter.sendOnce + local lastFiredAt guard
  const cooldownMs = 60 * 60 * 1000; // 60 min per D-16, pinned
  const nowMs = now.getTime();
  if (lastStalenessFiredAt !== null && nowMs - lastStalenessFiredAt < cooldownMs) {
    log.debug({ minutesSince: Math.floor(minutesSince), cooldownMs }, 'staleness alert suppressed — local cooldown');
    return 'stale';
  }

  const minutesInt = Math.floor(minutesSince);
  const text = `Pipeline stale: no Zenith credit in ${minutesInt}m during business hours`;
  await sendOnce('staleness', text, cooldownMs);
  lastStalenessFiredAt = nowMs;
  log.warn({ minutesSince: minutesInt, thresholdMinutes: parseThresholdMinutes(), tz }, text);
  return 'stale';
}

let checkerTimer: NodeJS.Timeout | null = null;
let checkerRunning = false;

export function startStalenessChecker(intervalMs = 60 * 1000): NodeJS.Timeout {
  if (checkerTimer) {
    clearInterval(checkerTimer);
  }
  const tick = async () => {
    if (checkerRunning) return;
    checkerRunning = true;
    try {
      await checkStaleness();
    } catch (err) {
      defaultLogger.error({ err }, 'staleness checker tick failed');
    } finally {
      checkerRunning = false;
    }
  };
  // Fire once immediately then interval — ensures fast detection after boot, then pinned 60s
  // But to respect pinned semantics, we schedule interval and also run first tick async
  setImmediate(() => tick().catch(() => {}));
  checkerTimer = setInterval(tick, intervalMs);
  // Don't block process exit
  if (typeof (checkerTimer as unknown as { unref?: () => void }).unref === 'function') {
    (checkerTimer as unknown as { unref: () => void }).unref();
  }
  return checkerTimer;
}

export function stopStalenessChecker(): void {
  if (checkerTimer) {
    clearInterval(checkerTimer);
    checkerTimer = null;
  }
  checkerRunning = false;
}

export function _getLastStalenessFiredAtForTests(): number | null {
  return lastStalenessFiredAt;
}
