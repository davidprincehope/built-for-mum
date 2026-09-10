import { z } from 'zod';
import { parse, isValid } from 'date-fns';

const currencyEnum = z.enum(['NGN', 'USD', 'EUR', 'GBP']);

export const transactionSchema = z.object({
  amount: z
    .string()
    .regex(/^[\d,]+\.\d{2}$/, 'amount must match N{,}NNN.NN with 2 decimals')
    .transform((s) => {
      const n = Number(s.replace(/,/g, ''));
      if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be >0');
      return n;
    })
    .refine((n) => /^\d+(\.\d{1,2})?$/.test(String(n)), { message: 'amount max 2 decimals' }),
  currency: currencyEnum,
  transaction_reference: z.string().optional().default('').transform((s) => s.trim()),
  transaction_date: z
    .string()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, 'transaction_date must be DD/MM/YYYY')
    .transform((s) => {
      const d = parse(s, 'dd/MM/yyyy', new Date());
      if (!isValid(d)) throw new Error('invalid date');
      const now = new Date();
      if (d.getTime() - now.getTime() > 5 * 60 * 1000) throw new Error('transaction_date in future beyond tolerance');
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }),
  transaction_time: z.string().optional().nullable(),
  sender_name: z.string().min(1, 'sender_name required'),
  sender_account: z.string().min(1, 'sender_account required'),
  description: z.string().optional().default(''),
  branch: z.string().optional().default(''),
  available_balance: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      if (v == null || v === '') return null as number | null;
      const cleaned = (v as string).replace(/,/g, '');
      const n = Number(cleaned);
      if (Number.isNaN(n)) throw new Error('available_balance not numeric');
      return n as number | null;
    }),
  bank: z.string().default('Zenith Bank'),
  email_message_id: z.string().min(1),
  email_auth_result: z.string().min(1),
});

export type ValidatedTransaction = z.infer<typeof transactionSchema>;

export function validateTransaction(input: Record<string, unknown>): ValidatedTransaction {
  return transactionSchema.parse(input);
}

// Helper to build validation input from parsed email fields (cheerio kv)
export function buildValidationInput(params: {
  fields: Record<string, string>;
  emailMessageId: string;
  emailAuthResult: string;
  senderName: string;
}): Record<string, unknown> {
  const f = params.fields;
  return {
    amount: f['amount'] ?? '',
    currency: (f['currency'] ?? 'NGN').toUpperCase(),
    transaction_reference: f['reference code'] ?? f['reference'] ?? '',
    transaction_date: f['date of transaction'] ?? f['date'] ?? '',
    transaction_time: null,
    sender_name: params.senderName,
    sender_account: f['account number'] ?? '',
    description: f['description'] ?? '',
    branch: f['branch'] ?? '',
    available_balance: f['available balance'] ?? f['current balance'] ?? null,
    bank: 'Zenith Bank',
    email_message_id: params.emailMessageId,
    email_auth_result: params.emailAuthResult,
  };
}

/**
 * NFR-1.4 raw_email capping: strip CID/inline images, enforce ~100KB.
 * Drops attachments per D-17, strips Content-Type: image/* blocks, then
 * truncates to 100KB with suffix "[...truncated N bytes]" and stripped:true metadata.
 */
export function capRawEmail(raw: string | null | undefined, capBytes = 100 * 1024): string | null {
  if (!raw) return null;
  let stripped = raw;
  // Remove data:image/* base64 inline
  stripped = stripped.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image stripped]');
  // Remove MIME image parts: --boundary + Content-Type: image/*
  stripped = stripped.replace(/Content-Type:\s*image\/[^\r\n]+\r?\n[^]*?(?=\r?\n--|\r?\nContent-Type:|$)/gi, '[image part stripped]');
  // Also strip --boundary image/* blocks heuristic
  stripped = stripped.replace(/--[^-\r\n]*\r?\nContent-Type:\s*image\/[^\n]*\n(?:[^\n]*\n)*?(?=\r?\n--)/gi, '[image boundary stripped]\n');

  const bytes = Buffer.byteLength(stripped, 'utf-8');
  if (bytes > capBytes) {
    const truncatedBytes = bytes - capBytes;
    // Slice to capBytes chars (approx, then adjust for suffix)
    const suffix = `\n[...truncated ${truncatedBytes} bytes]`;
    const suffixBytes = Buffer.byteLength(suffix, 'utf-8');
    const target = capBytes - suffixBytes;
    // Slice by bytes not chars: use Buffer to avoid cutting utf8 mid-char
    const buf = Buffer.from(stripped, 'utf-8');
    stripped = buf.slice(0, target).toString('utf-8') + suffix;
  }
  return stripped;
}
