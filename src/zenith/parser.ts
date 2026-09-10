import * as cheerio from 'cheerio';

/**
 * ParsedFields — hardened cheerio table parser per zenith_bank_email_format.md Field Regex table.
 * One extraction rule per field against kv values, not monolithic regex on raw HTML (Section 7.4).
 * D-09 strict: missing required field throws ParseFailure rather than returning partial object (T-1.9).
 */

export type ZenithFields = Record<string, string>;

export interface ParsedFields {
  accountNumber: string;
  transactionDateStr: string;
  amountStr: string;
  currency: string;
  description: string;
  referenceCode: string;
  branch: string;
  transactionType: string;
  availableBalanceStr: string;
  rawTable: Record<string, string>;
}

// Backward-compatible alias used by tracer/worker
export interface ParsedZenithEmail {
  accountNumber: string;
  transactionDate: string;
  amount: string;
  currency: string;
  description: string;
  referenceCode: string;
  branch: string;
  transactionType: string;
  availableBalance: string;
  rawFields: ZenithFields;
}

export class ParseFailure extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(`ParseFailure: missing ${field}: ${message}`);
    this.name = 'ParseFailure';
    this.field = field;
  }
}

/**
 * Extract labelled fields from Zenith HTML table.
 * Per RESEARCH: $('table tr') with label lowercased trimmed without trailing colon.
 */
export function parseZenithFields(html: string): ZenithFields {
  const $ = cheerio.load(html);
  const rows = $('table tr').toArray();
  const kv: ZenithFields = {};

  for (const tr of rows) {
    const cells = $(tr).find('td').toArray().map((td) => $(td).text().trim());
    if (cells.length >= 2) {
      const label = cells[0].replace(/[:\s]+$/, '').toLowerCase().trim();
      kv[label] = cells[1].trim();
    }
  }
  return kv;
}

// --- Per-field extractors applied to kv values (not raw HTML) ---

function extractAccountNumber(raw: string): string {
  const m = raw.match(/\d+\*+\d+/);
  if (!m) throw new ParseFailure('accountNumber', `no masked pattern in "${raw}"`);
  return m[0];
}

function extractTransactionDateStr(raw: string): string {
  const m = raw.match(/\d{2}\/\d{2}\/\d{4}/);
  if (!m) throw new ParseFailure('transactionDateStr', `no DD/MM/YYYY in "${raw}"`);
  return m[0];
}

function extractAmountStr(raw: string): string {
  const m = raw.match(/[\d,]+\.\d{2}/);
  if (!m) throw new ParseFailure('amountStr', `no N{,}NNN.NN in "${raw}"`);
  return m[0];
}

function extractCurrency(raw: string): string {
  const m = raw.match(/NGN|USD|EUR|GBP/i);
  if (!m) throw new ParseFailure('currency', `no known currency in "${raw}"`);
  return m[0].toUpperCase();
}

function extractReferenceCode(raw: string): string {
  const v = raw.trim();
  // Live 2026-09-10 NIP sample has empty reference code (NIP/KUDA...); allow empty and let validation decide
  return v;
}

function extractBranch(raw: string): string {
  const v = raw.trim();
  if (!v) throw new ParseFailure('branch', 'empty branch');
  return v;
}

function extractTransactionType(raw: string): string {
  const v = raw.trim();
  if (!v) throw new ParseFailure('transactionType', 'empty transaction type');
  return v;
}

function extractAvailableBalanceStr(raw: string): string {
  const m = raw.match(/[\d,]+\.\d{2}/);
  if (!m) throw new ParseFailure('availableBalanceStr', `no N{,}NNN.NN in "${raw}"`);
  return m[0];
}

/**
 * Pure function: HTML -> ParsedFields.
 * Builds kv map via cheerio, then per-field extraction with regex on kv values.
 * Throws ParseFailure with field name if any required field missing or fails its regex.
 */
export function parseZenithEmail(html: string): ParsedFields {
  if (!html || typeof html !== 'string' || html.trim().length === 0) {
    throw new ParseFailure('html', 'empty or missing HTML');
  }

  const kv = parseZenithFields(html);

  // Fail fast if no table rows at all -> truncated HTML case (T-1.9)
  if (Object.keys(kv).length === 0) {
    throw new ParseFailure('table', 'no table rows found — truncated or missing <table>');
  }

  function requireKv(keys: string[], fieldName: string): string {
    for (const k of keys) {
      const v = kv[k.toLowerCase()];
      if (v !== undefined && v !== '') return v;
    }
    throw new ParseFailure(fieldName, `missing row for keys [${keys.join(', ')}]`);
  }

  function optionalKv(keys: string[]): string {
    for (const k of keys) {
      if (k.toLowerCase() in kv) return kv[k.toLowerCase()] ?? '';
    }
    return '';
  }

  const accountNumberRaw = requireKv(['account number', 'account'], 'accountNumber');
  const dateRaw = requireKv(['date of transaction', 'transaction date', 'date'], 'transactionDateStr');
  const amountRaw = requireKv(['amount'], 'amountStr');
  const currencyRaw = requireKv(['currency'], 'currency');
  const descriptionRaw = requireKv(['description', 'narration'], 'description');
  const referenceRaw = optionalKv(['reference code', 'reference', 'reference number']);
  const branchRaw = requireKv(['branch'], 'branch');
  const typeRaw = requireKv(['transaction type', 'type'], 'transactionType');
  const balanceRaw = requireKv(['available balance', 'current balance', 'balance'], 'availableBalanceStr');

  return {
    accountNumber: extractAccountNumber(accountNumberRaw),
    transactionDateStr: extractTransactionDateStr(dateRaw),
    amountStr: extractAmountStr(amountRaw),
    currency: extractCurrency(currencyRaw),
    description: descriptionRaw.trim(),
    referenceCode: extractReferenceCode(referenceRaw),
    branch: extractBranch(branchRaw),
    transactionType: extractTransactionType(typeRaw),
    availableBalanceStr: extractAvailableBalanceStr(balanceRaw),
    rawTable: kv,
  };
}

// Backward-compatible wrapper returning ParsedZenithEmail shape for legacy callers
export function parseZenithEmailLegacy(html: string): ParsedZenithEmail {
  const p = parseZenithEmail(html);
  return {
    accountNumber: p.accountNumber,
    transactionDate: p.transactionDateStr,
    amount: p.amountStr,
    currency: p.currency,
    description: p.description,
    referenceCode: p.referenceCode,
    branch: p.branch,
    transactionType: p.transactionType,
    availableBalance: p.availableBalanceStr,
    rawFields: p.rawTable,
  };
}
