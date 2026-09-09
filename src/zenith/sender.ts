/**
 * D-10 Decision: LENIENT-but-safe policy for unknown description formats.
 *
 * Rationale (per CONTEXT.md agent discretion):
 * - Strict (alert + drop on UNKNOWN) would risk silently dropping legitimate credits
 *   that use a new narration format Zenith introduces. Losing a real money movement
 *   is worse than storing a raw description pending review.
 * - Lenient-but-safe stores the raw description verbatim as senderName with
 *   family=UNKNOWN, never guessing a sender, and surfaces via warn log +
 *   format-drift alert for human review. This avoids mis-attribution (T-02-02)
 *   while preserving the transaction for later matching once the format is known.
 * - The caller (processEmail) should treat UNKNOWN family as validation/alert
 *   path: insert with senderName=rawDescription but flag for review, or alert
 *   as format drift per FR-1.10 — not silently ignore.
 *
 * Implementation: extractSender(description) returns {senderName, senderAccount, family}
 * per zenith_bank_email_format.md extraction rules for the four families.
 */

export type SenderFamily = 'CIP_CR' | 'NIP' | 'UP_IB' | 'CHARGE' | 'UNKNOWN';

export interface SenderResult {
  senderName: string;
  senderAccount: string | null;
  family: SenderFamily;
}

// Masked account pattern per D-08 — stored as-is, never de-masked
const MASKED_ACCOUNT_RE = /101\*{2,}\d+/; // e.g. 999****999

const CHARGE_KEYWORDS = new Set([
  'vat',
  'value added tax',
  'c o t',
  'cot',
  'commission on turnover',
  'sms charges',
  'accountstatementrequest',
  'bank charges',
  'charge',
]);

function isChargeDescription(desc: string): boolean {
  const lower = desc.trim().toLowerCase();
  // Exact match or contains VAT/COT etc without slashes/pipes
  if (CHARGE_KEYWORDS.has(lower)) return true;
  // Also treat any of these substrings as charge when no slash prefix
  const chargeSubstrings = ['value added tax', 'commission on turnover', 'sms charges', 'accountstatement', 'cot'];
  for (const kw of chargeSubstrings) {
    if (lower.includes(kw) && !lower.includes('/') && !lower.includes('|')) return true;
  }
  // If description is short (<30 chars), no slash, no NIP/CIP/UP-IB prefix → likely charge
  if (!desc.includes('/') && !desc.includes('|') && lower.length < 40 && !/^cip\s*cr/i.test(lower) && !/^nip\//i.test(lower)) {
    // Check against known exact VAT
    if (lower === 'vat' || lower === 'value added tax') return true;
  }
  return false;
}

export function extractSender(description: string): SenderResult {
  const raw = (description ?? '').trim();
  if (!raw) {
    return { senderName: '', senderAccount: null, family: 'UNKNOWN' };
  }

  // Preserve masked account: if caller expects senderAccount to echo masked account found in description,
  // we never de-mask. The masked token is part of raw description in some narrations; return as-is if present.
  // D-08: stored as-is.

  // Family 1: CIP CR/ <SENDER NAME>/Transfer from ...
  // Extraction: text between CIP CR/ and first / after it
  const cipMatch = raw.match(/^CIP\s*CR\/\s*([^/]+?)\s*\/(.*)$/i);
  if (cipMatch) {
    const name = cipMatch[1].trim();
    // Masked account preservation: if name contains masked pattern, keep it
    return { senderName: name, senderAccount: null, family: 'CIP_CR' };
  }
  // Also handle CIP CR without trailing slash (rare truncated case) — treat as CIP_CR with whole remainder?
  const cipLoose = raw.match(/^CIP\s*CR\/\s*(.+)$/i);
  if (cipLoose && /^CIP\s*CR\//i.test(raw)) {
    // If no second slash, take up to 'Transfer' or whole
    const after = cipLoose[1].trim();
    const beforeTransfer = after.split(/\/\s*Transfer/i)[0].trim();
    // If after contains slash, we already handled above; otherwise use beforeTransfer
    const name = beforeTransfer.split('/')[0].trim();
    if (name) return { senderName: name, senderAccount: null, family: 'CIP_CR' };
  }

  // Family 2: NIP/<SOURCE_BANK>/<NARRATION>/...
  // Sender is token between first and second slash after bank code: NIP/FCMB/SAMPLE SENDER/...
  if (/^NIP\//i.test(raw)) {
    const parts = raw.split('/');
    // parts[0]=NIP, parts[1]=bank code, parts[2]=sender, rest narration
    if (parts.length >= 3) {
      const sender = parts[2].trim();
      // Edge: some NIP narrations like NIP/KBL/TRF BO OYETUNJI ... — sender may be multi-token before next slash
      // The spec rule is "between bank code and second slash" — parts[2] is exactly that.
      if (sender) {
        return { senderName: sender, senderAccount: null, family: 'NIP' };
      }
    }
    // Fallback for malformed NIP with insufficient slashes → UNKNOWN lenient
  }

  // Family 3: UP-IB Online Transfer|<CHANNEL>/<NARRATION>
  // No individual sender; use channel label USSD-NIP or MOB/UTO as senderName
  if (/^UP-IB Online Transfer\|/i.test(raw)) {
    const afterPipe = raw.split('|')[1] ?? '';
    const channel = afterPipe.split('/')[0].trim();
    // Expected channels: USSD-NIP, MOB, MOB/UTO — for MOB/UTO the split gives MOB, need handle UTO
    // Better: extract up to second slash for MOB/UTO case
    let channelLabel = channel;
    if (/^MOB$/i.test(channel) && afterPipe.toUpperCase().includes('MOB/UTO')) {
      channelLabel = 'MOB/UTO';
    } else if (!channel) {
      channelLabel = 'UP-IB';
    }
    return { senderName: channelLabel, senderAccount: null, family: 'UP_IB' };
  }

  // Family 4: Bank charges — description IS sender
  if (isChargeDescription(raw)) {
    return { senderName: raw.trim(), senderAccount: null, family: 'CHARGE' };
  }

  // Also treat any explicit VAT / charge without classification as CHARGE if it looks like charge
  const lowerRaw = raw.toLowerCase();
  if ((lowerRaw === 'vat' || lowerRaw.includes('value added tax')) && !raw.includes('/')) {
    return { senderName: raw.trim(), senderAccount: null, family: 'CHARGE' };
  }

  // D-10 UNKNOWN: lenient-but-safe — store raw description as senderName, family UNKNOWN
  // Caller should log warn and alert as format drift, not mis-attribute.
  return { senderName: raw, senderAccount: null, family: 'UNKNOWN' };
}
