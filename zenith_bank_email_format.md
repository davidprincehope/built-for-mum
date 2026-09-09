# Zenith Bank Transaction Notification Email Format

## How to Identify a Zenith Bank Transaction Email

A Zenith Bank transaction notification email is identified by these markers:

| Check | Value |
|---|---|
| **From address** | `@zenithbank.com` |
| **Subject line** | Contains `CREDIT TRANSACTION NOTIFICATION` or `DEBIT TRANSACTION NOTIFICATION` |
| **Account number** | `999****999` (masked in body) |
| **HTML structure** | Table-based layout with labeled field rows |

---

## Email Structure

### Subject Examples

```
CREDIT TRANSACTION NOTIFICATION
DEBIT TRANSACTION NOTIFICATION
```

### HTML Body — Key Fields (table rows with label + value cells)

| Field | Pattern in HTML |
|---|---|
| **Account Number** | `999****999` (last 3 digits exposed, rest masked) |
| **Date of Transaction** | `DD/MM/YYYY` e.g. `08/09/2026` |
| **Email header date** | `Weekday, Month DD, YYYY` e.g. `Monday, September 8, 2026` |
| **Amount** | `N{,}NNN{,}NNN.NN` e.g. `100,000.00` |
| **Currency** | `NGN` (seen), or `USD`, `EUR`, `GBP` |
| **Description** | Free-text narration (see formats below) |
| **Reference Code** | Alphanumeric string, unique per transaction |
| **Branch** | e.g. `KUBWA` |
| **Transaction Type** | `Credit` or `Debit` |
| **Available Balance** | `N{,}NNN{,}NNN.NN` (post-transaction) |
| **Current Balance** | `N{,}NNN{,}NNN.NN` |

### Body Encoding

- Outer layer: **Base64** encoded
- Inner layer: **Quoted-Printable** (RFC 2045)
- Final form: **UTF-8 HTML**

Decode pipeline:
```
raw_body → base64_decode → quopri_decode → UTF-8 HTML
```

---

## Transaction Description Formats

All descriptions are found in the `Description` cell of the HTML table.
These are the known patterns, ordered by frequency:

### 1. CIP CR/ (Customer Initiated Payment — Credit)

```
CIP CR/ <SENDER NAME>/Transfer from <SENDER NAME>
```

**Examples:**
```
CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER
CIP CR/ EXAMPLE ACCOUNT HOLDER/Transfer from EXAMPLE ACCOUNT HOLDER
CIP CR/ EXAMPLE ACCOUNT HOLDER/Transfer from EXAMPLE ACCOUNT HOLDER
CIP CR/ ISAAC GBENGA OGUNMODEDE/Transfer from ISAAC GBENGA OGUNMODEDE
```

**Extraction rule:** Sender is the text between `CIP CR/` and the first `/` after it.

### 2. NIP (NIBSS Instant Payment)

```
NIP/<SOURCE_BANK>/<NARRATION>/...
```

**Examples:**
```
NIP/FCMB/SAMPLE SENDER/App To Zenith Bank EXAMPLE COOPERATIVE SOCIETY
NIP/GTB/EXAMPLE BORROWER/Loan refund to EXAMPLE COOPERATIVE SOCIETY
NIP/KBL/TRF BO SAMPLE TRANSFER SENDER ISREAL /KIP ZENITH/9999999999
NIP/ABN/EXAMPLE SENDER/MOBILE TRF TO ZIB Example Recipient EXAMPLE COOPERATIVE
```

**Extraction rule:** Sender is between the bank code (first `/`) and the second `/`. The rest is narration.

### 3. UP-IB Online Transfer (USSD / Mobile)

```
UP-IB Online Transfer|<CHANNEL>/<NARRATION>
```

**Channels seen:**
- `USSD-NIP` — USSD-based transfer
- `MOB/UTO` — Mobile/UTO transfer

**Examples:**
```
UP-IB Online Transfer|USSD-NIP/To EXAMPLE S./23490XX
UP-IB Online Transfer|MOB/UTO/EXAMPLE COOPERATIVE/Example Recipient
```

**Extraction rule:** No individual sender name; use the channel label (`USSD-NIP`, `MOB/UTO`) as the sender.

### 4. Bank Charges / Debits

```
VAT
VALUE ADDED TAX
accountStatementRequest
SMS Charges
COT (Commission on Turnover)
```

**Extraction rule:** Description IS the sender. These are always DEBIT transactions.

---

## How Parsing Works

### Step 1 — Strip HTML tags
```python
text = re.sub(r'<[^>]+>', ' ', html_str)
text = re.sub(r'[ \t\r\n]+', ' ', text).strip()
```

### Step 2 — Match fields with regex

| Field | Regex |
|---|---|
| Type | `(CREDIT|DEBIT)\s+TRANSACTION\s+NOTIFICATION` |
| Email date | `(Weekday),\s+(Month)\s+(\d{1,2}),\s+(\d{4})` |
| Account | `Account\s+Number.*?(\d+\*+\d+)` |
| Txn date | `Date\s+of\s+Transaction.*?(\d{2}/\d{2}/\d{4})` |
| Amount | `Amount.*?([\d,]+\\.\d{2})` |
| Currency | `Currency.*?(NGN\|USD\|EUR\|GBP)` |
| Description | `Description\s*(.+?)\s*Reference\s+Code` |
| Reference | `Reference\s+Code\s*(.+?)\s+Branch` |
| Branch | `Branch\s*(.+?)\s+Transaction\s+Type` |
| Balance | `Available\s+Balance.*?([\d,]+\\.\d{2})` |

### Step 3 — Clean sender from description

```python
# Strip known prefixes
desc = re.sub(r'^CIP\s+CR?/?\s*', '', desc)   # CIP CR/
desc = re.sub(r'^NIP/?\s*', '', desc)           # NIP/
desc = re.sub(r'^STBC/?\s*', '', desc)          # STBC/
desc = re.sub(r'^FBN/?\s*', '', desc)           # First Bank
desc = re.sub(r'^KBL/?\s*', '', desc)           # Keystone Bank

# Strip trailing boilerplate
desc = re.sub(r'\s*/\s*TRANSFER\s+FROM\s+.+$', '', desc)
desc = re.sub(r'\s*/\s*TRF\b.*$', '', desc)

# If slashes remain, take the first meaningful segment
if '/' in desc:
    parts = [p.strip() for p in desc.split('/') if len(p.strip()) > 2]
    desc = parts[0]
```

---

## Output Tuple Format

Each parsed transaction is a 5-tuple:

```python
("DD/MM/YYYY", "CREDIT|DEBIT", 12345.67, "NGN", "Raw Description")
```

**Example:**
```python
("08/09/2026", "CREDIT", 10000.00, "NGN",
 "CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER")
```

---

## Full Crediting Example

**Input (raw HTML body — decoded from Base64+Quoted-Printable):**
```html
<table>
  <tr><td>Account Number</td><td>999****999</td></tr>
  <tr><td>Date of Transaction</td><td>08/09/2026</td></tr>
  <tr><td>Amount</td><td>10,000.00</td></tr>
  <tr><td>Currency</td><td>NGN</td></tr>
  <tr><td>Description</td><td>CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER</td></tr>
  <tr><td>Reference Code</td><td>ZIB20260908123456</td></tr>
  <tr><td>Branch</td><td>KUBWA</td></tr>
  <tr><td>Transaction Type</td><td>Credit</td></tr>
  <tr><td>Available Balance</td><td>1,234,567.89</td></tr>
</table>
```

**Output:**
```python
{
  "type": "CREDIT",
  "date": "08/09/2026",
  "amount": 10000.0,
  "currency": "NGN",
  "description": "CIP CR/ SAMPLE ACCOUNT HOLDER/Transfer from SAMPLE ACCOUNT HOLDER",
  "sender": "SAMPLE ACCOUNT HOLDER",
  "reference": "ZIB20260908123456",
  "branch": "KUBWA",
  "available_balance": 1234567.89
}
```