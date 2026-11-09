/* Mutual-fund CAS parser.
 *
 * Port of the CAMS/KFintech DETAILED parser from codereverser/casparser
 * (MIT License, https://github.com/codereverser/casparser). The geometry,
 * column anchors and header-region rules follow that implementation so the
 * output matches casparser's for the same statement. Runs on the vendored
 * pdf.js in the browser and in Node.
 */
var MfParse = (function () {
  'use strict';

  var Y_TOL = 1.5;
  var Y_OVERLAY_ROW_TOL = 3.0;
  var Y_OVERLAY_MIN_OFFSET = 0.05;
  var X_OVERLAY_MIN_FRAC = 0.5;

  var TXN_HEADER_LABELS = { Date: 1, Transaction: 1, Amount: 1, Units: 1, Price: 1, Unit: 1, Balance: 1, NAV: 1 };
  var TXN_MIN_HITS = 4;
  var ALIGN = { Date: 'left', Transaction: 'left', Amount: 'right', Units: 'right', Price: 'right', 'Unit Balance': 'right', NAV: 'right' };
  var HEADER_WINDOW_Y = 15.0;
  var NUMERIC_ZONE_WIDTH = 55.0;
  var CONTINUATION_MAX_GAP = 10.0;

  var FOLIO_LINE_RE = /Folio\s+No\s*:\s*(\d+(?:\s*\/\s*\d+)?)(?:.*?PAN\s*:\s*([A-Z]{5}\d{4}[A-Z]))?(?:.*?KYC\s*:\s*(OK|NOT OK))?(?:.*?PAN\s*:\s*(OK|NOT OK))?/i;
  var INLINE_ISIN_RE = /[-\s]*ISIN\s*:\s*([A-Z0-9]+)/i;
  var INLINE_ADVISOR_RE = /[-\s]*\(\s*Advisor\s*:\s*([^)]+?)\)/i;
  var SCHEME_HEAD_RTA_RE = /Registrar\s*:\s*(\S+)/i;
  var FULL_ISIN_RE = /^INF[0-9A-Z]{8}\d$/;
  var ISIN_ANYWHERE_RE = /\bINF[0-9A-Z]{8}\d\b/;
  var RTA_TOKEN_RE = /\b(CAMS|KFINTECH|KFIN|KARVY)\b/i;
  var OPEN_BAL_RE = /Opening\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
  var CLOSE_BAL_RE = /Closing\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
  var NAV_RE = /NAV\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
  var VALUATION_RE = /(?:Valuation|Market\s+Value)\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
  var COST_VALUE_RE = /Total\s+Cost\s+Value\s*:?\s*([\d,.]+)/i;
  var NOMINEE_RE = /Nominee\s+1\s*:\s*(?<n1>[^:]*?)\s*(?:Nominee\s+2\s*:\s*(?<n2>[^:]*?)\s*(?:Nominee\s+3\s*:\s*(?<n3>.*?))?)?$/i;
  var STMT_PERIOD_RE = /(\d{2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{2}-[A-Za-z]{3}-\d{4})/i;
  var AMC_RE = /^(.+?\s+(?:MF|Mutual\s*Fund|Fund\s*House|SIF))$/i;
  var DATE_CELL_RE = /^\s*(\d{1,2}[-\s]*[A-Za-z]{3}[-\s]*\d{4})/;

  var HEADER_MARKER_RE = /Registrar\s*:|Advisor\s*:|ISIN\s*:|Nominee\s+\d|\bARN-?\d+\b|\bINA\d+\b/i;
  var SCHEME_CODE_RE = /^\s*(?=[A-Z0-9 ]{0,40}[A-Z])[A-Z0-9]+(?: [A-Z0-9]+)*-\s*/i;
  var TRAILING_MARKER_RE = /(Registrar\s*:|Advisor\s*:|ISIN\s*:|\(\s*Advisor\s*:)\s*$/i;
  var NAME_EXCISE_ISIN_RE = /[-\s]*ISIN\s*:\s*INF[A-Z0-9]*/i;
  var NAME_TERMINATOR_RE = /\(\s*Advisor\s*:|Registrar\s*:?|Nominee\s+\d|\bARN-?\d+\b|\bINA\d+\b|\b(?:CAMS|KFINTECH|KFIN|KARVY)\b/i;
  var ADVISOR_CODE_RE = /\b(ARN-?\d+|INA\d+)\b/i;
  var HOLDER_NAME_CHARS_RE = /^[A-Z][A-Za-z .'&-]*$/;

  var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function isoDate(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }

  function parseDMonY(s) {
    var m = String(s || '').match(/(\d{1,2})[-\s]*([A-Za-z]{3})[-\s]*(\d{4})/);
    if (!m) return null;
    var mon = MON[m[2].toLowerCase()];
    if (!mon) return null;
    return isoDate(+m[3], mon, +m[1]);
  }

  function decimal(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (!s) return null;
    var neg = s.charAt(0) === '(' || s.charAt(0) === '-';
    s = s.replace(/^[(-]+/, '').replace(/[)]+$/, '').replace(/,/g, '');
    if (!s || !/^\d*\.?\d+$/.test(s)) return null;
    var d = parseFloat(s);
    return isNaN(d) ? null : (neg ? -d : d);
  }

  function money(s) { return decimal(String(s == null ? '' : s).replace(/[^\d.,()-]/g, '')); }

  function classify(desc, units) {
    var t = String(desc || '').toLowerCase();
    if (/reversal|reversed/.test(t)) return { type: 'REVERSAL', dividendRate: null };
    if (/stamp\s*duty/.test(t)) return { type: 'STAMP_DUTY_TAX', dividendRate: null };
    if (/\bstt\b|securities\s+transaction\s+tax/.test(t)) return { type: 'STT_TAX', dividendRate: null };
    if (/\btds\b|tax\s+deducted/.test(t)) return { type: 'TDS_TAX', dividendRate: null };
    if (/switch\s*[-/]?\s*in|switch\s+in/.test(t)) return { type: 'SWITCH_IN', dividendRate: null };
    if (/switch\s*[-/]?\s*out|switch\s+out/.test(t)) return { type: 'SWITCH_OUT', dividendRate: null };
    if (/gift.*\bin\b|\bin\b.*gift/.test(t)) return { type: 'GIFT_IN', dividendRate: null };
    if (/gift.*\bout\b|\bout\b.*gift/.test(t)) return { type: 'GIFT_OUT', dividendRate: null };
    if (/segregat/.test(t)) return { type: 'SEGREGATION', dividendRate: null };
    if (/redemption|redeem|\bsell\b|switch\s*out|payment/.test(t)) return { type: 'REDEMPTION', dividendRate: null };
    var div = /dividend|idcw|income\s+distribution/.test(t);
    if (div) {
      var rate = String(desc || '').match(/@\s*([\d.]+)/);
      var isReinvest = /reinvest/.test(t);
      return { type: isReinvest ? 'DIVIDEND_REINVEST' : 'DIVIDEND_PAYOUT', dividendRate: rate ? parseFloat(rate[1]) : null };
    }
    if (/purchase|subscription|allotment|sip|instal?ment/.test(t)) {
      return { type: /sip|instal?ment/.test(t) ? 'PURCHASE_SIP' : 'PURCHASE', dividendRate: null };
    }
    if (units != null && units < 0) return { type: 'REDEMPTION', dividendRate: null };
    if (units != null && units > 0) return { type: 'PURCHASE', dividendRate: null };
    return { type: 'MISC', dividendRate: null };
  }

  function collapse(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function cleanupHeaders(text) {
    var out = String(text);
    var rxs = [INLINE_ADVISOR_RE, NAME_EXCISE_ISIN_RE, NOMINEE_RE, FOLIO_LINE_RE, /PAN\s*:\s*[A-Z0-9]+/gi, /KYC\s*:\s*(?:OK|NOT OK)/gi, ADVISOR_CODE_RE];
    for (var i = 0; i < rxs.length; i++) out = out.replace(rxs[i], ' ');
    return out;
  }

  function parsedSchemeName(line) {
    var name = String(line)
      .replace(/\((?:formerly|erstwhile)[^)]*\)?/ig, '')
      .replace(/\((?:Non[\s-]?Demat|Demat).*/ig, '')
      .replace(/\s*\([^)]*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return name.replace(/[^a-zA-Z0-9_)]+$/, '').trim();
  }

  function isHeaderLine(text) { return HEADER_MARKER_RE.test(text) || RTA_TOKEN_RE.test(text) || SCHEME_CODE_RE.test(text); }

  function looksLikeHolderName(text) {
    var t = collapse(text);
    var words = t.split(' ');
    if (words.length < 2 || words.length > 8 || t.length > 80) return false;
    if (!HOLDER_NAME_CHARS_RE.test(t)) return false;
    for (var i = 0; i < words.length; i++) {
      if (!(words[i] === '&' || /^[A-Z]/.test(words[i]))) return false;
    }
    var hits = 0;
    for (var j = 0; j < words.length; j++) if (TXN_HEADER_LABELS[words[j]]) hits++;
    if (hits >= TXN_MIN_HITS) return false;
    return !isHeaderLine(t);
  }

  function expectsContinuation(text) {
    if (TRAILING_MARKER_RE.test(String(text).trim())) return true;
    var m = /\(\s*Advisor\s*:/i.exec(text);
    return !!m && text.slice(m.index + m[0].length).indexOf(')') < 0;
  }

  function findSchemeLine(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (!SCHEME_CODE_RE.test(lines[i])) continue;
      if (lines[i].split('-')[0].trim().toUpperCase() === 'ARN') continue;
      return i;
    }
    return null;
  }

  function headerMemberIndices(lines) {
    var out = [], forced = false;
    for (var i = 0; i < lines.length; i++) {
      if (forced || isHeaderLine(lines[i])) {
        out.push(i);
        forced = expectsContinuation(lines[i]);
      } else {
        forced = false;
      }
    }
    return out;
  }

  function regionCandidate(buf) {
    var lines = [];
    for (var i = 0; i < buf.length; i++) { var s = String(buf[i]).trim(); if (s) lines.push(s); }
    if (!lines.length) return null;
    var sIdx = findSchemeLine(lines);
    if (sIdx == null) return null;
    var members = headerMemberIndices(lines);
    var headerText = members.map(function (k) { return lines[k]; }).join(' ');
    if (headerText.indexOf('Registrar') < 0) return null;
    return { lines: lines, schemeIdx: sIdx, members: members, headerText: headerText };
  }

  function buildSchemeFromBuffer(buf, period) {
    var cand = regionCandidate(buf);
    if (!cand) return null;
    var lines = cand.lines, sIdx = cand.schemeIdx, members = cand.members, headerText = cand.headerText;
    var parts = lines[sIdx].split('-');
    var code = parts.shift().trim();
    var schemeRest = parts.join('-');
    var nameText = [schemeRest].concat(members.filter(function (k) { return k > sIdx; }).map(function (k) { return lines[k]; })).join(' ');
    nameText = nameText.replace(INLINE_ADVISOR_RE, '').replace(NAME_EXCISE_ISIN_RE, '');
    var cut = nameText.search(NAME_TERMINATOR_RE);
    var rawName = cut >= 0 ? nameText.slice(0, cut) : nameText;
    var name = parsedSchemeName(rawName) || parsedSchemeName(schemeRest);

    var isinM = INLINE_ISIN_RE.exec(headerText);
    var isin = isinM ? isinM[1].trim() : null;
    if (!isin || !FULL_ISIN_RE.test(isin)) {
      var any = ISIN_ANYWHERE_RE.exec(headerText);
      isin = any ? any[0] : null;
    }

    var advM = INLINE_ADVISOR_RE.exec(headerText);
    var advisor = advM ? advM[1].trim() : null;
    if (advisor) {
      var ac = ADVISOR_CODE_RE.exec(advisor);
      if (ac) advisor = ac[1];
    }

    var rtaM = RTA_TOKEN_RE.exec(headerText);
    var rta = rtaM ? rtaM[1].toUpperCase() : (function () {
      var lm = SCHEME_HEAD_RTA_RE.exec(headerText);
      return lm ? lm[1].trim() : 'CAMS';
    })();

    var nominees = [];
    for (var i = 0; i < lines.length; i++) {
      var nm = NOMINEE_RE.exec(lines[i]);
      if (nm && nm.groups) {
        nominees = [nm.groups.n1, nm.groups.n2, nm.groups.n3].map(function (s) { return collapse(s); }).filter(Boolean);
        break;
      }
    }

    return {
      scheme: name,
      advisor: advisor,
      rta: rta,
      rta_code: code,
      isin: isin,
      type: 'N/A',
      nominees: nominees,
      open: 0,
      close: 0,
      close_calculated: 0,
      valuation: { date: period ? period.to : null, nav: 0, value: 0, cost: null },
      transactions: []
    };
  }

  function abandonedWarning(buf, where) {
    var cand = regionCandidate(buf);
    if (!cand) return null;
    return 'scheme header region discarded at ' + where + " without an 'Opening Unit Balance' anchor; its scheme and transactions were skipped: " + JSON.stringify(cand.lines[cand.schemeIdx].slice(0, 80));
  }

  function continuationText(cells) {
    var filled = [];
    for (var k in cells) if (cells[k] && cells[k].trim()) filled.push(k);
    if (filled.length !== 1 || filled[0] !== 'Transaction') return null;
    return cells.Transaction.trim() || null;
  }

  function atomsFromItems(items) {
    var atoms = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var str = it.str == null ? it.text : it.str;
      if (!str) continue;
      var tr = it.transform;
      var x = tr ? tr[4] : (it.x || 0);
      var y = tr ? tr[5] : (it.y || 0);
      var a = tr ? tr[0] : 1;
      var b = tr ? tr[1] : 0;
      if (Math.abs(b) > Math.abs(a)) continue;
      var w = it.width != null ? it.width : (it.w || 0);
      var h = it.height != null ? it.height : (it.h != null ? it.h : 10);
      if (!(h > 0)) h = /\S/.test(str) ? 10 : 0;
      var chars = [];
      var len = str.length;
      for (var c = 0; c < len; c++) {
        var ch = str.charAt(c);
        if (ch === '\r' || ch === '\n' || ch === '\uFFFD') continue;
        chars.push({ text: ch, x0: x + (len ? w * c / len : 0), x1: x + (len ? w * (c + 1) / len : 0), y: y, h: h, font: it.fontName || '' });
      }
      if (chars.length) atoms.push({ x0: x, x1: x + w, y: y, h: h, font: it.fontName || '', chars: chars });
    }
    return atoms;
  }

  function dedupeOverlay(atoms) {
    var keep = [];
    for (var i = 0; i < atoms.length; i++) {
      var a = atoms[i], dup = false;
      for (var j = 0; j < keep.length; j++) {
        var k = keep[j];
        if ((a.font || '') !== (k.font || '')) continue;
        if (Math.abs(a.y - k.y) > Y_OVERLAY_ROW_TOL) continue;
        var narrower = Math.min(a.x1 - a.x0, k.x1 - k.x0);
        if (narrower <= 0) continue;
        var overlap = Math.max(0, Math.min(a.x1, k.x1) - Math.max(a.x0, k.x0));
        if (overlap / narrower < X_OVERLAY_MIN_FRAC) continue;
        var dy = Math.abs(a.y - k.y);
        if (dy >= Y_OVERLAY_MIN_OFFSET) { dup = true; break; }
      }
      if (!dup) keep.push(a);
    }
    return keep;
  }

  function clusterLines(atoms) {
    var chars = [];
    for (var i = 0; i < atoms.length; i++) chars = chars.concat(atoms[i].chars);
    chars.sort(function (p, q) { return (q.y - p.y) || (p.x0 - q.x0); });
    var lines = [];
    for (var c = 0; c < chars.length; c++) {
      var ch = chars[c];
      var ln = lines.length ? lines[lines.length - 1] : null;
      if (ln && Math.abs(ch.y - ln.baseline) <= Y_TOL) {
        ln.chars.push(ch);
        ln.baseline = (ln.baseline * (ln.chars.length - 1) + ch.y) / ln.chars.length;
      } else {
        lines.push({ baseline: ch.y, chars: [ch] });
      }
    }
    for (var l = 0; l < lines.length; l++) {
      lines[l].chars.sort(function (p, q) { return p.x0 - q.x0; });
      lines[l].text = lineText(lines[l]);
    }
    return lines;
  }

  function medianHeight(chars) {
    var hs = chars.map(function (c) { return c.h; }).sort(function (a, b) { return a - b; });
    return hs[Math.floor(hs.length / 2)] || 10;
  }

  function lineText(line) {
    var cs = line.chars;
    if (!cs.length) return '';
    var gap = Math.max(1.5, 0.6 * medianHeight(cs));
    var out = '', prev = null;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (prev != null && c.x0 - prev > gap) out += ' ';
      out += c.text;
      prev = c.x1;
    }
    return out;
  }

  function buildPages(itemsByPage) {
    return itemsByPage.map(function (items, idx) {
      var atoms = dedupeOverlay(atomsFromItems(items));
      return { number: idx + 1, lines: clusterLines(atoms), atoms: atoms };
    });
  }

  function wordsOnLine(line, minGap) {
    minGap = minGap == null ? 1.5 : minGap;
    var cs = line.chars.slice().sort(function (a, b) { return a.x0 - b.x0; });
    var words = [], cur = '', x0 = null, x1 = null;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (/\s/.test(c.text)) { if (cur) { words.push([cur, x0, x1]); cur = ''; } continue; }
      if (cur && c.x0 - x1 > minGap) { words.push([cur, x0, x1]); cur = ''; }
      if (!cur) x0 = c.x0;
      cur += c.text;
      x1 = c.x1;
    }
    if (cur) words.push([cur, x0, x1]);
    return words;
  }

  function buildColumns(words) {
    var cols = [];
    var hasBalance = words.some(function (w) { return w[0] === 'Balance'; });
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w[0] === 'Unit' && hasBalance) {
        for (var j = 0; j < words.length; j++) {
          var b = words[j];
          if (b[0] === 'Balance' && Math.abs((b[1] + b[2]) / 2 - (w[1] + w[2]) / 2) < 30) {
            cols.push({ label: 'Unit Balance', x_lo: Math.min(w[1], b[1]), x_hi: Math.max(w[2], b[2]), alignment: 'right' });
            break;
          }
        }
      } else if (ALIGN[w[0]] && w[0] !== 'Unit' && w[0] !== 'Balance') {
        cols.push({ label: w[0], x_lo: w[1], x_hi: w[2], alignment: ALIGN[w[0]] });
      }
    }
    cols.sort(function (a, b) { return a.x_lo - b.x_lo; });
    return cols;
  }

  function detectTxnColumns(lines, startIdx) {
    for (var i = startIdx; i < lines.length; i++) {
      var windowLines = [lines[i]];
      for (var j = i + 1; j < lines.length; j++) {
        if (lines[i].baseline - lines[j].baseline > HEADER_WINDOW_Y) break;
        windowLines.push(lines[j]);
      }
      var all = [];
      for (var k = 0; k < windowLines.length; k++) all = all.concat(wordsOnLine(windowLines[k]));
      var labels = {};
      for (var w = 0; w < all.length; w++) if (TXN_HEADER_LABELS[all[w][0]]) labels[all[w][0]] = 1;
      if (Object.keys(labels).length < TXN_MIN_HITS) continue;
      return { first: i, last: i + windowLines.length - 1, columns: buildColumns(all) };
    }
    return null;
  }

  function columnRanges(columns) {
    var sorted = columns.slice().sort(function (a, b) { return (a.x_lo + a.x_hi) / 2 - (b.x_lo + b.x_hi) / 2; });
    var ranges = [];
    for (var i = 0; i < sorted.length; i++) {
      var col = sorted[i], lo, hi;
      if (col.alignment === 'right') {
        lo = col.x_hi - NUMERIC_ZONE_WIDTH;
        hi = col.x_hi + 3.0;
      } else {
        lo = col.x_lo - 3.0;
        if (i + 1 < sorted.length) {
          var nxt = sorted[i + 1];
          hi = nxt.alignment === 'right' ? nxt.x_hi - NUMERIC_ZONE_WIDTH : nxt.x_lo - 3.0;
        } else {
          hi = Infinity;
        }
      }
      ranges.push({ col: col, lo: lo, hi: hi });
    }
    return ranges;
  }

  function assignCells(line, columns) {
    var ranges = columnRanges(columns), cells = {};
    for (var c = 0; c < columns.length; c++) cells[columns[c].label] = [];
    for (var i = 0; i < line.chars.length; i++) {
      var ch = line.chars[i];
      var mid = (ch.x0 + ch.x1) / 2;
      for (var r = 0; r < ranges.length; r++) {
        if (mid >= ranges[r].lo && mid < ranges[r].hi) { cells[ranges[r].col.label].push(ch); break; }
      }
    }
    var out = {};
    for (var label in cells) {
      var chars = cells[label];
      if (!chars.length) continue;
      chars.sort(function (a, b) { return a.x0 - b.x0; });
      var gap = Math.max(1.5, 0.6 * medianHeight(chars));
      var text = '', prev = null;
      for (var q = 0; q < chars.length; q++) {
        var cc = chars[q];
        if (prev != null && cc.x0 - prev > gap) text += ' ';
        text += cc.text;
        prev = cc.x1;
      }
      out[label] = text.trim();
    }
    return out;
  }

  function typeFromName(name) {
    var t = String(name || '').toUpperCase();
    if (/\b(REIT|REAL ESTATE|INVIT)\b/.test(t)) return 'REAL ESTATE';
    if (/\b(GOLD|SILVER|COMMODIT|METAL)\b/.test(t)) return 'COMMODITIES';
    if (/ARBITRAGE|BALANCED ADVANTAGE|EQUITY SAVINGS|AGGRESSIVE HYBRID|CONSERVATIVE HYBRID|HYBRID|MULTI ASSET|LIFE ?CYCLE|DYNAMIC ASSET|ASSET ALLOCATION/.test(t)) return 'HYBRID';
    if (/LIQUID|OVERNIGHT|MONEY MARKET|GILT|DEBT|BOND|DURATION|CREDIT RISK|BANKING (?:&|AND) PSU|ULTRA SHORT|TREASURY|SAVINGS FUND|FLOATING RATE|FIXED MATURITY/.test(t)) return 'DEBT';
    if (/INDEX|NIFTY|SENSEX|ELSS|TAX SAVER|EQUITY|VALUE FUND|CONTRA|FOCUSED|SMALL ?CAP|MID ?CAP|LARGE ?CAP|FLEXI ?CAP|MULTI ?CAP|DIVIDEND YIELD|SECTORAL|THEMATIC|PHARMA|BANKING|TECHNOLOGY|INFRA|CONSUMPTION|MANUFACTURING|ENERGY|POWER|PSU|DEFENCE|AUTO|FMCG|HEALTHCARE|BUSINESS CYCLE|HOUSING|TRANSPORT|LOGISTICS|MOBILITY|CHEMICAL|METALS|ESG|SHARIAH|QUANT|ALPHA/.test(t)) return 'EQUITY';
    return 'OTHER';
  }

  function subTypeFromName(name, invType) {
    var t = String(name || '').toUpperCase();
    if (invType === 'EQUITY') {
      if (/ELSS|TAX SAVER/.test(t)) return 'ELSS';
      if (/INDEX|NIFTY|SENSEX/.test(t)) return 'Index';
      if (/LARGE\s*(?:&|AND)\s*MID ?CAP/.test(t)) return 'Large & Mid Cap';
      if (/SMALL ?CAP/.test(t)) return 'Small Cap';
      if (/MID ?CAP/.test(t)) return 'Mid Cap';
      if (/LARGE ?CAP|BLUECHIP|BLUE CHIP/.test(t)) return 'Large Cap';
      if (/FLEXI ?CAP/.test(t)) return 'Flexi Cap';
      if (/MULTI ?CAP/.test(t)) return 'Multi Cap';
      if (/FOCUSED/.test(t)) return 'Focused';
      if (/DIVIDEND YIELD/.test(t)) return 'Dividend Yield';
      if (/VALUE/.test(t)) return 'Value';
      if (/CONTRA/.test(t)) return 'Contra';
      if (/SECTORAL|THEMATIC|PHARMA|BANKING|TECHNOLOGY|INFRA|CONSUMPTION|MANUFACTURING|ENERGY|POWER|PSU|DEFENCE|AUTO|FMCG|HEALTHCARE|BUSINESS CYCLE|HOUSING|TRANSPORT|LOGISTICS|MOBILITY|CHEMICAL|METALS|ESG|SHARIAH|QUANT|ALPHA/.test(t)) return 'Sectoral/Thematic';
      return 'Diversified';
    }
    if (invType === 'DEBT') {
      if (/OVERNIGHT/.test(t)) return 'Overnight';
      if (/LIQUID/.test(t)) return 'Liquid';
      if (/ULTRA SHORT/.test(t)) return 'Ultra Short';
      if (/LOW DURATION/.test(t)) return 'Low Duration';
      if (/SHORT DURATION/.test(t)) return 'Short Duration';
      if (/MEDIUM DURATION/.test(t)) return 'Medium Duration';
      if (/LONG DURATION/.test(t)) return 'Long Duration';
      if (/DYNAMIC BOND/.test(t)) return 'Dynamic Bond';
      if (/CORPORATE BOND/.test(t)) return 'Corporate Bond';
      if (/CREDIT RISK/.test(t)) return 'Credit Risk';
      if (/BANKING & PSU|BANKING AND PSU/.test(t)) return 'Banking & PSU';
      if (/GILT/.test(t)) return 'Gilt';
      return 'Debt';
    }
    if (invType === 'HYBRID') {
      if (/ARBITRAGE/.test(t)) return 'Arbitrage';
      if (/LIFE ?CYCLE/.test(t)) return 'Life Cycle';
      if (/BALANCED ADVANTAGE|DYNAMIC ASSET|ASSET ALLOCATION/.test(t)) return 'Balanced Advantage';
      if (/AGGRESSIVE/.test(t)) return 'Aggressive Hybrid';
      if (/CONSERVATIVE/.test(t)) return 'Conservative Hybrid';
      if (/MULTI ASSET/.test(t)) return 'Multi Asset';
      return 'Hybrid';
    }
    if (invType === 'COMMODITIES') return /SILVER/.test(t) ? 'Silver' : 'Gold';
    if (invType === 'REAL ESTATE') return /INVIT/.test(t) ? 'InvIT' : 'REIT';
    return 'Other';
  }

  function toRecords(cas) {
    var out = [];
    for (var f = 0; f < cas.folios.length; f++) {
      var folio = cas.folios[f];
      for (var s = 0; s < folio.schemes.length; s++) {
        var sc = folio.schemes[s];
        var val = sc.valuation || {};
        var invType = typeFromName(sc.scheme);
        var rec = {
          id: (sc.isin || sc.rta_code || sc.scheme) + '|' + folio.folio + '|' + sc.scheme,
          amc: folio.amc,
          folio: folio.folio,
          pan: folio.PAN || '',
          kyc: folio.KYC || '',
          holder: folio.name || folio.holder || '',
          nominees: sc.nominees || [],
          scheme: sc.scheme,
          isin: sc.isin || '',
          rtaCode: sc.rta_code || '',
          rta: sc.rta || '',
          advisor: sc.advisor || '',
          open: sc.open,
          close: sc.close,
          closeCalculated: sc.close_calculated,
          nav: val.nav != null ? val.nav : null,
          navDate: val.date || null,
          marketValue: val.value != null ? val.value : null,
          cost: val.cost != null ? val.cost : null,
          distribution: /IDCW|DIVIDEND|PAYOUT|REINVEST/i.test(sc.scheme) ? 'IDCW' : 'Growth',
          invType: invType,
          invSubType: subTypeFromName(sc.scheme, invType),
          transactions: (sc.transactions || []).map(function (t) {
            return {
              date: t.date,
              description: t.description,
              amount: t.amount,
              units: t.units,
              nav: t.nav,
              balance: t.balance,
              type: t.type,
              dividendRate: t.dividend_rate
            };
          }),
          warnings: []
        };
        rec.open = rec.open == null ? 0 : rec.open;
        rec.close = rec.close == null ? 0 : rec.close;
        out.push(rec);
      }
    }
    return out;
  }

  function parsePages(pages) {
    var statementPeriod = null;
    var folios = {};
    var order = [];
    var currentAmc = null, currentFolio = null, currentScheme = null;
    var lastColumns = [];
    var headerBuf = [], headerActive = false;
    var holderNameLinesLeft = 0;
    var warnings = [];

    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var detected = detectTxnColumns(page.lines, 0);
      var colFirst, headerIdx, columns;
      if (detected) {
        colFirst = detected.first; headerIdx = detected.last; columns = detected.columns; lastColumns = columns;
      } else {
        colFirst = -1; headerIdx = -1; columns = lastColumns;
      }

      var contIdx = -2, contBaseline = 0;

      for (var i = 0; i < page.lines.length; i++) {
        var line = page.lines[i];
        var text = line.text;

        if (!statementPeriod) {
          var sp = STMT_PERIOD_RE.exec(text);
          if (sp) statementPeriod = { from: parseDMonY(sp[1]), to: parseDMonY(sp[2]), raw: sp[0] };
        }

        var amc = AMC_RE.exec(text.trim());
        if (amc) {
          var ac = collapse(amc[0]);
          if (ac.split(' ').length <= 7 && !/ISIN|Advisor|Folio/i.test(ac)) {
            currentAmc = ac;
            if (headerActive) {
              var aw = abandonedWarning(headerBuf, 'AMC boundary');
              if (aw) warnings.push(aw);
            }
            headerBuf = []; headerActive = false; holderNameLinesLeft = 0;
            continue;
          }
        }

        if (text.indexOf('Folio No') >= 0 && !DATE_CELL_RE.test(text)) {
          var fm = FOLIO_LINE_RE.exec(text);
          if (fm) {
            var folioNo = collapse(fm[1]).replace(/\s*\/\s*/g, ' / ');
            var key = (currentAmc || 'UNKNOWN') + '\u0000' + folioNo;
            if (!folios[key]) {
              folios[key] = {
                folio: folioNo, amc: currentAmc || 'UNKNOWN',
                PAN: fm[2] || '', KYC: fm[3] || null, PANKYC: fm[4] || null,
                name: null, schemes: []
              };
              order.push(key);
            }
            currentFolio = folios[key];
            currentScheme = null;
            holderNameLinesLeft = currentFolio.name ? 0 : 2;
            if (headerActive) {
              var fw = abandonedWarning(headerBuf, 'folio boundary');
              if (fw) warnings.push(fw);
            }
            headerBuf = []; headerActive = true;
            continue;
          }
        }

        if (holderNameLinesLeft && currentFolio) {
          holderNameLinesLeft--;
          var stripped = text.trim();
          if (looksLikeHolderName(stripped)) {
            currentFolio.name = collapse(stripped);
            holderNameLinesLeft = 0;
          } else if (isHeaderLine(stripped) || OPEN_BAL_RE.test(stripped)) {
            holderNameLinesLeft = 0;
          }
        }

        var ob = OPEN_BAL_RE.exec(text);
        if (ob) {
          if (headerActive) {
            currentScheme = buildSchemeFromBuffer(headerBuf, statementPeriod);
            if (currentScheme) {
              if (currentFolio) currentFolio.schemes.push(currentScheme);
            } else {
              var region = headerBuf.map(function (s) { return String(s).trim(); }).filter(Boolean).slice(0, 2).join(' / ').slice(0, 120);
              warnings.push("unparseable scheme header region before 'Opening Unit Balance' on page " + page.number + '; the scheme and its transactions were skipped: ' + JSON.stringify(region));
            }
            headerActive = false; headerBuf = [];
          }
          if (currentScheme) {
            currentScheme.open = decimal(ob[1]) || 0;
            currentScheme.close_calculated = currentScheme.open;
          }
          continue;
        }

        var consumedFooter = false;
        if (currentScheme) {
          var cb = CLOSE_BAL_RE.exec(text);
          if (cb) {
            currentScheme.close = decimal(cb[1]) || 0;
            headerBuf = []; headerActive = true; consumedFooter = true;
          }
          var nv = NAV_RE.exec(text);
          if (nv) {
            currentScheme.valuation.date = parseDMonY(nv[1]);
            currentScheme.valuation.nav = decimal(nv[2]) || 0;
            consumedFooter = true;
          }
          var vv = VALUATION_RE.exec(text);
          if (vv) {
            currentScheme.valuation.date = parseDMonY(vv[1]);
            currentScheme.valuation.value = decimal(vv[2]) || 0;
            consumedFooter = true;
          }
          var cv = COST_VALUE_RE.exec(text);
          if (cv) {
            currentScheme.valuation.cost = decimal(cv[1]);
            consumedFooter = true;
          }
          if (!headerActive) {
            var nn = NOMINEE_RE.exec(text);
            if (nn && nn.groups) {
              currentScheme.nominees = [nn.groups.n1, nn.groups.n2, nn.groups.n3].map(function (s) { return collapse(s); }).filter(Boolean);
            }
          }
        }

        if (headerActive) {
          if (!consumedFooter && !(i >= colFirst && i <= headerIdx)) headerBuf.push(text);
          continue;
        }

        if (!currentScheme) continue;

        if (columns && columns.length && headerIdx != null && i > headerIdx) {
          var cells = assignCells(line, columns);
          var dateStr = (cells.Date || '').trim();
          var desc = (cells.Transaction || '').trim();
          var md = DATE_CELL_RE.exec(dateStr);
          if (!md) {
            if (i === contIdx + 1 && contBaseline - line.baseline <= CONTINUATION_MAX_GAP && currentScheme.transactions.length) {
              var tail = continuationText(cells);
              if (tail) {
                var tx = currentScheme.transactions[currentScheme.transactions.length - 1];
                tx.description = (tx.description + ' ' + tail).trim();
                var cl = classify(tx.description, tx.units);
                tx.type = cl.type;
                tx.dividend_rate = cl.dividendRate;
                contIdx = i; contBaseline = line.baseline;
              }
            }
            continue;
          }
          if (!desc) continue;
          dateStr = dateStr.replace(/[-\s]+/g, '-').replace(/^-|-$/g, '');
          var iso = parseDMonY(dateStr);
          if (!iso) continue;
          var amt = decimal(cells.Amount);
          var units = decimal(cells.Units);
          var nav = decimal(cells.Price) || decimal(cells.NAV);
          var bal = decimal(cells['Unit Balance']);
          if (amt == null && units == null && bal == null && desc.indexOf('***') !== 0) continue;
          if (nav == null && amt != null && units != null && units !== 0) nav = Math.round((amt / units) * 10000) / 10000;
          var cls = classify(desc, units);
          if (units != null) currentScheme.close_calculated += units;
          currentScheme.transactions.push({
            date: iso, description: desc, amount: amt, units: units,
            nav: nav, balance: bal, type: cls.type, dividend_rate: cls.dividendRate
          });
          contIdx = i; contBaseline = line.baseline;
        }
      }
    }

    if (headerActive) {
      var ew = abandonedWarning(headerBuf, 'end of document');
      if (ew) warnings.push(ew);
    }

    var folioList = order.map(function (k) { return folios[k]; });
    for (var fi = 0; fi < folioList.length; fi++) {
      for (var si = 0; si < folioList[fi].schemes.length; si++) {
        applyBalanceSignFix(folioList[fi].schemes[si]);
        warnings = warnings.concat(reconcileBalances(folioList[fi].schemes[si]));
      }
    }

    return {
      statement_period: statementPeriod || { from: null, to: null },
      folios: folioList,
      parse_warnings: warnings,
      cas_type: 'DETAILED'
    };
  }

  function applyBalanceSignFix(scheme) {
    var tol = 0.005;
    var prev = scheme.open == null ? 0 : scheme.open;
    for (var i = 0; i < scheme.transactions.length; i++) {
      var t = scheme.transactions[i];
      if (t.units == null || t.balance == null) continue;
      if (Math.abs((prev + t.units) - t.balance) <= tol) { prev = t.balance; continue; }
      if (Math.abs((prev - t.units) - t.balance) <= tol) {
        t.units = -t.units;
        if (t.amount != null) t.amount = -t.amount;
        var cl = classify(t.description, t.units);
        t.type = cl.type; t.dividend_rate = cl.dividendRate;
      }
      prev = t.balance;
    }
    var total = scheme.open == null ? 0 : scheme.open;
    for (var j = 0; j < scheme.transactions.length; j++) {
      if (scheme.transactions[j].units != null) total += scheme.transactions[j].units;
    }
    scheme.close_calculated = total;
  }

  function reconcileBalances(scheme) {
    var tol = 0.005, out = [];
    var label = JSON.stringify(scheme.scheme) + ' [' + (scheme.rta_code || '') + ']';
    var running = scheme.open == null ? 0 : scheme.open;
    for (var i = 0; i < scheme.transactions.length; i++) {
      var t = scheme.transactions[i];
      if (t.units != null) running += t.units;
      if (t.balance == null) continue;
      if (Math.abs(running - t.balance) > tol) {
        out.push(label + ': unit-balance discontinuity at ' + t.date + ' (' + t.type + ') — computed ' + running + ' but statement printed ' + t.balance + ' (Δ=' + (running - t.balance) + '); a transaction row may be missing or mis-parsed');
        running = t.balance;
      }
    }
    if (scheme.close != null && Math.abs(running - scheme.close) > tol) {
      out.push(label + ': closing unit balance mismatch — computed ' + running + ' but statement printed ' + scheme.close + ' (Δ=' + (running - scheme.close) + '); a transaction row may be missing or mis-parsed');
    }
    return out;
  }

  function workerSrc() {
    if (typeof document === 'undefined') return null;
    try {
      var s = document.querySelector('script[src*="pdf.min.js"]');
      if (s && s.src) {
        var u = new URL(s.src);
        u.pathname = u.pathname.replace(/pdf\.min\.js$/, 'pdf.worker.min.js');
        return u.href;
      }
    } catch (e) {}
    try { return new URL('vendor/pdf.worker.min.js', document.baseURI).href; }
    catch (e) { return null; }
  }

  function parsePdf(data, pdfjsLib, password) {
    if (ArrayBuffer.isView(data)) data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      var ws = workerSrc();
      if (ws) pdfjsLib.GlobalWorkerOptions.workerSrc = ws;
    }
    return pdfjsLib.getDocument({
      data: data,
      password: password,
      isEvalSupported: false
    }).promise.then(function (doc) {
      var tasks = [], pages = [];
      var chain = Promise.resolve();
      for (var p = 1; p <= doc.numPages; p++) {
        (function (pn) {
          chain = chain.then(function () {
            return doc.getPage(pn).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
              pages[pn - 1] = tc.items;
            });
          });
        })(p);
      }
      return chain.then(function () {
        var built = buildPages(pages);
        var cas = parsePages(built);
        cas.num_pages = doc.numPages;
        cas.file_type = detectFileType(pages);
        return cas;
      });
    });
  }

  function detectFileType(pages) {
    var s = '';
    for (var i = 0; i < Math.min(2, pages.length); i++) {
      s += pages[i].map(function (it) { return it.str || it.text || ''; }).join(' ');
    }
    if (/CAMSCASWS/i.test(s)) return 'CAMS';
    if (/KFINCASWS/i.test(s)) return 'KFINTECH';
    return 'UNKNOWN';
  }

  return {
    parsePdf: parsePdf,
    parsePages: parsePages,
    buildPages: buildPages,
    toRecords: toRecords,
    classify: classify,
    parseDMonY: parseDMonY,
    decimal: decimal,
    money: money,
    detectTxnColumns: detectTxnColumns,
    assignCells: assignCells,
    typeFromName: typeFromName,
    subTypeFromName: subTypeFromName,
    parsedSchemeName: parsedSchemeName
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MfParse;
