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
    var s = String(Math.round(n));
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    if (s.length <= 3) return (neg ? '-' : '') + s;
    var out = s.slice(-3);
    var rest = s.slice(0, -3);
    while (rest.length > 2) { out = rest.slice(-2) + ',' + out; rest = rest.slice(0, -2); }
    if (rest.length) out = rest + ',' + out;
    return (neg ? '-' : '') + out;
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
  /* Expected total = bank-stated maturity value when present, else P + simple interest. */
  function fdExpectedTotal(fd) {
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
  /* Bank-stated maturity value if present, else the computed expected total. */
  function fdMaturityValue(fd) {
    if (fd && fd.maturityValue > 0) return fd.maturityValue;
    return fdExpectedTotal(fd);
  }
  /* ---- Interest ledger (per-payout rows) ----
   * Each FD has entries [{date, int, tax}] = the interest paid out per period
   * (net = int - tax). Two modes:
   *   'compound' (FD)  — net is credited into the principal; interest accrues on the running amount.
   *   'payout'   (floating bond) — net is paid out; interest accrues on the original principal. */
  function normInterestMode(fd) {
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
  /* Annualized return of an FD. Payout-mode net entries count as cash flows;
   * compound-mode ones do not (credited in, so only initial + final matter). */
  function fdXirr(fd) {
    if (!fd || !fd.amount || !fd.issueDate) return null;
    var flows = [{ date: fd.issueDate, amt: -fd.amount }];
    var mode = normInterestMode(fd);
    (fd.entries || []).forEach(function (e) {
      var net = entryNet(e);
      if (mode === 'payout' && e.date && net > 0) flows.push({ date: e.date, amt: net });
    });
    var final = fd.maturityValue > 0 ? fd.maturityValue : fdExpectedTotal(fd);
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
    validFd: validFd, fdDateCheck: fdDateCheck, fdFileMaturity: fdFileMaturity,
    validPan: validPan, normPan: normPan, holderLabel: holderLabel,
    parseDDMMYYYY: parseDDMMYYYY, isoToDDMMYYYY: isoToDDMMYYYY
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
