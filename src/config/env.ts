import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REFRESH_TOKEN: z.string().min(1, 'GOOGLE_REFRESH_TOKEN is required'),
  GOOGLE_CLOUD_PROJECT: z.string().optional().default(''),
  GOOGLE_PUBSUB_TOPIC: z.string().optional().default('gmail-zenith-notifications'),
  GOOGLE_PUBSUB_SUBSCRIPTION: z.string().optional().default('gmail-zenith-push'),
  ZENITH_SENDER_DOMAINS: z
    .string()
    .optional()
    .default('zenithbank.com')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ALERT_WEBHOOK_URL: z.string().optional().default(''),
  STALENESS_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(60),
  BUSINESS_HOURS_START: z.string().regex(/^\d{2}:\d{2}$/).default('07:00'),
  BUSINESS_HOURS_END: z.string().regex(/^\d{2}:\d{2}$/).default('21:00'),
  BUSINESS_HOURS_TIMEZONE: z.string().default('Africa/Lagos'),
  POLL_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().optional(),
});

export type Env = z.infer<typeof envSchema> & {
  // keep raw string for backwards compat if needed
  ZENITH_SENDER_DOMAINS_RAW?: string;
};

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Environment validation failed: ${details}`);
  }
  return parsed.data as Env;
}

export const env: Env = loadEnv();
