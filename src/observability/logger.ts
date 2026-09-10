import pino from 'pino';
import { Writable } from 'node:stream';
import { logRing } from '../telegram/ringBuffer';

const level = (process.env.LOG_LEVEL as pino.LevelWithSilent | undefined) ?? 'info';

// Writable that feeds parsed pino JSON lines into the ring buffer
class RingBufferStream extends Writable {
  constructor() {
    super({ objectMode: false });
  }

  _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    try {
      const raw = chunk.toString().trim();
      if (!raw) {
        cb();
        return;
      }
      // pino writes newline-delimited JSON; chunk may contain multiple lines
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const lvlRaw = obj.level as string | number | undefined;
          const levelMap: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
          let lvlStr: string;
          if (typeof lvlRaw === 'number') lvlStr = levelMap[lvlRaw] ?? 'info';
          else if (typeof lvlRaw === 'string') lvlStr = lvlRaw;
          else lvlStr = 'info';
          const msg = typeof obj.msg === 'string' ? obj.msg : (typeof obj.message === 'string' ? obj.message : line.slice(0, 500));
          const ts = typeof obj.time === 'number' ? obj.time : Date.now();
          // collect bindings: everything except well-known pino keys
          const { level: _l, msg: _m, message: _msg, time: _t, pid: _pid, hostname: _host, v: _v, ...rest } = obj;
          const hasBindings = Object.keys(rest).length > 0;
          logRing.push({ ts, level: lvlStr, msg, bindings: hasBindings ? rest : undefined, raw: obj });
        } catch {
          // not JSON — store raw line
          logRing.push({ ts: Date.now(), level: 'info', msg: line.slice(0, 2000) });
        }
      }
    } catch {
      // never throw from logging path
    }
    cb();
  }
}

const ringStream = new RingBufferStream();

// Fan out to stdout (Railway JSON) + ring buffer
const multistream = pino.multistream([
  { stream: process.stdout },
  { stream: ringStream as unknown as NodeJS.WritableStream },
]);

export const logger = pino(
  {
    level,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    redact: {
      paths: [
        'authorization',
        'auth',
        '*.authorization',
        'headers.authorization',
        'GOOGLE_REFRESH_TOKEN',
        'DATABASE_URL',
        'TELEGRAM_WEBHOOK_SECRET',
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_BOT_PASSWORD',
        'OPENROUTER_API_KEY',
        'BOT_TOKEN',
        '*.TELEGRAM_WEBHOOK_SECRET',
        '*.TELEGRAM_BOT_TOKEN',
        '*.TELEGRAM_BOT_PASSWORD',
        '*.OPENROUTER_API_KEY',
        '*.DATABASE_URL',
        '*.GOOGLE_REFRESH_TOKEN',
        'text',
        'password',
        '*.text',
        '*.password',
        'update.message.text',
        '*.update.message.text',
      ],
      remove: true,
    },
  },
  multistream,
);

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
