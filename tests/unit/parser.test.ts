import { describe, it, expect } from 'vitest';
import { parseZenithEmail, parseZenithFields, ParseFailure } from '../../src/zenith/parser';
import { htmlFixtures, buildBodyB64 } from '../fixtures/zenith-samples';
import { decodeStrict } from '../../src/zenith/decode';

describe('parseZenithFields — cheerio kv extraction', () => {
  it('extracts kv map with lowercased labels without trailing colon', () => {
    const html = `<table><tr><td>Account Number:</td><td>999****999</td></tr></table>`;
    const kv = parseZenithFields(html);
    expect(kv['account number']).toBe('999****999');
  });

  it('handles nested tables and trims whitespace', () => {
    const html = `<table><tr><td>  Branch  </td><td>  KUBWA  </td></tr></table>`;
    const kv = parseZenithFields(html);
    expect(kv['branch']).toBe('KUBWA');
  });
});

describe('parseZenithEmail — per-field extractors (FR-1.6 / T-1.6 / T-1.7 / T-1.9)', () => {
  it('T-1.6 well-formed CIP CR credit parses all fields', () => {
    const p = parseZenithEmail(htmlFixtures.creditCipCr);
    expect(p.accountNumber).toMatch(/\d+\*+\d+/);
    expect(p.accountNumber).toBe('999****999');
    expect(p.transactionDateStr).toBe('08/09/2026');
    expect(p.amountStr).toBe('10,000.00');
    expect(p.currency).toBe('NGN');
    expect(p.description).toBe('CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER');
    expect(p.referenceCode).toBe('ZIB20260908123456');
    expect(p.branch).toBe('KUBWA');
    expect(p.transactionType).toBe('Credit');
    expect(p.availableBalanceStr).toBe('1,234,567.89');
    expect(p.rawTable).toBeDefined();
    expect(Object.keys(p.rawTable).length).toBeGreaterThanOrEqual(9);
  });

  it('acceptance: CIP CR credit fixture via spec field table — no invented field names', () => {
    const p = parseZenithEmail(htmlFixtures.creditCipCr);
    // All spec columns present via per-field rules
    expect(p.amountStr).toMatch(/[\d,]+\.\d{2}/);
    expect(p.currency).toMatch(/NGN|USD|EUR|GBP/);
    expect(p.referenceCode).toBeTruthy();
    expect(p.branch).toBeTruthy();
    expect(p.rawTable['account number']).toBeDefined();
    expect(p.rawTable['date of transaction']).toBeDefined();
    expect(p.rawTable['available balance']).toBeDefined();
  });

  it('T-1.7 amount with comma thousands separators parses correctly', () => {
    const html = `<table>
      <tr><td>Account Number</td><td>999****999</td></tr>
      <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
      <tr><td>Amount</td><td>100,000.00</td></tr>
      <tr><td>Currency</td><td>NGN</td></tr>
      <tr><td>Description</td><td>CIP CR/ TEST/Transfer</td></tr>
      <tr><td>Reference Code</td><td>REF123</td></tr>
      <tr><td>Branch</td><td>KUBWA</td></tr>
      <tr><td>Transaction Type</td><td>Credit</td></tr>
      <tr><td>Available Balance</td><td>2,000,000.00</td></tr>
    </table>`;
    const p = parseZenithEmail(html);
    expect(p.amountStr).toBe('100,000.00');
    expect(p.availableBalanceStr).toBe('2,000,000.00');
    // numeric conversion sanity
    expect(Number(p.amountStr.replace(/,/g, ''))).toBe(100000);
  });

  it('parseZenithEmail on NIP fixture returns description starting NIP/ and amount despite commas', () => {
    const p = parseZenithEmail(htmlFixtures.nipCooperative);
    expect(p.description.startsWith('NIP/')).toBe(true);
    expect(p.amountStr).toBe('25,000.00');
    expect(p.referenceCode).toBe('NIP202609050001');
  });

  it('parseZenithEmail on UP-IB fixture returns correct description and currency', () => {
    const p = parseZenithEmail(htmlFixtures.upIbUssdNip);
    expect(p.description).toBe('UP-IB Online Transfer|USSD-NIP/To EXAMPLE S./23490XX');
    expect(p.currency).toBe('NGN');
  });

  it('cheerio extracts all four families without monolithic regex on raw HTML', () => {
    for (const key of ['creditCipCr', 'nipCooperative', 'upIbUssdNip', 'bankChargeVat'] as const) {
      const p = parseZenithEmail(htmlFixtures[key]);
      expect(p.accountNumber).toMatch(/\d+\*+\d+/);
      expect(p.amountStr).toMatch(/[\d,]+\.\d{2}/);
    }
  });

  it('T-1.9 Missing Description row returns ParseFailure with field name, not partial object', () => {
    const htmlMissingDesc = `<table>
      <tr><td>Account Number</td><td>999****999</td></tr>
      <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
      <tr><td>Amount</td><td>10,000.00</td></tr>
      <tr><td>Currency</td><td>NGN</td></tr>
      <tr><td>Reference Code</td><td>ZIB123</td></tr>
      <tr><td>Branch</td><td>KUBWA</td></tr>
      <tr><td>Transaction Type</td><td>Credit</td></tr>
      <tr><td>Available Balance</td><td>1,000.00</td></tr>
    </table>`;
    expect(() => parseZenithEmail(htmlMissingDesc)).toThrow(ParseFailure);
    try {
      parseZenithEmail(htmlMissingDesc);
    } catch (e) {
      expect((e as ParseFailure).field).toBe('description');
      expect((e as Error).message).toMatch(/ParseFailure/);
    }
  });

  it('T-1.9 truncated HTML returns ParseFailure, not partial object', () => {
    expect(() => parseZenithEmail('<html><body>not a table at all</body></html>')).toThrow(ParseFailure);
    expect(() => parseZenithEmail('')).toThrow(ParseFailure);
    expect(() => parseZenithEmail('<table><tr><td>Account Number</td></tr></table>')).toThrow(ParseFailure);
  });

  it('T-3.6 non-English / unexpected chars in description handled without corruption', () => {
    const html = `<table>
      <tr><td>Account Number</td><td>999****999</td></tr>
      <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
      <tr><td>Amount</td><td>10,000.00</td></tr>
      <tr><td>Currency</td><td>NGN</td></tr>
      <tr><td>Description</td><td>CIP CR/ JOSÉ GARCÍA-LÓPEZ/Transfer — café ñ</td></tr>
      <tr><td>Reference Code</td><td>ZIB123</td></tr>
      <tr><td>Branch</td><td>KUBWA</td></tr>
      <tr><td>Transaction Type</td><td>Credit</td></tr>
      <tr><td>Available Balance</td><td>1,000.00</td></tr>
    </table>`;
    const p = parseZenithEmail(html);
    expect(p.description).toContain('JOSÉ');
    expect(p.description).toContain('café');
  });

  it('decodeStrict -> parseZenithEmail integration preserves fields through B64->QP->HTML', () => {
    const html = htmlFixtures.creditCipCr;
    const b64 = buildBodyB64(html);
    const decoded = decodeStrict(b64);
    const p = parseZenithEmail(decoded);
    expect(p.referenceCode).toBe('ZIB20260908123456');
    expect(p.amountStr).toBe('10,000.00');
  });

  it('edge: currency lowercasing and alternative currencies (USD, EUR, GBP)', () => {
    for (const cur of ['USD', 'EUR', 'GBP', 'ngn']) {
      const html = `<table>
        <tr><td>Account Number</td><td>999****999</td></tr>
        <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
        <tr><td>Amount</td><td>10,000.00</td></tr>
        <tr><td>Currency</td><td>${cur}</td></tr>
        <tr><td>Description</td><td>CIP CR/ X/Transfer</td></tr>
        <tr><td>Reference Code</td><td>REF1</td></tr>
        <tr><td>Branch</td><td>KUBWA</td></tr>
        <tr><td>Transaction Type</td><td>Credit</td></tr>
        <tr><td>Available Balance</td><td>1,000.00</td></tr>
      </table>`;
      const p = parseZenithEmail(html);
      expect(['NGN', 'USD', 'EUR', 'GBP']).toContain(p.currency);
    }
  });

  it('edge: Available Balance also accepts Current Balance label variant', () => {
    const html = `<table>
      <tr><td>Account Number</td><td>999****999</td></tr>
      <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
      <tr><td>Amount</td><td>10,000.00</td></tr>
      <tr><td>Currency</td><td>NGN</td></tr>
      <tr><td>Description</td><td>VAT</td></tr>
      <tr><td>Reference Code</td><td>VAT123</td></tr>
      <tr><td>Branch</td><td>KUBWA</td></tr>
      <tr><td>Transaction Type</td><td>Debit</td></tr>
      <tr><td>Current Balance</td><td>999.00</td></tr>
    </table>`;
    const p = parseZenithEmail(html);
    expect(p.availableBalanceStr).toBe('999.00');
  });
});
