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
    var entries = (fd.entries || []).slice();
    entries.forEach(function (e, idx) {
      var prevDate = idx === 0 ? (fd.issueDate || '') : (entries[idx - 1].date || '');
      var days = daysBetweenISO(prevDate, e.date);
      var int = e.int || 0, tax = e.tax || 0, net = int - tax;
      var base = mode === 'compound' ? (fd.amount || 0) + sumNet(entries, idx) : (fd.amount || 0);
      var after = base + net; // compound: credited in; payout: principal + paid-out
      var expected = days != null && base > 0 ? Math.round(base * rate * (days / 365)) : null;
      out.push({
        idx: idx, date: e.date || '', days: days, base: base, expected: expected,
        int: int, tax: tax, net: net, after: after
      });
    });
    return out;
  }
  function sumNet(entries, upToIdx) {
    var s = 0;
    for (var i = 0; i < upToIdx; i++) s += (entries[i].int || 0) - (entries[i].tax || 0);
    return s;
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
  function fdStatus(fd, today) {
    today = today || todayISO();
    if (!fd || !fd.maturityDate) return 'unknown';
    if (today < fd.maturityDate) return 'active';
    return 'matured';
  }
  function fdStatusRank(fd, today) {
    var r = { active: 0, matured: 1, unknown: 2 }[fdStatus(fd, today)];
    return r == null ? 2 : r;
  }
  function sortFds(list, today) {
    return (list || []).slice().sort(function (a, b) {
      var ra = fdStatusRank(a, today), rb = fdStatusRank(b, today);
      if (ra !== rb) return ra - rb;
      var da = a.maturityDate || '9999', db = b.maturityDate || '9999';
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
    fdStatus: fdStatus, fdStatusRank: fdStatusRank, sortFds: sortFds, fdSummary: fdSummary,
    validFd: validFd, validPan: validPan, normPan: normPan, holderLabel: holderLabel
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
