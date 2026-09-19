# Neu-Tracker — Requirements, Rules & Verification Spec

HDFC Tata Neu Credit-Card statement tracker (single card, Tata Neu only).

**Purpose of this file:** capture every rule, formula, layout quirk and verified
decision so the assistant can re-implement / continue the work from this doc
alone. Keep it up to date when behaviour changes.

---

## 1. Scope & non-goals

- One credit card: HDFC **Tata Neu Infinity** (₹5,00,000 limit). No multi-card support.
- NeuCoins value model: 1 NeuCoin = ₹0.25 by default (`rewardsConfig.valuePerCoin`).
- "Rewards" = NeuCoin ledger reconciled per category; "Bills" = due/payment dashboard.
- Completely offline (no network). pdf.js runs in-browser (legacy build) reading
  the user's own PDFs. No personal data ever sent anywhere (privacy guard tests
  enforce this).

---

## 2. File map (in `neu-tracker/`)

| File | Role |
|---|---|
| `parser.js` | PDF text layer → structured transaction/summary parsing (new + old layouts) |
| `calc.js` | Reconciliation engine: `verifyStatement`, math checks, categories, exceptions, schema migration |
| `app.js` | View wiring: import, statements list, rewards/bills views, charts, verify UI, persistence |
| `data/bundle.js` | Seed: empty ledger, `version: 2`, `rewardsConfig.valuePerCoin: 0.25` |
| `index.html`, `style.css`, `manifest.json`, `sw.js`, `icons/` | PWA shell |
| `test/cc-calc.test.js` | Parser+Calc unit tests (uses `test/` fixtures; holds golden `parser.test.txt` old/new variants) |
| `test/cc-dom.test.js` | jsdom boot smoke test (uses repo `node_modules/jsdom`) |

---

## 3. Data model — bundle schema `version: 2`

```js
{
  version: 2,
  card: { issuer: 'HDFC', program: 'Tata Neu Infinity', last4: '…', limit: 500000 },
  statement: {
    period: '18/01/2025', total: 4243, minimumDue: 220, dueDate: '07/02/2025',
    creditLimit: 500000, availLimit: 495757, previousDue: 0, finance: NaN,
    purchases: NaN, payments: NaN, importOK: true, source: 'anonymous', date: 1737138600000
  },
  transactions: [ { date:'13/01/2025', time:'22:53', desc:'…', base:7, amount:485, credit:false } ],
  coins: { open: 0, earned: 7, transferred: 0, adjusted: 0, close: 5 },  /* or `prev` alt */
  mad: 220, cbilled: 0,
  reconcile: { },                       /* per-check acceptance/exceptions */
  redemptions: [ { date, coins, value, note } ],
  payments: [ { date, amount, mode } ],
  rewardsConfig: { valuePerCoin: 0.25 },
  payments: …,
  importTrace: /* raw page texts, kept for debugging */
}
```

Endpoints exposed by `Calc`: `Calc.migrateBundle`, `Calc.SCHEMA_VERSION=2`,
`Calc.DEFAULT_COIN_VALUE=0.25`, `Calc.verifyStatement`, `Calc.applyExceptions`,
`Calc.hasBlocking`, `Calc.statusSummary`, `Calc.redemptionReconcile`,
`Calc.rewardsReconcile`, `Calc.dueStatus`, `Calc.utilizationOf`,
`Calc.predictedCoins`, `Calc.classifyMerchant`, `Calc.accountSummary` (via parser),
categories table in `Calc.CATEGORIES`.

---

## 4. Parser rules (see `parser.js`)

### 4.1 Two statement layouts

- **NEW** (`Tata Neu … / TOTAL AMOUNT DUE`): transactions separated with `|`,
  date may be followed by an optional `|` (`19/09/2025| 09:01 …`); summary uses a
  5-column money row.
- **OLD** (`Statement for HDFC Bank Credit Card … Minimum Amount Due`):
  transactions separated by spaces only (old parser path), summary rows use space
  separators and 6-column money rows.

Detection: `isNewLayout(text)` = contains `TOTAL AMOUNT DUE` **and** `MINIMUM DUE`;
else `isOldLayout` via `Statement for HDFC` / `Minimum Amount Due` markers.

### 4.2 Transaction line

Required regex: `^(\d{2}\/\d{2}\/\d{4})\s*\|?\s*(\d{2}:\d{2}(?::\d{2})?)\s+(.+)$`
(a `|` after the date is tolerated). Amount is scanned from the **right**:
- trailing `Cr` → credit;
- a leading `+ C` before the amount → credit (waivers/refunds print e.g.
  `PETRO SURCHARGE WAIVER + C 8.68`);
- sign token `+` → credit;
- `BPPY`-prefixed rows → credit (bank payment);
- integer `base` = the printed coin count immediately before amount (`+ 7` tokens);
- desc = everything left, trailing sign/`Cr`/`C` stripped.

Genuine parser quirks (verified against real PDFs):
- `₹`/`C`/`RS.`/`Rs.` glyphs and glue forms (`C2,19,972.09`) are normalized.
- EMI / `PI` / reversal rows (e.g. `SANGEETHA … - 7 + C 485.00`) are debit rows
  that a naive right-to-left scanner can mis-sign — see tests below.

### 4.3 Account summary rows (money columns)

`accountSummary(lines)` returns `[prevDues, payments, purchases, finance, total]`.
Two extraction strategies exist (old vs new); **fall back** between them by column
positions when one yields NaN. On the 20 real PDFs both layouts parse all five
columns; `purchases`/`payments` cross-check the parsed transactions (see §6).

Honestly verified on real statements:
- `total` (amount due) = trailing `Cr?` money of the summary;
- `minimumDue` = `ceil(total × 5% / 10) × 10` (HDFC rounds the 5% up ₹10s);
- purchases line prints on the statement as `Purchases:`; payments as `Payments:`.

### 4.4 NeuCoins block & closing formula

- Closing NeuCoins = `open + earned − transferred − adjusted`; when the statement
  prints a closing value take it; else `close = open + earned − transferred − adjusted`.
- Coins are parsed as integers (`[*,address…]` style ~ no decimals); 5 ints
  `[open, earned, transferred, adjusted, close]` on NEW layout, 4 ints
  `[open, earned, transferred, adjusted]` plus closing on OLD layout.
- Coin-earning rule (used by ledger/prediction): purchases earn 1.5% base (UPI,
  Grocery, Base); Tata-branded spend 3.5% credited next statement; BPPY/payments
  and no-coins items earn 0. `predictedCoins = round(amount × rate)`.

---

## 5. Categories & reward programs (`calc.js`)

| category | rate | program | notes |
|---|---|---|---|
| `upi` | 1.5% | NeuCoins_on_UPI_Acc | 1% base + 0.5% bonus |
| `grocery` | 1.5% | Base_Grocery | base rate |
| `base` | 1.5% | BaseNeuCoins | base rate |
| `tata` | 3.5% | Add_TataPayment | bonus lands next statement |
| `nocoins` | 0 | — | no NeuCoins |
| `payment` | 0 | — | repayment, no NeuCoins |

`classifyMerchant(desc)` → UPI→`upi`; grocery keywords→`grocery`; `TATA…`→`tata`;
`BPPY`/`UPI` bank rows→`payment`; default `base`.

NeuCoins denominations: 1 coin ≈ ₹0.25; `redemptionReconcile` computes how many
coins the redemption `value` consumed, and `rewardsReconcile` sanity-checks
`earned − transferred − redeemed` vs the ledger.

---

## 6. Verification checks (`verifyStatement`, `calc.js`)

Produces `checks[]`; each has `{key,label,status,expected,actual,delta,configurable,message}`.
`status` ∈ `pass|warn|fail|info`. `applyExceptions(checks, exceptions)` promotes a
configurable fail/warn to `accepted` when the user supplies a matching exception.
`hasBlocking` = any non-configurable `fail` without exception (hard block).

Checks (key → meaning → configurable):
- `total` — total due read (configurable)
- `mad` — minimum due = 5% formula (configurable)
- `purchases` — transactions sum to printed purchases (configurable)
- `payments` — credits sum to printed payments (configurable)
- `balance` — running balance ≈ printed total (configurable)
- `coins` — coins closing = opening + earned − transferred − adjusted (configurable)
- `coins_prev` — opening coins match previous closing (configurable)
- `bonus` — bonus program list adds to earned (configurable)
- `identity` — card number matches profile (configurable)
- `limit` — credit limit ≈ printed (configurable)
- `finance` — finance charges (NOT configurable → hard block)

Tolerances (`deltas`): purchases/payments error ≤ ₹2; balance ≤ ₹20;
coins ≤ 5 (real statements are clean except note ₹8.68/ft quirks below).

Known residual mismatches on real statements (2025-2026, all 20 verified):
- 202503 (old layout): transactions sum off by ₹2 (₹16,946.46 vs 16,948.46); payments off by ₹299 (₹53,439.85 vs 53,738.85) due to an EMI / `PI` row.
- 202507 (new): purchases ₹43,366.41 vs 43,395.41 (₹29 bank rounding split).
- 20250918: transactions vs printed ₹2,19,972.09 → ₹2,19,981.61; payments ₹2,99,974.00 → ₹3,15,773.28 — both flagged but import allowed; treat as "needs statement-level override".
- 20260119: purchases ₹27,743.45 vs ₹24,023.45; payments ₹70,623.00 vs ₹74,343.00 (residual EMI/refund rows; `₹8.68` waiver credit now parsed correctly).
- General: `PETRO SURCHARGE WAIVER + C 8.68` (₹8.68 waiver credit) and EMI/PI
  rows must NOT be counted as purchases/payments; the parser handles the waiver
  credit; EMI rows should be tagged `emi` when desc matches `EMI`.

**Rule:** verification never mutates data; it only reports. Import is allowed if
no non-configurable check fails; configurable fails surface to the user to accept
("Mark as reconciled").

---

## 7. UI/views & behavior (`app.js`)

- **Import:** `readPdf` reads ALL pages of a multi-page statement (merges page
  text, offsetting each page's y by +10000 so coordinates stay unique), runs the
  parser, then `Calc.verifyStatement`.
- **Statements list:** each statement row shows period, total, minimum due, due
  date, coins closing, import status, verify icon; clicking opens verify dialog.
- **Rewards view:** NeuCoin balance timeline + coins-earned per category; monthly
  redemption/transfer ledger (add/delete redemptions, `createRedemption`);
  rupee value = coins × `valuePerCoin`; bonuses (e.g. Tata 3.5% next statement).
- **Bills view:** monthly due dashboard, payment log (full/min/partial), MD 5%
  formula, finance-charge summary, credit-limit utilization trend
  (`utilizationOf = used/limit`).
- **Persistence:** statements + bundle localStorage key; schema v2 with migration.
- Charts are guarded so views without the chart lib never throw.

---

## 8. Tests & how to run

- Unit/Calc: `node test/cc-calc.test.js` (172 checks — includes old/new layout
  fixtures + Calc reconciliation).
- DOM boot: `node test/cc-dom.test.js` (23 checks; jsdom; strips external scripts
  & SW registration; injects a stub `window.pdfjsLib`).
- Harness for real PDFs (password `TESTPW01`, dir `Downloads/Neu_statement`):
  `node /tmp/opencode/run_merge.js` (ever merged result of 20 files, prints
  period/total/mad/due/limit/avail + verify status per statement).

Run order each time: `node test/cc-calc.test.js && node test/cc-dom.test.js`.

### Regression rules (don't break these)
1. All real statements must `importOK=true` after merge (+old-layout path).
2. `period`, `total`, `minimumDue` (5% formula), `due`, `limit` must parse on both layouts.
3. NeuCoins closing formula must hold on old & new layouts.
4. `+ C 8.68` waiter credits stay credits; EMI/PI rows never inflate purchases/payments.
5. No forbidden personal tokens in tracked files (privacy guard).
