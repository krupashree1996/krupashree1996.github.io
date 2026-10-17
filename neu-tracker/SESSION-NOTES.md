# Neu-Tracker — Session Notes (last: 2026-10-18)

Hand-off notes for the next assistant session. Full spec: [REQUIREMENTS.md](REQUIREMENTS.md).
All work is committed & pushed on `main` (GitHub Pages, no build step).

## Current state (verified green)
- `node test/cc-calc.test.js` → **222 passed, 0 failed**
- `node test/cc-dom.test.js` → **94 passed, 0 failed**
- Versions: `SCHEMA_VERSION=6` (calc.js), `APP_VERSION=6` (app.js), SW `neu-tracker-v23` (sw.js)
- Latest commit: `08ef46f` — "remove rewards tab; show UPI coin split (1% app / 0.5% statement) in ledger"

## What was done this session
1. **Rewards tab removed** (user: never redeems, doesn't track lapsed coins).
   - UI deleted from index.html/app.js (nav button, section, charts, redemption form, wiring).
   - Data model untouched: `redemptions[]` field + Calc reward functions
     (`rewardsTimeline`, `redemptionReconcile`, `rewardsByCategory`, `rewardsValue`)
     remain — bundle portability + still covered by cc-calc tests.
   - NeuCoins still parsed from statements; shown per-statement + Home "Coins still earnable".
2. **UPI coin split in ledger** (user: "1% comes in Tata Neu app, 0.5% comes in bank
   statement"; wants to track both even without the rewards tab).
   - `Calc.coinSplit(entry)` (calc.js) → `{ base, bonus, total, basePct, bonusPct }`.
     Only `upi` has a `split` ({base: 0.01, bonus: 0.005}); all other categories return null.
     `base = total − round(amount × bonus)`, so base+bonus ≡ `predictedCoins(entry).coins`.
   - Ledger row (app.js `ledgerRow`) and the import-diff "in ledger, not on statement"
     list render a `.coin-split` sublabel: `1% app 10 · 0.5% statement 5` + tooltip.
   - CSS: `.lrow .coin-split` (style.css).
   - Note the percent formatting: `Math.round(pct*1000)/10` (NOT `Math.round` —
     that turned 0.5% into 1%).
3. Docs updated: REQUIREMENTS.md (rewards-removal note, UPI split rule in §5,
   §7 header/multi-card + ledger split, §8 test counts, Calc endpoint list),
   root README.md (neu-tracker/investments/tn-utilities entries).

## Open threads / possible next work
- Nothing blocked. No pending uncommitted work.
- Axis Scapia is still `generic`: no statement parser (deferred — needs its own
  layout rules). If requested, mirror parser.js patterns + add fixtures.
- Coin rounding: per-entry round (matches statement behavior); if the user ever
  wants floor/ceil instead, change `predictedCoins`/`coinSplit` together and the
  `round up 66.66 → 67` test.
- If a third card type is ever needed, extend `Calc.newCard` + `rebuildCategoryOptions`.

## Conventions
- Commit style: `neu-tracker: <lowercase description>`; always commit+push only when
  the user asks (this session's work was explicitly committed at the user's request).
- Run both test files after any change: `node test/cc-calc.test.js && node test/cc-dom.test.js`
  (run from repo root).
- Bump `sw.js` VERSION on every user-visible change (currently v23).
- Privacy guard: never commit real card numbers / statements / passwords; tests
  include a guard for this.
