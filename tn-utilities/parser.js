/* TN Utilities - layout-aware PDF text extractor + field parsers.
 * Works in browser (pdf.js) and in Node (dev harness).
 * Layouts:
 *   L1 - old Firefox-print bill (2021-02 .. 2024-08), label-above-value
 *   L2 - portal invoice (2024-10 .. now), 2-column flowing form
 *   R  - Tamil receipt (TANGEDCO PORTAL / MOBILE APP / BHARAT BILL PAY)
 */

const Parser = (function () {
  'use strict';

  var D = /\d/;

  function digitOnly(s) {
    return String(s == null ? '' : s).replace(/\D/g, '');
  }

  function num(v) {
    if (v == null) return NaN;
    var s = String(v).replace(/,/g, '').replace(/\/-?/g, '').trim();
    if (!/^[+\-]?\d+(\.\d+)?$/.test(s)) return NaN;
    return parseFloat(s);
  }

  function absNum(v) {
    var n = num(v);
    return isFinite(n) ? Math.abs(n) : n;
  }

  /* Group pdf.js textContent items into visual lines (top to bottom). */
  function groupLines(textContent) {
    var map = {};
    var items = textContent.items || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.str || !it.str.trim()) continue;
      var x = it.transform[4];
      var y = Math.round(it.transform[5] * 2) / 2;
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

  function collapse(lines) {
    return lines.join('\n');
  }

  /* Find label in the line list; capture value with valueRe from the label
   * line or the following `window` lines. */
  function capture(lines, labelRe, valueRe, window) {
    window = window == null ? 3 : window;
    for (var i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      for (var j = i; j < Math.min(lines.length, i + 1 + window); j++) {
        var m = lines[j].match(valueRe);
        if (m) return { value: m[1] != null ? m[1] : m[0], from: i, at: j };
      }
      break;
    }
    return null;
  }

  /* Consumer-name heuristics. Bills have no fixed column for the name, so we
   * look for the first "person-name looking" ALL-CAPS line (e.g. "J.SMITH")
   * while skipping header vocabulary and address tokens. */
  var NAME_RE = /^[A-Z][A-Z .'\-]{3,}$/;
  var NON_NAME =
    /ROAD|STREET|ST\b|NAGAR|NGR|LANE|CORPORATION|LIMITED|GENERATION|DISTRIBUTION|REGISTERED|OFFICE|TARIFF|SANCTIONED|LOAD|METER|SUPPLY|TYPE|INVOICE|SECTION|CIRCLE|PHASE|SOLAR|REVERSE|CHARGE|STATE|CODE|CONSUMER|GST|BILLING|CYCLE|BILL|PAYMENT|AMOUNT|DATE|PREVIOUS|TOTAL|DUE|FAMIL|BOOK|ACCOUNT|INDEX|CONTRACTED|POWER|FACTOR|READ|DEMAND|STATIC|ELECTRONIC|RECORD|FIXED|SECURITY|DEPOSIT|PARTICULAR|ENERGY|PENAL|COMPENSATION|PLACE|MONTHLY|MANUFACTUR|PAYABLE|SUBSIDY|EXEMPT|ADJUST|KWH|KW\b|UNIT|GROSS|NET|NO\b|BILLING|PAY|INPUT|SLAB/i;

  function consumerNameOf(lines, maxLines) {
    maxLines = maxLines == null ? 40 : maxLines;
    for (var i = 0; i < Math.min(lines.length, maxLines); i++) {
      var t = (lines[i] || '').trim();
      if (!t || t.length > 40) continue;
      if (t.indexOf('.') >= 0 && /^[A-Z0-9.'\-]{3,}$/.test(t) && t.split('.').length > 2) continue;
      if (!NAME_RE.test(t)) continue;
      if (NON_NAME.test(t)) continue;
      return t;
    }
    return '';
  }

  /* L2 invoices carry the consumer as "Name/Address & GST of the Consumer"
   * followed by the name line(s); the raw first-line heuristic can otherwise
   * grab a shop/header name that appears earlier (e.g. a shop name above
   * consumer names). Anchor on that standard label instead. */
  function l2ConsumerName(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (!/Name\/Address\s*&\s*GST of the Consumer/i.test(lines[i])) continue;
      for (var j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        var t = (lines[j] || '').trim();
        if (!t) continue;
        if (/Consumer GST No|BILL\b|INVOICE|S\/C No\.?/i.test(t)) break;
        if (t.length > 60) continue;
        if (NAME_RE.test(t) && !NON_NAME.test(t)) return t.slice(0, 40);
      }
      break;
    }
    return '';
  }

  /* Receipts: first few lines carry "bga® : <NAME>" (Tamil) or
   * "Name : <NAME>" (English). */
  function receiptNameOf(lines) {
    for (var i = 0; i < Math.min(lines.length, 8); i++) {
      var m = lines[i].match(/(?:Name|name|bga\S*)\s*[:：]\s*([A-Z][A-Z .'\-]{3,})/);
      if (m) return m[1].trim().slice(0, 40);
    }
    return '';
  }

  var RE_DATE = /\d{2}\/\d{2}\/\d{4}/;
  var RE_NUM = /-?\d[\d,]*(?:\.\d+)?/;

  function firstNum(s) {
    var m = s.match(RE_NUM);
    return m ? num(m[0]) : NaN;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad2(n) { n = String(n); return n.length === 1 ? '0' + n : n; }
  /* Normalise any of `dd-MM-yyyy`, `d MMM yyyy`, `dd/MM/yyyy` → dd/MM/yyyy. */
  function toDMY(s) {
    s = String(s == null ? '' : s).trim();
    var m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (m) return pad2(m[1]) + '/' + pad2(m[2]) + '/' + m[3];
    m = s.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})/);
    if (m) {
      var idx = -1;
      for (var q = 0; q < MONTHS.length; q++) if (MONTHS[q].toLowerCase() === m[2].toLowerCase()) idx = q;
      if (idx >= 0) return pad2(m[1]) + '/' + pad2(idx + 1) + '/' + m[3];
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
    return s;
  }

  function isL2(lines) {
    var t = collapse(lines);
    return /Tax Invoice for LT|Net Payable Amt|Pay This Bill By Online/i.test(t);
  }

  function isReceipt(lines) {
    var t = collapse(lines);
    return /fHf«|fââ|uÓJ|t.v©|é»j¥?|BIHARAT|BHARAT PAYMENT|TANGEDCO (PAYMENT|MOBILE)/i.test(t) &&
      !/(S\/C No\.|Servi(?:e|ce) Connection Number)/i.test(t);
  }

  /* ------------------------------ Bills ------------------------------ */

  function parseL1(lines) {
    var text = collapse(lines);
    var b = { layout: 'L1' };

    b.scNo = digitOnly((text.match(/\b\d{11}\b/) || [])[0] || '');
    b.tariff = (text.match(/\bLA1A\b/) || text.match(/TARIFF[^\n]*\n([A-Z0-9]+)/) || [])[1] || (text.match(/\bLA\d[A-Z]?\b/i) || [])[0] || '';

    var pd = text.match(new RegExp('BI-MONTHLY/MONTHLY[\\s\\S]{0,80}?(' + RE_DATE.source + ')[\\s\\S]{0,40}?(' + RE_DATE.source + ')'));
    b.periodFrom = pd ? pd[1] : '';
    b.periodTo = pd ? pd[2] : '';

    var dd = text.match(new RegExp('BILL DATE[^\\n]*\\n[^\\n]*?(' + RE_DATE.source + ')[^\\n]*(' + RE_DATE.source + ')'));
    if (dd) { b.billDate = dd[1]; b.lastDate = dd[2]; }

    var readingRow = null;
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*\d{6,8}\s+\d+|^\s*\d{3,8}\/\d/.test(lines[i])) {
        var cand = lines[i];
        var nums = (cand.match(/-?\d+(?:\.\d+)?/g) || []);
        if (nums.length >= 4) { readingRow = cand; break; }
      }
    }
    if (readingRow) {
      var tokens = readingRow.trim().split(/\s+/);
      var vals = tokens.map(function (t) { return { raw: t, n: num(t.split('/')[0]) }; });
      var first = vals[0];
      var offset;
      if (/\//.test(first.raw)) { offset = 0; }
      else { b.meterNo = first.n; offset = 1; }
      b.prevReading = vals[offset] ? vals[offset].n : NaN;
      b.presentReading = vals[offset + 1] ? vals[offset + 1].n : NaN;
      b.mf = vals[offset + 2] && isFinite(vals[offset + 2].n) ? vals[offset + 2].n : 1;
      var tail = vals.slice(offset + 3).filter(function (v) { return isFinite(v.n); });
      if (tail.length) b.units = tail[tail.length - 1].n;
    }

    var cap = function (label, valueRe, win) {
      var c = capture(lines, label, valueRe, win);
      return c ? c.value : null;
    };
    b.energyCharges = absNum(cap(/ENERGY CHARGES/, /ENERGY CHARGES\s+([\d,.]+)/, 1));
    b.fixedCharges = absNum(cap(/FIXED CHARGES FOR CONTR\.LOAD\s/, /FIXED CHARGES FOR CONTR\.LOAD\s+([\d,.]+)/, 1));
    b.govtSubsidy = absNum(cap(/GOVERNMENT SUBSIDY AMOUNT/, /GOVERNMENT SUBSIDY AMOUNT \([-\w]+\)\s+([\d,.]+)/, 1));
    b.netTotal = absNum(cap(/NET CURRENT BILL/, /NET CURRENT BILL\s+([\d,.]+)/, 1));
    b.totalPayable = absNum(cap(/TOTAL AMOUNT PAYABLE/, /TOTAL AMOUNT PAYABLE\s+([\d,.]+)/, 1));
    if (isNaN(b.govtSubsidy)) b.govtSubsidy = 0;

    return b;
  }

  function parseL2(lines) {
    var text = collapse(lines);
    var b = { layout: 'L2' };

    b.scNo = digitOnly((text.match(/Servi(?:e|ce) Connection Number[\s\S]{0,140}?([\d\-]{11,})/) || [])[1] || '');
    b.tariff = (text.match(/Tariff Applied[\s\S]*?(\bLA\d[A-Z0-9]*\b)/i) || text.match(/\bLA\d[A-Z]?\b/i) || [])[1] || '';

    var inv = text.match(/Invoice No:\s*(\S+)\s*\/ Date:\s*(\d{2}\/\d{2}\/\d{4})/);
    if (inv) { b.invoiceNo = inv[1]; b.invoiceDate = inv[2]; }

    var bi = -1;
    for (var k = 0; k < lines.length; k++) if (/Bill\s*Period/.test(lines[k])) { bi = k; break; }
    if (bi >= 0) {
      var after = [], stop = false;
      for (var k2 = bi + 1; k2 < Math.min(lines.length, bi + 6) && !stop; k2++) {
        if (/Due\s*Date|Bill\s*Amount/.test(lines[k2])) { stop = true; break; }
        var ds = lines[k2].match(/\d{2}\/\d{2}\/\d{4}/g);
        if (!ds) { if (after.length) stop = true; continue; }
        after = after.concat(ds);
      }
      if (after.length >= 2) {
        b.periodFrom = after[0]; b.periodTo = after[1];
      } else if (after.length === 1) {
        b.periodTo = after[0];
        for (var k3 = bi - 1; k3 >= Math.max(0, bi - 6); k3--) {
          var ds3 = lines[k3].match(/\d{2}\/\d{2}\/\d{4}/g);
          if (ds3 && ds3.length) { b.periodFrom = ds3[ds3.length - 1]; break; }
        }
      }
    }
    b.billDate = b.periodTo || (inv ? inv[2] : '');

    var amt = text.match(/Bill Amount\s*\n?\s*Rs\.?([\d,]+)\/|\nRs\.([\d,]+)\/\s*\n/);
    b.billAmount = num(amt ? (amt[1] || amt[2]) : null);

    var due = text.match(/(\d{2}\/\d{2}\/\d{4})\s*\n\s*Due Date/);
    b.dueDate = due ? due[1] : '';

    var rd = text.match(/READING\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)/);
    if (rd) {
      b.presentReading = num(rd[1]);
      b.prevReading = num(rd[2]);
      b.mf = num(rd[3]);
      b.units = num(rd[4]);
    }

    var ec = text.match(/Energy Charges\s+\d+\s+\d+\s+(-?[\d,.]+)/);
    b.energyCharges = absNum(ec ? ec[1] : null);
    var fc = text.match(/Fixed Charges\s+\d+\s+\d+\s+(-?[\d,.]+)/);
    b.fixedCharges = fc ? absNum(fc[1]) : 0;
    var gs = text.match(/Govt Subsidy\s+\d+\s+\d+\s+(-?[\d,.]+)/);
    b.govtSubsidy = gs ? absNum(gs[1]) : 0;

    var np = text.match(/Net Payable Amt[\s\S]{0,80}?([\d,]+\.\d{2})/);
    b.netTotal = b.totalPayable = np ? num(np[1]) : NaN;
    if (!isFinite(b.netTotal)) b.netTotal = b.totalPayable = b.billAmount || NaN;

    var mo = text.match(/Month of ([\w ]+)/);
    b.billMonth = mo ? mo[1].trim() : '';
    return b;
  }

  /* ---------------------------- Receipts ---------------------------- */

  function parseReceipt(lines) {
    var text = collapse(lines);
    var r = { layout: 'receipt_tamil' };
    var m;

    m = text.match(/bga®\s*:\s*([A-Z][A-Z0-9 .]+)/);
    r.consumerName = m ? m[1].trim() : receiptNameOf(lines);
    r.name = r.consumerName;

    m = text.match(/ä‹\.\s*Ï\.\s*v©\s*:\s*(\d{11})/);
    if (!m) m = text.match(/\b(\d{11})\b/);
    r.scNo = m ? m[1] : '';

    m = text.match(/ÏuÓJ\s*v©\s*:\s*([A-Za-z0-9]+)/);
    if (!m) m = text.match(/\b(PG[A-Z0-9]{4,})\b/);
    r.receiptNo = m ? m[1] : '';

    m = text.match(/ehŸ\s*:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      r.paidDate = m[1] + '/' + m[2] + '/' + m[3];
      r.paidTime = m[4] + ':' + m[5] + ':' + m[6];
    } else {
      m = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
      if (m) { r.paidDate = m[1]; r.paidTime = m[2]; }
    }

    m = text.match(/f£lz Kiw\s*:\s*([A-Za-z0-9 ]+)/);
    r.portal = m ? m[1].replace(/\s+/g, ' ').trim() : '';

    m = text.match(/\bCC Charges\s+([\d,.]+)/);
    r.amount = m ? num(m[1]) : NaN;
    m = text.match(/bkh¤j«\s+([\d,.]+)/);
    if (m) r.amountTotal = num(m[1]);
    if (!isFinite(r.amount)) r.amount = r.amountTotal || NaN;
    if (!isFinite(r.amount)) {
      var as = text.match(/([\d,]+\.\d{2})/g) || [];
      r.amount = num(as[as.length - 1]);
    }

    var wm = text.match(/(?:only|only\.)/i) ? text.match(/([A-Z][A-Za-z ]+) only\s*$/m) : null;
    r.amountWords = wm ? wm[1].trim() : '';

    var payM = text.match(/Are|paid|PAID/);
    r.okMark = !!payM;
    return r;
  }

  /* ------------------- Water receipts (CMWSSB) --------------------
   * L3: modern "Water Tax & Charges e-Receipt" (2022+, ₹ figures, two-column
   *     flowing form; CMC No + Receipt No + items + Grand Total).
   * L4: legacy "eReceipt" (2012–2021, "Receipt No. … Customer No." header +
   *     "Annual value" + Period/Tax/Charges grid, no ₹ symbol). */
  function isWater(lines) {
    var t = collapse(lines);
    return /(CMWSSB|Chennai Metropol|litan Water|Water Tax & Charges|Water & Sewer|CMC No\.|Customer No\.|Annual value\b)/i.test(t) &&
      !isPT(lines);
  }

  function nameFromClassicHeader(lines, dataIndex) {
    for (var i = dataIndex + 1; i < Math.min(lines.length, dataIndex + 4); i++) {
      var t = (lines[i] || '').trim();
      if (!t || t.length > 40) continue;
      var m = /(?:Customer|Name)\s*&?\s*([A-Z][A-Z .'\-\u2019]{2,})$/.exec(t);
      if (m) return m[1].trim().slice(0, 40);
      if (NAME_RE.test(t) && !NON_NAME.test(t)) return t.slice(0, 40);
    }
    return '';
  }

  function parseWater(lines) {
    var text = collapse(lines);
    var w = { kind: 'water' };
    var classic = /Receipt No\. Reference No\. Date Customer No\./.test(text) || /Tax Amount\s+\d/.test(text);
    w.layout = classic ? 'cmwssb_classic' : 'cmwssb_eRcpt';
    var m, i;

    if (classic) {
      for (i = 0; i < lines.length; i++) {
        m = lines[i].match(/^(\d{7,})\s+(\d+)\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\S+)/);
        if (m) {
          w.receiptNo = m[1];
          w.customerNo = m[6];
          w.cmcNo = digitOnly(m[6]);
          w.paidDate = toDMY(m[3] + ' ' + m[4] + ' ' + m[5]);
          w.consumerName = nameFromClassicHeader(lines, i);
          break;
        }
      }
      m = text.match(/Annual [Vv]alue\s+(\d[\d,]*)/);
      w.annualValue = m ? num(m[1]) : NaN;
      m = text.match(/Tax Amount\s+(\d[\d.,]*)/);
      w.tax = m ? num(m[1]) : NaN;
      var cm = text.match(/Category\s+(\S+)\s+Class\s+(\S+)/);
      if (cm) { w.category = cm[1]; w.cls = cm[2]; }
      var items = [];
      for (i = 0; i < lines.length; i++) {
        m = lines[i].match(/^(\d{6})(FI|TI|SI|WI|OI|AI|TC|CC|WC)\s+(.+)$/);
        if (m) {
          var nums = (m[3].match(/-?[\d,]+(?:\.\d+)?/g) || []).map(num);
          items.push({ term: m[1] + m[2], amount: nums.length ? nums[nums.length - 1] : NaN });
        }
      }
      w.items = items;
      m = null;
      for (i = 0; i < lines.length; i++) {
        m = /^Total\s+(-?\d[\d.,]*\s+)*-?\d[\d.,]*\s*$/.exec(lines[i] || '');
        if (m) break;
      }
      if (m) {
        var tn = (m[0].match(/-?[\d,]+(?:\.\d+)?/g) || []).map(num);
        var tl = tn.length ? tn[tn.length - 1] : NaN;
        w.grandTotal = tl;
        w.paidTotal = tl;
      }
      w.amount = isFinite(w.paidTotal) ? w.paidTotal : NaN;
      m = text.match(/Payment Type\s+([A-Za-z\/ ]+)/);
      w.mode = m ? m[1].replace(/\s+/g, ' ').trim() : '';
      return w;
    }

    /* modern layout */
    m = text.match(/CMC No\.\s*:\s*([0-9\s/]+)/);
    if (m) w.cmcNo = digitOnly(m[1]);
    else { m = text.match(/Bill No\.\s*:\s*([0-9\s/]+)/); w.cmcNo = m ? digitOnly(m[1]) : ''; }
    m = text.match(/Receipt No\.\s*:\s*([A-Za-z0-9/\-]+)/);
    w.receiptNo = m ? m[1] : '';
    m = text.match(/Name\s*:\s*([A-Z][A-Z .'\-\u2019]+?)\s+(?:Receipt|Address|Annual|Tax|Class|Category|Type|Mode|Mobile|Transaction|Status|Bill|Customer)\b/);
    if (!m) m = text.match(/Name\s*:\s*([A-Z][A-Z .'\-\u2019]{2,})/);
    w.consumerName = m ? m[1].trim().slice(0, 40) : '';
    m = text.match(/Receipt Date\s*:\s*(\d{2}\/\d{2}\/\d{4})/);
    w.paidDate = m ? m[1] : '';
    m = text.match(/Receipt Time\s*:\s*([0-9:]{4,}(?:\s*[AP]M)?)/);
    w.paidTime = m ? m[1] : '';
    m = text.match(/Receipt Amount\s*:\s*(?:₹\s*)?\s*([\d,]+(?:\.\d{1,2})?)/);
    w.receiptAmount = m ? num(m[1]) : NaN;
    m = text.match(/Annual Value\s*:\s*(?:₹\s*)?\s*([\d,]+)/);
    w.annualValue = m ? num(m[1]) : NaN;
    m = text.match(/Tax\s*:\s*(?:₹\s*)?\s*([\d,]+(?:\.\d{1,2})?)\s*\/\s*Half Year/);
    w.tax = m ? num(m[1]) : NaN;
    m = text.match(/Class\s*:\s*([^\n]+)/);
    w.cls = m ? m[1].trim() : '';
    m = text.match(/Category\s*:\s*([^\n]+)/);
    w.category = m ? m[1].trim() : '';
    m = text.match(/\bType\s*:\s*([A-Za-z ]+)/);
    w.type = m ? m[1].replace(/\s+/g, ' ').trim() : '';
    m = text.match(/Mode of Payment\s*:\s*([^\n]+)/);
    w.mode = m ? m[1].trim() : '';
    var items2 = [];
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(/^\s*\d+\s+((?:\d{2}-\d{2}\/)[A-Z0-9]+|[A-Z]\d)?\s+([\d₹,.\-\s]+)$/);
      if (m) {
        var nums2 = (m[2].match(/[\d,]+(?:\.\d{1,2})?/g) || []).map(num);
        if (nums2.length) items2.push({ term: m[1] || '', amount: nums2[nums2.length - 1] });
        continue;
      }
      m = lines[i].match(/^Advance Amount\s+(?:₹\s*)?([\d,]+(?:\.\d{1,2})?)/);
      if (m) items2.push({ term: 'advance', amount: num(m[1]) });
    }
    w.items = items2;
    m = null;
    for (i = 0; i < lines.length; i++) {
      m = /^Grand Total\s*:\s*.+$/.exec(lines[i] || '');
      if (m) break;
    }
    var tn2 = null;
    if (m) tn2 = m[0].match(/[\d,]+(?:\.\d{1,2})?/g);
    if (!tn2) {
      for (i = 0; i < lines.length; i++) {
        m = /^Total\s*:\s*.+$/.exec(lines[i] || '');
        if (m) break;
      }
      if (m) tn2 = m[0].match(/[\d,]+(?:\.\d{1,2})?/g);
    }
    if (tn2 && tn2.length) {
      var vl = tn2.map(num);
      w.paidTotal = vl[vl.length - 1];
      w.grandTotal = vl.length > 1 ? vl[0] : w.paidTotal;
    }
    w.amount = isFinite(w.paidTotal) ? w.paidTotal : (isFinite(w.receiptAmount) ? w.receiptAmount : NaN);
    return w;
  }

  /* ------------------- Property tax receipts (GCC) -------------------
   * "PROPERTY TAX RECEIPT": Receipt No (YY-YY/NNN/xxxxxxxx), Property Tax
   * Bill Number (old format / new format),
   * Head-of-A/C item rows (I/25-26 1019.00 …), Total. While the printable
   * date is `11-03-2024`, capture it as dd/MM/yyyy internally. */
  function isPT(lines) {
    var t = collapse(lines);
    return /(Greater Chennai Corporation|PROPERTY TAX RECEIPT|Property Tax Bill\s*\n?\s*Number|Property Tax New Bill Number|Head of A\/C)/i.test(t);
  }

  function parsePT(lines) {
    var text = collapse(lines);
    var p = { kind: 'pt', layout: 'gcc_rcpt' };
    var m;
    m = text.match(/Receipt No:\s*([A-Za-z0-9/\-]+)/);
    p.receiptNo = m ? m[1] : '';
    m = text.match(/Name:\s*([A-Z][A-Z .'\-\u2019]{2,})/);
    p.consumerName = m ? m[1].trim().slice(0, 40) : '';
    m = text.match(/\b(\d{2}-\d{3}-\d{5}-\d{3})\b/);
    if (!m) m = text.match(/Property Tax New Bill Number\s*:\s*([0-9\-]+)/);
    if (!m) m = text.match(/\b(\d{2}-\d{3}-\d{3,6})\b/);
    p.propertyNo = m ? m[1] : '';
    var tm = text.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (tm) { p.paidDate = tm[1] + '/' + tm[2] + '/' + tm[3]; p.paidTime = tm[4] + ':' + tm[5] + ':' + tm[6]; }
    var pd = text.match(/Payment Dated:\s*(\d{2})-(\d{2})-(\d{4})/);
    if (pd) { p.paidDate = pd[1] + '/' + pd[2] + '/' + pd[3]; }
    else {
      var cd = text.match(/Dated\s+(\d{2})-(\d{2})-(\d{4})/);
      if (cd) p.paidDate = cd[1] + '/' + cd[2] + '/' + cd[3];
    }
    m = text.match(/Total:\s*([\d,]+(?:\.\d{1,2})?)/);
    p.amount = m ? num(m[1]) : NaN;
    var items = [];
    for (var i = 0; i < lines.length; i++) {
      m = lines[i].match(/^([IV]+)\/(\d{2}-\d{2})\s+([\d,]+(?:\.\d{1,2})?)\s*$/);
      if (m) items.push({ term: m[1] + '/' + m[2], amount: num(m[3]) });
    }
    p.items = items;
    return p;
  }

  /* OCR text (scanned receipts) won't have the Tamil labels - same fallbacks
   * used by parseReceipt handle it. */

  /* ---------------------------- API ---------------------------- */

  function parseBill(lines) {
    var b;
    if (!lines || !lines.length) return null;
    if (isL2(lines)) b = parseL2(lines); else b = parseL1(lines);
    b.kind = 'bill';
    b.layoutVersion = 1;
    b.consumerName = (isL2(lines) ? l2ConsumerName(lines) : '') || consumerNameOf(lines);
    b.units = num(b.units);
    b.prevReading = num(b.prevReading);
    b.presentReading = num(b.presentReading);
    b.mf = num(b.mf) || 1;
    return b;
  }

  function parseAny(lines) {
    if (!lines || !lines.length) return null;
    if (isReceipt(lines)) return parseReceipt(lines);
    if (isPT(lines)) return parsePT(lines);
    if (isWater(lines)) return parseWater(lines);
    return parseBill(lines);
  }

  return {
    groupLines: groupLines,
    collapse: collapse,
    parseBill: parseBill,
    parseReceipt: parseReceipt,
    parseWater: parseWater,
    parsePT: parsePT,
    parseAny: parseAny,
    isReceipt: isReceipt,
    isWater: isWater,
    isPT: isPT,
    toDMY: toDMY,
    consumerNameOf: consumerNameOf,
    l2ConsumerName: l2ConsumerName,
    receiptNameOf: receiptNameOf,
    capture: capture,
    cleanDigits: digitOnly,
    num: num
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Parser; else window.Parser = Parser;