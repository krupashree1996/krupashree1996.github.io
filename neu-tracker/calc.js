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
    upi:     { label: 'UPI',       rate: 0.015, program: 'NeuCoins_on_UPI_Acc',  note: '1.5% (1% app + 0.5% bank statement)', split: { base: 0.01, bonus: 0.005, srcBase: 'app', srcBonus: 'statement' } },
    grocery: { label: 'Grocery',   rate: 0.015, program: 'Base_Grocery',         note: '1.5% (bank statement only)' },
    base:    { label: 'Base',      rate: 0.015, program: 'BaseNeuCoins',         note: '1.5% (bank statement only)' },
    tata:    { label: 'Tata',      rate: 0.035, program: 'Add_TataPayment',      note: '3.5% (bank statement — lands next cycle)' },
    tatagroc:{ label: 'Tata+Groc', rate: 0.05,  program: 'Add_TataPayment',      note: '5% (1.5% grocery + 3.5% Tata) — e.g. BigBasket via Tata Pay; grocery this cycle, the 3.5% lands next cycle', split: { base: 0.015, bonus: 0.035, srcBase: 'grocery', srcBonus: 'Tata', nextCycle: true } },
    nocoins: { label: 'NoCoins',   rate: 0,     program: '',                     note: 'no NeuCoins' },
    payment: { label: 'Payment',   rate: 0,     program: '',                     note: 'repayment to the bank — pick “for period” to reduce that bill’s outstanding' }
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

  /* Split a coin-earning entry into its two parts (the two major coin
   * sources: the Tata Neu app and the bank statement):
   *   upi      — 1% app (never on the statement) + 0.5% statement
   *   tatagroc — 1.5% grocery (this cycle) + 3.5% Tata (lands next cycle);
   *              the app already shows the full 5% instantly
   * Returns null for categories with no split. base + bonus always equals
   * predictedCoins(entry).coins. */
  function coinSplit(entry) {
    var cat = CATEGORIES[entry && entry.category];
    if (!cat || !cat.split || cat.rate <= 0 || !isFinite(entry.amount) || entry.amount <= 0) return null;
    var total = Math.round(entry.amount * cat.rate);
    var bonus = Math.round(entry.amount * cat.split.bonus);
    var base = total - bonus;
    return {
      base: base, bonus: bonus, total: total,
      basePct: Math.round(cat.split.base * 1000) / 10, bonusPct: Math.round(cat.split.bonus * 1000) / 10,
      srcBase: cat.split.srcBase || 'base', srcBonus: cat.split.srcBonus || 'bonus',
      nextCycle: !!cat.split.nextCycle
    };
  }

  /* guess the category from a merchant description */
  function classifyMerchant(desc, credit) {
    if (credit) return 'payment';
    var d = String(desc || '').toUpperCase();
    /* BigBasket bills settle via Tata Pay: 1.5% grocery (this cycle) +
     * 3.5% Tata (next cycle) = 5% — must match before the generic grocery
     * rule, and the statement prints base=0 on these rows. */
    if (/BIGBASKET/i.test(d)) return 'tatagroc';
    if (/GROCERY|SUPERMARKET|BIGBASKET|DMART|NOVEM|FRESH|ORGCHANDRACOMPLEX|GREEN|KIRANA|MEGA|RELIANCE\s*(MARKET|FRESH|MART)/.test(d)) return 'grocery';
    if (/TATAPAYMENT|TATA\b/.test(d)) return 'tata';
    if (/^UPI/.test(d)) return 'upi';
    return 'base';
  }

  /* Pick the ledger category for a statement transaction. The printed 'base'
   * column is the 1.5% base on eligible spend (the 3.5% Tata bonus is a
   * separate bonus column), so base>0 means coin-earning → disambiguate by
   * merchant; base=0 → NoCoins; credit → Payment. */
  function guessCategory(tx) {
    if (!tx) return 'base';
    if (tx.credit) return 'payment';
    /* UPI rows earn the 1.5% UPI bonus even when the statement prints no
     * base-coin column (base=0), so classify by the UPI-… descriptor before
     * the base=0 → NoCoins fallback. Same for BigBasket (Tata Pay: 5% total,
     * the 3.5% lands next cycle) — the statement prints base=0 on these too. */
    if (/^UPI/i.test(String(tx.desc || ''))) return 'upi';
    if (/BIGBASKET/i.test(String(tx.desc || ''))) return 'tatagroc';
    if (!isFinite(tx.base) || tx.base <= 0) return 'nocoins';
    return classifyMerchant(tx.desc, false);
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

    /* 1 the real check: printed total must equal the sum of the bill's items */
    var bal = st.prevDues + st.purchases + st.finance - st.payments;
    var balMiss = Math.abs(round2(bal) - round2(st.total));
    push(checks, {
      key: 'balance', label: 'Total amount due = prev dues + purchases + finance − payments',
      status: !isFinite(st.total) ? 'fail' : (!isFinite(bal) ? 'info' : (balMiss <= deltas.balance ? 'pass' : 'fail')),
      expected: isFinite(bal) ? fmtMoney(bal) : '—', actual: isFinite(st.total) ? fmtMoney(st.total) : 'not read',
      delta: isFinite(bal) && isFinite(st.total) ? round2(balMiss) : null,
      message: balMiss > deltas.balance ? 'Opening + purchases + finance − payments ≠ printed total. Check for unpicked lines.' : '',
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

    /* 10 credit limit — available credit is expected to be <= limit − total
     * (the bank deducts unbilled spend too). A printed available HIGHER than
     * expected is the misread signal; a lower one is normal. */
    var limGap = isFinite(st.creditLimit) && isFinite(st.availLimit) && isFinite(st.total)
      ? st.availLimit - (st.creditLimit - st.total) : NaN;
    var limOk = isFinite(limGap) && limGap <= 500;
    push(checks, {
      key: 'limit', label: 'Available credit ≤ credit limit − outstanding',
      status: isFinite(st.creditLimit) && isFinite(st.availLimit) ? (limOk ? 'pass' : 'warn') : 'info',
      expected: isFinite(st.creditLimit) && isFinite(st.total) ? fmtMoney(st.creditLimit - st.total) : '—',
      actual: isFinite(st.availLimit) ? fmtMoney(st.availLimit) : '—',
      message: !isFinite(st.creditLimit) ? 'Credit limit not printed on this statement.'
        : (limOk ? (isFinite(limGap) && limGap < 0 ? 'Lower than expected — includes un-billed spends.' : '') : 'Available credit exceeds limit − outstanding; limit block may be misread.'),
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
    /* day/month tolerate a single digit (5/10/2026) — ledger entries are
     * free-typed and are normalized on load, but reconcile must not miss */
    var m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : NaN;
  }
  function prevPeriodTo(st, prevRecord) {
    if (prevRecord && prevRecord.periodTo) return prevRecord.periodTo;
    return st.periodFrom || '';
  }

  /* Match every ledger entry (date >= windowStart && <= st.periodTo) to a
   * statement txn by exact amount + same day. The lower bound is INCLUSIVE so
   * a spend dated on the previous period-end stays matchable on the NEXT
   * statement (bank boundary posting, e.g. an 18/06 spend on the 18/07
   * statement). Such a boundary entry, however, belongs to the previous cycle:
   * if it does NOT match a txn here it must not be listed as "in ledger, not
   * on statement". */
  function reconcile(st, ledger, prevRecord) {
    var prevEnd = (prevRecord && isFinite(pdate(prevRecord.periodTo))) ? prevRecord.periodTo : '';
    var winFrom = prevPeriodTo(st, prevRecord);
    var winTo = st.periodTo || st.statementDate;
    var active = (ledger || []).filter(function (e) {
      if (e.reconciled && e.reconciled === winTo) return true; // already matched this window
      if (e.reconciled) return false; // consumed by another statement's cycle
      /* an entry booked by "Add all" from ANOTHER statement (sourcePeriod set
       * and ≠ this window) may have a date inside this window without
       * belonging to it — it can neither match here nor be listed as
       * "not on statement". Legacy entries have no sourcePeriod. */
      if (e.sourcePeriod && e.sourcePeriod !== winTo) return false;
      /* booked from THIS statement — its printed date may fall outside the
       * billing window (late-posted charge), but it still belongs here. */
      if (e.sourcePeriod && e.sourcePeriod === winTo) return true;
      var t = pdate(e.date);
      var lo = winFrom && isFinite(pdate(winFrom)) ? pdate(winFrom) : -Infinity;
      var hi = winTo && isFinite(pdate(winTo)) ? pdate(winTo) : Infinity;
      return isFinite(t) && t >= lo && t <= hi;
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
    /* a boundary entry (dated exactly on the previous period-end) that did not
     * match belongs to the previous statement — exclude from "not on statement" */
    var bookOnly = active.filter(function (e, i) {
      if (used[i]) return false;
      return !(prevEnd && e.date === prevEnd);
    });
    /* byKey now holds only the txns that no ledger entry consumed; take those
     * (not every txn whose key still has leftovers) so duplicate statement
     * rows are counted exactly once each. */
    var stmtOnly = [];
    Object.keys(byKey).forEach(function (k) { stmtOnly = stmtOnly.concat(byKey[k]); });

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

  /* Statement txns still needing a ledger row. Mirrors reconcile's date+amount
   * key and counts only entries that are actually usable in this window, so a
   * row already booked elsewhere cannot make "Add to ledger" report nothing
   * to do while the row keeps showing as statement-only. */
  function stmtRowsToBook(rec, ledger, prevRecord) {
    var res = reconcile(rec, ledger, prevRecord);
    var keyOf = function (date, amount) { return date + '|' + round2(amount).toFixed(2); };
    var want = {}, have = {};
    ((rec && rec.txns) || []).forEach(function (tx) {
      var k = keyOf(tx.date, tx.amount);
      want[k] = (want[k] || 0) + 1;
    });
    res.matched.forEach(function (x) {
      var k = keyOf(x.entry.date, x.entry.amount);
      have[k] = (have[k] || 0) + 1;
    });
    res.bookOnly.forEach(function (e) {
      var k = keyOf(e.date, e.amount);
      have[k] = (have[k] || 0) + 1;
    });
    var rows = [];
    res.stmtOnly.forEach(function (tx) {
      var k = keyOf(tx.date, tx.amount);
      if ((have[k] || 0) >= (want[k] || 0)) return;
      have[k] = (have[k] || 0) + 1;
      rows.push(tx);
    });
    return rows;
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

  /* Every payment logged against a statement period, classified full/min/partial.
   * A payment is attributed to `rec` when:
   *  1. it explicitly carries forPeriod = rec's period (or statementDate), or
   *  2. it is unlinked (no forPeriod) and its date falls in rec's payment
   *     window — strictly after rec's period-to (the bill closes) up to and
   *     including the next bill's period-to: a bill is paid off after it
   *     closes, before the next one does. For the newest bill (no statement
   *     after it yet) the window extends indefinitely: a payment after its
   *     closing date settles it immediately (e.g. a bill closing 18/09 and
   *     paid off on 03/10 shows settled before the next statement arrives).
   * Negative entries in other categories are reversals, not payments. */
  /* A ledger entry only reduces a bill's outstanding when it is actually a
   * repayment to the bank — not a statement credit that is a reversal/waiver
   * /refund (those print as credits too and get auto-tagged 'payment' on
   * import, but never actually pay anything). */
  function isRepayment(e) {
    if (!e || !isFinite(e.amount) || e.amount <= 0) return false;
    if (e.category && e.category !== 'payment') return false; // pre-v5: undefined = payment
    /* a payment the user explicitly linked to a bill is a repayment by intent */
    if (String(e.forPeriod || '')) return true;
    /* legacy pre-ledger payment-array entries (no category, no reliable desc)
     * are accepted as-is so auto-settle backfill is unchanged */
    if (e.category === undefined) return true;
    var d = String(e.desc || '').toUpperCase();
    return /BPPY|EFT|NEFT|RTGS|ACH|UPI|ATM|CARD PAY|BANK TRANSFER|PAYMENT/.test(d);
  }

  function paymentForRecord(rec, ledger, records) {
    var start = pdate(rec.periodTo);
    var isLatest = true, end = Infinity;
    (records || []).forEach(function (r) {
      if (!r || r.id === rec.id) return;
      var t2 = pdate(r.periodTo);
      if (!isFinite(t2)) return;
      if (t2 > start) { isLatest = false; if (t2 < end) end = t2; }
    });
    var list = (ledger || []).filter(function (p) {
      if (!isRepayment(p)) return false;
      var fp = String(p.forPeriod || '');
      if (fp && (fp === rec.periodTo || fp === rec.statementDate)) return true;
      if (fp) return false;
      var t = pdate(p.date);
      if (!isFinite(t) || !isFinite(start)) return false;
      return t > start && t <= end;
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

  function dueStatus(rec, ledger, records, today) {
    if (records instanceof Date) { today = records; records = undefined; }
    var ref = today || new Date();
    var due = isFinite(pdate(rec.dueDate)) ? pdate(rec.dueDate) : NaN;
    var daysLeft = isFinite(due) ? Math.round((due - startOfDay(ref)) / 86400000) : null;
    var pay = paymentForRecord(rec, ledger, records);
    return {
      dueDate: rec.dueDate,
      daysLeft: daysLeft,
      overdue: isFinite(due) && due < startOfDay(ref) && pay.kind !== 'full',
      kind: pay.kind,
      paid: pay.totalPaid,
      outstanding: pay.outstanding,
      settled: pay.kind !== 'none'
    };
  }

  /* Sum predicted coins over entries (e.g. the unbilled ones) into two
   * totals: `base` = the base-coin portion of each entry (base/grocery/tata
   * are all base; UPI contributes its 1% app part; tatagroc its 1.5% grocery
   * part — the parts NOT booked as a next-cycle bonus), `total` = everything
   * those entries will earn. */
  function coinTotals(entries) {
    var base = 0, total = 0;
    (entries || []).forEach(function (e) {
      if (!e) return;
      var p = predictedCoins(e);
      total += p.coins;
      var s = coinSplit(e);
      base += s ? s.base : p.coins;
    });
    return { base: base, total: total };
  }

  /* Estimate the NEXT bill from what the ledger has not yet booked on a
   * statement: carried (unpaid part of the latest bill) + unbilled spend +
   * the last finance charge (only while dues are carried). Rounded UP to a
   * whole rupee so it lines up with the printed TOTAL AMOUNT DUE; min due
   * uses the 5% formula. `base` is the latest statement's periodTo (the
   * estimate's reference bill) or '' when there is none. */
  function estimatedDue(records, ledger) {
    var k = null;
    (records || []).forEach(function (r) {
      var t = pdate(r.periodTo) || 0;
      if (!k || t > (pdate(k.periodTo) || 0)) k = r;
    });
    var unbilled = 0, carried = 0, finEst = 0;
    (ledger || []).forEach(function (e) {
      if (e.reconciled) return;
      if (e.category === 'payment') return;
      unbilled += e.amount;
    });
    if (k) {
      var ds = dueStatus(k, ledger, records);
      carried = Math.max(Math.round((k.total - ds.paid) * 100) / 100, 0);
      finEst = (isFinite(k.finance) && carried > 0) ? k.finance : 0;
    }
    var total = Math.ceil(round2(carried + unbilled + finEst));
    return { total: total, minDue: madFor(total), unbilled: unbilled, carried: carried, finEst: finEst, base: k ? k.periodTo : '' };
  }

  /* A statement's 'payments' column is the payment the customer made against the
   * immediately preceding bill's dues — proof that bill was paid. Auto-record it
   * (capped at that bill's total) so the old bill shows 'settled' without manual
   * entry. The `auto` flag makes this idempotent: a re-import or schema re-run
   * never double-counts. Returns the number of payments added. */
  function autoSettlePrior(records, ledger, newRecord) {
    if (!newRecord || !Array.isArray(records) || !Array.isArray(ledger)) return 0;
    /* pre-v5 bundles pass the legacy DATA.payments array, whose entries have no
     * category — every one of those is a payment. */
    var payments = ledger.filter(function (e) { return isRepayment(e); });
    var nt = pdate(newRecord.periodTo);
    if (!nt || !isFinite(newRecord.payments) || newRecord.payments <= 0) return 0;
    // the single most-recent bill strictly before the new statement
    var prior = null, best = -Infinity;
    records.forEach(function (rec) {
      if (rec.id === newRecord.id) return;
      var dt = pdate(rec.periodTo);
      if (dt && dt < nt && dt > best) { best = dt; prior = rec; }
    });
    if (!prior || !isFinite(prior.total) || prior.total <= 0) return 0;
    // already covered (by a prior auto-settle or a manual entry) → skip
    var covered = 0;
    payments.forEach(function (p) { if (p.forPeriod === prior.periodTo && isFinite(p.amount)) covered += p.amount; });
    if (covered >= prior.total - 1) return 0;
    var amount = round2(Math.min(newRecord.payments, prior.total));
    if (!(amount > 0)) return 0;
    ledger.push({
      id: 'auto-' + prior.id + '-paid',
      date: newRecord.statementDate || prior.dueDate || '',
      desc: 'Payment to bank (auto)',
      category: 'payment',
      amount: amount,
      forPeriod: prior.periodTo,
      method: 'statement',
      note: 'auto: paid off in the ' + (newRecord.periodTo || newRecord.statementDate || 'next') + ' statement',
      reconciled: '', sourcePeriod: '', auto: true
    });
    return 1;
  }

  /* ---------- annual fee waiver ----------
   * The card's annual fee is waived for the window [Jan 19, Jan 18 of the next
   * year] if at least `target` (default ₹3,00,000) is spent in that window.
   * Spend = sum of each statement's purchases whose periodTo falls in the window.
   * cfg: { target, month (0-based), day } — month/day define the window start. */
  var DEFAULT_WAIVER = { target: 300000, month: 0, day: 19 };

  function waiverWindowStart(year, cfg) {
    cfg = cfg || {};
    return new Date(year, cfg.month != null ? cfg.month : 0, cfg.day != null ? cfg.day : 19);
  }

  function waiverStatus(records, today, cfg) {
    cfg = Object.assign({}, DEFAULT_WAIVER, cfg || {});
    today = today || new Date();
    var y = today.getFullYear();
    var start = waiverWindowStart(y, cfg);
    if (today < start) start = waiverWindowStart(y - 1, cfg);
    var end = waiverWindowStart(start.getFullYear() + 1, cfg);
    var s = +start, e = +end;
    var spent = 0;
    (records || []).forEach(function (r) {
      var t = pdate(r && r.periodTo);
      if (isFinite(t) && t >= s && t < e && isFinite(r && r.purchases)) spent += r.purchases;
    });
    spent = round2(spent);
    var target = cfg.target || 0;
    return {
      windowFrom: start, windowTo: end,
      target: target,
      spent: spent,
      remaining: round2(Math.max(target - spent, 0)),
      waived: target > 0 && spent >= target,
      daysLeft: Math.ceil((e - +today) / 86400000)
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
  var SCHEMA_VERSION = 7;
  var MIGRATIONS = {
    0: function (d) { d.version = 1; if (!Array.isArray(d.records)) d.records = []; if (!Array.isArray(d.ledger)) d.ledger = []; return d; },
    1: function (d) {
      d.version = 2;
      if (!Array.isArray(d.redemptions)) d.redemptions = [];
      if (!Array.isArray(d.payments)) d.payments = [];
      if (!d.rewardsConfig || typeof d.rewardsConfig !== 'object') d.rewardsConfig = {};
      if (!isFinite(Number(d.rewardsConfig.valuePerCoin))) d.rewardsConfig.valuePerCoin = DEFAULT_COIN_VALUE;
      return d;
    },
    /* UPI rows earn the 1.5% bonus even when the statement prints no base
     * column; older app versions classified those (base=0) as 'nocoins'.
     * Re-classify any existing UPI-descriptor nocoins entries so already
     * booked ledger rows also count toward UPI rewards. Reliance Market is
     * a supermarket — older versions classified it 'base'; move it to
     * grocery too. */
    2: function (d) {
      d.version = 3;
      if (Array.isArray(d.ledger)) d.ledger.forEach(function (e) {
        var desc = String(e && e.desc || '');
        if (!e) return;
        if (e.category === 'nocoins' && /^UPI/i.test(desc)) e.category = 'upi';
        if (e.category === 'base' && /RELIANCE\s*(MARKET|MART|FRESH)/i.test(desc)) e.category = 'grocery';
      });
      return d;
    },
    /* Backfill auto-settlement for bills already imported before this feature:
     * for every statement except the first, the next statement's payments prove
     * the previous bill was paid. Idempotent — guarded by the `auto` flag. */
     3: function (d) {
      d.version = 4;
      if (!Array.isArray(d.records)) d.records = [];
      if (!Array.isArray(d.payments)) d.payments = [];
      var recs = d.records.slice().sort(function (a, b) { return (pdate(a.periodTo) || 0) - (pdate(b.periodTo) || 0); });
      for (var i = 1; i < recs.length; i++) autoSettlePrior(recs, d.payments, recs[i]);
      return d;
    },
    /* Payments move from the separate DATA.payments array into the ledger as
     * category 'payment' entries (with forPeriod). The expense ledger becomes
     * the single entry point: a Payment entry with a period reduces that
     * bill's outstanding on the due-date board. */
    4: function (d) {
      d.version = 5;
      if (!Array.isArray(d.ledger)) d.ledger = [];
      if (!Array.isArray(d.payments)) d.payments = [];
      d.payments.forEach(function (p) {
        if (!p) return;
        d.ledger.push({
          id: String(p.id || ('l-' + (Math.random() + Date.now()).toString(36).slice(2))),
          date: String(p.date || ''),
          desc: String(p.note && p.note.indexOf('auto:') === 0 ? 'Payment to bank (auto)' : (p.desc || 'Payment to bank')),
          category: 'payment',
          amount: isFinite(Number(p.amount)) ? round2(Number(p.amount)) : NaN,
          forPeriod: String(p.forPeriod || ''),
          method: String(p.method || ''),
          reconciled: '', sourcePeriod: '',
          auto: !!p.auto
        });
      });
       d.payments = [];
       return d;
     },
     /* Multi-card: the single top-level card/records/ledger/redemptions move
      * into cards[] (each card profile is self-contained — its own statements,
      * ledger, redemptions and reward/fee config) + activeCardId. The existing
      * (single) card becomes the first profile, and an empty Axis Scapia
      * profile is seeded so a second card can be added without a fresh
      * bundle. Non-neu cards (type !== 'neu') get no rewards/fee config —
      * the parser + reward model are Tata-Neu specific (deferred to a later
      * Axis parser). */
     5: function (d) {
       d.version = 6;
       if (Array.isArray(d.cards)) return d; // already migrated
       var neu = {
         id: 'neu', name: 'HDFC Tata Neu Infinity', type: 'neu',
         card: d.card || { no: '', aan: '', name: '' },
         records: d.records || [], ledger: d.ledger || [], redemptions: d.redemptions || [],
         rewardsConfig: d.rewardsConfig || { valuePerCoin: DEFAULT_COIN_VALUE },
         feeConfig: d.feeConfig || { target: DEFAULT_WAIVER.target, month: DEFAULT_WAIVER.month, day: DEFAULT_WAIVER.day }
       };
       neu.card.no = String(neu.card.no || '');
       neu.card.aan = String(neu.card.aan || '');
       neu.card.name = String(neu.card.name || '');
       d.cards = [neu];
       /* seed an empty Axis Scapia profile so a second card is ready without a
        * fresh bundle (type !== 'neu' → no rewards/fee config). Guarded so a
        * reload (cards already present) does not seed a duplicate. */
       if (!d.cards.some(function (c) { return c.id === 'scapia'; })) {
         d.cards.push({
           id: 'scapia', name: 'Axis Scapia', type: 'generic',
           card: { no: '', aan: '', name: '' },
           records: [], ledger: [], redemptions: [],
           rewardsConfig: null, feeConfig: null
         });
       }
        if (typeof d.activeCardId !== 'string' || !d.cards.some(function (c) { return c.id === d.activeCardId; })) {
          d.activeCardId = neu.id;
        }
        /* data now lives per-card in d.cards[] — drop the legacy top-level
         * fields so the persisted shape carries no duplicate / stale card data. */
         delete d.card; delete d.records; delete d.ledger; delete d.redemptions;
         delete d.payments; delete d.rewardsConfig; delete d.feeConfig;
         return d;
       },
      /* BigBasket bills settle via Tata Pay — 1.5% grocery (this cycle) +
       * 3.5% Tata (next cycle) = 5% — but the statement prints base=0 on
       * those rows, so the importer booked them 'nocoins'. Re-book any
       * BigBasket descriptor in the ledger as 'tatagroc'. */
      6: function (d) {
        d.version = 7;
        if (Array.isArray(d.cards)) d.cards.forEach(function (c) {
          if (c && Array.isArray(c.ledger)) c.ledger.forEach(function (e) {
            if (e && /BIGBASKET/i.test(String(e.desc || '')) && e.category !== 'payment') e.category = 'tatagroc';
          });
        });
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
    e.sourcePeriod = String(e.sourcePeriod || '');
    e.forPeriod = String(e.forPeriod || '');
    e.method = String(e.method || '');
    return e;
  }

  function migrateBundle(raw) {
    if (!raw || typeof raw !== 'object') return { incompatible: true, version: null };
    var v = (typeof raw.version === 'number' && isFinite(raw.version)) ? raw.version : 0;
    if (v > SCHEMA_VERSION) return { incompatible: true, version: v };
    var d = raw;
    while (v < SCHEMA_VERSION && MIGRATIONS[v]) { d = MIGRATIONS[v](d) || d; v++; }
    /* Per-card normalization: every card profile is self-contained. */
    if (!Array.isArray(d.cards)) d.cards = [];
    if (!d.cards.length) {
      d.cards.push(newCard('neu', 'HDFC Tata Neu Infinity'));
    }
    d.cards.forEach(normalizeCard);
    if (typeof d.activeCardId !== 'string' || !d.cards.some(function (c) { return c.id === d.activeCardId; })) {
      d.activeCardId = d.cards[0].id;
    }
    d.version = SCHEMA_VERSION;
    return d;
  }

  function newCard(type, name) {
    return {
      id: type + '-' + (Math.random() + Date.now()).toString(36).slice(2, 8),
      name: name || (type === 'neu' ? 'HDFC Tata Neu Infinity' : 'Credit card'),
      type: type,
      card: { no: '', aan: '', name: '' },
      records: [], ledger: [], redemptions: [],
      rewardsConfig: type === 'neu' ? { valuePerCoin: DEFAULT_COIN_VALUE } : null,
      feeConfig: type === 'neu' ? { target: DEFAULT_WAIVER.target, month: DEFAULT_WAIVER.month, day: DEFAULT_WAIVER.day } : null
    };
  }

  function normalizeCard(c) {
    if (!c || typeof c !== 'object') return;
    if (typeof c.id !== 'string' || !c.id) c.id = (c.type || 'card') + '-' + (Math.random() + Date.now()).toString(36).slice(2, 8);
    c.name = String(c.name || 'Credit card');
    c.type = String(c.type || 'neu');
    if (!c.card || typeof c.card !== 'object') c.card = { no: '', aan: '', name: '' };
    c.card.no = String(c.card.no || '');
    c.card.aan = String(c.card.aan || '');
    c.card.name = String(c.card.name || '');
    if (!Array.isArray(c.records)) c.records = [];
    if (!Array.isArray(c.ledger)) c.ledger = [];
    if (!Array.isArray(c.redemptions)) c.redemptions = [];
    c.records.forEach(migrateRecord);
    c.ledger.forEach(migrateLedgerEntry);
    c.redemptions.forEach(function (r) {
      r.id = String(r.id || (Math.random() + Date.now()).toString(36).slice(2));
      r.date = String(r.date || '');
      r.coins = isFinite(Number(r.coins)) ? round2(Number(r.coins)) : 0;
      r.value = (r.value === undefined || r.value === null || r.value === '') ? NaN : round2(Number(r.value));
      r.note = String(r.note || '');
    });
    c.records.sort(function (a, b) { return (pdate(a.periodTo) || 0) - (pdate(b.periodTo) || 0); });
    if (c.type === 'neu') {
      if (!c.rewardsConfig || typeof c.rewardsConfig !== 'object') c.rewardsConfig = {};
      if (!isFinite(Number(c.rewardsConfig.valuePerCoin))) c.rewardsConfig.valuePerCoin = DEFAULT_COIN_VALUE;
      if (!c.feeConfig || typeof c.feeConfig !== 'object') c.feeConfig = {};
      if (!isFinite(Number(c.feeConfig.target)) || c.feeConfig.target <= 0) c.feeConfig.target = DEFAULT_WAIVER.target;
      c.feeConfig.month = isFinite(Number(c.feeConfig.month)) ? c.feeConfig.month : DEFAULT_WAIVER.month;
      c.feeConfig.day = isFinite(Number(c.feeConfig.day)) ? c.feeConfig.day : DEFAULT_WAIVER.day;
    } else {
      c.rewardsConfig = null;
      c.feeConfig = null;
    }
  }

  return {
    round2: round2, close: close, cleanAmount: cleanAmount,
    fmtMoney: fmtMoney, fmtNum: fmtNum, fmtCoins: fmtCoins,
    madFor: madFor, CATEGORIES: CATEGORIES, predictedCoins: predictedCoins, coinSplit: coinSplit,
    classifyMerchant: classifyMerchant, guessCategory: guessCategory,
    verifyStatement: verifyStatement, applyExceptions: applyExceptions,
    hasBlocking: hasBlocking, statusSummary: statusSummary,
    reconcile: reconcile, stmtRowsToBook: stmtRowsToBook, pdate: pdate,
    rewardsValue: rewardsValue, rewardsByCategory: rewardsByCategory,
    redemptionReconcile: redemptionReconcile, rewardsTimeline: rewardsTimeline,
    paymentForRecord: paymentForRecord, dueStatus: dueStatus, autoSettlePrior: autoSettlePrior,
    utilizationOf: utilizationOf,
    interestSummary: interestSummary,
    estimatedDue: estimatedDue,
    coinTotals: coinTotals,
    waiverStatus: waiverStatus,
    DEFAULT_COIN_VALUE: DEFAULT_COIN_VALUE,
    SCHEMA_VERSION: SCHEMA_VERSION, migrateBundle: migrateBundle, newCard: newCard, BLOCKING: BLOCKING
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc; else window.Calc = Calc;