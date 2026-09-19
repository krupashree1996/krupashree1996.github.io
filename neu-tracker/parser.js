/* HDFC Tata Neu Credit Card statement parser.
 * Converts pdf.js page textContent into a structured statement object.
 * Handles both statement layouts:
 *   - old: 'Statement for HDFC Bank Credit Card' + 'Payment Due Date ... Minimum Amount Due'
 *   - new: 'Tata Neu Infinity ...' + 'TOTAL AMOUNT DUE' / 'MINIMUM DUE'
 * All amounts are rupees; coins are integer NeuCoins. Fully offline.
 */

const Parser = (function () {
  'use strict';

  /* pdf.js renders empty glyphs (rupee) as 'C'/'₹'/'Rs.' next to numbers. */
  var CUR = /^(₹|C|RS\.?|Rs\.?)$/i;
  var DEC = /^[+-]?[\d,]+(\.\d{1,2})$/;
  var INT = /^[+-]?[\d,]+$/;

  function num(s) {
    var n = String(s == null ? '' : s).replace(/[,\s]/g, '');
    var v = parseFloat(n);
    return isFinite(v) ? v : NaN;
  }

  /* Tokenise a grouped line into rupee amounts, merging a standalone
   * currency glyph (+/- too) with the following number. */
  function moneyTokens(line) {
    var toks = String(line).split(' ');
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (CUR.test(t)) continue;                                // currency glyph alone
      if (/^[+\-]$/.test(t)) continue;                          // stray sign
      var m = t.match(/^([+\-]?[\d,]+\.\d{1,2})(Cr)?$/i);
      if (m) { out.push(num(m[1])); continue; }
      /* 'C16,554.31' or '₹5,00,000.00' glued glyph+number, or '1,230.00Cr' */
      var g = t.match(/^(?:₹|C|RS\.?|Rs\.?)?([+\-]?[\d,]+\.\d{1,2})(Cr)?$/i);
      if (g) { out.push(num(g[1])); continue; }
    }
    return out.filter(isFinite);
  }

  /* Every token on the line is a currency glyph or decimal rupee value
   * (e.g. the account summary / past-dues rows). */
  function isPureMoneyLine(line) {
    var toks = String(line).trim().split(' ');
    if (!toks.length) return false;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i].replace(/Cr$/i, '');
      if (!CUR.test(t) && !DEC.test(t) && !/^[+\-]$/.test(t) && !/^(?:₹|C|RS\.?|Rs\.?)[+\-]?[\d,]+\.\d{1,2}(Cr)?$/i.test(toks[i]))
        return false;
    }
    return moneyTokens(line).length >= 2;
  }

  function pureMoneyRow(lines, want) {
    for (var i = 0; i < lines.length; i++) {
      if (isPureMoneyLine(lines[i])) {
        var v = moneyTokens(lines[i]);
        if (v.length === want) return v;
      }
    }
    return null;
  }

  function pureIntRow(lines, anchorRe, minCount) {
    var from = 0;
    if (anchorRe) {
      for (var k = 0; k < lines.length; k++) if (anchorRe.test(lines[k])) { from = k; break; }
    }
    for (var i = from; i < lines.length && i < from + 10; i++) {
      var toks = lines[i].trim().split(' ');
      if (!toks.length) continue;
      var good = true, vals = [];
      for (var j = 0; j < toks.length; j++) {
        if (!INT.test(toks[j])) { good = false; break; }
        vals.push(num(toks[j]));
      }
      if (good && vals.length >= (minCount || 4)) return vals;
    }
    return null;
  }

  function firstMoney(lines, labelRe, within) {
    for (var i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      for (var j = i; j < lines.length && j <= i + (within || 2); j++) {
        var v = moneyTokens(lines[j]);
        if (v.length) return v[0];
      }
    }
    return NaN;
  }

  /* Integer rupee amounts (credit limits, cash limits) e.g. '₹5,00,000'. */
  function intAmountTokens(line) {
    var toks = String(line).split(' ');
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      var m = toks[i].match(/^[+\-]?\s*(?:₹|C|RS\.?|Rs\.?)?(\d[\d,]*)$/i);
      if (m && !/\./.test(m[1])) out.push(num(m[1]));
    }
    return out;
  }

  function firstAfter(lines, labelRe, pickReg) {
    for (var i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      for (var j = i + 1; j < lines.length && j <= i + 2; j++) {
        var m = lines[j].match(pickReg);
        if (m) return m[1] || m[0];
      }
    }
    return '';
  }

  /* '18 Nov, 2025' or '18/11/2025' -> '18/11/2025' */
  function normDate(s) {
    var m = String(s || '').match(/(\d{1,2})[\/\s]+(\d{1,2})[\/\s,]+(\d{4})/);
    if (m && m[2] <= 12 && m[1] <= 31) return pad(m[1]) + '/' + pad(m[2]) + '/' + m[3];
    var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    var d = String(s || '').match(/(\d{1,2})\s*([A-Za-z]+)[,\s]+(\d{4})/);
    if (d && MON[d[2].toLowerCase()]) return pad(+d[1]) + '/' + pad(MON[d[2].toLowerCase()]) + '/' + d[3];
    return '';
  }

  function pad(x) { return String(x).length === 1 ? '0' + x : String(x); }

  function groupLines(textContent) {
    var map = {};
    var items = (textContent && textContent.items) || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.str || !it.str.trim()) continue;
      var x = it.transform ? it.transform[4] : 0;
      var y = Math.round((it.transform ? it.transform[5] : 0) * 2) / 2;
      if (!map[y]) map[y] = [];
      map[y].push({ x: x, str: it.str, w: it.width || 0 });
    }
    var ys = Object.keys(map).map(Number).sort(function (a, b) { return b - a; });
    var lines = [];
    for (var j = 0; j < ys.length; j++) {
      var parts = map[ys[j]];
      parts.sort(function (a, b) { return a.x - b.x; });
      var s = '';
      for (var k = 0; k < parts.length; k++) {
        if (k > 0 && (parts[k].x - (parts[k - 1].x + (parts[k - 1].w || parts[k - 1].str.length * 3))) > 0.6) s += ' ';
        s += parts[k].str;
      }
      if (s.trim()) lines.push(s);
    }
    return lines;
  }

  function extractText(textContent) {
    var items = (textContent && textContent.items) || [];
    var s = '';
    for (var i = 0; i < items.length; i++) if (items[i].str) s += items[i].str + ' ';
    return s;
  }

  function isStatement(text) { return /Statement for HDFC Bank Credit Card|TOTAL AMOUNT DUE|MINIMUM DUE/.test(text || ''); }
  function isNewLayout(text) {
    return /TOTAL AMOUNT DUE/.test(text || '') && /MINIMUM DUE/.test(text || '');
  }

  /* ---- transaction lines ---- */

  function parseTxnLine(line) {
    var m = line.match(/^(\d{2}\/\d{2}\/\d{4})\s*\|?\s*(\d{2}:\d{2}(?::\d{2})?)\s+(.+)$/);
    if (!m) {
      /* some statements print the date only (multi-line rows) — skip for now */
      return null;
    }
    var date = m[1], time = m[2];
    var rest = m[3];
    var toks = rest.trim().split(' ');
    var credit = false;
    var amount = NaN, base = 0;
    var i = toks.length - 1;
    if (i >= 0 && /^Cr$/i.test(toks[i])) { credit = true; i--; }
    for (; i >= 0; i--) {
      var t = toks[i];
      if (CUR.test(t)) continue;
      if (/^[+\-]$/.test(t)) { credit = true; continue; }
      var mm = t.match(/^([+\-]?[\d,]+\.\d{1,2})Cr?$/i);
      if (mm) { amount = num(mm[1]); i--; break; }
      if (/^[+\-]?[\d,]+\.\d{1,2}$/.test(t)) { amount = num(t); i--; break; }
      break;
    }
    for (; i >= 0; i--) {
      var t2 = toks[i];
      if (CUR.test(t2) || /^Cr$/i.test(t2)) continue;
      if (/^\+?\d{1,5}$/.test(t2) && num(t2) <= 99999 && amount !== 0) { base = parseInt(t2, 10); i--; continue; }
      break;
    }
    var desc = toks.slice(0, i + 1).join(' ').replace(/\s+/g, ' ').trim();
    /* A trailing sign + currency before the amount marks a credit
     * (waivers/refunds print e.g. 'PETRO SURCHARGE WAIVER + C 8.68'). */
    if (/[+\-]\s*C\s*[+\-]?\s*[\d,]+(?:\.\d{1,2})?\s*Cr?$/i.test(rest)) credit = true;
    desc = desc.replace(/\s*[+\-]\s*(?:C\b)?$/i, '').trim();
    if (/^BPPY/i.test(desc)) credit = true;
    if (!isFinite(amount)) return null;
    return { date: date, time: time, desc: desc || '', base: base, amount: round2(amount), credit: credit };
  }

  function round2(x) { return Math.round((x + 1e-9) * 100) / 100; }

  function parseTransactions(lines) {
    var txns = [];
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^(\d{2}\/\d{2}\/\d{4})\s*\|?\s*(\d{2}:\d{2})/);
      if (!m) continue;
      var t = parseTxnLine(lines[i]);
      if (t) txns.push(t);
    }
    return txns;
  }

  /* ---- bonus NeuCoins program list ---- */
  function parseBonusPrograms(lines) {
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/Bonus NeuCoins Summary/i.test(lines[i])) { start = i; break; }
    }
    var out = [];
    var total = NaN, sum = 0;
    for (var j = start + 1; j < lines.length && j < start + 60; j++) {
      var m = lines[j].match(/^\s*(\d+)\s+(.+?)\s+([+\-]?[\d,]+)\s*$/);
      if (!m) continue;
      var prog = m[2].trim();
      var coins = num(m[3]);
      if (/^total$/i.test(prog)) { total = coins; continue; }
      out.push({ program: prog, coins: coins });
      sum += coins;
    }
    if (!isFinite(total)) total = sum;
    return { programs: out, total: isFinite(total) ? total : sum };
  }

  /* ---- account summary ----
   * Both layouts print <= 5 money values in the top summary block in this
   * column order (even the 'new' Tata Neu Infinity statements):
   *   previous-statement dues | payments/credits | purchases/debits | finance | total-due
   * Locked against real statements (see test harness). */
  function accountSummary(lines) {
    var v = pureMoneyRow(lines, 5);
    if (v) return { prevDues: v[0], payments: v[1], purchases: v[2], finance: v[3], total: v[4] };
    v = pureMoneyRow(lines, 4);
    if (v) return { prevDues: v[0], payments: v[1], purchases: v[2], finance: v[3], total: NaN };
    return null;
  }

  function dueRow(lines) {
    var label = /\bPayment Due Date\b.*\bMinimum Amount Due\b/i;
    for (var i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      for (var j = i; j < lines.length && j <= i + 2; j++) {
        var v = moneyTokens(lines[j]);
        if (v.length < 2) continue;
        var dt = lines[j].match(/(\d{2}\/\d{2}\/\d{4})/);
        return { dueDate: dt ? dt[1] : '', total: v[0], minimumDue: v[v.length - 1] };
      }
    }
    return null;
  }

  function creditLimit(lines) {
    function rowVals(j) {
      var v = moneyTokens(lines[j]);
      if (v.length >= 3) return v;
      var iv = intAmountTokens(lines[j]);
      if (iv.length >= 3) return iv;
      /* mixed rows like '₹5,00,000 ₹4,90,987.85 ₹2,00,000' / 'C12,40,000 C12,21,375 C4,96,000' */
      var all = [];
      String(lines[j] || '').replace(/(?:₹|C|Rs\.?|RS\.?)?[+\-]?[\d,]+(?:\.\d{1,2})?/gi, function (m) { all.push(num(m.replace(/[₹C]|rs\.?/gi, ''))); return m; });
      if (all.length >= 3) return all;
      return null;
    }
    /* header-style label lines only (never the sentence in the footer blurb),
     * with a wide window since the values print up to several rows later. */
    var head = /^\s*(?:TOTAL|AVAILABLE)\s+(?:CREDIT|CASH)\s*LIMIT|^\s*CREDIT\s*LIMIT/i;
    for (var i = 0; i < lines.length; i++) {
      if (!head.test(lines[i])) continue;
      for (var j = i; j < lines.length && j <= i + 8; j++) {
        var v = rowVals(j);
        if (v) return { limit: v[0], availLimit: v[1], availCash: v[2] };
      }
    }
    /* fallback: unanchored match close to the label (older layouts) */
    for (var k = 0; k < lines.length; k++) {
      if (!/CREDIT LIMIT/i.test(lines[k])) continue;
      for (var l = k; l < lines.length && l <= k + 1; l++) {
        var w = rowVals(l);
        if (w) return { limit: w[0], availLimit: w[1], availCash: w[2] };
      }
    }
    return null;
  }

  function coinsBlock(lines, layout) {
    var anchor = /NeuCoins Summary|NeuCoins with|NeuCoins Earned|Closing NeuCoins|Adjusted\/Lapsed/i;
    var v = pureIntRow(lines, anchor, 4);
    var o = {};
    if (v) {
      o.opening = v[0];
      o.earned = v[1];
      o.transferred = v[2];
      o.adjusted = v.length >= 4 ? v[3] : 0;
      o.closing = v.length >= 5 ? v[v.length - 1] : NaN;
    } else {
      o.opening = o.earned = o.transferred = o.adjusted = NaN;
    }
    if (layout === 'new') {
      /* printed 'Closing NeuCoins with Bank' value when present */
      for (var i = 0; i < lines.length; i++) {
        if (!/Closing\s+NeuCoins with Bank/i.test(lines[i])) continue;
        for (var j = i; j < lines.length && j <= i + 1; j++) {
          var m = lines[j].match(/[+\-]?[\d,]+(?:\.\d{1,2})?/g);
          if (m && m.length) { o.closing = num(m[m.length - 1]); break; }
        }
        break;
      }
    }
    /* The bank's 'NeuCoins with Bank' column always equals opening+earned-transferred-adjusted. */
    if (!isFinite(o.closing) && isFinite(o.opening) && isFinite(o.earned) && isFinite(o.transferred) && isFinite(o.adjusted)) {
      o.closing = o.opening + o.earned - o.transferred - o.adjusted;
    }
    return o;
  }

  /* ---- main ---- */
  function parseStatement(textContent) {
    var lines = groupLines(textContent);
    var text = lines.join('\n');
    if (/Statement for HDFC Bank Credit Card/i.test(text)) {
      var layout = isNewLayout(text) ? 'new' : 'old';
      if (layout === 'new') return parseNew(textContent, lines, text);
      return parseOld(textContent, lines, text);
    }
    if (isNewLayout(text)) return parseNew(textContent, lines, text);
    throw new Error('Not an HDFC Tata Neu credit card statement.');
  }

  function identity(lines) {
    var cardNo = '', aan = '', name = '';
    for (var i = 0; i < lines.length; i++) {
      if (!cardNo) {
        var m = lines[i].match(/\b(\d{4}\s\d{4}\sX{4}\s\d{4}|\d{4}\s\d{2}X{2}\sX{4}\s\d{4})\b/i);
        if (m) cardNo = m[1].replace(/\s/g, '');
      }
      var a = lines[i].match(/\b(\d{19})\b/);
      if (a && !aan) aan = a[1];
      var n = lines[i].match(/Card Member Since:\s*([A-Z][A-Z ]{3,})\s*\d{4}/);
      if (n && !name) name = n[1].trim().replace(/\s+/g, ' ');
    }
    return { cardNo: cardNo || '', aan: aan || '', name: name || '' };
  }

  function parseOld(textContent, lines, text) {
    var sum = accountSummary(lines);
    var due = dueRow(lines);
    var lim = creditLimit(lines);
    var coins = coinsBlock(lines, 'old');
    var bonus = parseBonusPrograms(lines);
    var st;
    var sd = (text.match(/Statement\s*Date:?\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1] || '';
    if (!sum) {
      /* dropped rows / pauses: account summary split across lines */
      var label = -1;
      for (var i = 0; i < lines.length; i++) if (/Balance\s+Credits\s+Debits\s+Charges\s+Total Dues/i.test(lines[i])) { label = i; break; }
      if (label >= 0) {
        var acc = 0;
        for (var j = 0; j < lines.length; j++) if (isPureMoneyLine(lines[j])) {
          var v = moneyTokens(lines[j]);
          if (v.length >= 4) { acc = v; break; }
        }
        if (acc) sum = { prevDues: acc[0], payments: acc[1], purchases: acc[2], finance: acc[3], total: acc.length >= 5 ? acc[4] : acc[3] };
      }
    }
    st = {
      layout: 'old', statementDate: sd, periodFrom: '', periodTo: sd,
      dueDate: (due && due.dueDate) || '', cardNo: identity(lines).cardNo, aan: identity(lines).aan, name: identity(lines).name,
      total: sum ? sum.total : NaN, minimumDue: (due && due.minimumDue) || NaN,
      prevDues: sum ? sum.prevDues : NaN, payments: sum ? sum.payments : NaN,
      purchases: sum ? sum.purchases : NaN, finance: sum ? sum.finance : NaN,
      creditLimit: lim ? lim.limit : NaN, availLimit: lim ? lim.availLimit : NaN, availCash: lim ? lim.availCash : NaN,
      openingNeuCoins: isFinite(coins.opening) ? coins.opening : NaN, earnedNeuCoins: isFinite(coins.earned) ? coins.earned : NaN,
      transferredNeuCoins: isFinite(coins.transferred) ? coins.transferred : NaN, adjustedNeuCoins: isFinite(coins.adjusted) ? coins.adjusted : NaN,
      closingNeuCoins: isFinite(coins.closing) ? coins.closing : NaN,
      bonusPrograms: bonus.programs, bonusTotal: bonus.total,
      txns: parseTransactions(lines)
    };
    return st;
  }

  function parseNew(textContent, lines, text) {
    var sum = accountSummary(lines);
    var lim = creditLimit(lines);
    var coins = coinsBlock(lines, 'new');
    var bonus = parseBonusPrograms(lines);
    var total = isFinite(sum && sum.total) ? sum.total : firstMoney(lines, /TOTAL AMOUNT DUE/i, 3);
    var minDue = firstMoney(lines, /MINIMUM DUE/i, 2);
    var dueDate = normDate(firstAfter(lines, /DUE DATE/i, /(\d{1,2}\s+[A-Za-z]+\s*,?\s*\d{4})/));
    var stDate = normDate(firstAfter(lines, /Statement\s*Date/i, /(\d{1,2}\s+[A-Za-z]+\s*,?\s*\d{4}|\d{2}\/\d{2}\/\d{4})/));
    var period = '';
    var pFrom = '', pTo = '';
    for (var i = 0; i < lines.length; i++) {
      if (/Billing\s*Period|Statement\s*Period/i.test(lines[i])) {
        for (var j = i; j < lines.length && j <= i + 1; j++) {
          period = lines[j].replace(/^.*(?:Billing|Statement)\s*Period\s*[:.]?\s*/i, '');
          var ds = period.match(/\d{1,2}\s+[A-Za-z]+\s*,?\s*\d{4}/g);
          if (ds && ds.length >= 2) { pFrom = normDate(ds[0]); pTo = normDate(ds[ds.length - 1]); break; }
        }
      }
    }
    if (!pTo) pTo = stDate;
    if (!sum) {
      for (var k = 0; k < lines.length; k++) if (/PREVIOUS STATEMENT DUES/i.test(lines[k])) {
        var v = [];
        for (var j2 = k; j2 < lines.length && j2 <= k + 2; j2++) v = v.concat(moneyTokens(lines[j2]));
        var vals = [];
        for (var q = 0; q < v.length; q++) if (!vals.length || vals[vals.length - 1] !== v[q]) vals.push(v[q]);
        if (vals.length >= 4) sum = { prevDues: vals[0], payments: vals[1], purchases: vals[2], finance: vals[3] };
        break;
      }
    }
    return {
      layout: 'new', statementDate: stDate, periodFrom: pFrom, periodTo: pTo,
      dueDate: dueDate, cardNo: identity(lines).cardNo, aan: identity(lines).aan, name: identity(lines).name,
      total: total, minimumDue: minDue,
      prevDues: sum ? sum.prevDues : NaN, payments: sum ? sum.payments : NaN,
      purchases: sum ? sum.purchases : NaN, finance: sum ? sum.finance : NaN,
      creditLimit: lim ? lim.limit : NaN, availLimit: lim ? lim.availLimit : NaN, availCash: lim ? lim.availCash : NaN,
      openingNeuCoins: isFinite(coins.opening) ? coins.opening : NaN, earnedNeuCoins: isFinite(coins.earned) ? coins.earned : NaN,
      transferredNeuCoins: isFinite(coins.transferred) ? coins.transferred : NaN, adjustedNeuCoins: isFinite(coins.adjusted) ? coins.adjusted : NaN,
      closingNeuCoins: isFinite(coins.closing) ? coins.closing : NaN,
      bonusPrograms: bonus.programs, bonusTotal: bonus.total,
      txns: parseTransactions(lines)
    };
  }

  return {
    groupLines: groupLines,
    extractText: extractText,
    parseStatement: parseStatement,
    isStatement: isStatement,
    isNewLayout: isNewLayout,
    parseTxnLine: parseTxnLine,
    normDate: normDate,
    pureMoneyRow: pureMoneyRow
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Parser; else window.Parser = Parser;