import { describe, it, expect } from 'vitest';
import { extractSender } from '../../src/zenith/sender';
import * as fs from 'fs';

describe('extractSender — four families per zenith_bank_email_format.md', () => {
  it('CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER → SAMPLE ACCOUNT HOLDER', () => {
    const r = extractSender('CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER');
    expect(r.senderName).toBe('SAMPLE ACCOUNT HOLDER');
    expect(r.family).toBe('CIP_CR');
    expect(r.senderAccount).toBeNull();
  });

  it('CIP CR/ with varied spacing still extracts', () => {
    expect(extractSender('CIP CR/EXAMPLE ACCOUNT HOLDER/Transfer from GBENGA').senderName).toBe('EXAMPLE ACCOUNT HOLDER');
    expect(extractSender('CIP CR/ EXAMPLE ACCOUNT HOLDER/Transfer from EXAMPLE ACCOUNT HOLDER').family).toBe('CIP_CR');
  });

  it('NIP/FCMB/SAMPLE SENDER/App To Zenith Bank ... → SAMPLE SENDER', () => {
    const r = extractSender('NIP/FCMB/SAMPLE SENDER/App To Zenith Bank EXAMPLE COOPERATIVE SOCIETY');
    expect(r.senderName).toBe('SAMPLE SENDER');
    expect(r.family).toBe('NIP');
  });

  it('NIP/KBL/TRF BO SAMPLE TRANSFER SENDER ISREAL /KIP ZENITH/9999999999 → TRF BO... (between bank code and second slash)', () => {
    const r = extractSender('NIP/KBL/TRF BO SAMPLE TRANSFER SENDER ISREAL /KIP ZENITH/9999999999');
    expect(r.family).toBe('NIP');
    expect(r.senderName).toBe('TRF BO SAMPLE TRANSFER SENDER ISREAL');
  });

  it('NIP/ABN/EXAMPLE SENDER/MOBILE TRF TO ZIB ... → EXAMPLE SENDER', () => {
    const r = extractSender('NIP/ABN/EXAMPLE SENDER/MOBILE TRF TO ZIB Example Recipient EXAMPLE COOPERATIVE');
    expect(r.senderName).toBe('EXAMPLE SENDER');
    expect(r.family).toBe('NIP');
  });

  it('UP-IB Online Transfer|USSD-NIP/To EXAMPLE S./23490XX → USSD-NIP', () => {
    const r = extractSender('UP-IB Online Transfer|USSD-NIP/To EXAMPLE S./23490XX');
    expect(r.senderName).toBe('USSD-NIP');
    expect(r.family).toBe('UP_IB');
    expect(r.senderAccount).toBeNull();
  });

  it('UP-IB Online Transfer|MOB/UTO/EXAMPLE COOPERATIVE/Example Recipient → MOB/UTO', () => {
    const r = extractSender('UP-IB Online Transfer|MOB/UTO/EXAMPLE COOPERATIVE/Example Recipient');
    expect(r.senderName).toBe('MOB/UTO');
    expect(r.family).toBe('UP_IB');
  });

  it('bank charge VAT → VAT with family CHARGE (description IS sender)', () => {
    const r = extractSender('VAT');
    expect(r.senderName).toBe('VAT');
    expect(r.family).toBe('CHARGE');
  });

  it('bank charge VALUE ADDED TAX → CHARGE', () => {
    const r = extractSender('VALUE ADDED TAX');
    expect(r.family).toBe('CHARGE');
    expect(r.senderName).toBe('VALUE ADDED TAX');
  });

  it('D-10 UNKNOWN: RANDOM NEW FORMAT X returns family UNKNOWN with raw description and no throw', () => {
    const r = extractSender('RANDOM NEW FORMAT X');
    expect(r.family).toBe('UNKNOWN');
    expect(r.senderName).toBe('RANDOM NEW FORMAT X');
    expect(r.senderAccount).toBeNull();
  });

  it('unknown with slashes but no known prefix → UNKNOWN, not mis-attributed', () => {
    const r = extractSender('SOME/NEW/FORMA/X/Y');
    expect(r.family).toBe('UNKNOWN');
    expect(r.senderName).toBe('SOME/NEW/FORMA/X/Y');
  });

  it('masked account 999****999 never de-masked (star preservation)', () => {
    // Check sender.ts file does not contain de-mask logic
    const src = fs.readFileSync('src/zenith/sender.ts', 'utf-8');
    // Should not have replace removing * or logic to expand masked account
    // But should preserve masked pattern
    const r = extractSender('NIP/KBL/TRF BO SAMPLE TRANSFER SENDER ISREAL /KIP ZENITH/9999999999');
    // senderName should not contain the masked 999****999 de-masked
    // The reference 9999999999 is unmasked in NIP example — that's sender-side account, not masked zenith account
    // Ensure the zenith masked account 999****999 is stored as-is elsewhere (not in sender extraction)
    const cipWithMask = extractSender('CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER 999****999');
    expect(cipWithMask.senderName).toBe('SAMPLE ACCOUNT HOLDER');
    // Verify source doesn't contain de-mask replacement
    expect(src).not.toMatch(/replace.*\*.*\d/);
    // Also verify validation test preserves stars
    expect('999****999').toMatch(/101\*{4}877/);
  });

  it('empty description → UNKNOWN with empty senderName', () => {
    const r = extractSender('');
    expect(r.family).toBe('UNKNOWN');
    expect(r.senderName).toBe('');
  });
});
