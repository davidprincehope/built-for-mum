import { describe, it, expect } from 'vitest';
import { isCreditTransaction, isTransactionAlert } from '../../src/zenith/classifier';

describe('isCreditTransaction — credit-only per D-06', () => {
  it('CREDIT TRANSACTION NOTIFICATION + Credit → true', () => {
    expect(isCreditTransaction('CREDIT TRANSACTION NOTIFICATION', 'Credit')).toBe(true);
  });

  it('DEBIT TRANSACTION NOTIFICATION + Debit → false (ignored at debug)', () => {
    expect(isCreditTransaction('DEBIT TRANSACTION NOTIFICATION', 'Debit')).toBe(false);
  });

  it('Fwd: CREDIT TRANSACTION NOTIFICATION still true (forwarded subject)', () => {
    expect(isCreditTransaction('Fwd: CREDIT TRANSACTION NOTIFICATION', 'Credit')).toBe(true);
    expect(isCreditTransaction('Re: Fwd: CREDIT TRANSACTION NOTIFICATION', null)).toBe(true);
  });

  it('case-insensitive CREDIT still true', () => {
    expect(isCreditTransaction('credit transaction notification', 'Credit')).toBe(true);
    expect(isCreditTransaction('Credit Transaction Notification', 'credit')).toBe(true);
  });

  it('missing type but credit subject still true', () => {
    expect(isCreditTransaction('CREDIT TRANSACTION NOTIFICATION', null)).toBe(true);
    expect(isCreditTransaction('CREDIT TRANSACTION NOTIFICATION', '')).toBe(true);
  });

  it('missing subject but Transaction Type Credit → true', () => {
    expect(isCreditTransaction('', 'Credit')).toBe(true);
    expect(isCreditTransaction('', 'credit')).toBe(true);
  });

  it('missing subject but Transaction Type Debit → false', () => {
    expect(isCreditTransaction('', 'Debit')).toBe(false);
  });

  it('no marker and no type → false (non-alert)', () => {
    expect(isCreditTransaction('', null)).toBe(false);
    expect(isCreditTransaction('Some other subject', null)).toBe(false);
  });

  it('DEBIT subject wins even if type says Credit (subject marker precedence)', () => {
    expect(isCreditTransaction('DEBIT TRANSACTION NOTIFICATION', 'Credit')).toBe(false);
  });
});

describe('isTransactionAlert — FR-1.5 / Pitfall 7 alert storm avoidance', () => {
  it('CREDIT TRANSACTION NOTIFICATION with table → true', () => {
    expect(isTransactionAlert('CREDIT TRANSACTION NOTIFICATION', true)).toBe(true);
    expect(isTransactionAlert('DEBIT TRANSACTION NOTIFICATION', true)).toBe(true);
  });

  it('OTP subject returns false (no alert path)', () => {
    expect(isTransactionAlert('Your OTP is 123456', true)).toBe(false);
    expect(isTransactionAlert('Zenith Bank OTP', false)).toBe(false);
    expect(isTransactionAlert('Account Statement for March', true)).toBe(false);
  });

  it('credit subject but hasTable false → false (no table means not a parseable alert)', () => {
    expect(isTransactionAlert('CREDIT TRANSACTION NOTIFICATION', false)).toBe(false);
  });

  it('html string with expected labels → true when subject is alert', () => {
    const html = '<table><tr><td>Account Number</td><td>999****999</td></tr><tr><td>Reference Code</td><td>ZIB123</td></tr></table>';
    expect(isTransactionAlert('CREDIT TRANSACTION NOTIFICATION', html)).toBe(true);
    expect(isTransactionAlert('Your OTP is 123', html)).toBe(false);
  });

  it('kv map with account number → true when subject is alert', () => {
    expect(isTransactionAlert('CREDIT TRANSACTION NOTIFICATION', { 'account number': '999****999', amount: '10,000.00' })).toBe(true);
    expect(isTransactionAlert('Your OTP', { 'account number': '999****999' })).toBe(false);
  });

  it('forwarded credit subject still counts as alert', () => {
    expect(isTransactionAlert('Fwd: CREDIT TRANSACTION NOTIFICATION', true)).toBe(true);
  });

  it('DEBIT subject with table still counts as alert (isCreditTransaction decides routing, not isTransactionAlert)', () => {
    // isTransactionAlert identifies transaction alerts vs non-alerts; credit-only gating is separate
    expect(isTransactionAlert('DEBIT TRANSACTION NOTIFICATION', true)).toBe(true);
  });
});
