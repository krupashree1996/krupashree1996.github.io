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

## Current state (last update: 2026-09-29)
- App: investments v7 (`APP_VERSION = 7` in `investments/app.js`), SW cache `investments-v15` (`investments/sw.js`).
- Latest commit: `bcbbacb` (session_handover.md) + this reordering commit.
- FD summary tiles (order): Invested, Close now (principal + credited + simple accrual to today, ~1% break penalty ignored — noted in tooltip), Expected total, FY interest, FY TDS, prev-FY interest, prev-FY TDS (FY = 1 Apr–31 Mar, recorded payouts only).
- XIRR is net-of-TDS; archived records are recomputed on load.
- All buttons default to `type="button"` (the `el()` helper in `app.js` + explicit attrs in `index.html` + regression test in `test/invest-dom.test.js`).
- `npm test` = 8 suites, all passing.

## Known open item
- Older git history (pre-scrub commits) still contains real-looking fixtures
  (a `...4005`-style account comment, a `202608_consolidated.xlsx` reference, a
  14-digit repay-account value). Working tree and all new commits are clean;
  full removal requires `git filter-repo` + force-push — do only on the user's
  explicit go-ahead. (Describe values abstractly; never write them here.)
