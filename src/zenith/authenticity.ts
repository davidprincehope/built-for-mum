export interface AuthenticityResult {
  pass: boolean;
  domain: string | null;
  reason: string;
}

/**
 * D-07: DKIM-only clause-bound verification.
 * Split Authentication-Results on ';', iterate clauses where dkim=pass,
 * extract header.d / d / header.i, lowercase, require === 'zenithbank.com'.
 * Missing header fails closed.
 */
export function verifyAuthenticity(authResultsHeader: string): AuthenticityResult {
  if (!authResultsHeader || !authResultsHeader.trim()) {
    return { pass: false, domain: null, reason: 'missing Authentication-Results' };
  }

  const clauses = authResultsHeader.split(';').map((s) => s.trim());

  for (const clause of clauses) {
    if (!/^\s*dkim\s*=\s*pass\b/i.test(clause) && !/\bdkim\s*=\s*pass\b/i.test(clause)) {
      // Clause must contain dkim=pass as a discrete token — but also ensure it's bound to this clause
      // For robustness, check if clause contains dkim=pass at all; if not, skip clause
      continue;
    }
    // verify clause actually contains dkim=pass (handles clauses starting with mx.google.com prefix)
    if (!/\bdkim\s*=\s*pass\b/i.test(clause)) continue;

    const dMatch = clause.match(/header\.d\s*=\s*([^\s;]+)/i);
    const dFallback = clause.match(/\bd\s*=\s*([^\s;]+)/i);
    const iMatch = clause.match(/header\.i\s*=\s*@?([^\s;]+)/i);
    const raw = (dMatch?.[1] ?? dFallback?.[1] ?? iMatch?.[1] ?? '').replace(/^@/, '').toLowerCase();

    if (raw === 'zenithbank.com') {
      return { pass: true, domain: raw, reason: `dkim=pass d=${raw}` };
    }
    // dkim=pass but wrong domain — continue searching other clauses (attacker domain case)
  }

  const anyPass = /\bdkim\s*=\s*pass\b/i.test(authResultsHeader);
  if (anyPass) {
    return { pass: false, domain: 'mismatch', reason: 'dkim=pass but d!=zenithbank.com' };
  }
  return { pass: false, domain: null, reason: 'no dkim=pass' };
}
