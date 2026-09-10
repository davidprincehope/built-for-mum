export interface RingEntry {
  ts: number;
  level: string;
  msg: string;
  bindings?: unknown;
  raw?: unknown;
}

const LEVEL_MAP: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const NUM_TO_LABEL: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function normalizeLevel(level: string | number | undefined): string {
  if (typeof level === 'number') return NUM_TO_LABEL[level] ?? 'info';
  if (typeof level === 'string') {
    if (LEVEL_MAP[level] !== undefined) return level;
    const asNum = Number(level);
    if (!Number.isNaN(asNum) && NUM_TO_LABEL[asNum]) return NUM_TO_LABEL[asNum]!;
    return level;
  }
  return 'info';
}

export class RingBuffer {
  private buf: RingEntry[] = [];
  constructor(private max = 500) {}

  push(entry: RingEntry): void {
    // normalize level label
    entry.level = normalizeLevel(entry.level);
    if (this.buf.length >= this.max) this.buf.shift();
    this.buf.push(entry);
  }

  tail(n = 20, minLevel?: string): RingEntry[] {
    let arr = this.buf;
    if (minLevel && LEVEL_MAP[minLevel] !== undefined) {
      const threshold = LEVEL_MAP[minLevel]!;
      arr = arr.filter((e) => (LEVEL_MAP[e.level] ?? 30) >= threshold);
    }
    return arr.slice(-n);
  }

  clear(): void {
    this.buf = [];
  }

  get length(): number {
    return this.buf.length;
  }
}

export const logRing = new RingBuffer(500);

export function formatTail(n = 20, level?: string): string[] {
  return logRing.tail(n, level).map((e) => {
    const time = new Date(e.ts).toISOString().slice(11, 19);
    return `[${time} ${e.level}] ${e.msg}`;
  });
}

export function _resetRingForTests(): void {
  logRing.clear();
}
