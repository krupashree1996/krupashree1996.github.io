# Neu-Tracker — Requirements, Rules & Verification Spec

Credit-Card statement tracker (multi-card). Ships with the HDFC **Tata Neu
Infinity** profile (full feature: import + verify + fee waiver; the statement
shows NeuCoins but there is no dedicated rewards/redeem UI) and an **Axis
Scapia** profile (generic: ledger + due board only — statement import is
Tata-Neu specific and deferred to a later Axis parser).

> **Rewards tab removed (user decision):** the user does not redeem NeuCoins and
> doesn't track lapsed coins, so the Rewards view (per-cycle coin breakdown,
> redemption/transfer ledger, coin-value config, earned/balance charts) was
> deleted. NeuCoins from statements are still parsed and shown per statement and
> in Home's "Coins still earnable"; the `redemptions[]` field and the `Calc`
> rewards functions are kept in the data model for bundle portability but have no
> UI.

**Purpose of this file:** capture every rule, formula, layout quirk and verified
decision so the assistant can re-implement / continue the work from this doc
alone. Keep it up to date when behaviour changes.

---

## 1. Scope & non-goals

- **Multi-card:** multiple card profiles in `DATA.cards[]`, each self-contained
  (its own statements, ledger, redemptions, rewards + fee config). `activeCardId`
  selects the profile the views render. A header dropdown switches profiles;
  "+ Card" adds one (type **neu** or **generic**).
  - `type: 'neu'` — full feature: statement import/verify + fee waiver (HDFC Tata
    Neu Infinity). NeuCoins are parsed from statements and shown per-statement +
    in Home's "Coins still earnable" (no dedicated rewards UI — see note above).
  - `type: 'generic'` — ledger + due board + card number only. Import nav is
    disabled (the parser is Tata-Neu specific — a generic Axis parser is
    deferred); it earns no coins (category dropdown offers only NoCoins +
    Payment), and reward/fee config stay `null`.
- NeuCoins value model (per neu card): 1 NeuCoin = ₹0.25 by default
  (`card.rewardsConfig.valuePerCoin`) — used only for the per-statement /
  Home "worth of coins" line.
- The "Bills" dashboard (due dates, payment log, interest, utilization) is
  merged into **Home** + **Ledger** — there is no separate Bills tab.
- Completely offline (no network). pdf.js runs in-browser (legacy build) reading
  the user's own PDFs. No personal data ever sent anywhere (privacy guard tests
  enforce this).

---

## 2. File map (in `neu-tracker/`)

| File | Role |
|---|---|
| `parser.js` | PDF text layer → structured transaction/summary parsing (new + old layouts) |
| `calc.js` | Reconciliation engine: `verifyStatement`, math checks, categories, exceptions, schema migration |
| `app.js` | View wiring: card switcher + add/delete card, import, statements list, ledger (with UPI + Tata+Groc coin-split sublabels), reconcile, home, charts, verify UI, persistence |
| `data/bundle.js` | Seed bundle: `version: 2`, empty ledger, `rewardsConfig.valuePerCoin: 0.25` (migrated up to v6 on load) |
| `index.html`, `style.css`, `manifest.json`, `sw.js` (v23), `icons/` | PWA shell |
| `test/cc-calc.test.js` | Parser+Calc unit tests (237 checks — old/new layout fixtures + Calc reconciliation + `guessCategory` + `coinSplit` incl. Tata+Groc + `estimatedDue` + v7 BigBasket migration) |
| `test/cc-dom.test.js` | jsdom boot smoke test (101 checks; uses repo `node_modules/jsdom`; asserts card switcher, UPI + Tata+Groc coin-split render, ledger edit/date, Home est./min-due + est-vs-actual, import-diff) |

---

## 3. Data model — bundle schema `version: 7` (multi-card)

The bundle is a list of card profiles. Each profile is self-contained: its own
identity, statements, ledger, redemptions and (for neu cards) reward/fee config.
`activeCardId` picks the profile the views render. `Calc.migrateBundle` upgrades
any older flat bundle (v0–v5, which had a single top-level card) into this shape
and seeds an empty **Axis Scapia** generic profile.

```js
{
  version: 6,
  activeCardId: 'neu',          // id of the currently-selected profile
  cards: [
    {
      id: 'neu',                // stable id
      name: 'HDFC Tata Neu Infinity',
      type: 'neu',              // 'neu' | 'generic'
      card: { no: '…8311', aan: '…', name: '…' },   // stored locally only
      records: [ /* statements, see below */ ],
      ledger: [ { id, date, desc, amount, category, reconciled, forPeriod, note } ],
      redemptions: [ { id, date, coins, value, note } ],
      rewardsConfig: { valuePerCoin: 0.25 },   // neu only; null for generic
      feeConfig: { target: 300000, month: 0, day: 19 }   // neu only; null for generic
    },
    {
      id: 'scapia', name: 'Axis Scapia', type: 'generic',
      card: { no: '', aan: '', name: '' },
      records: [], ledger: [], redemptions: [],
      rewardsConfig: null, feeConfig: null
    }
  ]
}
```

A **statement** (`records[i]`, produced by `verifyStatement` from a PDF) carries
the parsed cycle: `periodFrom/periodTo/total/minimumDue/prevDues/payments/
purchases/finance/creditLimit/availLimit/dueDate`, NeuCoins fields
(`opening/earned/transferred/adjusted/closingNeuCoins`, `bonusPrograms[]`),
`txns[]`, `status` (`verified`/`unverified`) and `reconciled` (period it was
matched to). `importTrace` (raw page texts) is kept per record for debugging.

Migration is idempotent and versioned: `SCHEMA_VERSION` in `calc.js` is the
target; `MIGRATIONS[n]` transforms shape `n → n+1`. v5 → v6 moves the legacy
top-level `card/records/ledger/redemptions/rewardsConfig/feeConfig` into
`cards[0]` (type `neu`), seeds the `scapia` profile, sets `activeCardId`, and
deletes the now-redundant top-level fields. v6 → v7 re-books BigBasket ledger
entries `nocoins` → `tatagroc` (see the BigBasket rule in §5).

Endpoints exposed by `Calc`: `Calc.migrateBundle`, `Calc.SCHEMA_VERSION=7`,
`Calc.newCard`, `Calc.DEFAULT_COIN_VALUE=0.25`, `Calc.verifyStatement`,
`Calc.applyExceptions`, `Calc.hasBlocking`, `Calc.statusSummary`,
`Calc.reconcile`, `Calc.pdate`, `Calc.redemptionReconcile`,
`Calc.rewardsTimeline`, `Calc.rewardsByCategory`, `Calc.rewardsValue`,
`Calc.dueStatus`, `Calc.utilizationOf`, `Calc.interestSummary`,
`Calc.estimatedDue`, `Calc.waiverStatus`, `Calc.autoSettlePrior`,
`Calc.paymentForRecord`,
`Calc.predictedCoins`, `Calc.coinSplit`, `Calc.classifyMerchant`,
`Calc.guessCategory`, `Calc.accountSummary` (via parser), categories table in
`Calc.CATEGORIES`. (`rewardsTimeline`/`rewardsByCategory`/`rewardsValue`/
`redemptionReconcile` have no UI since the rewards-tab removal — kept for data
model + tests.)

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
| `upi` | 1.5% | NeuCoins_on_UPI_Acc | 1% (credited in the Neu **app** only) + 0.5% (printed on the bank **statement**) |
| `grocery` | 1.5% | Base_Grocery | base rate (bank statement only; app credits nothing) |
| `base` | 1.5% | BaseNeuCoins | base rate (bank statement only; app credits nothing) |
| `tata` | 3.5% | Add_TataPayment | bonus lands next statement/cycle |
| `tatagroc` | 5% | Add_TataPayment | 1.5% grocery (this cycle) + 3.5% Tata (**next cycle**) — e.g. BigBasket paid via Tata Pay; the app already shows the full 5% instantly |
| `nocoins` | 0 | — | no NeuCoins |
| `payment` | 0 | — | repayment, no NeuCoins |

`classifyMerchant(desc)` → UPI→`upi`; grocery keywords→`grocery`; `TATA…`→`tata`;
`BPPY`/`UPI` bank rows→`payment`; default `base`.

**Coin splits in the ledger (user requests, 2026-10):** there are only two
major coin sources — the Tata Neu **app** and the bank **statement**:
- **UPI**: 1% app (never on the statement) + 0.5% statement.
- **Base/Grocery**: 1.5% statement only; the app credits nothing.
- **Tata Pay spend (e.g. BigBasket)**: 1.5% grocery this cycle + 3.5% Tata
  next cycle (`Add_TataPayment`); the app already shows the full 5% instantly.

`Calc.coinSplit(entry)` returns
`{ base, bonus, total, basePct, bonusPct, srcBase, srcBonus, nextCycle }`
(base = total − round(amount × bonusRate), so base+bonus always equals
`predictedCoins(entry).coins`); only `upi` and `tatagroc` have a `split`, all
other categories return `null`. Each such ledger row renders the combined `+N`
plus a small sublabel built from the source labels —
`1% app 10 · 0.5% statement 5` (UPI) or
`1.5% grocery 14 · 3.5% Tata 33 (next cycle)` (BigBasket, ₹942.12) — in both
the ledger and the import-diff "in ledger, not on statement" list. The total
is the calculated 5% (47 on the 02/02/25 entry); the app's own display
(47.55) is not tracked.

**BigBasket rule:** the statement prints `base=0` on BigBasket rows, so the
importer used to book them `nocoins`. `classifyMerchant` now returns
`tatagroc` for `BIGBASKET` descriptors (matched *before* the generic grocery
rule), and `guessCategory` does the same for statement txns. MIGRATIONS[6]
(v6→v7, `SCHEMA_VERSION=7`) re-books any existing BigBasket ledger entry from
`nocoins` to `tatagroc` (payments excluded). Verified against the user's real
bundle: 5 entries re-booked (02/02/25 ₹942.12 → +47 = 14+33, 16/03/25,
10/05/26, 18/07/26, 26/08/26).

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
- `balance` — **the primary check**: printed total due = prev dues + purchases
  + finance − payments (configurable)
- `mad` — minimum due = 5% formula (configurable)
- `purchases` — transactions sum to printed purchases (configurable)
- `payments` — credits sum to printed payments (configurable)
- `coins` — coins closing = opening + earned − transferred − adjusted (configurable)
- `coins_prev` — opening coins match previous closing (configurable)
- `bonus` — bonus program list adds to earned (configurable)
- `identity` — card number matches profile (configurable)
- `limit` — available credit ≤ limit − total (configurable; a *lower* printed
  available is normal — the bank deducts un-billed spends too; a *higher* one
  flags a possible limit-block misread)
- `finance` — finance charges (NOT configurable → hard block)

Tolerances (`deltas`): purchases/payments error ≤ ₹2; balance ≤ ₹20;
coins ≤ 5 (real statements are clean except note ₹8.68/ft quirks below).

All 20 real statements (202501–202608, old + new layout) now import with **zero
failing checks** — the two historical gaps are closed:

1. **No-time rows** (parser.js `parseTxnLine`): EMI / fee / loan-prepay /
   `AGGREGATOREMI` credit rows print with **no time-of-day**
   (e.g. `18/02/2025 AGGREGATOREMI -OFFUS CREDIT (Ref# …) - 416 27,709.10 Cr`).
   Previously these were dropped entirely (the date-time guard required
   `\d{2}:\d{2}`), silently under-counting payments/purchases. Now `parseTxnLine`
   falls back to a date-only match with `time='00:00'`, and the caller guard in
   `parseTransactions` accepts a date followed by a space or `|` (so pipe-layout
   new rows still work). Covers 202502, 202503, 202507.
2. **Wrapped `+ C <amount>` credits** (parser.js credit regex): payment rows whose
   description wraps to the previous line print as `19/01/2026 12:53 + C 1,210.00`
   — a credit, but the old credit regex ended `\s*Cr?` (a *required* literal `C`
   after the amount), so it never matched the bare amount. Changed to `(?:\s*Cr)?$`
   (optional). This also fixes `PETRO SURCHARGE WAIVER + C 8.68`. Covers all 2026
   files + the waiver.

**Rule:** verification never mutates data; it only reports. Import is allowed if
no non-configurable check fails; configurable fails surface to the user to accept
("Mark as reconciled").

---

## 7. UI/views & behavior (`app.js`)

**Views:** Home (landing), Import/Verify, Ledger, Reconcile. There is **no
Rewards tab** (removed — see note at top) and **no separate Bills tab** — the
bills functionality was merged:

- **Header (all views):** card profile dropdown (`#cardBox`) switches the active
  card (persisted as `activeCardId`), **"+ Card"** opens an add-card modal
  (name + type `neu`/`generic` + card number/AAN; `Calc.newCard` builds the
  profile), **"Delete card"** opens a confirm modal showing the card name and
  its record/ledger counts — the last remaining card cannot be deleted.
  `switchCard` re-renders everything (landing, ledger, charts, category
  dropdown) and persists the selection. For a `generic` card the **Import** nav
  button is disabled (the parser is Tata-Neu specific) and the category
  dropdown offers only **NoCoins + Payment** (`rebuildCategoryOptions()` runs on
  init and on every card switch; defaults to NoCoins so generic cards earn no
  coins).

- **Home (landing):** stats + history, the monthly-purchases & spend-by-category
  charts, **credit-utilization trend** (`utilizationOf = used/limit`), the
  **finance/interest summary** (`interestSummary`), the **due-dates board**
  (`dueStatus`: due date, days left, overdue, full/min/partial, outstanding).
  **Current bill** is the latest imported statement as its own entity: printed
  Statement, Total bill, Minimum due, Due date, Paid, Outstanding and Status
  (unpaid / part paid / minimum paid / settled / overdue). **Next bill (est.)**
  is the projection (single source of truth: `Calc.estimatedDue(records,
  ledger)` = carried + unbilled + last finance charge, **rounded UP to a whole
  rupee** to line up with the printed TOTAL AMOUNT DUE; min due = the 5% formula
  on that rounded total — e.g. unbilled ₹21,266.24 → est. ₹21,267, min due
  ₹1,070). Unbilled (new spend) = the sum of **non-reconciled** non-payment
  ledger entries — NOT a date cutoff. The bank's cut-off means a statement omits
  txns near its period end (an 18/09 statement only prints through 15/09), so
  spend dated *before* `periodTo` can still land on the next bill; the
  `reconciled` flag is the authoritative "already on a statement" marker (set by
  the reconcile flow when a bill fully matches). Unbilled is independent of
  statements, so a statement-less card (Axis Scapia) still shows "Unbilled (new
  spend)" on Home; "Estimated total", "Min due (est.)", "Carried forward" and
  "Finance (est.)" (and the coins line, which is Neu-only) appear only once a
  statement has been imported / for a neu card. Adding/editing/deleting a ledger
  entry re-renders Home so the totals stay live. A manual Payment entry (no
  `sourcePeriod`, not `auto`) counts as a repayment even without a bank keyword;
  imported statement credits still require a payment keyword or `forPeriod`, so
  refunds/waivers do not reduce dues.
- **Import:** `readPdf` reads ALL pages of a multi-page statement (merges page
  text, offsetting each page's y by +10000 so coordinates stay unique), runs the
  parser, then `Calc.verifyStatement`.
- **Verify:** check list with accept/raise-concern; when every check passes it
  records automatically after a short visible countdown (15s).
 - **Statements list (Home):** each statement row shows period, total, purchases,
   coins closing, ✓ reconciled / exception count; an un-reconciled row has a
   **Reconcile** button. Re-importing a recorded period keeps its reconciled flag.
   Every record stores `estimated` (the `Calc.estimatedDue` snapshot from just
   before that statement was imported, with `base` = the previous periodTo,
   computed over records excluding the one being committed so re-imports are
   stable); the row then renders an **est-vs-actual** tag, e.g. `est 24,492
   (+5)` or `est 24,492 ✓` when the printed TOTAL AMOUNT DUE matched the
   estimate.
- **Ledger:** manual spend entries (category, date, amount) grouped by month,
  category totals, plus the **payment log** (what was actually paid the bank:
  date / period / amount / method) with full/min/partial classification. Each
   coin-earning row shows its predicted `+N`; **UPI** and **Tata+Groc** rows
   additionally render a small `.coin-split` sublabel with their source
   breakdown (UPI: `1% app N₁ · 0.5% statement N₂`; BigBasket: `1.5% grocery
   N₁ · 3.5% Tata N₂ (next cycle)` — see §5) with a category-note tooltip; the
   same sublabel appears in the import-diff "in ledger, not on statement" list.
   The date field is a native `<input type="date">` (defaults to today).
   Storage stays dd/mm/yyyy — converted at
  the boundary via `toISO`/`fromISO`, both of which tolerate non-zero-padded
  day/month (`5/10/2026` → `05/10/2026`). `normalizeLedgerDates()` runs on
  load and in `renderLedger` so legacy unpadded dates never break the month
  group key (it used to render an "undefined" group). `Calc.pdate` is equally
  tolerant. Every ledger entry has **Edit** (re-fills the add form, button
  becomes "Save changes" + Cancel appears; deleting the entry being edited
  cancels the edit) and **Delete**.
- **Reconcile:** matches the ledger to the statement (amount + date); auto-
  reconciles and returns home when the bill fully matches (nothing unmatched on
  either side). A "Add all N to ledger" button books every statement-only row
  (`Calc.guessCategory`: credit→Payment, base=0→NoCoins, else merchant-guessed).
- **Persistence:** statements + bundle in one `localStorage` key; schema v6
  (multi-card) with migrations from v0–v5. `Calc.migrateBundle` is idempotent;
  a bare-JSON or older bundle file opened via **Open bundle** is migrated on
  load (see `loadBundleFile` in app.js).
- **Password:** session-only — stored in `sessionStorage` (survives reload of the open
  tab, wiped when the browser/tab closes). Never in `localStorage`, bundle.js, or the
  repo. There is no "remember on this device" option by design.
- Charts are guarded so views without the chart lib never throw.

---

## 8. Tests & how to run

- Unit/Calc: `node test/cc-calc.test.js` (237 checks — includes old/new layout
  fixtures + Calc reconciliation + `guessCategory` + `coinSplit` +
  `estimatedDue` + v7 BigBasket migration).
- DOM boot: `node test/cc-dom.test.js` (101 checks; jsdom; strips external
  scripts & SW registration; injects stub `window.pdfjsLib` + `window.Chart`
  so chart draws are asserted; exercises the multi-card header, card
  switcher, the UPI coin-split render, the merged Home/Ledger layout and the
  payment log).
- Harness for real PDFs (password `PDFPW01`, dir `Downloads/Neu_statement`):
  `node /tmp/opencode/run_merge.js` (ever merged result of 20 files, prints
  period/total/mad/due/limit/avail + verify status per statement).

Run order each time: `node test/cc-calc.test.js && node test/cc-dom.test.js`.

### Regression rules (don't break these)
1. All real statements must `importOK=true` after merge (+old-layout path).
2. `period`, `total`, `minimumDue` (5% formula), `due`, `limit` must parse on both layouts.
3. NeuCoins closing formula must hold on old & new layouts.
4. `+ C 8.68` waiter credits stay credits; EMI/PI rows never inflate purchases/payments.
5. No forbidden personal tokens in tracked files (privacy guard).
