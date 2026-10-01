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
- App: investments v13 (`APP_VERSION = 13` in `investments/app.js`), SW cache `investments-v21` (`investments/sw.js`).
- Latest commit: holder resync on load/bundle-import/profile-save (name↔PAN auto-links without manual edit); duplicate copies ALL fields except account incl. payouts (deep copy).
- FD summary tiles (order): Invested, Close now (principal + credited + simple accrual to today, ~1% break penalty ignored — noted in tooltip), Expected total, FY interest, FY TDS, prev-FY interest, prev-FY TDS (FY = 1 Apr–31 Mar, recorded payouts only).
- XIRR is net-of-TDS; archived records are recomputed on load.
- Per-FD FY breakdown (interest + TDS for current + previous FY, recorded payouts only) shows under the ledger total in the interest modal / archived payout detail, in the "Interest (paid)" tooltip on FD rows, and in the Interest (net) / TDS cell tooltips on matured-history rows. Past-dated payout entries can be added freely (no date restriction).
- Duplicate FD: a `duplicate` button on every FD row (active + matured history) opens the add form copying EVERY field except the account number — holder/PAN, amount, rate, issue + maturity dates, maturity value, tenure, TDS, mode, repay a/c, and payouts (deep-copied so edits don't leak back). Synthetic accounts `130910DP00004008` + `...4010/4011/4012` are allowlisted in the `cc-calc` PII guard.
- History rows have an `edit` button ("Edit FD (history)"): edit in place (e.g. fill a missing bank maturity value, rate, TDS); XIRR is recomputed on save. `commitFd` gains an `arch` flag; the duplicate-guard ignores the record being edited (`dup.id !== o.id`).
- Matured-history table is sorted by **latest maturity date first** (`maturityDate`, not `archivedAt`).
- All buttons default to `type="button"` (the `el()` helper in `app.js` + explicit attrs in `index.html` + regression test in `test/invest-dom.test.js`).
- `resyncHolders()` (app.js) re-links every FD/archived record to its holder by PAN text whenever `panId` is empty or stale — runs on session load, bundle import, and profile save. Fixes "import bundle then name/PAN only shows after manually editing each record".
- `npm test` = 8 suites, all passing (115 checks in invest-dom alone).

## Known open item
- Older git history (pre-scrub commits) still contains real-looking fixtures
  (a `...4005`-style account comment, a `202608_consolidated.xlsx` reference, a
  14-digit repay-account value). Working tree and all new commits are clean;
  full removal requires `git filter-repo` + force-push — do only on the user's
  explicit go-ahead. (Describe values abstractly; never write them here.)
