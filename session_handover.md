# Session handover — investments app

> This file is for continuity between sessions. It lives in the PUBLIC repo, so it
> must never contain real personal data (names, accounts, PANs, amounts, PDFs).
> Synthetic fixtures only — see AGENTS.md.

## Mandatory PII discipline (no exceptions)
- Before ANY `git commit` / `git push`: run `node scripts/pii-scan.js` (local, uncommitted — it embeds the real patterns it hunts for; keep it out of the repo).
- `npm test` always runs the committed PRIVACY GUARDs:
  - `test/cc-calc.test.js` — scans `neu-tracker/` for forbidden tokens and allowlists synthetic PNB accounts across `investments/` + `test/`.
- A COMMITTED hook at `scripts/git-hooks/pre-push` blocks pushes on PII hits (runs `scripts/pii-scan.js` when present + the committed guards). Activate once per machine: `git config core.hooksPath scripts/git-hooks`.
- Test fixtures: synthetic values only (e.g. `130910DP00004001`, `TEST HOLDER`, `130910DP00000001`).
- If real data is ever found in git history: scrub the working tree, `git filter-repo`, force-push, then verify with a full-blob scan (`git rev-list --all --objects` + grep).

## Current state (last update: 2026-10-01)
- App: investments v15 (`APP_VERSION = 15` in `investments/app.js`), SW cache `investments-v23` (`investments/sw.js`).
- Latest commit: FD/SCSS/RBI-FRB **type field** (auto payout + TDS 0, SCSS/RBI expected-total = principal-only, row badge) + a new **Commodities** tab (SGB/gold: cost vs current value or units×price, coupon receipts, return % + XIRR on actual cash flows). v15: maturity-value field hidden/ignored for scss/rbi; "Worth now" = principal for payout instruments.
- `DATA` gains a `commodities` array (persisted to localStorage + bundle). Each: `{id, name, kind(sgb|gold|other), panId, pan, invested, units, unitPrice, currentValue, valuedOn, purchaseDate, soldValue, soldDate, notes, coupons:[{date,amount}]}`. Helpers in `calc.js`: `commodityMarketValue`, `commodityCouponSummary`, `commodityFinalValue`, `commodityReturnPct`, `commodityXirr`, `validCommodity`.
- FD records gain `type` (`fd`|`scss`|`rbi`, default `fd`). `Calc.normFdType` + `fdTypeLabel`; SCSS/RBI force `interestMode=payout` (in `normInterestMode`) and their `fdExpectedTotal` = principal only (no P+simple interest). `fdFields` flips TDS→0 / mode→payout live when type changes (listener on the local `form`, NOT the document — form isn't in DOM yet at build time).
- Payout instruments (scss/rbi) IGNORE `maturityValue` everywhere: `fdExpectedTotal`, `fdMaturityValue` and `fdXirr`'s final leg all use principal-only for them (a bank-stated value is meaningless when interest is paid out — the maturity payout is just the principal). The "Maturity value" form field is hidden for scss/rbi and save zeroes it; the "Worth now" cell shows principal only in payout mode (paid-out interest is cash in hand, not in the instrument — adding it would double-count).
- FD summary tiles (order): Invested, Close now (principal + credited + simple accrual to today, ~1% break penalty ignored — noted in tooltip), Expected total, FY interest, FY TDS, prev-FY interest, prev-FY TDS (FY = 1 Apr–31 Mar, recorded payouts only).
- XIRR is net-of-TDS; archived records are recomputed on load.
- Per-FD FY breakdown (interest + TDS for current + previous FY, recorded payouts only) shows under the ledger total in the interest modal / archived payout detail, in the "Interest (paid)" tooltip on FD rows, and in the Interest (net) / TDS cell tooltips on matured-history rows. Past-dated payout entries can be added freely (no date restriction).
- Duplicate FD: a `duplicate` button on every FD row (active + matured history) opens the add form copying EVERY field except the account number — holder/PAN, amount, rate, issue + maturity dates, maturity value, tenure, TDS, mode, repay a/c, and payouts (deep-copied so edits don't leak back). Synthetic accounts `130910DP00004008` + `...4010/4011/4012` are allowlisted in the `cc-calc` PII guard.
- History rows have an `edit` button ("Edit FD (history)"): edit in place (e.g. fill a missing bank maturity value, rate, TDS); XIRR is recomputed on save. `commitFd` gains an `arch` flag; the duplicate-guard ignores the record being edited (`dup.id !== o.id`).
- Matured-history table is sorted by **latest maturity date first** (`maturityDate`, not `archivedAt`).
- All buttons default to `type="button"` (the `el()` helper in `app.js` + explicit attrs in `index.html` + regression test in `test/invest-dom.test.js`).
- `resyncHolders()` (app.js) re-links every FD/archived record to its holder by PAN text whenever `panId` is empty or stale — runs on session load, bundle import, and profile save. Fixes "import bundle then name/PAN only shows after manually editing each record".
- `npm test` = 8 suites, all passing (115 checks in invest-dom alone).

## History scrub — RESOLVED (2026-10-01)
- Full-history PII scan (every blob, all refs) found the ONLY real personal
  token in the repo's entire history was a residence name on a single
  `FORBIDDEN = [...]` test-guard line inside two old blobs of
  `test/cc-calc.test.js`. Every other candidate (synthetic PNB accounts,
  14-digit FD reference numbers, PDF/JS numeric constants, a JPEG's binary
  bytes, a timestamp) was verified to be a false positive, not PII.
- That line was rewritten to the synthetic values the working tree already used
  (matching the original `64ce1a3` scrub) via `git filter-branch --tree-filter`
  (the installed `git-filter-repo` had a broken `--replace-text` in this env —
  it silently no-op'd, so filter-branch was used instead). All 94 commits were
  rewritten; refs/original backup ref removed; reflogs expired; `git gc
  --prune=now` ran. A post-scrub full-blob scan confirms **0** real-PII blobs.
- Force-pushed to `main` (clean history now at `2e01b69`). GitHub may keep the
  pruned objects for up to ~90 days in its own GC; the rewritten history is
  what's served and what new clones/fetches get.
- If a future full-blob scan ever re-flags anything, re-run
  `git rev-list --all --objects` + the guard patterns before pushing.
