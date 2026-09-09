import pino from 'pino';

const level = (process.env.LOG_LEVEL as pino.LevelWithSilent | undefined) ?? 'info';

export const logger = pino({
  level,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  // redact sensitive headers if they ever get logged
  redact: {
    paths: ['authorization', 'auth', '*.authorization', 'headers.authorization', 'GOOGLE_REFRESH_TOKEN', 'DATABASE_URL'],
    remove: true,
  },
});

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
