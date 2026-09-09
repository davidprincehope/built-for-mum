import { describe, it, expect } from 'vitest';
import { verifyAuthenticity } from '../../src/zenith/authenticity';

/**
 * Coverage table — maps to Phase 1 plan Section 10.1 T-1.1 to T-1.5
 * T-1.1 dkim=pass + zenithbank.com => pass
 * T-1.2 dkim=pass + attacker domain => fail domain mismatch
 * T-1.3 dkim=fail => fail
 * T-1.4 missing header => fail closed
 * T-1.5 display-name spoof (From Zenith Bank but DKIM attacker) => fail
 * Plus clause-binding multi-signature case
 */

describe('verifyAuthenticity unit — T-1.1 to T-1.5', () => {
  it('T-1.1 dkim=pass with zenithbank.com => pass', () => {
    const r = verifyAuthenticity('mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass');
    expect(r.pass).toBe(true);
    expect(r.domain).toBe('zenithbank.com');
  });

  it('T-1.2 dkim=pass but signing domain not Zenith => fail with mismatch', () => {
    const r = verifyAuthenticity('mx.google.com; dkim=pass header.d=evil.com; spf=pass');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/mismatch|d!=/i);
    expect(r.domain).toBe('mismatch');
  });

  it('T-1.3 dkim=fail => fail', () => {
    const r = verifyAuthenticity('mx.google.com; dkim=fail header.d=zenithbank.com; spf=pass');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no dkim=pass/i);
  });

  it('T-1.4 missing Authentication-Results => fail closed', () => {
    expect(verifyAuthenticity('').pass).toBe(false);
    expect(verifyAuthenticity('').reason).toMatch(/missing/i);
    expect(verifyAuthenticity('   ').pass).toBe(false);
  });

  it('T-1.5 display-name spoof — From is Zenith Bank but DKIM domain is attacker => fail', () => {
    // From: Zenith Bank <alerts@zenithbank.com> but Authentication-Results shows attacker d
    const header = 'mx.google.com; dkim=pass header.d=attacker.com header.i=@attacker.com; spf=pass';
    const r = verifyAuthenticity(header);
    expect(r.pass).toBe(false);
    // ensure we never check display name — only header.d
  });

  it('clause binding: multiple DKIM signatures — attacker pass + zenith pass both present, picks zenith', () => {
    const header = 'mx.google.com; dkim=pass header.d=attacker.com; dkim=pass header.d=zenithbank.com';
    expect(verifyAuthenticity(header).pass).toBe(true);
  });

  it('clause binding: attacker pass only even when zenith fail present => fail', () => {
    const header = 'mx.google.com; dkim=pass header.d=attacker.com; dkim=fail header.d=zenithbank.com';
    expect(verifyAuthenticity(header).pass).toBe(false);
  });

  it('header.d case-insensitive and handles uppercase domain', () => {
    const r = verifyAuthenticity('mx.google.com; dkim=pass header.d=ZENITHBANK.COM');
    expect(r.pass).toBe(true);
  });
});
