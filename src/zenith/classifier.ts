/**
 * D-06: Credit-only scope. Only CREDIT TRANSACTION NOTIFICATION enters transactions.
 * DEBIT is ignored at debug level, no suspicious, no alert. Per FR-1.5.
 * Also implements isTransactionAlert distinguishing real alerts from OTP/statement/marketing
 * to avoid alert storms (Pitfall 7).
 */

export function isCreditTransaction(subject: string, transactionTypeField?: string | null): boolean {
  const subj = (subject ?? '').toUpperCase();
  // Subject wins: CREDIT marker → true even if type says Debit (forwarded edge)
  // Use includes so Fwd:/Re: prefixes still match
  if (subj.includes('CREDIT TRANSACTION NOTIFICATION')) return true;
  if (subj.includes('DEBIT TRANSACTION NOTIFICATION')) return false;

  // Fallback to Transaction Type field (lowercased === 'credit')
  const t = (transactionTypeField ?? '').toLowerCase().trim();
  if (t === 'credit') return true;
  if (t === 'debit') return false;

  // Neither subject marker nor known type → not a credit (treat as non-alert)
  return false;
}

export function isTransactionAlert(
  subject: string,
  hasTable?: boolean | string | Record<string, string>,
): boolean {
  const subj = (subject ?? '').trim();
  const hasAlertSubject = /(CREDIT|DEBIT)\s+TRANSACTION\s+NOTIFICATION/i.test(subj);
  if (!hasAlertSubject) return false;

  // Also require evidence of Zenith table structure to distinguish from spoof subject-only
  if (hasTable === undefined || hasTable === null) return true; // subject alone is enough when caller has no table info

  if (typeof hasTable === 'boolean') return hasTable;

  if (typeof hasTable === 'string') {
    // hasTable is HTML string: check for expected labels
    return /account\s+number/i.test(hasTable) && /reference\s+code/i.test(hasTable);
  }

  if (typeof hasTable === 'object') {
    // hasTable is kv map: check for known labels
    const keys = Object.keys(hasTable).map((k) => k.toLowerCase());
    return keys.includes('account number') || keys.includes('amount') || keys.includes('reference code');
  }

  return false;
}
