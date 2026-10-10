/* Investments tracker — shared calculation helpers (FD module).
 * Pure, dependency-free ES5. Exposed as window.Calc; also CommonJS export for tests. */
var Calc = (function () {
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseISO(iso) {
    if (!iso) return null;
    var p = String(iso).split('-').map(Number);
    if (p.length < 3 || isNaN(p[0]) || isNaN(p[1]) || isNaN(p[2])) return null;
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function dateAdd(iso, days) {
    if (!iso) return '';
    var d = parseISO(iso);
    if (!d) return '';
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fmtDate(iso) {
    if (!iso) return '\u2014';
    var p = String(iso).split('-');
    var mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1] - 1] || p[1];
    return (+p[2]) + ' ' + mo + ' ' + p[0];
  }
  function groupIn(n) {
    var fixed = Math.round(n * 100) / 100;
    var s = String(fixed);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var dot = s.indexOf('.');
    var intPart = dot >= 0 ? s.slice(0, dot) : s;
    var decPart = dot >= 0 ? s.slice(dot) : '';
    if (intPart.length <= 3) return (neg ? '-' : '') + intPart + decPart;
    var out = intPart.slice(-3);
    var rest = intPart.slice(0, -3);
    while (rest.length > 2) { out = rest.slice(-2) + ',' + out; rest = rest.slice(0, -2); }
    if (rest.length) out = rest + ',' + out;
    return (neg ? '-' : '') + out + decPart;
  }
  function fmtNum(n) { if (n == null || isNaN(n)) return '\u2014'; return groupIn(n); }
  function inr(n) {
    if (n == null || isNaN(n)) return '\u2014';
    return (n < 0 ? '\u2212' : '') + '\u20B9' + groupIn(Math.abs(n));
  }
  function compact(n) {
    if (n == null || isNaN(n)) return '\u2014';
    var neg = n < 0, a = Math.abs(n), pre = (neg ? '\u2212' : '') + '\u20B9';
    if (a >= 1e7) return pre + (a / 1e7).toFixed(2) + 'Cr';
    if (a >= 1e5) return pre + (a / 1e5).toFixed(2) + 'L';
    if (a >= 1000) return pre + (a / 1000).toFixed(1) + 'k';
    return inr(n);
  }
  function uid(p) { return p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* Days between two ISO dates (maturity - issue). */
  function fdDays(fd) {
    if (fd && fd.days > 0) return fd.days;
    var a = parseISO(fd && fd.issueDate), b = parseISO(fd && fd.maturityDate);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }
  /* Simple interest = P * r% * years. years = days/365. */
  function fdInterest(fd) {
    var p = fd && fd.amount, r = fd && fd.rate;
    if (!(p > 0) || !(r > 0)) return null;
    var d = fdDays(fd);
    if (d == null) return null;
    return Math.round(p * (r / 100) * (d / 365));
  }
  /* Instrument type: 'fd' (default), 'scss', 'rbi' (RBI floating-rate bond).
   * SCSS and FRB return ONLY the principal at maturity (interest was paid out
   * quarterly), so their expected total must not add simple interest. */
  function normFdType(fd) {
    var t = typeof fd === 'string' ? fd : fd && fd.type;
    return t === 'scss' || t === 'rbi' ? t : 'fd';
  }
  /* Expected total = bank-stated maturity value when present (FD only), else
   * P + simple interest (FD). scss/rbi are principal-only: payout instruments
   * return the invested amount at maturity, so a bank-stated value never
   * applies to them. */
  function fdExpectedTotal(fd) {
    if (normFdType(fd) !== 'fd') return fd && fd.amount > 0 ? fd.amount : null;
    if (fd && fd.maturityValue > 0) return fd.maturityValue;
    var i = fdInterest(fd);
    if (i == null) return null;
    return (fd.amount || 0) + i;
  }
  function fdTax(fd) {
    var i = fdInterest(fd);
    if (i == null) return null;
    var tds = (fd.tdsRate == null) ? 10 : fd.tdsRate;
    if (!(tds > 0)) return 0;
    return Math.round(i * (tds / 100) * 100) / 100;
  }
  function fdNetTotal(fd) {
    var exp = fdExpectedTotal(fd), tax = fdTax(fd);
    if (exp == null) return null;
    return exp - (tax || 0);
  }
  /* Bank-stated maturity value if present (FD only), else the computed
   * expected total. Payout instruments settle at principal, so a stored
   * bank value never applies to them. */
  function fdMaturityValue(fd) {
    if (normFdType(fd) === 'fd' && fd && fd.maturityValue > 0) return fd.maturityValue;
    return fdExpectedTotal(fd);
  }
  /* ---- Interest ledger (per-payout rows) ----
   * Each FD has entries [{date, int, tax}] = the interest paid out per period
   * (net = int - tax). Two modes:
   *   'compound' (FD)  — net is credited into the principal; interest accrues on the running amount.
   *   'payout'   (floating bond) — net is paid out; interest accrues on the original principal. */
  function normInterestMode(fd) {
    /* SCSS / FRB always pay out (interest never credited back), so their mode
     * is payout regardless of whatever an older record stored. */
    if (normFdType(fd) !== 'fd') return 'payout';
    var m = fd && fd.interestMode;
    return m === 'payout' ? 'payout' : 'compound';
  }
  function entryNet(e) {
    if (!e) return 0;
    return (e.int || 0) - (e.tax || 0);
  }
  /* One entry -> { idx, date, days, base, expected, int, tax, net, after }.
   * `base` is the principal the period's interest is computed on (running for
   * compound, constant for payout). `expected` is the simple-interest estimate
   * for that period, to cross-check against the bank figure (`int`). */
  function fdEntries(fd, today) {
    var out = [], base0 = fd.amount || 0, mode = normInterestMode(fd);
    var rate = (fd.rate || 0) / 100;
    // Sort by date so the ledger is chronologically ordered no matter in which
    // order the payouts were entered; day counts and the running base then
    // follow the timeline.
    var entries = (fd.entries || []).slice().sort(function (a, b) {
      return String(a.date || '') < String(b.date || '') ? -1 : String(a.date || '') > String(b.date || '') ? 1 : 0;
    });
    var accNet = 0;
    entries.forEach(function (e, idx) {
      var prevDate = idx === 0 ? (fd.issueDate || '') : (entries[idx - 1].date || '');
      var days = daysBetweenISO(prevDate, e.date);
      var int = e.int || 0, tax = e.tax || 0, net = int - tax;
      var base = mode === 'compound' ? (fd.amount || 0) + accNet : (fd.amount || 0);
      var after = base + net; // compound: credited in; payout: principal + paid-out
      var expected = days != null && base > 0 ? Math.round(base * rate * (days / 365)) : null;
      out.push({
        idx: idx, date: e.date || '', days: days, base: base, expected: expected,
        int: int, tax: tax, net: net, after: after
      });
      accNet += net;
    });
    return out;
  }
  function fdEntrySummary(fd) {
    var s = { count: 0, gross: 0, tax: 0, net: 0, lastDate: '', after: (fd.amount || 0) };
    var entries = fd.entries || [];
    entries.forEach(function (e) {
      if (!(e.int > 0)) return;
      s.count++;
      s.gross += e.int;
      s.tax += e.tax || 0;
      s.net += (e.int || 0) - (e.tax || 0);
      if (e.date > s.lastDate) s.lastDate = e.date;
    });
    s.after = (fd.amount || 0) + s.net;
    return s;
  }
  function daysBetweenISO(a, b) {
    var x = parseISO(a), y = parseISO(b);
    if (!x || !y) return null;
    return Math.round((y - x) / 86400000);
  }
  /* XIRR (annualized IRR) over cash flows [{date: iso, amt: +/-number}].
   * Returns fraction (0.08 = 8%) or null. Newton-Raphson with bisection fallback. */
  function xirr(flows) {
    var f = (flows || []).filter(function (x) { return parseISO(x && x.date) && isFinite(x.amt); })
      .map(function (x) { return { d: parseISO(x.date), a: x.amt }; });
    f.sort(function (x, y) { return x.d - y.d; });
    if (f.length < 2) return null;
    var t0 = f[0].d.getTime(), sumPos = 0, sumNeg = 0;
    f.forEach(function (x) { if (x.a > 0) sumPos += x.a; else sumNeg -= x.a; });
    if (sumPos <= 0 || sumNeg <= 0) return null;
    function npv(r) {
      var d = 0;
      f.forEach(function (x) { d += x.a / Math.pow(1 + r, (x.d - t0) / 86400000 / 365); });
      return d;
    }
    var lo = -0.9999, hi = 10;
    var flo = npv(lo), fhi = npv(hi);
    if (flo * fhi > 0) return null;
    var r = 0.1, i, x, fx, slope, nr;
    for (i = 0; i < 200; i++) {
      fx = npv(r);
      if (Math.abs(fx) < 1e-9) return r;
      if (fx * flo > 0) { lo = r; flo = fx; } else { hi = r; }
      x = r + 1e-9;
      slope = (npv(x) - fx) / 1e-9;
      if (slope !== 0) nr = r - fx / slope; else nr = (lo + hi) / 2;
      if (!(nr > lo && nr < hi)) nr = (lo + hi) / 2;
      if (Math.abs(nr - r) < 1e-12) return nr;
      r = nr;
    }
    return isFinite(r) ? r : null;
  }
  /* Annualized return of an FD, NET of TDS — the return on money actually in
   * hand. Payout mode: net entries (already after TDS) are cash flows and the
   * final value is the principal (or bank-stated value) untouched. Compound
   * mode: credits stay in the account, so only initial + final matter — the
   * final is the actual worth in hand: principal + credited net (gross − TDS)
   * from recorded payouts, or the bank value minus estimated TDS when none. */
  function fdXirr(fd) {
    if (!fd || !fd.amount || !fd.issueDate) return null;
    var flows = [{ date: fd.issueDate, amt: -fd.amount }];
    var mode = normInterestMode(fd);
    var netIn = 0;
    (fd.entries || []).forEach(function (e) {
      var net = entryNet(e);
      if (mode === 'payout' && e.date && net > 0) flows.push({ date: e.date, amt: net });
      netIn += net;
    });
    var final;
    if (mode === 'payout') {
      // Payout bonds return only the principal at maturity (interest was paid
      // out in the entries) — a bank-stated value never applies to them, so
      // this is the principal, full stop.
      final = fd.amount || 0;
    } else if (netIn > 0) {
      // Compound: the credits (already net of TDS) are in the account at
      // maturity, so money in hand = principal + net credited.
      final = (fd.amount || 0) + netIn;
    } else {
      // No payouts recorded: bank value (or P + simple interest) less the
      // TDS that would be withheld on the interest.
      final = fd.maturityValue > 0 ? fd.maturityValue : fdExpectedTotal(fd);
      final = final > 0 ? Math.max(0, final - (fdTax(fd) || 0)) : 0;
    }
    if (final > 0 && fd.maturityDate) flows.push({ date: fd.maturityDate, amt: final });
    if (flows.length < 2) return null;
    return xirr(flows);
  }
  /* Accept DD/MM/YYYY (Indian) or YYYY-MM-DD; return ISO or null if invalid. */
  function parseDDMMYYYY(s) {
    s = (s == null ? '' : String(s)).trim();
    if (!s) return null;
    var m;
    if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/))) {
      var dd = +m[1], mm = +m[2], yy = +m[3];
      if (yy < 100) yy += 2000;
      var d = new Date(yy, mm - 1, dd);
      if (d.getFullYear() !== yy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
      return yy + '-' + pad(mm) + '-' + pad(dd);
    }
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
      var iso = parseISO(s);
      if (!iso) return null;
      return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    }
    return null;
  }
  function isoToDDMMYYYY(iso) {
    if (!iso) return '';
    var p = String(iso).split('-');
    if (p.length < 3) return String(iso);
    return p[2] + '/' + p[1] + '/' + p[0];
  }
  function fdStatus(fd, today) {
    today = today || todayISO();
    if (!fd || !fd.maturityDate) return 'unknown';
    if (today < fd.maturityDate) return 'active';
    return 'matured';
  }
  /* Auto-remove on 1 Oct, 1.5 financial years after the FY of maturity
   * (Indian FY = Apr 1 – Mar 31). e.g. matured FY 2024-25 -> removed 1 Oct 2026;
   * matured FY 2025-26 -> removed 1 Oct 2027. */
  function fdAutoRemove(fd, today) {
    today = today || todayISO();
    if (!fd || !fd.maturityDate) return false;
    var p = String(fd.maturityDate).split('-');
    var y = +p[0], mo = +p[1];
    if (!y || !mo || !today) return false;
    var fyEndYear = mo >= 4 ? y + 1 : y; // FY ends 31 Mar of this year (Jan-Mar) or next (Apr-Dec)
    var cutoff = (fyEndYear + 1) + '-10-01';
    return today >= cutoff;
  }
  function fdStatusRank(fd, today) {
    var r = { active: 0, matured: 1, unknown: 2 }[fdStatus(fd, today)];
    return r == null ? 2 : r;
  }
  function sortFds(list, today) {
    return (list || []).slice().sort(function (a, b) {
      var da = a.maturityDate, db = b.maturityDate;
      if (!da && !db) return (a.account || '').localeCompare(b.account || '');
      if (!da) return 1;
      if (!db) return -1;
      if (da !== db) return da < db ? -1 : 1;
      return (a.account || '').localeCompare(b.account || '');
    });
  }
  /* Worth if this FD is closed TODAY: principal + credited net (compound) plus
   * simple interest accrued since the last credit date at the current rate.
   * Ignores the bank's break penalty (~1% on accrued interest). Null for FDs
   * that are not active. */
  function fdCloseNowValue(fd, today) {
    today = today || todayISO();
    if (!fd || !fd.maturityDate || today >= fd.maturityDate) return null;
    var mode = normInterestMode(fd);
    var base = fd.amount || 0;
    var last = fd.issueDate || '';
    (fd.entries || []).forEach(function (e) {
      if (mode === 'compound') base += entryNet(e);
      if (e.date > last) last = e.date;
    });
    var days = daysBetweenISO(last, today);
    if (days == null) days = 0;
    if (days < 0) days = 0;
    var acc = Math.round(base * ((fd.rate || 0) / 100) * (days / 365));
    return base + acc;
  }
  /* Indian FY (1 Apr – 31 Mar) containing an ISO date, as its starting year. */
  function fyOfDate(iso) {
    var p = String(iso || '').split('-');
    if (p.length < 2) return null;
    var y = +p[0], m = +p[1];
    if (!y || !m) return null;
    return m >= 4 ? y : y - 1;
  }
  function fyYearOf(isoDate, today) {
    var d = parseISO(isoDate || todayISO());
    return d.getFullYear() - (d.getMonth() + 1 < 4 ? 1 : 0);
  }
  function fyLabel(startYear) {
    return 'FY ' + String(startYear).slice(2) + '\u2013' + String(startYear + 1).slice(2);
  }
  /* Recorded (entered, not estimated) payout totals per FY for a list of FDs.
   * Covers the current and the previous FY only. */
  function fdFySummary(list, today) {
    today = today || todayISO();
    var cy = fyYearOf(today, today), py = cy - 1;
    function blank(startYear) { return { year: startYear, label: fyLabel(startYear), count: 0, interest: 0, tax: 0 }; }
    var out = { cur: blank(cy), prev: blank(py) };
    (list || []).forEach(function (fd) {
      (fd.entries || []).forEach(function (e) {
        if (!(e.int > 0) || !e.date) return;
        var fy = fyOfDate(e.date);
        if (fy == null) return;
        var t = fy === cy ? out.cur : (fy === py ? out.prev : null);
        if (t) { t.count++; t.interest += e.int || 0; t.tax += e.tax || 0; }
      });
    });
    return out;
  }
  function fdSummary(list, today) {
    var s = { count: 0, invested: 0, expected: 0, net: 0, tax: 0, matured: 0, active: 0, maturedValue: 0 };
    (list || []).forEach(function (fd) {
      s.count++;
      s.invested += fd.amount || 0;
      var exp = fdExpectedTotal(fd);
      if (exp != null) s.expected += exp;
      var net = fdNetTotal(fd);
      if (net != null) s.net += net;
      s.tax += fdTax(fd) || 0;
      var st = fdStatus(fd, today);
      if (st === 'matured') { s.matured++; s.maturedValue += fdMaturityValue(fd) || 0; }
      if (st === 'active') s.active++;
    });
    s.interest = s.expected - s.invested;
    return s;
  }
  /* ---- Commodities (gold / SGB) ----
   * A commodity is valued by its current market/redemption value (not a fixed
   * contractual payoff like debt). SGB: each bond = 1 g gold equivalent,
   * redeemed at prevailing gold price + an optional 2.5% p.a. coupon on face.
   * Returns are driven by the gold price, so "expected" is never computed — the
   * user records the current value (or units × price) and any coupon receipts. */
  function commodityMarketValue(c) {
    if (!c) return null;
    if (c.currentValue > 0) return c.currentValue;
    if (c.units > 0 && c.unitPrice > 0) return Math.round(c.units * c.unitPrice);
    return null;
  }
  function commodityCouponSummary(c) {
    var s = { count: 0, total: 0 };
    (c && c.coupons || []).forEach(function (e) {
      if (e && e.amount > 0) { s.count++; s.total += e.amount; }
    });
    return s;
  }
  /* Final value in hand: the sold/redemption value when redeemed, otherwise the
   * current market value (unrealized). */
  function commodityFinalValue(c, today) {
    if (!c) return null;
    if (c.soldValue > 0) return c.soldValue;
    return commodityMarketValue(c);
  }
  /* Simple (un-annualized) return on the cost basis: (value + coupons − cost)
   * / cost × 100. Null when there is nothing to measure yet. */
  function commodityReturnPct(c, today) {
    var v = commodityFinalValue(c, today);
    if (!c || !(c.invested > 0) || v == null) return null;
    return ((v + commodityCouponSummary(c).total - c.invested) / c.invested) * 100;
  }
  /* XIRR over the actual cash flows: −cost at purchase, +coupons, +final value
   * at the redemption date (or today when still held). */
  function commodityXirr(c, today) {
    if (!c || !(c.invested > 0) || !c.purchaseDate) return null;
    today = today || todayISO();
    var flows = [{ date: c.purchaseDate, amt: -c.invested }];
    (c.coupons || []).forEach(function (e) {
      if (e && e.amount > 0 && e.date) flows.push({ date: e.date, amt: e.amount });
    });
    var fv = commodityFinalValue(c, today);
    var end = c.soldDate || today;
    if (fv > 0 && end) flows.push({ date: end, amt: fv });
    if (flows.length < 2) return null;
    return xirr(flows);
  }
  function validCommodity(c) {
    var e = [];
    if (!(c.name || '').trim()) e.push('Name is required.');
    if (!(c.invested > 0)) e.push('Cost (invested amount) is required.');
    if (!c.purchaseDate) e.push('Purchase date is required.');
    if (c.soldDate && c.purchaseDate && c.soldDate < c.purchaseDate) e.push('Redemption date is before purchase date.');
    return e;
  }

  function validPan(o) {
    var e = [];
    var p = normPan(o.pan);
    if (p && !/^[A-Z]{5}\d{4}[A-Z]$/.test(p)) e.push('PAN must be 5 letters, 4 digits, 1 letter.');
    if (!p && !(o.name || '').trim()) e.push('Give a name or a PAN for this holder.');
    return e;
  }
  /* File-name maturity (Y_PNB_FD_YYYYMMDD_...) if the slip was imported with a
   * matching name — used to disambiguate a tenure/date mismatch. */
  function fdFileMaturity(fd) {
    var n = fd && fd.notes ? String(fd.notes) : '';
    var m = n.match(/_([0-9]{8})_/);
    if (!m) return '';
    var s = m[1];
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }

  /* Cross-check issue date, tenure (days) and maturity date. Returns a warning
   * string when they disagree by more than the month-rounding slack, else null.
   * (A "60 Months" FD is stored as 1800 days but matures ~26 days later, so the
   * tolerance is 60 days — a full-year slip is still caught.) */
  function fdDateCheck(fd) {
    if (!fd || !fd.issueDate || !fd.maturityDate) return null;
    var fileM = fdFileMaturity(fd);
    var implied = '';
    if (fd.days) implied = dateAdd(fd.issueDate, fd.days);
    // Primary signal: stated maturity vs issue + tenure.
    if (implied && implied !== fd.maturityDate) {
      var diff = Math.round((parseISO(fd.maturityDate) - parseISO(implied)) / 86400000);
      if (Math.abs(diff) > 60) {
        var suggested = implied;
        if (fileM) {
          var fdiff = Math.round((parseISO(fileM) - parseISO(implied)) / 86400000);
          if (Math.abs(fdiff) <= 10) suggested = fileM; // tenure and file name agree
        }
        return 'Maturity date ' + fmtDate(fd.maturityDate) + ' doesn\u2019t match the ' + fd.days +
          '-day tenure (issue ' + fmtDate(fd.issueDate) + ' \u2192 ' + fmtDate(implied) +
          '). Looks like a year error \u2014 should it be ' + fmtDate(suggested) + '?';
      }
    }
    // Fallback (no tenure): stated maturity vs the file-name maturity.
    if (!implied && fileM && fileM !== fd.maturityDate) {
      var d2 = Math.round((parseISO(fd.maturityDate) - parseISO(fileM)) / 86400000);
      if (Math.abs(d2) > 60) {
        return 'Maturity date ' + fmtDate(fd.maturityDate) + ' differs from the file name\u2019s ' +
          fmtDate(fileM) + ' by ' + d2 + ' days. Check the year.';
      }
    }
    return null;
  }

  function fdTypeLabel(t) {
    return { fd: 'FD', scss: 'SCSS', rbi: 'RBI FRB' }[normFdType(t)] || 'FD';
  }
  /* End-of-month ISO date: end of the month that contains the given month-start. */
  function endOfMonthISO(year, month) { // month is 1-12
    return year + '-' + pad(month) + '-' + pad(new Date(year, month, 0).getDate());
  }
  /* Payout schedule estimate for SCSS (quarterly) / RBI FRB (semi-annual).
   * These pay on TRUE periods: a full quarter = P * r / 4, a full half-year =
   * P * r / 2 — no day count. Only the two broken ends (issue -> first period
   * end, last period end -> maturity) are day-dependent, so their amounts
   * come from the record's user-entered estimates
   * (`payoutEstimate.{brokenStart,brokenEnd}`); the full-period amount comes
   * from `payoutEstimate.full` (default P*r/q). Period ends fall on the end of
   * Mar/Jun/Sep/Dec (SCSS) or on 01-Jul / 01-Jan (FRB — the bank credits the
   * semi-annual interest on the first of those months), starting with the first
   * end AFTER the issue date; the last item is always the maturity date.
   * Each item: { date, days, kind: 'start'|'full'|'end', amount }.
   * Returns [] when dates/amount are incomplete. */
   function fdPayoutSchedule(fd) {
    var type = normFdType(fd);
    if (!fd.issueDate || !fd.maturityDate || !(fd.amount > 0) || !(fd.rate > 0)) return [];
    var frb = type === 'rbi';
    var compound = type === 'fd' && normInterestMode(fd) === 'compound';
    var q = frb ? 2 : 4;                       // payouts per year (FD: quarterly)
    var gap = 12 / q;                          // months between period ends
    var per = Math.round((fd.amount * fd.rate / 100) / q);
    var perDay = fd.amount * fd.rate / 100 / 365;   // day-based pro-rata for broken ends
    var est = fd.payoutEstimate || {};
    var full = est.full != null ? est.full : per;
    var rateFrac = fd.rate / 100;
    var p = String(fd.issueDate).split('-');
    var iy = +p[0], im = +p[1];
    var out = [];
    var start = frb ? 1 : 3;                   // first boundary month (FRB: 1,7 / others: 3,6,9,12)
    var mo = start + Math.ceil((im - start) / gap) * gap;  // first boundary month >= issue month
    var bal = fd.amount;                        // running value (compound: credited-in grows it)
    for (;;) {
      var y = iy + Math.floor((mo - 1) / 12);
      var mn = ((mo - 1) % 12) + 1;
      var lastDay = frb ? 1 : new Date(y, mn, 0).getDate(); // FRB: 1st; others: last day
      var iso = y + '-' + pad(mn) + '-' + pad(lastDay);
      if (iso <= fd.issueDate) { mo += gap; continue; }
      if (iso >= fd.maturityDate) break;
      var prev = out.length ? out[out.length - 1].date : fd.issueDate;
      var days = daysBetweenISO(prev, iso);
      // a short first period (issue close to the boundary) is a broken start,
      // otherwise a full period
      var kind = out.length || days >= Math.round(gap * 30) ? 'full' : 'start';
      var amt;
      if (compound) {
        // credited in: each period's interest compounds on the running value
        amt = kind === 'full' ? Math.round(bal * rateFrac / q) : Math.round(days * bal * rateFrac / 365);
        bal += amt;
        out.push({ date: iso, days: days, kind: kind, amount: amt, after: bal });
      } else {
        amt = kind === 'full' ? full : (est.brokenStart != null ? est.brokenStart : Math.round(days * perDay));
        out.push({ date: iso, days: days, kind: kind, amount: amt });
      }
      mo += gap;
    }
    if (!out.length) return [];
    var endDays = daysBetweenISO(out[out.length - 1].date, fd.maturityDate);
    if (compound) {
      // last period's credit on the running value; `after` = value at maturity
      var finalCredit = Math.round(endDays * bal * rateFrac / 365);
      out.push({ date: fd.maturityDate, days: endDays, kind: 'end', amount: finalCredit, after: bal + finalCredit });
    } else {
      out.push({
        date: fd.maturityDate, days: endDays, kind: 'end',
        amount: est.brokenEnd != null ? est.brokenEnd : Math.round(endDays * perDay)
      });
    }
    return out;
  }
  /* Estimated coupon + redemption schedule for an SGB holding (kind 'sgb').
   * Coupons are semi-annual on the purchase anniversary (real SGB coupon dates
   * differ by a few days per series — this is an estimate). Coupon amount is on
   * the cost basis (invested), matching how most statements compute it; the
   * final redemption is at face value (₹1,000 per unit).
   * Items: { date, days, kind: 'coupon'|'end'|'redemption', amount }.
   * Returns [] when sold, or when dates/amount are incomplete. */
  function commodityPayoutSchedule(c) {
    if (!c || c.kind !== 'sgb' || c.soldDate) return [];
    if (!c.purchaseDate || !(c.invested > 0)) return [];
    var redeem = c.redeemDate;
    if (!redeem || redeem <= c.purchaseDate) return [];
    var rate = c.couponRate != null ? c.couponRate : 2.5;
    var perDay = c.invested * rate / 100 / 365;
    var full = Math.round((c.invested * rate / 100) / 2);
    var p = String(c.purchaseDate).split('-');
    var iy = +p[0], im = +p[1], iday = +p[2];
    var out = [];
    for (var k = 1; k <= 200; k++) {
      var mo = im + k * 6 - 1;
      var y = iy + Math.floor(mo / 12), mn = (mo % 12) + 1;
      var d = Math.min(iday, new Date(y, mn, 0).getDate());
      var iso = y + '-' + pad(mn) + '-' + pad(d);
      if (iso > redeem) break;            // a coupon landing exactly on maturity is the final coupon
      var prev = out.length ? out[out.length - 1].date : c.purchaseDate;
      out.push({
        date: iso, days: daysBetweenISO(prev, iso), kind: 'coupon',
        amount: full
      });
    }
    var lastDate = out.length ? out[out.length - 1].date : c.purchaseDate;
    var endDays = daysBetweenISO(lastDate, redeem);
    if (endDays > 0) out.push({ date: redeem, days: endDays, kind: 'end', amount: Math.round(endDays * perDay) });
    if (c.units > 0) out.push({ date: redeem, days: 0, kind: 'redemption', amount: Math.round(c.units * 1000) });
    return out;
  }
   /* Merge an estimated payout schedule with the recorded entries so the UI can
    * show ONE table: each estimated period row, with the bank's actual filled in
    * beside it. A recorded entry "matches" a period when its date is within
    * `tol` days of the period date (banks credit a few days early/late).
    * Each entry matches at most one period (nearest wins); an entry that matches
    * nothing becomes its own row (extra: true). Result rows:
    * { date, days, kind, amount, after, matched: entry|null, extra: bool },
    * sorted by date. `entries` items need at least { date, int } (or .amount). */
   function mergeSchedule(sched, entries, tol) {
     tol = tol || 10;
     var rows = (sched || []).map(function (r) {
       return { date: r.date, days: r.days, kind: r.kind, amount: r.amount, after: r.after, matched: null, extra: false };
     });
     (entries || []).forEach(function (e) {
       var d = parseISO(e && e.date);
       if (!d) return;
       var best = -1, bestDiff = Infinity;
       for (var i = 0; i < rows.length; i++) {
         if (rows[i].extra || rows[i].matched) continue;
         var rd = parseISO(rows[i].date);
         if (!rd) continue;
         var diff = Math.round(Math.abs(d - rd) / 86400000);
         if (diff <= tol && diff < bestDiff) { best = i; bestDiff = diff; }
       }
       if (best >= 0) rows[best].matched = e;
       else rows.push({ date: e.date, days: null, kind: 'extra', amount: null, after: null, matched: e, extra: true });
     });
     rows.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; });
     return rows;
   }
    /* The first scheduled period that has no recorded entry within `tol` days —
     * i.e. the next interest payment still to be recorded (null when none).
     * Includes overdue periods (date < today) so missed payments still show up
     * in the reminder banner (flagged red by the UI). */
    function nextUnrecorded(sched, entries, today, tol) {
      var rows = mergeSchedule(sched, entries, tol);
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].extra && !rows[i].matched) return rows[i];
      }
      return null;
    }
   function validFd(fd) {
    var e = [];
    if (!(fd.account || '').trim()) e.push('Account number is required.');
    if (!(fd.amount > 0)) e.push('Invested amount is required.');
    if (!(fd.rate > 0)) e.push('Interest rate is required.');
    if (!fd.issueDate) e.push('Issue date is required.');
    if (!fd.maturityDate) e.push('Maturity date is required.');
    if (fd.issueDate && fd.maturityDate && fd.maturityDate < fd.issueDate) e.push('Maturity date is before issue date.');
    return e;
  }
  function normPan(p) { return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function holderLabel(h) {
    if (!h) return '\u2014';
    var s = h.name || '';
    if (h.pan) s += s ? ' \u00B7 ' + h.pan : h.pan;
    return s || 'PAN';
  }

  return {
    pad: pad, todayISO: todayISO, parseISO: parseISO, dateAdd: dateAdd, fmtDate: fmtDate,
    groupIn: groupIn, fmtNum: fmtNum, inr: inr, compact: compact, uid: uid,
    fdDays: fdDays, fdInterest: fdInterest, fdExpectedTotal: fdExpectedTotal,
    fdTax: fdTax, fdNetTotal: fdNetTotal, fdMaturityValue: fdMaturityValue,
    normInterestMode: normInterestMode, entryNet: entryNet, fdEntries: fdEntries, fdEntrySummary: fdEntrySummary,
    fdStatus: fdStatus, fdAutoRemove: fdAutoRemove, fdStatusRank: fdStatusRank,
    xirr: xirr, fdXirr: fdXirr, sortFds: sortFds, fdSummary: fdSummary,
    fdCloseNowValue: fdCloseNowValue, fyOfDate: fyOfDate, fyYearOf: fyYearOf, fyLabel: fyLabel, fdFySummary: fdFySummary,
    normFdType: normFdType, fdTypeLabel: fdTypeLabel, fdPayoutSchedule: fdPayoutSchedule,
    mergeSchedule: mergeSchedule, nextUnrecorded: nextUnrecorded,
    validFd: validFd, fdDateCheck: fdDateCheck, fdFileMaturity: fdFileMaturity,
    commodityMarketValue: commodityMarketValue, commodityPayoutSchedule: commodityPayoutSchedule, commodityCouponSummary: commodityCouponSummary,
    commodityFinalValue: commodityFinalValue, commodityReturnPct: commodityReturnPct,
    commodityXirr: commodityXirr, validCommodity: validCommodity,
    validPan: validPan, normPan: normPan, holderLabel: holderLabel,
    parseDDMMYYYY: parseDDMMYYYY, isoToDDMMYYYY: isoToDDMMYYYY
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
