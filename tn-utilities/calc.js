/* TN Utilities - calculation & verification engine.
 * Mirrors the workbook "New Rates" model: two slab tables
 * (below-500 and above/below-500) chosen by whether units <= 500.
 */

const Calc = (function () {
  'use strict';

  function round2(x) {
    return Math.round((x + Number.EPSILON) * 100) / 100;
  }

  function cleanAmount(s) {
    var n;
    if (s == null) return NaN;
    n = String(s).replace(/[₹Rs.,\s]/gi, '').replace(/\/-?/g, '');
    n = n.replace(/\(-/g, '').replace(/\)/g, '');
    if (!/^-?\d+(\.\d*)?$/.test(n)) return NaN;
    return parseFloat(n);
  }

  function close(a, b, tol) {
    if (tol == null) tol = 0.02;
    if (!isFinite(a) || !isFinite(b)) return false;
    return Math.abs(round2(a) - round2(b)) <= tol;
  }

  var DAY_MS = 86400000;
  var GAP_DAYS = 35; /* > this many days between boundary dates ⇒ bills aren't
                        adjacent (a cycle is missing) ⇒ reading checks skip */

  function pdate(s) {
    var m = String(s == null ? '' : s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : NaN;
  }
  function gapDays(a, b) { /* b − a in days, NaN if unparseable */
    var ta = pdate(a), tb = pdate(b);
    return (isFinite(ta) && isFinite(tb)) ? Math.round((tb - ta) / DAY_MS) : NaN;
  }

  // ------------------------- slab energy engine ---------------------------

  /* tables = { below: [[from,to,rate],...], above: [[from,to,rate],...] }
   * from/to inclusive (to null = infinity). mirrors workbook branch at 500. */
  function energyByTables(units, tables, outBreakdown) {
    var table, i, from, to, rate, hits, qty, total = 0;
    if (!tables) return NaN;
    table = (units <= 500) ? tables.below : tables.above;
    if (!Array.isArray(table)) return NaN;
    for (i = 0; i < table.length; i++) {
      from = table[i][0];
      to = table[i][1];
      rate = table[i][2];
      if (units < from) continue;
      hits = (to == null) ? units - from + 1 : Math.min(units, to) - from + 1;
      if (hits < 0) continue;
      qty = hits * rate;
      total += qty;
      if (outBreakdown) outBreakdown.push({ from: from, to: to, rate: rate, units: hits, amount: qty });
    }
    return round2(total);
  }

  function proposedByTables(units, tables) {
    var b = [];
    var sum = energyByTables(units, tables, b);
    return { total: sum, breakdown: b };
  }

  /* Govt subsidy — exact translation of the workbook column D formula
   * (current regime R2025; verified against printed subsidy for 2025-10 →
   * 2026-08). NB: the (400,500] and (500,600] bands use different base
   * constants in the source — preserved verbatim. */
  function govtSubsidy(units) {
    var u = units;
    if (!isFinite(u) || u <= 0) return NaN;
    if (u <= 100) return 4.95 * u;
    if (u <= 200) return 4.95 * 100 + 2.6 * (u - 100);
    if (u <= 400) return 4.95 * 100 + 2.6 * 100 + 0.25 * (u - 200);
    if (u <= 500) return 4.95 * 100 + 2.6 * 100 + 0.25 * 200 + 0.35 * (u - 400);
    if (u <= 600) return 4.95 * 100 + 0.25 * 300 + 0.35 * 100 + 0.4 * (u - 500);
    if (u <= 800) return 4.95 * 100 + 0.25 * 300 + 0.35 * 100 + 0.4 * 100 + 0.5 * (u - 600);
    if (u <= 1000) return 4.95 * 100 + 0.25 * 300 + 0.35 * 100 + 0.4 * 100 + 0.5 * 200 + 0.55 * (u - 800);
    return 4.95 * 100 + 0.25 * 300 + 0.35 * 100 + 0.4 * 100 + 0.5 * 200 + 0.55 * 200 + 0.6 * (u - 1000);
  }

  // ------------------ built-in effective-dated tariff regimes --------------
  /* TANGEDCO rate revisions reconstructed and verified to the rupee against
   * the bill corpus (Jun-2021 → Aug-2026). The era is picked automatically by
   * the bill's consumption period; bills spanning a 1-Jul tariff change (an
   * Aug bill, e.g.) are prorated across the two regimes day-by-day.
   *    R2022  10-Sep-2022  below 4.50/6.00 · above 4.50/6.00/8.00/9.00/10.00/11.00
   *    R2023   1-Jul-2023  below 4.60/6.15 · above 4.60/6.15/8.15/9.20/10.20/11.25
   *    R2024   1-Jul-2024  below 4.80/6.45 · above 4.80/6.45/8.55/9.65/10.70/11.80
   *    R2025   1-Jul-2025  below 4.95/6.65 · above 4.95/6.65/8.80/9.95/11.05/12.15
   *    R2026  10-May-2026  same rates as R2025; ≤500 → first 200 units free
   *                        (scheme G.O.), >500 keeps the 100-free subsidy.
   *    Top slab 1001+ = 12.15 per the FY2025-26 LT-I(A) schedule (TNERC
   *    Suo-Motu T.O. No.6 of 2025, 30-Jun-2025); the earlier 11.05 guess was
   *    unverified. R2025/R2026 also carry `.net` ("you pay") tables = gross −
   *    govt subsidy per slab — display-only; verification stays on gross.
   * Subsidy bands per era (verified to printed):
   *    R2022 ≤500 → 675 flat (100 ×4.50 + 100 ×2.25); >500 → 450 (100 ×4.50)
   *    R2023 ≤500 → 460 + 235 + 0.10·(u−200);     >500 → 460 + 0.15·(u−200)
   *    R2024 ≤500 → 480 + 245 + 0.10·(u−200);     >500 → 480 + 0.15·(up to 200)
                                                          + 0.20·(over 600)
   *    R2025 → govtSubsidy() above (current). */
  function sub2022(u) {
    if (u <= 100) return 4.50 * u;
    if (u <= 200) return 4.50 * 100 + 2.25 * (u - 100);
    if (u <= 500) return 675;
    return 450;
  }
  function sub2023(u) {
    if (u <= 100) return 4.60 * u;
    if (u <= 200) return 4.60 * 100 + 2.35 * (u - 100);
    if (u <= 500) return 460 + 235 + 0.10 * (u - 200);
    return 460 + 0.15 * (u - 200);
  }
  function sub2024(u) {
    if (u <= 100) return 4.80 * u;
    if (u <= 200) return 4.80 * 100 + 2.45 * (u - 100);
    if (u <= 500) return 480 + 245 + 0.10 * (u - 200);
    return 480 + 0.15 * Math.min(u - 200, 400) + 0.20 * Math.max(u - 600, 0);
  }
  /* 200-units-free scheme (G.O., 10-May-2026, CM C. Joseph Vijay): bi-monthly
   * consumption ≤500 → first 200 units free; >500 → keeps the 100-free scheme
   * (i.e. govtSubsidy). Tariff rates are unchanged from R2025. Confirmed
   * against the official tnebnet.org Bill Calculator: 478.87 units (bi-monthly)
   * → ₹1,436.881, exactly this model (free-200 value = 200×4.95 + carried
   * 0.25/0.35 upper-slab subsidies). B13.pdf's printed invoice (subsidy
   * ₹977.53, net ₹1,527.00) deviates → billing-software error, accept via gate. */
  function sub2026(u) {
    if (u <= 200) return 4.95 * u;
    if (u <= 400) return 4.95 * 200 + 0.25 * (u - 200);
    if (u <= 500) return 4.95 * 200 + 0.25 * 200 + 0.35 * (u - 400);
    return govtSubsidy(u);
  }
  var REGIMES = [
    { key: 'R2022', from: '2022-09-10', label: 'Sep-2022 order · 10-Sep-2022 → 30-Jun-2023',
      below: [[1, 400, 4.50], [401, 500, 6.00]],
      above: [[1, 400, 4.50], [401, 500, 6.00], [501, 600, 8.00], [601, 800, 9.00], [801, 1000, 10.00], [1001, null, 11.00]],
      sub: sub2022 },
    { key: 'R2023', from: '2023-07-01', label: 'FY2023-24 · 1-Jul-2023 → 30-Jun-2024',
      below: [[1, 400, 4.60], [401, 500, 6.15]],
      above: [[1, 400, 4.60], [401, 500, 6.15], [501, 600, 8.15], [601, 800, 9.20], [801, 1000, 10.20], [1001, null, 11.25]],
      sub: sub2023 },
    { key: 'R2024', from: '2024-07-01', label: 'FY2024-25 · 1-Jul-2024 → 30-Jun-2025',
      below: [[1, 400, 4.80], [401, 500, 6.45]],
      above: [[1, 400, 4.80], [401, 500, 6.45], [501, 600, 8.55], [601, 800, 9.65], [801, 1000, 10.70], [1001, null, 11.80]],
      sub: sub2024 },
    { key: 'R2025', from: '2025-07-01', label: 'FY2025-26 · 1-Jul-2025 → 10-May-2026',
      below: [[1, 400, 4.95], [401, 500, 6.65]],
      above: [[1, 400, 4.95], [401, 500, 6.65], [501, 600, 8.80], [601, 800, 9.95], [801, 1000, 11.05], [1001, null, 12.15]],
      /* net ("you pay") = gross − govt subsidy per slab; display-only.
         ≤500 keeps the extra 101–200 @₹2.60 rebate (so it splits at 200),
         >500 keeps the 100-free shape. Verified to the rupee vs the corpus. */
      net: {
        below: [[1, 100, 0], [101, 200, 2.35], [201, 400, 4.70], [401, 500, 6.30]],
        above: [[1, 100, 0], [101, 400, 4.70], [401, 500, 6.30], [501, 600, 8.40], [601, 800, 9.45], [801, 1000, 10.50], [1001, null, 11.55]]
      },
      sub: govtSubsidy },
    { key: 'R2026', from: '2026-05-10', label: 'FY2025-26 · free-200 scheme · 10-May-2026 — current',
      below: [[1, 400, 4.95], [401, 500, 6.65]],
      above: [[1, 400, 4.95], [401, 500, 6.65], [501, 600, 8.80], [601, 800, 9.95], [801, 1000, 11.05], [1001, null, 12.15]],
      /* net for R2026: ≤500 → free-200 scheme (200 free, then 4.70, 6.30 —
         matches the official tnebnet.org calculator: 478.87 → ₹1,436.88);
         >500 same as R2025 (100-free). */
      net: {
        below: [[1, 200, 0], [201, 400, 4.70], [401, 500, 6.30]],
        above: [[1, 100, 0], [101, 400, 4.70], [401, 500, 6.30], [501, 600, 8.40], [601, 800, 9.45], [801, 1000, 10.50], [1001, null, 11.55]]
      },
      sub: sub2026 }
  ];

  function isoDate(s) {
    var m = String(s == null ? '' : s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? m[3] + '-' + m[2] + '-' + m[1] : String(s == null ? '' : s);
  }
  function regimeOn(iso) {
    var out = null;
    for (var i = 0; i < REGIMES.length; i++) { if (String(iso) >= REGIMES[i].from) out = REGIMES[i]; }
    return out;
  }
  function daysDiff(aIso, bIso) {
    var u = function (x) { var p = String(x).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); };
    var ta = u(aIso), tb = u(bIso);
    return (isFinite(ta) && isFinite(tb)) ? Math.round((tb - ta) / DAY_MS) : NaN;
  }
  function blendRates(newTables, oldTables, fOld) {
    return newTables.map(function (row, i) {
      var oldRate = (oldTables && oldTables[i]) ? oldTables[i][2] : row[2];
      return [row[0], row[1], oldRate * fOld + row[2] * (1 - fOld)];
    });
  }
  /* Resolve the built-in regime(s) that apply to a bill. Returns
   *   { regime, tables:{below,above}, subFn, cutover? }   — era applies
   *   null                                               — bill predates the
   *     earliest built-in regime (before 10-Sep-2022) or has no period end;
   *     caller falls back to the legacy tables. */
  function tablesForBill(bill) {
    if (!bill) return null;
    var perTo = isoDate(bill.periodTo);
    var cur = perTo ? regimeOn(perTo) : null;
    if (!cur) return null;
    var perFrom = isoDate(bill.periodFrom);
    var cut = null;
    if (perFrom) {
      for (var i = 0; i < REGIMES.length; i++) {
        if (REGIMES[i].from > perFrom && REGIMES[i].from <= perTo) { cut = REGIMES[i]; break; }
      }
    }
    if (!cut) return { regime: cur, tables: { below: cur.below, above: cur.above }, subFn: cur.sub };
    var idx = REGIMES.indexOf(cut);
    if (idx === 0) return null; /* consumption starts before the earliest built-in era */
    var prev = REGIMES[idx - 1];
    var tot = daysDiff(perFrom, perTo);
    var fOld = isFinite(tot) ? daysDiff(perFrom, cut.from) / Math.max(1, tot) : 0;
    if (fOld < 0) fOld = 0;
    return {
      regime: cur, cutover: { on: cut.from, fOld: fOld, newRegime: cut, oldRegime: prev },
      tables: { below: blendRates(cut.below, prev.below, fOld), above: blendRates(cut.above, prev.above, fOld) },
      subFn: function (u) { return prev.sub(u) * fOld + cut.sub(u) * (1 - fOld); }
    };
  }

  /* Display-only net ("you pay") tables = gross − per-slab govt subsidy,
   * defined only for eras whose subsidy is slab-linear (R2025/R2026). Eras
   * with flat-compensation subsidies have no per-unit net rate → null. */
  function netTablesFor(regime) {
    return regime && regime.net ? regime.net : null;
  }

  // --------------------------- verify checks ------------------------------

  /* Each check returns { key, label, status, message, expected, actual, delta }
   * status: 'pass' | 'warn' | 'fail' | 'info' */

  var BLOCKING = { fail: true };

  function verifyBill(bill, ctx) {
    ctx = ctx || {};
    var checks = [];
    /* auto: true → pick the built-in era tables from the bill's consumption
     * period (prorating across a 1-Jul tariff change when the bill spans it);
     * falls back to ctx.tables for pre-2022 (era-A) bills. Without `auto`,
     * ctx.tables is used verbatim (legacy path — dev harness). */
    var resolved = ctx.auto ? tablesForBill(bill) : null;
    var cutover = resolved && resolved.cutover;
    var tables = resolved ? resolved.tables : (ctx.tables || {});
    var subFn = resolved ? resolved.subFn : govtSubsidy;
    var recomputed = proposedByTables(bill.units, tables);
    var prev = ctx.prevRecord;

    // 1 SC number — whether the bill belongs to the primary profile. A
    // different S/C is NOT a concern (parallel connections are a normal flow):
    // it is shown as 'info' with no gate buttons, and the bill is recorded
    // under its own S/C as a separate profile on commit.
    var scPass = !!(ctx.profileSc && bill.scNo && bill.scNo.replace(/\D/g, '') === String(ctx.profileSc).replace(/\D/g, ''));
    checks.push({
      key: 'sc', label: scPass ? 'S/C number matches profile' : 'S/C number differs from profile',
      status: scPass ? 'pass' : 'info',
      expected: ctx.profileSc || 'any', actual: bill.scNo,
      configurable: true,
      message: scPass ? '' : (bill.scNo ? 'Different connection — this bill will be recorded under S/C ' + bill.scNo + ' as a separate profile.' : 'No S/C number printed on this bill (legacy/basic account).')
    });

    // 2 tariff
    checks.push({
      key: 'tariff', label: 'Tariff matches profile (LA1A)',
      status: /LA1A/i.test(bill.tariff || '') ? 'pass' : (bill.tariff ? 'warn' : 'info'),
      expected: 'LA1A', actual: bill.tariff || 'not printed',
      configurable: true
    });

    // 3 reading continuity (backward: new bill's initial == previous bill's final)
    //    skipped as info when the two bills aren't adjacent (> GAP_DAYS gap, e.g.
    //    an intermediate bill was never entered) — a raw reading compare is
    //    meaningless across a missing cycle.
    var readingsValid = isFinite(bill.prevReading) && isFinite(bill.presentReading);
    var later = ctx && ctx.laterRecord;
    if (prev && (prev.periodTo || prev.period) && readingsValid) {
      var gap = gapDays(prev.periodTo || prev.period, bill.periodFrom || bill.periodTo);
      if (isFinite(gap) && gap > GAP_DAYS) {
        checks.push({
          key: 'continuity', label: 'Readings are continuous with previous entry',
          status: 'info',
          message: 'Skipped — gap of ' + gap + ' days between bills (no adjacent previous bill).',
          ref: 'previous bill ' + (prev.periodTo || prev.period || ''),
          configurable: true
        });
      } else {
        var contOk = close(bill.prevReading, prev.presentReading);
        checks.push({
          key: 'continuity', label: 'Readings are continuous with previous entry',
          status: contOk ? 'pass' : 'fail',
          expected: prev.presentReading, actual: bill.prevReading,
          delta: contOk ? 0 : round2(bill.prevReading - prev.presentReading),
          ref: 'previous bill ' + (prev.periodTo || prev.period || ''),
          configurable: true
        });
      }
    } else {
      checks.push({
        key: 'continuity', label: 'Reading continuity ' + (readingsValid ? '(first entry)' : '(no/defective readings)'),
        status: 'info', message: 'Skipped — ' + (!readingsValid ? 'bill has no usable meter reading.' : 'no previous entry.')
      });
    }

    // 3b reading continuity (forward: new bill's final == next bill's initial,
    //    when that later bill was already recorded — e.g. uploaded out of order)
    if (later && (later.periodFrom || later.period) && readingsValid && isFinite(bill.presentReading) && isFinite(later.prevReading)) {
      var fgap = gapDays(bill.periodTo || bill.period, later.periodFrom || later.period);
      if (isFinite(fgap) && fgap > GAP_DAYS) {
        checks.push({
          key: 'continuityFwd', label: 'Readings are continuous with next entry',
          status: 'info',
          message: 'Skipped — gap of ' + fgap + ' days to the next-recorded entry.',
          ref: 'next bill ' + (later.periodFrom || later.period || ''),
          configurable: true
        });
      } else {
        var fOk = close(bill.presentReading, later.prevReading);
        checks.push({
          key: 'continuityFwd', label: 'Readings are continuous with next entry (already recorded)',
          status: fOk ? 'pass' : 'fail',
          expected: later.prevReading, actual: bill.presentReading,
          delta: fOk ? 0 : round2(later.prevReading - bill.presentReading),
          ref: 'next bill ' + (later.periodFrom || later.period || ''),
          configurable: true
        });
      }
    } else if (later) {
      checks.push({
        key: 'continuityFwd', label: 'Readings are continuous with next entry',
        status: 'info',
        message: 'Skipped — ' + (!readingsValid ? 'bill has no usable meter reading.' : 'next entry has no usable reading.'),
        configurable: true
      });
    }

    // 4 units internal consistency
    if (isFinite(bill.units) && readingsValid) {
      var raw = round2((bill.presentReading - bill.prevReading) * bill.mf);
      var rawNoMf = round2(bill.presentReading - bill.prevReading);
      var unitsOk = close(bill.units, raw) || close(bill.units, rawNoMf);
      checks.push({
        key: 'units', label: 'Units = (present − previous) × MF',
        status: unitsOk ? 'pass' : 'fail',
        expected: rawNoMf, actual: bill.units,
        delta: round2(bill.units - rawNoMf),
        note: 'MF=' + bill.mf + '; (present−prev)×MF=' + raw,
        configurable: true
      });
    } else {
      checks.push({
        key: 'units', label: 'Units consistent with readings',
        status: 'info', message: 'Skipped — no usable readings/units to compare.'
      });
    }

    // 5 energy vs recomputed (built-in/era or your tables). The tables
    // reproduce the effective payable (energy − subsidy); so accept a match
    // against the printed energy line OR the printed net/total amount. The
    // printed amount is rounded to whole rupees while the slab math is
    // paise-exact, so allow a rupee-scale tolerance (design rule: < ₹2).
    // Bills spanning a tariff change are prorated, so use a wider tolerance.
    var tolE = cutover ? 10.0 : 2.0;
    var energyDiff = round2(recomputed.total - bill.energyCharges);
    var netDiff = round2(recomputed.total - (isFinite(bill.totalPayable) ? bill.totalPayable : bill.netTotal));
    var energyOk = close(recomputed.total, bill.energyCharges, tolE) ||
      (!isFinite(bill.energyCharges) && hasNet && close(recomputed.total, bill.totalPayable, tolE));
    var unitsUsable = isFinite(bill.units) && isFinite(recomputed.total);
    var hasNet = isFinite(bill.totalPayable);
    var hasSub = isFinite(bill.govtSubsidy);
    var energyMatched = close(recomputed.total, bill.energyCharges, tolE);
    var netMatched = hasNet && close(recomputed.total, bill.totalPayable, tolE);
    var eF = Calc.fmtMoney(recomputed.total);
    var cutNote = cutover
      ? 'Bill period spans the ' + cutover.on + ' tariff change — prorated by days across both rates.'
      : '';
    var netExplain = hasNet && hasSub
      ? 'net ' + Calc.fmtMoney(bill.totalPayable) + ' = energy − subsidy ' + Calc.fmtMoney(bill.govtSubsidy)
      : (hasNet ? 'net ' + Calc.fmtMoney(bill.totalPayable) : '');
    var energyMsg;
    if (!unitsUsable) {
      energyMsg = 'No usable units to recompute — special/assessment bill.';
    } else if (energyMatched) {
      energyMsg = eF + ' = printed energy ' + Calc.fmtMoney(bill.energyCharges) +
        (netExplain ? '; ' + netExplain : '') + (cutNote ? ' ' + cutNote : '');
    } else if (netMatched) {
      energyMsg = eF + ' ≈ ' + netExplain +
        ' (printed energy ' + Calc.fmtMoney(bill.energyCharges) + ' differs by ' + Calc.fmtMoney(energyDiff) + ')' +
        (cutNote ? ' ' + cutNote : '');
    } else {
      energyMsg = eF + ' vs printed energy ' + Calc.fmtMoney(bill.energyCharges) +
        ' and ' + netExplain +
        ' (Δ energy ' + Calc.fmtMoney(energyDiff) +
        (hasNet ? ', Δ net ' + Calc.fmtMoney(netDiff) : '') + ')';
    }
    checks.push({
      key: 'energy', label: resolved ? 'Amount matches built-in tariff (era by bill date)' : 'Amount matches editable rate tables',
      status: unitsUsable ? (energyOk ? 'pass' : 'fail') : 'info',
      expected: recomputed.total + (resolved ? ' (' + resolved.regime.key + ' tariff)' : ' (tables)'),
      actual: bill.energyCharges,
      delta: energyDiff,
      netDelta: netDiff,
      breakdown: recomputed.breakdown,
      message: energyMsg,
      configurable: true
    });

    // 6 govt subsidy vs era/dates formula
    var subNotPrinted = !isFinite(bill.govtSubsidy) || bill.govtSubsidy <= 0;
    var subUsable = !subNotPrinted && isFinite(bill.units) && bill.units > 0;
    var subFormula = subUsable ? subFn(bill.units) : NaN;
    /* era subsidy constants are exact to the paise for most bills; two corpus
       bills carry a small extra charge (+₹2.5/+₹4.5), so allow ₹5 when the era
       is auto-resolved (₹10 when prorated across a tariff change). */
    var subPass = close(subFormula, bill.govtSubsidy, resolved ? (cutover ? 10.0 : 5.0) : 0.02);
    var subLikelyMissing = subNotPrinted && isFinite(bill.units) && bill.units > 0 &&
      isFinite(bill.energyCharges) && bill.energyCharges > 0;
    var subStatus = 'info';
    if (subLikelyMissing) subStatus = 'warn';
    else if (!subNotPrinted) subStatus = subUsable ? (subPass ? 'pass' : 'fail') : 'info';
    checks.push({
      key: 'subsidy', label: 'Govt subsidy matches tariff-era formula',
      status: subStatus,
      expected: subNotPrinted ? null : round2(subFormula),
      actual: subNotPrinted ? null : bill.govtSubsidy,
      delta: subNotPrinted ? null : round2(subFormula - bill.govtSubsidy),
      message: subLikelyMissing
        ? 'No subsidy line detected on a non-zero bill — verify the printed subsidy was read correctly.'
        : (subNotPrinted
          ? 'No subsidy printed on bill.'
          : (subPass
            ? ''
            : (resolved
              ? 'Era subsidy estimate ' + Calc.fmtMoney(subFormula) + ' vs printed ' +
                Calc.fmtMoney(bill.govtSubsidy) + ' — bills occasionally add a small extra charge, accept if the total matches.'
              : 'Subsidy formula is the current regime (' + Calc.fmtMoney(subFormula) +
                ' vs printed ' + Calc.fmtMoney(bill.govtSubsidy) +
                ') — bills before Jul-2025 used an earlier subsidy, accept.'))),
      configurable: true
    });

    // 7 fixed charge (~0 in current regime)
    checks.push({
      key: 'fixed', label: 'Fixed charge is zero (current regime)',
      status: (!bill.fixedCharges || close(bill.fixedCharges, 0)) ? 'pass' : 'warn',
      actual: bill.fixedCharges || 0, expected: 0, configurable: true
    });

    // 8 total math: round(E + Fixed − Subsidy) == printed payable
    var compTotal = round2(bill.energyCharges + (bill.fixedCharges || 0) - bill.govtSubsidy);
    var totalOk = close(compTotal, bill.totalPayable, 2.0) || close(compTotal, bill.netTotal, 2.0);
    var specialAssessment = (!isFinite(bill.energyCharges) || bill.energyCharges <= 0) &&
      isFinite(bill.totalPayable) && bill.totalPayable > 0;
    checks.push({
      key: 'total', label: 'Amount = Energy + Fixed − Subsidy',
      status: specialAssessment ? 'info' : (isFinite(bill.totalPayable) ? (totalOk ? 'pass' : 'fail') : 'fail'),
      message: specialAssessment ? 'Special/assessment bill — no energy breakdown.' : '',
      expected: compTotal, actual: bill.totalPayable,
      delta: isFinite(bill.totalPayable) ? round2(compTotal - bill.totalPayable) : null,
      configurable: true
    });

    return { checks: checks, recomputed: recomputed.total, compTotal: compTotal };
  }

  function verifyReceipt(payment, bill, ctx) {
    var checks = [];
    var scMatchA = String((payment.scNo || '').replace(/\D/g, ''));
    var scMatchB = String((bill.scNo || '').replace(/\D/g, ''));
    var scOk = scMatchA && scMatchB && scMatchA === scMatchB;
    checks.push({
      key: 'receipt_sc', label: 'Receipt S/C number matches bill',
      status: scOk ? 'pass' : 'fail',
      expected: (bill.scNo || '').replace(/\D/g, ''), actual: (payment.scNo || '').replace(/\D/g, ''),
      configurable: true
    });

    var amountOk = close(payment.paidAmount, bill.totalPayable) || close(payment.paidAmount, bill.netTotal);
    checks.push({
      key: 'receipt_amount', label: 'Receipt amount matches bill amount',
      status: amountOk ? 'pass' : 'fail',
      expected: bill.totalPayable, actual: payment.paidAmount,
      delta: isFinite(bill.totalPayable) && isFinite(payment.paidAmount) ? round2(payment.paidAmount - bill.totalPayable) : null,
      configurable: true
    });

    var noOk = /^[A-Z0-9]{6,30}$/i.test(payment.receiptNo || '');
    checks.push({
      key: 'receipt_no', label: 'Receipt number present',
      status: noOk ? 'pass' : 'fail',
      actual: payment.receiptNo || '(missing)',
      configurable: true
    });

    var hasInvoice = bill instanceof Object && bill.id;
    if (hasInvoice && ctx && ctx.usedReceiptNo) {
      var dup = ctx.usedReceiptNo.has(payment.receiptNo);
      checks.push({
        key: 'receipt_dup', label: 'Receipt number not already used',
        status: dup ? 'fail' : 'pass',
        actual: payment.receiptNo, configurable: true
      });
    }

    return checks;
  }

  function connKeyFor(r, field) {
    return String(field === 'pt' ? (r && r.propertyNo) : (r && r.cmcNo) || '').replace(/\D/g, '');
  }
  /* The single-stage verify for utility receipts (water/PT): the receipt IS
   * the record. ctx carries the connection from the current roster and any
   * already-committed receipt numbers for this connection. */
  function verifyWater(p, ctx) {
    var checks = [];
    var conn = (ctx && ctx.cmcNo) ? String(ctx.cmcNo).replace(/\D/g, '') : '';
    var cmcOk = conn && String(p.cmcNo || '').replace(/\D/g, '') === conn;
    checks.push({
      key: 'water_conn', label: 'CMC No. matches current connection',
      status: cmcOk ? 'pass' : 'fail',
      expected: conn || '(fill in profile CMC No.)', actual: p.cmcNo || '(missing)',
      configurable: true
    });
    var sum = 0, allFin = !!(p.items && p.items.length);
    (p.items || []).forEach(function (it) { if (!isFinite(it.amount)) allFin = false; else sum += it.amount; });
    sum = round2(sum);
    var sumOk = close(sum, p.amount, 2.0) || close(sum, p.grandTotal, 2.0);
    checks.push({
      key: 'water_sum', label: 'Item amounts add up',
      status: (p.items && p.items.length) ? (allFin ? (sumOk ? 'pass' : 'fail') : 'fail') : 'warn',
      message: (p.items && p.items.length) ? '' : 'No itemised rows.',
      expected: isFinite(p.amount) ? round2(sum) : null, actual: isFinite(p.amount) ? p.amount : null,
      delta: isFinite(p.amount) ? round2(sum - p.amount) : null,
      configurable: true
    });
    var amtOk = close(p.amount, p.paidTotal, 2.0) || close(p.amount, p.receiptAmount, 2.0);
    checks.push({
      key: 'water_amount', label: 'Receipt Amount matches Paid Total',
      status: isFinite(p.amount) ? (amtOk ? 'pass' : 'fail') : 'fail',
      expected: isFinite(p.paidTotal) ? p.paidTotal : p.receiptAmount,
      actual: isFinite(p.amount) ? p.amount : null,
      delta: isFinite(p.amount) && isFinite(p.paidTotal) ? round2(p.paidTotal - p.amount) : null,
      configurable: true
    });
    var noOk = /^[A-Z0-9/\-]{6,30}$/i.test(p.receiptNo || '');
    checks.push({ key: 'water_no', label: 'Receipt number present', status: noOk ? 'pass' : 'fail', actual: p.receiptNo || '(missing)', configurable: true });
    var dtOk = /^\d{2}\/\d{2}\/\d{4}$/.test(p.paidDate || '') && p.paidDate !== '01/01/1970';
    checks.push({ key: 'water_date', label: 'Payment date present and sane', status: dtOk ? 'pass' : 'fail', actual: p.paidDate || '(missing)', configurable: true });
    if (ctx && ctx.usedReceiptNo) {
      checks.push({ key: 'water_dup', label: 'Receipt No. not already committed', status: ctx.usedReceiptNo.has(p.receiptNo) ? 'fail' : 'pass', actual: p.receiptNo, configurable: true });
    }
    return checks;
  }

  function verifyPT(p, ctx) {
    var checks = [];
    var conn = (ctx && ctx.propertyNo) ? String(ctx.propertyNo).replace(/\D/g, '') : '';
    var propOk = conn && String(p.propertyNo || '').replace(/\D/g, '') === conn;
    checks.push({
      key: 'pt_prop', label: 'Property No. matches current property',
      status: propOk ? 'pass' : 'fail',
      expected: conn || '(fill in profile Property No.)', actual: p.propertyNo || '(missing)',
      configurable: true
    });
    if (p.items && p.items.length) {
      var sum = 0, allFin = true;
      p.items.forEach(function (it) { if (!isFinite(it.amount)) allFin = false; else sum += it.amount; });
      sum = round2(sum);
      var sumOk = close(sum, p.amount, 2.0);
      checks.push({
        key: 'pt_sum', label: 'Installment amounts add up',
        status: allFin ? (sumOk ? 'pass' : 'fail') : 'fail',
        expected: isFinite(p.amount) ? round2(sum) : null, actual: isFinite(p.amount) ? p.amount : null,
        delta: isFinite(p.amount) ? round2(sum - p.amount) : null,
        configurable: true
      });
    } else {
      checks.push({ key: 'pt_sum', label: 'Installment amounts add up', status: 'warn', message: 'No installments listed.', configurable: true });
    }
    var amtOk = isFinite(p.amount) && p.amount > 0;
    checks.push({ key: 'pt_amount', label: 'Amount present', status: amtOk ? 'pass' : 'fail', actual: isFinite(p.amount) ? p.amount : null, configurable: true });
    var noOk = /^[A-Z0-9/\-]{6,30}$/i.test(p.receiptNo || '');
    checks.push({ key: 'pt_no', label: 'Receipt number present', status: noOk ? 'pass' : 'fail', actual: p.receiptNo || '(missing)', configurable: true });
    var dtOk = /^\d{2}\/\d{2}\/\d{4}$/.test(p.paidDate || '') && p.paidDate !== '01/01/1970';
    checks.push({ key: 'pt_date', label: 'Payment date present and sane', status: dtOk ? 'pass' : 'fail', actual: p.paidDate || '(missing)', configurable: true });
    if (ctx && ctx.usedReceiptNo) {
      checks.push({ key: 'pt_dup', label: 'Receipt No. not already committed', status: ctx.usedReceiptNo.has(p.receiptNo) ? 'fail' : 'pass', actual: p.receiptNo, configurable: true });
    }
    return checks;
  }

  function duplicatesFor(records, periodFrom, periodTo, selfId) {
    var out = [];
    (records || []).forEach(function (r) {
      if (selfId && r.id === selfId) return;
      if (!r.periodFrom || !r.periodTo) return;
      if (periodTo < r.periodFrom || periodFrom > r.periodTo) return;
      out.push(r);
    });
    return out;
  }

  /* Apply accepted exceptions to a check list. exceptions = { key: note }
   * returns { checks, blocked, decisionsRequired } */
  function applyExceptions(checks, exceptions) {
    var blocked = false;
    var required = [];
    var out = checks.map(function (c) {
      if ((c.status === 'fail' || c.status === 'warn') && c.configurable && exceptions && exceptions[c.key]) {
        return Object.assign({}, c, { status: 'accepted', exception: exceptions[c.key] });
      }
      if (BLOCKING[c.status]) blocked = true;
      if ((c.status === 'fail') && c.required && !(exceptions && exceptions[c.key])) required.push(c.key);
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

  function fmtMoney(x) {
    if (!isFinite(x)) return '—';
    var neg = x < 0;
    var v = Math.abs(x);
    var s = v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '-' : '') + '\u20B9' + s;
  }

  function fmtNum(x) {
    if (!isFinite(x)) return '—';
    return String(round2(x));
  }

  // ---------- bundle schema versioning + migration ----------
  // SCHEMA_VERSION is the current on-disk format. Older bundles are upgraded
  // step-by-step; newer (future) bundles are rejected as incompatible so the
  // app never silently mis-reads data it doesn't understand.
  var SCHEMA_VERSION = 3;

  function digitsOnly(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  function migRecId(scNo, periodTo) { return 'b-' + digitsOnly(scNo) + '-' + (periodTo || ''); }
  function migRecRid(scNo, periodTo) { return 'r-' + digitsOnly(scNo) + '-' + (periodTo || ''); }
  var MIG_NUM_FIELDS = ['units', 'prevReading', 'presentReading', 'mf', 'energyCharges', 'fixedCharges', 'govtSubsidy', 'netTotal', 'totalPayable'];

  function migrateRecord(r) {
    if (!r || typeof r !== 'object') return r;
    var isNonElec = r.type === 'water' || r.type === 'pt';
    if (!isNonElec) {
      MIG_NUM_FIELDS.forEach(function (k) {
        var v = r[k];
        if (v === undefined || v === null || v === '') r[k] = 0;
        else { r[k] = Number(v); if (!isFinite(r[k])) r[k] = 0; }
      });
    }
    r.scNo = r.scNo == null ? '' : String(r.scNo);
    r.consumerName = r.consumerName == null ? '' : String(r.consumerName);
    r.periodFrom = r.periodFrom == null ? '' : String(r.periodFrom);
    r.periodTo = r.periodTo == null ? '' : String(r.periodTo);
    r.status = (r.status === 'paid' || (r.paidOn && (r.paidOn.date || r.paidOn.receiptNo))) ? 'paid' : (r.status || 'unpaid');
    if (!Array.isArray(r.accepted)) r.accepted = [];
    if (!Array.isArray(r.docs)) r.docs = [];
    if (typeof r.layout !== 'string') r.layout = '';
    var idOk = r.id && /^(b-[0-9]+-|w-[0-9]+-|p-[0-9]+-)/.test(r.id);
    r.id = idOk ? r.id : (isNonElec ? '' : migRecId(r.scNo, r.periodTo));
    (r.docs || []).forEach(function (d) {
      if (d && d.kind === 'receipt' && (!d.docId || !/^r-[0-9]+-/.test(d.docId))) d.docId = migRecRid(r.scNo, r.periodTo);
    });
    return r;
  }

  function rebuildConsumers(d) {
    var map = {};
    (d.records || []).forEach(function (r) {
      if (r && (r.type === 'water' || r.type === 'pt')) return;
      var sc = digitsOnly(r.scNo);
      if (!sc) return;
      if (!map[sc]) map[sc] = { scNo: sc, name: r.consumerName || '', tariff: r.tariff || '', since: r.periodFrom || '' };
      else {
        if (!map[sc].name && r.consumerName) map[sc].name = r.consumerName;
        if (r.periodFrom && (!map[sc].since || r.periodFrom < map[sc].since)) map[sc].since = r.periodFrom;
      }
    });
    d.consumers = Object.keys(map).map(function (k) { return map[k]; });
    return d;
  }

  /* Rebuild the water/PT connection rosters from already-committed records.
   * field: 'water' → waterConsumers (cmcNo keys), 'pt' → ptConsumers. */
  function rebuildConnRoster(d, field) {
    var isPT = field === 'pt';
    var rosterKey = isPT ? 'ptConsumers' : 'waterConsumers';
    var map = {};
    (d.records || []).forEach(function (r) {
      if (!r || (isPT ? r.type !== 'pt' : r.type !== 'water')) return;
      var label = String(isPT ? (r.propertyNo || '') : (r.cmcNo || ''));
      var key = label.replace(/\D/g, '');
      if (!key) return;
      if (!map[key]) map[key] = { no: key, label: label, name: r.consumerName || '' };
      else {
        if (!map[key].name && r.consumerName) map[key].name = r.consumerName;
        if (!map[key].label) map[key].label = label;
      }
    });
    d[rosterKey] = Object.keys(map).map(function (k) { return map[k]; });
    return d;
  }

  // Each entry upgrades a bundle FROM that version TO version+1.
  var MIGRATIONS = {
    0: function (d) { d.version = 1; return d; },
    1: function (d) { (d.records || []).forEach(migrateRecord); d.version = 2; return d; },
    2: function (d) {
      (d.records || []).forEach(function (r) { if (r && !r.type) r.type = 'elec'; });
      rebuildConnRoster(d, 'water');
      rebuildConnRoster(d, 'pt');
      d.version = 3;
      return d;
    }
  };

  function migrateBundle(raw) {
    if (!raw || typeof raw !== 'object') return { incompatible: true, version: null };
    var v = (typeof raw.version === 'number' && isFinite(raw.version)) ? raw.version : 0;
    if (v > SCHEMA_VERSION) return { incompatible: true, version: v };
    var d = raw;
    while (v < SCHEMA_VERSION && MIGRATIONS[v]) { d = MIGRATIONS[v](d) || d; v++; }
    (d.records || []).forEach(migrateRecord);
    if (!d.profile || typeof d.profile !== 'object') d.profile = { name: '', scNo: '', tariff: '' };
    if (!Array.isArray(d.consumers) || !d.consumers.length) rebuildConsumers(d);
    if (!Array.isArray(d.waterConsumers)) d.waterConsumers = [];
    if (!Array.isArray(d.ptConsumers)) d.ptConsumers = [];
    if (!Array.isArray(d.records)) d.records = [];
    if (!d.cycle) d.cycle = '';
    if (!d.since) d.since = '';
    if (!d.rateTables) d.rateTables = null;
    if (d.rateTablesVersion === undefined) d.rateTablesVersion = (d.rateTables ? 'custom' : 2);
    d.version = SCHEMA_VERSION;
    return d;
  }

  return {
    round2: round2,
    cleanAmount: cleanAmount,
    close: close,
    energyByTables: energyByTables,
    proposedByTables: proposedByTables,
    govtSubsidy: govtSubsidy,
    REGIMES: REGIMES,
    tablesForBill: tablesForBill,
    netTablesFor: netTablesFor,
    verifyBill: verifyBill,
    verifyReceipt: verifyReceipt,
    verifyWater: verifyWater,
    verifyPT: verifyPT,
    rebuildConnRoster: rebuildConnRoster,
    connKeyFor: connKeyFor,
    duplicatesFor: duplicatesFor,
    applyExceptions: applyExceptions,
    hasBlocking: hasBlocking,
    statusSummary: statusSummary,
    fmtMoney: fmtMoney,
    fmtNum: fmtNum,
    SCHEMA_VERSION: SCHEMA_VERSION,
    migrateBundle: migrateBundle,
    BLOCKING: BLOCKING
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc; else window.Calc = Calc;