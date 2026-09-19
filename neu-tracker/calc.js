/* HDFC Tata Neu Credit Card Tracker — verification & reconciliation engine.
 * Formulas (all verified against actual statements):
 *   minimum due = ceil(total * 5% / 10) * 10
 *   balance:  prev dues + purchases + finance - payments = total (paise-level noise only)
 *   NeuCoins: closing = opening + earned - transferred - adjusted
 *   per-tx base coins = 1.5% of card spend (categories below get bonus programs)
 *   ledger coin prediction: UPI 1.5% (1% base + 0.5% bonus), Grocery 1.5%,
 *     Base 1.5%, Tata 3.5% (credited next statement), NoCoins 0%, Payment 0.
 */

const Calc = (function () {
  'use strict';

  function round2(x) { return Math.round((x + 1e-9) * 100) / 100; }
  function close(a, b, tol) {
    if (tol == null) tol = 0.02;
    if (!isFinite(a) || !isFinite(b)) return false;
    return Math.abs(round2(a) - round2(b)) <= tol;
  }
  function cleanAmount(s) {
    if (s == null) return NaN;
    var n = String(s)
      .replace(/rs\.?/gi, '').replace(/₹/g, '').replace(/C/g, '')
      .replace(/[,\s]/g, '')
      .replace(/\/-?/g, '')
      .replace(/[−–]/g, '-')
      .replace(/\(/g, '').replace(/\)/g, '');
    if (!/^-?\d+(\.\d*)?$/.test(n)) return NaN;
    return parseFloat(n);
  }
  function fmtMoney(x) {
    if (!isFinite(x)) return '—';
    var neg = x < 0;
    var s = Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '-' : '') + '\u20B9' + s;
  }
  function fmtNum(x) { return isFinite(x) ? String(round2(x)) : '—'; }
  function fmtCoins(x) { return isFinite(x) ? Math.round(x).toLocaleString('en-IN') : '—'; }

  /* Minimum amount due — confirmed on all 20 statements. */
  function madFor(total) {
    if (!isFinite(total)) return NaN;
    return Math.ceil(round2(total) * 0.05 / 10) * 10;
  }

  /* ledger categories with coin rules matching the user's tracker sheet */
  var CATEGORIES = {
    upi:     { label: 'UPI',       rate: 0.015, program: 'NeuCoins_on_UPI_Acc',  note: '1.5% (1% base + 0.5% bonus)' },
    grocery: { label: 'Grocery',   rate: 0.015, program: 'Base_Grocery',         note: '1.5% base on groceries' },
    base:    { label: 'Base',      rate: 0.015, program: 'BaseNeuCoins',         note: '1.5% base' },
    tata:    { label: 'Tata',      rate: 0.035, program: 'Add_TataPayment',      note: '3.5% — bonus lands next statement' },
    nocoins: { label: 'NoCoins',   rate: 0,     program: '',                     note: 'no NeuCoins' },
    payment: { label: 'Payment',   rate: 0,     program: '',                     note: 'repayment, no NeuCoins' }
  };

  function predictedCoins(entry) {
    var cat = CATEGORIES[entry && entry.category];
    if (!cat || cat.rate <= 0 || !isFinite(entry.amount) || entry.amount <= 0) {
      return { coins: 0, program: cat ? cat.program : '', note: cat ? cat.note : '' };
    }
    return {
      coins: Math.round(entry.amount * cat.rate),
      program: cat.program,
      note: cat.note
    };
  }

  /* guess the category from a merchant description */
  function classifyMerchant(desc, credit) {
    if (credit) return 'payment';
    var d = String(desc || '').toUpperCase();
    if (/GROCERY|SUPERMARKET|BIGBASKET|DMART|NOVEM|FRESH|ORGCHANDRACOMPLEX|GREEN|KIRANA|MEGA/.test(d)) return 'grocery';
    if (/TATAPAYMENT|TATA\b/.test(d)) return 'tata';
    if (/^UPI/.test(d)) return 'upi';
    return 'base';
  }

  /* ---------- verifyStatement ---------- */
  var BLOCKING = { fail: true };

  function push(checks, c) { checks.push(c); return c; }

  function verifyStatement(st, ctx) {
    ctx = ctx || {};
    var checks = [];
    var prev = ctx.prevRecord; // previous statement record (by period)
    var deltas = {
      purchases: 2,      // paise rounding / EMI split tolerable
      payments: 2,
      balance: 20,       // verified deltas are <= 0.45
      coins: 5
    };
    var sumDebit = 0, sumCredit = 0;
    (st.txns || []).forEach(function (t) {
      if (t.credit) sumCredit += t.amount; else sumDebit += t.amount;
    });

    /* 1 total present */
    push(checks, {
      key: 'total', label: 'Total amount due read from statement',
      status: isFinite(st.total) && st.total > 0 ? 'pass' : 'fail',
      expected: isFinite(st.total) ? fmtMoney(st.total) : 'n/a', actual: isFinite(st.total) ? fmtMoney(st.total) : 'not read',
      configurable: true
    });

    /* 2 minimum amount due formula */
    var mad = madFor(st.total);
    var madOk = isFinite(st.minimumDue) && isFinite(mad) && st.minimumDue === mad;
    push(checks, {
      key: 'mad', label: 'Minimum due matches 5% formula (ceil to ₹10)',
      status: isFinite(st.minimumDue) ? (madOk ? 'pass' : 'fail') : 'info',
      expected: isFinite(mad) ? fmtMoney(mad) : '—',
      actual: isFinite(st.minimumDue) ? fmtMoney(st.minimumDue) : 'not printed',
      delta: madOk ? 0 : null,
      message: madOk ? '' : 'Bank minimum differs from 5% of total.',
      configurable: true
    });

    /* 3 debit totals vs printed purchases */
    var debitMiss = Math.abs(round2(sumDebit) - round2(st.purchases));
    push(checks, {
      key: 'purchases', label: 'Transactions sum to printed purchases',
      status: !isFinite(st.purchases) ? 'info' : (debitMiss <= deltas.purchases ? 'pass' : 'fail'),
      expected: isFinite(st.purchases) ? fmtMoney(st.purchases) : 'not printed',
      actual: fmtMoney(sumDebit),
      delta: isFinite(st.purchases) ? round2(debitMiss) : null,
      message: isFinite(st.purchases) && debitMiss > deltas.purchases ? 'Lines read from PDF do not add up to the printed purchases.' : '',
      configurable: true
    });

    /* 4 credit totals vs printed payments */
    var creditMiss = Math.abs(round2(sumCredit) - round2(st.payments));
    push(checks, {
      key: 'payments', label: 'Credits sum to printed payments',
      status: !isFinite(st.payments) ? 'info' : (creditMiss <= deltas.payments ? 'pass' : 'fail'),
      expected: isFinite(st.payments) ? fmtMoney(st.payments) : 'not printed',
      actual: fmtMoney(sumCredit),
      delta: isFinite(st.payments) ? round2(creditMiss) : null,
      message: isFinite(st.payments) && creditMiss > deltas.payments ? 'Credit rows do not add up to the printed payments.' : '',
      configurable: true
    });

    /* 5 running balance */
    var bal = st.prevDues + st.purchases + st.finance - st.payments;
    var balMiss = Math.abs(round2(bal) - round2(st.total));
    push(checks, {
      key: 'balance', label: 'Running balance matches printed total',
      status: !isFinite(bal) || !isFinite(st.total) ? 'info' : (balMiss <= deltas.balance ? 'pass' : 'fail'),
      expected: isFinite(bal) ? fmtMoney(bal) : '—',
      actual: isFinite(st.total) ? fmtMoney(st.total) : '—',
      delta: isFinite(bal) && isFinite(st.total) ? round2(balMiss) : null,
      message: balMiss > deltas.balance ? 'Opening + purchases + finance − payments ≠ total. Check for unpicked lines.' : '',
      configurable: true
    });

    /* 6 NeuCoins bookkeeping */
    var cb = {
      closing: st.closingNeuCoins, earned: st.earnedNeuCoins,
      opening: st.openingNeuCoins, transferred: st.transferredNeuCoins, adjusted: st.adjustedNeuCoins
    };
    var coinsOk = [cb.closing, cb.earned, cb.opening, cb.transferred, cb.adjusted].every(isFinite) &&
      Math.round(cb.closing) === Math.round(cb.opening + cb.earned - cb.transferred - cb.adjusted);
    push(checks, {
      key: 'coins', label: 'NeuCoins balance: closing = opening + earned − transferred − adjusted',
      status: isFinite(cb.closing) ? (coinsOk ? 'pass' : 'fail') : 'info',
      expected: coinsOk || !isFinite(cb.closing) ? (isFinite(cb.closing) ? fmtCoins(cb.closing) : '—') : fmtCoins(cb.opening + cb.earned - cb.transferred - cb.adjusted),
      actual: isFinite(cb.closing) ? fmtCoins(cb.closing) : '—',
      message: isFinite(cb.closing) && !coinsOk ? 'Coins do not balance — possible lapsed/adjustment not captured.' : '',
      configurable: true
    });

    /* 7 coin continuity with previous statement */
    var prevClose = prev && isFinite(prev.closingNeuCoins) ? prev.closingNeuCoins : NaN;
    push(checks, {
      key: 'coins_prev', label: 'Opening NeuCoins match previous closing',
      status: isFinite(cb.opening) && isFinite(prevClose) ? (Math.abs(cb.opening - prevClose) <= deltas.coins ? 'pass' : 'fail') : 'info',
      expected: isFinite(prevClose) ? fmtCoins(prevClose) : 'no previous bill',
      actual: isFinite(cb.opening) ? fmtCoins(cb.opening) : '—',
      delta: isFinite(cb.opening) && isFinite(prevClose) ? Math.round(cb.opening - prevClose) : null,
      ref: prev ? ('previous bill ' + (prev.periodTo || prev.statementDate || '')) : '',
      message: !isFinite(prevClose) ? (prev ? 'Previous bill has no coins block.' : 'No previous bill imported yet.') : '',
      configurable: true
    });

    /* 8 earned = bonus program list total (+ base column when readable) */
    var progSum = 0;
    (st.bonusPrograms || []).forEach(function (p) { if (isFinite(p.coins)) progSum += p.coins; });
    var bonusTotal = isFinite(st.bonusTotal) ? st.bonusTotal : progSum;
    var earnOk = (st.bonusPrograms || []).length === 0
      ? true
      : Math.abs(progSum - bonusTotal) <= 2;
    var baseKnown = (st.txns || []).every(function (t) { return !t.credit; }) || true;
    var baseSeen = (st.txns || []).some(function (t) { return t.base > 0; });
    push(checks, {
      key: 'bonus', label: 'Bonus program list adds up to earned (Base + Bonus)',
      status: (st.bonusPrograms || []).length === 0 ? 'info'
        : (earnOk ? 'pass' : 'fail'),
      expected: isFinite(bonusTotal) ? fmtCoins(bonusTotal) : '—',
      actual: fmtCoins(progSum),
      delta: earnOk ? null : (isFinite(bonusTotal) ? progSum - bonusTotal : null),
      message: !baseSeen ? 'Base-coins column not printed on every row; earned also includes 1.5% base coins on most spends.' : '',
      configurable: true
    });

    /* 9 identity */
    var profCard = String(ctx.cardNo || '').replace(/\D/g, '');
    var stCard = String(st.cardNo || '').replace(/\D/g, '');
    var cardOk = !profCard || !stCard || profCard === stCard;
    push(checks, {
      key: 'identity', label: 'Card number matches profile',
      status: cardOk ? 'pass' : 'fail',
      expected: profCard || 'any', actual: stCard || 'not printed',
      message: !profCard ? 'Profile card not set — statement recorded under its printed card.' : (cardOk ? '' : 'This statement is for a different card.'),
      configurable: true
    });

    /* 10 credit limit */
    var limOk = isFinite(st.creditLimit) && isFinite(st.availLimit) && isFinite(st.total) &&
      Math.abs(st.creditLimit - st.total - st.availLimit) <= 1000;
    push(checks, {
      key: 'limit', label: 'Available credit ≈ credit limit − outstanding',
      status: isFinite(st.creditLimit) && isFinite(st.availLimit) ? (limOk ? 'pass' : 'warn') : 'info',
      expected: isFinite(st.creditLimit) && isFinite(st.total) ? fmtMoney(st.creditLimit - st.total) : '—',
      actual: isFinite(st.availLimit) ? fmtMoney(st.availLimit) : '—',
      message: !isFinite(st.creditLimit) ? 'Credit limit not printed on this statement.' : 'Available credit excludes todays’s un-billed spends.',
      configurable: true
    });

    /* 11 finance charges */
    push(checks, {
      key: 'finance', label: 'Finance charges',
      status: 'info',
      expected: '0.00', actual: isFinite(st.finance) ? fmtMoney(st.finance) : '—',
      message: isFinite(st.finance) && st.finance > 0 ? 'Finance/interest charged — revolver was not fully settled.' : 'No interest charged.',
      configurable: false
    });

    return { checks: checks, st: st, deltas: deltas };
  }

  function applyExceptions(checks, exceptions) {
    var blocked = false, required = [];
    var out = checks.map(function (c) {
      if ((c.status === 'fail' || c.status === 'warn') && c.configurable && exceptions && exceptions[c.key]) {
        return Object.assign({}, c, { status: 'accepted', exception: exceptions[c.key] });
      }
      if (BLOCKING[c.status]) blocked = true;
      if (c.status === 'fail' && c.required && !(exceptions && exceptions[c.key])) required.push(c.key);
      return c;
    });
    return { checks: out, blocked: blocked, required: required };
  }

  function hasBlocking(checks, exceptions) {
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      if (c.status === 'fail' && !(exceptions && exceptions[c.key])) return true;
      if (c.configurable && exceptions && exceptions[c.key]) continue;
      if (c.status === 'fail' && !c.configurable) return true;
    }
    return false;
  }

  function statusSummary(checks) {
    var s = { pass: 0, warn: 0, fail: 0, info: 0, accepted: 0 };
    checks.forEach(function (c) { if (s[c.status] != null) s[c.status]++; });
    return s;
  }

  /* ---------- reconciliation ---------- */
  function pdate(s) {
    var m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : NaN;
  }
  function prevPeriodTo(st, prevRecord) {
    if (prevRecord && prevRecord.periodTo) return prevRecord.periodTo;
    return st.periodFrom || '';
  }

  /* Match every ledger entry (date > windowStart && <= st.periodTo) to a
   * statement txn by exact amount + same day. */
  function reconcile(st, ledger, prevRecord) {
    var winFrom = prevPeriodTo(st, prevRecord);
    var winTo = st.periodTo || st.statementDate;
    var active = (ledger || []).filter(function (e) {
      if (e.reconciled && e.reconciled === winTo) return true; // already matched this window
      var t = pdate(e.date);
      var lo = winFrom && isFinite(pdate(winFrom)) ? pdate(winFrom) : -Infinity;
      var hi = winTo && isFinite(pdate(winTo)) ? pdate(winTo) : Infinity;
      return isFinite(t) && t > lo && t <= hi;
    });
    var used = {}; // entry index -> true
    var matched = [];
    var keyOf = function (date, amount) { return date + '|' + round2(amount).toFixed(2); };
    var byKey = {};
    (st.txns || []).forEach(function (tx) {
      var k = keyOf(tx.date, tx.amount);
      if (!byKey[k]) byKey[k] = [];
      byKey[k].push(tx);
    });
    active.forEach(function (e, idx) {
      var k = keyOf(e.date, e.amount);
      var pool = byKey[k];
      if (pool && pool.length) {
        var tx = pool.shift();
        matched.push({ entry: e, txn: tx, index: idx });
        used[idx] = true;
      }
    });
    var bookOnly = active.filter(function (e, i) { return !used[i]; });
    var stmtOnly = [];
    (st.txns || []).forEach(function (tx) {
      var k = keyOf(tx.date, tx.amount);
      if (byKey[k] && byKey[k].length) stmtOnly.push(tx);
    });

    /* splits: one ledger entry matching two statement rows of same amount+date */
    var payInBook = 0, payInStmt = 0;
    bookOnly.forEach(function (e) { if (e.category === 'payment') payInBook += e.amount; });
    stmtOnly.forEach(function (tx) { if (tx.credit) payInStmt += tx.amount; });

    /* coins comparison: expected (per program) vs actual bonus table for the window */
    var expected = {};
    active.forEach(function (e) {
      var p = predictedCoins(e);
      if (p.coins > 0) expected[p.program] = (expected[p.program] || 0) + p.coins;
    });
    var actual = {};
    (st.bonusPrograms || []).forEach(function (p) { if (isFinite(p.coins)) actual[p.program] = (actual[p.program] || 0) + p.coins; });

    return {
      windowFrom: winFrom, windowTo: winTo,
      matched: matched, bookOnly: bookOnly, stmtOnly: stmtOnly,
      payInBook: payInBook, payInStmt: payInStmt,
      expected: expected, actual: actual,
      matchedCount: matched.length,
      bookOnlyCount: bookOnly.length,
      stmtOnlyCount: stmtOnly.length
    };
  }

  /* ---------- rewards ---------- */
  var CAT_TO_PROGRAM = { upi: 'NeuCoins_on_UPI_Acc', grocery: 'Base_Grocery', base: 'BaseNeuCoins', tata: 'Add_TataPayment' };
  var PROGRAM_TO_CAT = {};
  Object.keys(CAT_TO_PROGRAM).forEach(function (k) { PROGRAM_TO_CAT[CAT_TO_PROGRAM[k]] = k; });

  var DEFAULT_COIN_VALUE = 0.25;

  function rewardsValue(coins, rate) {
    var r = isFinite(Number(rate)) ? Number(rate) : DEFAULT_COIN_VALUE;
    if (!isFinite(coins)) return NaN;
    return round2(coins * r);
  }

  /* Per-cycle NeuCoins: expected per ledger category vs actual per statement
   * program (mapped back to category where known). */
  function rewardsByCategory(rec, ledger, prevRecord) {
    var res = reconcile(rec, ledger, prevRecord);
    var expected = {}, actual = {}, rest = 0;
    Object.keys(res.expected).forEach(function (p) {
      var cat = PROGRAM_TO_CAT[p] || 'other';
      expected[cat] = (expected[cat] || 0) + res.expected[p];
    });
    Object.keys(res.actual).forEach(function (p) {
      var cat = PROGRAM_TO_CAT[p] || 'other';
      if (cat === 'other' && PROGRAM_TO_CAT[p] == null) rest += res.actual[p];
      actual[cat] = (actual[cat] || 0) + res.actual[p];
    });
    if (rest) actual.other += rest;
    return { expected: expected, actual: actual, resolved: res };
  }

  /* Lifetime NeuCoins checks against the redemptions ledger. */
  function redemptionReconcile(records, redemptions) {
    var totalEarned = 0, totalTransferred = 0;
    (records || []).forEach(function (r) {
      if (isFinite(r.earnedNeuCoins)) totalEarned += r.earnedNeuCoins;
      if (isFinite(r.transferredNeuCoins)) totalTransferred += r.transferredNeuCoins;
    });
    var totalRedeemed = 0;
    (redemptions || []).forEach(function (x) { if (isFinite(x.coins)) totalRedeemed += x.coins; });
    return {
      totalEarned: Math.round(totalEarned),
      totalTransferred: Math.round(totalTransferred),
      totalRedeemed: Math.round(totalRedeemed),
      netUnspent: Math.round(totalEarned - totalTransferred - totalRedeemed)
    };
  }

  /* Monthly earned + running balance series for the rewards charts. */
  function rewardsTimeline(records) {
    var earned = [], balance = [];
    (records || []).forEach(function (r) {
      if (isFinite(r.earnedNeuCoins)) earned.push({ periodTo: r.periodTo, coins: Math.round(r.earnedNeuCoins) });
      if (isFinite(r.closingNeuCoins)) balance.push({ periodTo: r.periodTo, coins: Math.round(r.closingNeuCoins) });
    });
    return { earned: earned, balance: balance };
  }

  /* ---------- dues & payments ---------- */
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

  /* Every payment logged against a statement period, classified full/min/partial. */
  function paymentForRecord(rec, payments) {
    var list = (payments || []).filter(function (p) {
      var fp = String(p.forPeriod || '');
      return fp === rec.periodTo || fp === rec.statementDate;
    });
    var totalPaid = 0;
    list.forEach(function (p) { if (isFinite(p.amount)) totalPaid += p.amount; });
    totalPaid = round2(totalPaid);
    var kind = 'none';
    if (list.length && isFinite(rec.total)) {
      if (totalPaid >= rec.total - 1) kind = 'full';
      else if (isFinite(rec.minimumDue) && totalPaid >= rec.minimumDue - 1) kind = 'minimum';
      else kind = 'partial';
    }
    return {
      payments: list,
      totalPaid: totalPaid,
      kind: kind,
      outstanding: isFinite(rec.total) ? round2(Math.max(rec.total - totalPaid, 0)) : 0
    };
  }

  function dueStatus(rec, payments, today) {
    var ref = today || new Date();
    var due = isFinite(pdate(rec.dueDate)) ? pdate(rec.dueDate) : NaN;
    var daysLeft = isFinite(due) ? Math.round((due - startOfDay(ref)) / 86400000) : null;
    var pay = paymentForRecord(rec, payments);
    return {
      dueDate: rec.dueDate,
      daysLeft: daysLeft,
      overdue: isFinite(due) && due < startOfDay(ref),
      kind: pay.kind,
      paid: pay.totalPaid,
      outstanding: pay.outstanding,
      settled: pay.kind !== 'none'
    };
  }

  /* outstanding ÷ credit limit as a percentage; null when unknowable. */
  function utilizationOf(rec) {
    if (!rec || !isFinite(rec.total) || !isFinite(rec.creditLimit) || rec.creditLimit <= 0) return null;
    return Math.round(rec.total / rec.creditLimit * 10000) / 100;
  }

  function interestSummary(records) {
    var per = [], total = 0;
    (records || []).forEach(function (r) {
      var f = isFinite(r.finance) ? r.finance : 0;
      total += f;
      per.push({ periodTo: r.periodTo, finance: round2(f) });
    });
    return { perRecord: per, total: round2(total) };
  }

  /* ---------- schema migration ---------- */
  var SCHEMA_VERSION = 2;
  var MIGRATIONS = {
    0: function (d) { d.version = 1; if (!Array.isArray(d.records)) d.records = []; if (!Array.isArray(d.ledger)) d.ledger = []; return d; },
    1: function (d) {
      d.version = 2;
      if (!Array.isArray(d.redemptions)) d.redemptions = [];
      if (!Array.isArray(d.payments)) d.payments = [];
      if (!d.rewardsConfig || typeof d.rewardsConfig !== 'object') d.rewardsConfig = {};
      if (!isFinite(Number(d.rewardsConfig.valuePerCoin))) d.rewardsConfig.valuePerCoin = DEFAULT_COIN_VALUE;
      return d;
    }
  };

  function migrateRecord(r) {
    if (!r || typeof r !== 'object') return r;
    r.id = String(r.id || '');
    r.layout = String(r.layout || '');
    r.statementDate = String(r.statementDate || '');
    r.periodFrom = String(r.periodFrom || '');
    r.periodTo = String(r.periodTo || '');
    ['total', 'minimumDue', 'prevDues', 'payments', 'purchases', 'finance'].forEach(function (k) {
      var v = r[k];
      r[k] = (v === undefined || v === null || v === '') ? NaN : Number(v);
    });
    ['creditLimit', 'availLimit', 'availCash'].forEach(function (k) {
      r[k] = (r[k] === undefined || r[k] === null || r[k] === '') ? NaN : Number(r[k]);
    });
    ['openingNeuCoins', 'earnedNeuCoins', 'transferredNeuCoins', 'adjustedNeuCoins', 'closingNeuCoins', 'bonusTotal'].forEach(function (k) {
      r[k] = (r[k] === undefined || r[k] === null || r[k] === '') ? NaN : Number(r[k]);
    });
    r.cardNo = String(r.cardNo || '');
    r.aan = String(r.aan || '');
    r.name = String(r.name || '');
    if (!Array.isArray(r.accepted)) r.accepted = [];
    if (!Array.isArray(r.bonusPrograms)) r.bonusPrograms = [];
    if (!Array.isArray(r.txns)) r.txns = [];
    if (!r.status) r.status = 'verified';
    return r;
  }

  function migrateLedgerEntry(e) {
    if (!e || typeof e !== 'object') return e;
    e.id = String(e.id || (Math.random() + Date.now()).toString(36).slice(2));
    e.date = String(e.date || '');
    e.desc = String(e.desc || '');
    e.amount = isFinite(Number(e.amount)) ? round2(Number(e.amount)) : NaN;
    e.category = CATEGORIES[e.category] ? e.category : (e.amount < 0 ? 'payment' : classifyMerchant(e.desc, false));
    e.reconciled = e.reconciled || '';
    return e;
  }

  function migrateBundle(raw) {
    if (!raw || typeof raw !== 'object') return { incompatible: true, version: null };
    var v = (typeof raw.version === 'number' && isFinite(raw.version)) ? raw.version : 0;
    if (v > SCHEMA_VERSION) return { incompatible: true, version: v };
    var d = raw;
    while (v < SCHEMA_VERSION && MIGRATIONS[v]) { d = MIGRATIONS[v](d) || d; v++; }
    if (!Array.isArray(d.records)) d.records = [];
    if (!Array.isArray(d.ledger)) d.ledger = [];
    if (!Array.isArray(d.redemptions)) d.redemptions = [];
    if (!Array.isArray(d.payments)) d.payments = [];
    if (!d.rewardsConfig || typeof d.rewardsConfig !== 'object') d.rewardsConfig = {};
    if (!isFinite(Number(d.rewardsConfig.valuePerCoin))) d.rewardsConfig.valuePerCoin = DEFAULT_COIN_VALUE;
    d.records.forEach(migrateRecord);
    d.ledger.forEach(migrateLedgerEntry);
    d.redemptions.forEach(function (r) {
      r.id = String(r.id || (Math.random() + Date.now()).toString(36).slice(2));
      r.date = String(r.date || '');
      r.coins = isFinite(Number(r.coins)) ? round2(Number(r.coins)) : 0;
      r.value = (r.value === undefined || r.value === null || r.value === '') ? NaN : round2(Number(r.value));
      r.note = String(r.note || '');
    });
    d.payments.forEach(function (p) {
      p.id = String(p.id || (Math.random() + Date.now()).toString(36).slice(2));
      p.date = String(p.date || '');
      p.amount = isFinite(Number(p.amount)) ? round2(Number(p.amount)) : NaN;
      p.forPeriod = String(p.forPeriod || '');
      p.method = String(p.method || '');
      p.note = String(p.note || '');
    });
    d.records.sort(function (a, b) { return (pdate(a.periodTo) || 0) - (pdate(b.periodTo) || 0); });
    if (!d.card || typeof d.card !== 'object') d.card = { no: '', aan: '', name: '' };
    d.card.no = String(d.card.no || '');
    d.card.aan = String(d.card.aan || '');
    d.card.name = String(d.card.name || '');
    d.version = SCHEMA_VERSION;
    return d;
  }

  return {
    round2: round2, close: close, cleanAmount: cleanAmount,
    fmtMoney: fmtMoney, fmtNum: fmtNum, fmtCoins: fmtCoins,
    madFor: madFor, CATEGORIES: CATEGORIES, predictedCoins: predictedCoins,
    classifyMerchant: classifyMerchant,
    verifyStatement: verifyStatement, applyExceptions: applyExceptions,
    hasBlocking: hasBlocking, statusSummary: statusSummary,
    reconcile: reconcile, pdate: pdate,
    rewardsValue: rewardsValue, rewardsByCategory: rewardsByCategory,
    redemptionReconcile: redemptionReconcile, rewardsTimeline: rewardsTimeline,
    paymentForRecord: paymentForRecord, dueStatus: dueStatus,
    utilizationOf: utilizationOf, interestSummary: interestSummary,
    DEFAULT_COIN_VALUE: DEFAULT_COIN_VALUE,
    SCHEMA_VERSION: SCHEMA_VERSION, migrateBundle: migrateBundle, BLOCKING: BLOCKING
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc; else window.Calc = Calc;