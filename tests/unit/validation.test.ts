import { describe, it, expect } from 'vitest';
import { validateTransaction, buildValidationInput, capRawEmail } from '../../src/zenith/validation';
import { fixtures } from '../fixtures/zenith-samples';

function validInput(overrides: Record<string, unknown> = {}) {
  const baseFields: Record<string, string> = {
    amount: '10,000.00',
    currency: 'NGN',
    'reference code': 'ZIB20260908123456',
    'date of transaction': '08/09/2026',
    description: 'CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER',
    branch: 'KUBWA',
    'account number': '999****999',
    'available balance': '1,234,567.89',
  };
  const input = buildValidationInput({
    fields: baseFields,
    emailMessageId: 'test-msg-001',
    emailAuthResult: 'mx.google.com; dkim=pass header.d=zenithbank.com',
    senderName: 'SAMPLE ACCOUNT HOLDER',
  });
  return { ...input, ...overrides } as Record<string, unknown>;
}

describe('validation — FR-1.7 / T-1.10..T-1.13 / T-3.5', () => {
  it('T-1.13 full valid fixture passes and produces normalized amount 10000 for "10,000.00"', () => {
    const input = validInput();
    const v = validateTransaction(input);
    expect(v.amount).toBe(10000);
    expect(v.currency).toBe('NGN');
    expect(v.transaction_date).toBe('2026-09-08');
    expect(v.sender_name).toBe('SAMPLE ACCOUNT HOLDER');
    expect(v.sender_account).toBe('999****999');
  });

  it('T-1.13 comma amount "100,000.00" transforms to 100000', () => {
    const input = validInput({ amount: '100,000.00' } as unknown as Record<string, unknown>);
    // Need to bypass buildValidationInput which sets amount via fields; directly set amount
    const direct = { ...validInput(), amount: '100,000.00' };
    const v = validateTransaction(direct);
    expect(v.amount).toBe(100000);
  });

  it('T-1.10 negative amount rejected with validation error naming amount', () => {
    const direct = { ...validInput(), amount: '-100.00' };
    expect(() => validateTransaction(direct)).toThrow();
    try {
      validateTransaction(direct);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // ZodError message should mention amount
      expect(msg.toLowerCase()).toMatch(/amount/);
    }
  });

  it('T-1.10 zero amount rejected', () => {
    const direct = { ...validInput(), amount: '0.00' };
    expect(() => validateTransaction(direct)).toThrow(/amount/);
  });

  it('T-1.11 bad currency rejected', () => {
    const direct = { ...validInput(), currency: 'XYZ' };
    expect(() => validateTransaction(direct)).toThrow(/currency|invalid/i);
    const lower = { ...validInput(), currency: 'ngn' };
    // lower should be uppercased by buildValidationInput, but direct enum is case-sensitive
    // Test via buildValidationInput path: currency is uppercased there, so XYZ only fails
  });

  it('T-1.11 unknown currency via buildValidationInput path still rejected', () => {
    const input = buildValidationInput({
      fields: { amount: '10,000.00', currency: 'XYZ', 'reference code': 'R1', 'date of transaction': '08/09/2026', 'account number': '999****999', branch: 'KUBWA', description: 'VAT', 'available balance': '1,000.00' },
      emailMessageId: 't-xyz',
      emailAuthResult: 'mx.google.com; dkim=pass header.d=zenithbank.com',
      senderName: 'VAT',
    });
    expect(() => validateTransaction(input as Record<string, unknown>)).toThrow();
  });

  it('T-1.12 date in future (tomorrow) rejected', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dd = String(tomorrow.getDate()).padStart(2, '0');
    const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const yyyy = tomorrow.getFullYear();
    const futureStr = `${dd}/${mm}/${yyyy}`;
    const direct = { ...validInput(), transaction_date: futureStr };
    expect(() => validateTransaction(direct)).toThrow(/future/);
  });

  it('T-1.12 date with invalid calendar date rejected', () => {
    const direct = { ...validInput(), transaction_date: '32/13/2026' };
    expect(() => validateTransaction(direct)).toThrow();
  });

  it('T-3.5 missing transaction_reference rejected with non-empty error, no row inserted path', () => {
    const direct = { ...validInput(), transaction_reference: '' };
    expect(() => validateTransaction(direct)).toThrow(/transaction_reference|non-empty/i);
  });

  it('T-3.5 empty description still passes (description optional) but sender_name required', () => {
    const direct = { ...validInput(), description: '' };
    expect(() => validateTransaction(direct)).not.toThrow();
    const noSender = { ...validInput(), sender_name: '' };
    expect(() => validateTransaction(noSender)).toThrow(/sender_name/);
  });

  it('currency case: NGN lowercased via buildValidationInput uppercases to NGN', () => {
    const input = buildValidationInput({
      fields: { amount: '10,000.00', currency: 'ngn', 'reference code': 'R1', 'date of transaction': '08/09/2026', 'account number': '999****999', branch: 'KUBWA', description: 'VAT', 'available balance': '1,000.00' },
      emailMessageId: 't-lower',
      emailAuthResult: 'mx.google.com; dkim=pass header.d=zenithbank.com',
      senderName: 'VAT',
    });
    const v = validateTransaction(input as Record<string, unknown>);
    expect(v.currency).toBe('NGN');
  });

  it('available_balance comma-strip transforms correctly and nullable handled', () => {
    const direct = { ...validInput(), available_balance: '1,234,567.89' };
    const v = validateTransaction(direct);
    expect(v.available_balance).toBe(1234567.89);
    const nullBal = { ...validInput(), available_balance: null };
    const v2 = validateTransaction(nullBal);
    expect(v2.available_balance).toBeNull();
  });

  it('sender_account 999****999 stored masked as-is per D-08 never de-masked', () => {
    const input = validInput();
    const v = validateTransaction(input);
    expect(v.sender_account).toBe('999****999');
    expect(v.sender_account).toContain('****');
  });
});

describe('capRawEmail — NFR-1.4 ~100KB', () => {
  it('small email not truncated and not heavily modified', () => {
    const raw = 'From: test\nSubject: hi\n\n<table><tr><td>Amount</td><td>10,000.00</td></tr></table>';
    const capped = capRawEmail(raw);
    expect(capped).toBe(raw);
    expect(Buffer.byteLength(capped!, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
  });

  it('large inline image stripped and capped to <=100KB with truncated marker', () => {
    const imageBlob = 'A'.repeat(300 * 1024); // 300KB fake image data
    const raw = `MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary123"

--boundary123
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

<table><tr><td>Amount</td><td>10,000.00</td></tr></table>

--boundary123
Content-Type: image/jpeg; name="image.jpg"
Content-Transfer-Encoding: base64

${imageBlob}

--boundary123--`;
    const capped = capRawEmail(raw);
    expect(capped).not.toContain(imageBlob.slice(0, 100));
    expect(Buffer.byteLength(capped!, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    expect(capped!).toMatch(/\[image|truncated/i);
  });

  it('direct large blob without MIME truncation still caps to 100KB with suffix', () => {
    const raw = 'x'.repeat(150 * 1024);
    const capped = capRawEmail(raw);
    expect(Buffer.byteLength(capped!, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    expect(capped!).toContain('[...truncated');
  });

  it('null input returns null', () => {
    expect(capRawEmail(null)).toBeNull();
    expect(capRawEmail(undefined)).toBeNull();
  });

  it('data:image base64 stripped', () => {
    const raw = '<html><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="></html>' + 'a'.repeat(100);
    const capped = capRawEmail(raw);
    expect(capped).not.toContain('iVBORw0KGgo');
    expect(capped).toContain('[image stripped]');
  });
});
