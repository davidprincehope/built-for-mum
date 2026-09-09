import quotedPrintable from 'quoted-printable';

// Helper to produce Gmail body.data payload (base64url of QP-encoded HTML)
export function buildBodyB64(html: string): string {
  const qp = quotedPrintable.encode(html);
  const b64 = Buffer.from(qp, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function buildRawHtmlTable(fields: {
  accountNumber?: string;
  dateOfTransaction?: string;
  amount?: string;
  currency?: string;
  description?: string;
  referenceCode?: string;
  branch?: string;
  transactionType?: string;
  availableBalance?: string;
}): string {
  const rows: Array<[string, string]> = [
    ['Account Number', fields.accountNumber ?? '999****999'],
    ['Date of Transaction', fields.dateOfTransaction ?? '08/09/2026'],
    ['Amount', fields.amount ?? '10,000.00'],
    ['Currency', fields.currency ?? 'NGN'],
    ['Description', fields.description ?? 'CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER'],
    ['Reference Code', fields.referenceCode ?? 'ZIB20260908123456'],
    ['Branch', fields.branch ?? 'KUBWA'],
    ['Transaction Type', fields.transactionType ?? 'Credit'],
    ['Available Balance', fields.availableBalance ?? '1,234,567.89'],
  ];
  const tr = rows.map(([k, v]) => `  <tr><td>${k}</td><td>${v}</td></tr>`).join('\n');
  return `<table>\n${tr}\n</table>`;
}

// Prebuilt HTML fixtures per spec families
export const htmlFixtures = {
  creditCipCr: buildRawHtmlTable({
    accountNumber: '999****999',
    dateOfTransaction: '08/09/2026',
    amount: '10,000.00',
    currency: 'NGN',
    description: 'CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER',
    referenceCode: 'ZIB20260908123456',
    branch: 'KUBWA',
    transactionType: 'Credit',
    availableBalance: '1,234,567.89',
  }),
  nipCooperative: buildRawHtmlTable({
    accountNumber: '999****999',
    dateOfTransaction: '05/09/2026',
    amount: '25,000.00',
    currency: 'NGN',
    description: 'NIP/FCMB/SAMPLE SENDER/App To Zenith Bank EXAMPLE COOPERATIVE SOCIETY',
    referenceCode: 'NIP202609050001',
    branch: 'HEAD OFFICE',
    transactionType: 'Credit',
    availableBalance: '2,100,000.00',
  }),
  upIbUssdNip: buildRawHtmlTable({
    accountNumber: '999****999',
    dateOfTransaction: '06/09/2026',
    amount: '5,500.00',
    currency: 'NGN',
    description: 'UP-IB Online Transfer|USSD-NIP/To EXAMPLE S./23490XX',
    referenceCode: 'USSD20260906002',
    branch: 'LAGOS',
    transactionType: 'Credit',
    availableBalance: '1,800,250.50',
  }),
  upIbMobUto: buildRawHtmlTable({
    accountNumber: '999****999',
    dateOfTransaction: '06/09/2026',
    amount: '12,000.00',
    currency: 'NGN',
    description: 'UP-IB Online Transfer|MOB/UTO/EXAMPLE COOPERATIVE/Example Recipient',
    referenceCode: 'MOB20260906003',
    branch: 'LAGOS',
    transactionType: 'Credit',
    availableBalance: '1,812,250.50',
  }),
  bankChargeVat: buildRawHtmlTable({
    accountNumber: '999****999',
    dateOfTransaction: '07/09/2026',
    amount: '50.00',
    currency: 'NGN',
    description: 'VAT',
    referenceCode: 'VAT20260907004',
    branch: 'KUBWA',
    transactionType: 'Debit',
    availableBalance: '1,234,517.89',
  }),
  debit: buildRawHtmlTable({
    accountNumber: '999****999',
    dateOfTransaction: '07/09/2026',
    amount: '100,000.00',
    currency: 'NGN',
    description: 'CIP CR/ JOHN DOE/Transfer from JOHN DOE',
    referenceCode: 'ZIB20260907005',
    branch: 'KUBWA',
    transactionType: 'Debit',
    availableBalance: '1,134,517.89',
  }),
};

// Gmail wrapper helpers
export interface GmailFixture {
  headers: Record<string, string>;
  bodyData: string;
  html: string;
  expectedFields: {
    accountNumber: string;
    transactionDateStr: string;
    amountStr: string;
    currency: string;
    description: string;
    referenceCode: string;
    branch: string;
    transactionType: string;
    availableBalanceStr: string;
  };
}

function toFixture(html: string, overrides: Partial<GmailFixture> = {}): GmailFixture {
  return {
    headers: {
      From: 'Zenith Bank <alerts@zenithbank.com>',
      Subject: 'CREDIT TRANSACTION NOTIFICATION',
      'Authentication-Results': 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
      ...(overrides.headers ?? {}),
    },
    bodyData: buildBodyB64(html),
    html,
    expectedFields: {
      accountNumber: '999****999',
      transactionDateStr: '08/09/2026',
      amountStr: '10,000.00',
      currency: 'NGN',
      description: 'CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER',
      referenceCode: 'ZIB20260908123456',
      branch: 'KUBWA',
      transactionType: 'Credit',
      availableBalanceStr: '1,234,567.89',
      ...(overrides.expectedFields ?? {}),
    },
  };
}

export const fixtures: Record<string, GmailFixture> = {
  creditCipCr: toFixture(htmlFixtures.creditCipCr),
  nip: toFixture(htmlFixtures.nipCooperative, {
    headers: { Subject: 'CREDIT TRANSACTION NOTIFICATION' },
    expectedFields: {
      accountNumber: '999****999',
      transactionDateStr: '05/09/2026',
      amountStr: '25,000.00',
      currency: 'NGN',
      description: 'NIP/FCMB/SAMPLE SENDER/App To Zenith Bank EXAMPLE COOPERATIVE SOCIETY',
      referenceCode: 'NIP202609050001',
      branch: 'HEAD OFFICE',
      transactionType: 'Credit',
      availableBalanceStr: '2,100,000.00',
    },
  }),
  upIbUssdNip: toFixture(htmlFixtures.upIbUssdNip, {
    expectedFields: {
      accountNumber: '999****999',
      transactionDateStr: '06/09/2026',
      amountStr: '5,500.00',
      currency: 'NGN',
      description: 'UP-IB Online Transfer|USSD-NIP/To EXAMPLE S./23490XX',
      referenceCode: 'USSD20260906002',
      branch: 'LAGOS',
      transactionType: 'Credit',
      availableBalanceStr: '1,800,250.50',
    },
  }),
  upIbMobUto: toFixture(htmlFixtures.upIbMobUto, {
    expectedFields: {
      accountNumber: '999****999',
      transactionDateStr: '06/09/2026',
      amountStr: '12,000.00',
      currency: 'NGN',
      description: 'UP-IB Online Transfer|MOB/UTO/EXAMPLE COOPERATIVE/Example Recipient',
      referenceCode: 'MOB20260906003',
      branch: 'LAGOS',
      transactionType: 'Credit',
      availableBalanceStr: '1,812,250.50',
    },
  }),
  bankChargeVat: {
    headers: {
      From: 'Zenith Bank <alerts@zenithbank.com>',
      Subject: 'DEBIT TRANSACTION NOTIFICATION',
      'Authentication-Results': 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
    },
    bodyData: buildBodyB64(htmlFixtures.bankChargeVat),
    html: htmlFixtures.bankChargeVat,
    expectedFields: {
      accountNumber: '999****999',
      transactionDateStr: '07/09/2026',
      amountStr: '50.00',
      currency: 'NGN',
      description: 'VAT',
      referenceCode: 'VAT20260907004',
      branch: 'KUBWA',
      transactionType: 'Debit',
      availableBalanceStr: '1,234,517.89',
    },
  },
  debit: {
    headers: {
      From: 'Zenith Bank <alerts@zenithbank.com>',
      Subject: 'DEBIT TRANSACTION NOTIFICATION',
      'Authentication-Results': 'mx.google.com; dkim=pass header.d=zenithbank.com header.s=selector1; spf=pass',
    },
    bodyData: buildBodyB64(htmlFixtures.debit),
    html: htmlFixtures.debit,
    expectedFields: {
      accountNumber: '999****999',
      transactionDateStr: '07/09/2026',
      amountStr: '100,000.00',
      currency: 'NGN',
      description: 'CIP CR/ JOHN DOE/Transfer from JOHN DOE',
      referenceCode: 'ZIB20260907005',
      branch: 'KUBWA',
      transactionType: 'Debit',
      availableBalanceStr: '1,134,517.89',
    },
  },
};

// Helper to make Gmail message mock id payload for fetchMessage-style tests
export function makeGmailMessageMock(fix: GmailFixture, messageId = 'test-001') {
  return {
    users: {
      messages: {
        get: async () => ({
          data: {
            id: messageId,
            payload: {
              headers: Object.entries(fix.headers).map(([name, value]) => ({ name, value })),
              parts: [{ mimeType: 'text/html', body: { data: fix.bodyData } }],
            },
          },
        }),
      },
    },
  };
}
