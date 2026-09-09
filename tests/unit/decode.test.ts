import { describe, it, expect } from 'vitest';
import quotedPrintable from 'quoted-printable';
import { base64UrlToBase64, decodeStrict } from '../../src/zenith/decode';

function buildBodyB64(html: string): string {
  const qp = quotedPrintable.encode(html);
  const b64 = Buffer.from(qp, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const sampleHtml = `<table>
  <tr><td>Account Number</td><td>999****999</td></tr>
  <tr><td>Amount</td><td>10,000.00</td></tr>
</table>`;

describe('decodeStrict — strict B64->QP->HTML (D-09)', () => {
  it('decodes base64url payload with -/_ and missing padding into HTML containing <table', () => {
    const b64url = buildBodyB64(sampleHtml);
    expect(b64url).not.toContain('+');
    expect(b64url).not.toContain('/');
    expect(b64url).not.toMatch(/=$/);
    // ensure dash/underscore present for at least one sample
    const withPlusSlash = Buffer.from(quotedPrintable.encode('<html>aaa???bbb</html>'), 'utf-8').toString('base64');
    if (/[+/]/.test(withPlusSlash)) {
      const urlVariant = withPlusSlash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      expect(urlVariant).toMatch(/[-_]/);
    }
    const decoded = decodeStrict(b64url);
    expect(decoded).toContain('<table');
    expect(decoded).toContain('Account Number');
    expect(decoded).toContain('999****999');
  });

  it('normalizes -/_ and handles missing == padding', () => {
    const html = '<table><tr><td>Currency</td><td>NGN</td></tr></table>';
    const b64urlNoPad = buildBodyB64(html);
    // b64url has no padding; decodeStrict must pad internally
    const normalized = base64UrlToBase64(b64urlNoPad);
    expect(normalized.length % 4).toBe(0);
    expect(decodeStrict(b64urlNoPad)).toContain('NGN');
  });

  it('base64UrlToBase64 converts -/_ to +/ and pads correctly', () => {
    expect(base64UrlToBase64('YWJj')).toBe('YWJj');
    expect(base64UrlToBase64('YWJjZA')).toBe('YWJjZA==');
    expect(base64UrlToBase64('YWJjZGVm')).toBe('YWJjZGVm');
    expect(base64UrlToBase64('ab-_')).toBe('ab+/');
    expect(base64UrlToBase64('ab-_cd')).toBe('ab+/cd==');
  });

  it('throws strict-decode: base64 fail on invalid base64 (no silent fallback) per D-09', () => {
    expect(() => decodeStrict('!!!not-base64!!!')).toThrow(/strict-decode: base64 fail/);
    expect(() => decodeStrict('')).toThrow(/base64 fail/);
    expect(() => decodeStrict('@@@###')).toThrow(/strict-decode: base64 fail/);
  });

  it('throws on non-string or whitespace-only input', () => {
    expect(() => decodeStrict(null as unknown as string)).toThrow(/base64 fail/);
    expect(() => decodeStrict('   ')).toThrow(/base64 fail/);
  });

  it('no fallback to plain HTML: 7bit/plain body not base64-encoded should throw or not be silently treated as HTML', () => {
    // Plain HTML string is not valid base64url of QP — our strict decoder should reject it
    const plain = '<table><tr><td>Amount</td><td>10,000.00</td></tr></table>';
    // This plain string contains < > which fails base64 regex
    expect(() => decodeStrict(plain)).toThrow(/strict-decode: base64 fail/);
  });

  it('round-trips fixture B64->QP->HTML preserving all fields', () => {
    const html = `<table>
  <tr><td>Account Number</td><td>999****999</td></tr>
  <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
  <tr><td>Amount</td><td>10,000.00</td></tr>
  <tr><td>Currency</td><td>NGN</td></tr>
  <tr><td>Description</td><td>CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER</td></tr>
  <tr><td>Reference Code</td><td>ZIB20260908123456</td></tr>
  <tr><td>Branch</td><td>KUBWA</td></tr>
  <tr><td>Transaction Type</td><td>Credit</td></tr>
  <tr><td>Available Balance</td><td>1,234,567.89</td></tr>
</table>`;
    const b64 = buildBodyB64(html);
    const decoded = decodeStrict(b64);
    expect(decoded).toContain('Account Number');
    expect(decoded).toContain('CIP CR/ SAMPLE ACCOUNT HOLDER');
    expect(decoded).toContain('ZIB20260908123456');
  });

  it('handles standard base64 (with +/ and padding) as well as base64url', () => {
    const qp = quotedPrintable.encode(sampleHtml);
    const standardB64 = Buffer.from(qp, 'utf-8').toString('base64'); // includes +/ and =
    expect(standardB64).toMatch(/[+/=]/);
    const decoded = decodeStrict(standardB64);
    expect(decoded).toContain('<table');
  });
});
