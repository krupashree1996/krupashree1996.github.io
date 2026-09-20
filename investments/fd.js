/* PNB FD slip PDF parser (browser, pdf.js based).
 * Works on text items {x, y, str} with spatial label->value association so
 * it is robust to pdf.js line-grouping differences. Handles the clean
 * "Confirmation of e-Fixed Deposit" format fully. Older "CONFIRMATION OF
 * DEPOSIT" slips use a proprietary font that garbles the text layer, so they
 * are recovered from the file name (Y_PNB_FD_<date>_<acc>_<maturity>.pdf),
 * the lakh-format amount figure, and a derived issue date — with whatever
 * remains prefilled for manual correction in the review form. */
var FdParse = (function () {
  function money(s) {
    if (s == null) return null;
    var m = String(s).replace(/[,\u00A0\u2009\u20B9\s]/g, '').match(/-?(\d+(?:\.\d+)?)/);
    return m ? +m[1] : null;
  }
  function isoFromMon(s) {
    var m = String(s).match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i);
    if (!m) return null;
    var mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(m[2].toUpperCase()) + 1;
    return m[3] + '-' + (mo < 10 ? '0' : '') + mo + '-' + String(+m[1]).padStart(2, '0');
  }

  /* Find the value item nearest-below a label item, within a vertical band. */
  function valueBelow(label, items) {
    var best = null, bestScore = Infinity;
    items.forEach(function (it) {
      if (it === label) return;
      var dy = label.y - it.y;
      if (dy < 2 || dy > 130) return;
      var dx = Math.abs(it.x - label.x);
      var score = dx + dy * 0.5;
      if (score < bestScore) { bestScore = score; best = it; }
    });
    return best;
  }

  function findLabel(items, re, maxLen) {
    for (var i = 0; i < items.length; i++) {
      var s = items[i].str;
      if (re.test(s) && (maxLen == null || s.length <= maxLen)) return items[i];
    }
    return null;
  }

  /* Value on the same line as the label (newer slips print "Label : value").
   * Takes the NEAREST item to the right — the value always directly follows
   * its label, so a neighbour's far-off header is never chosen. Callers still
   * validate the returned string (money / date / account) and fall back to
   * valueBelow for the older layout. */
  function valueOnLine(label, items) {
    var best = null, bestDx = Infinity;
    items.forEach(function (it) {
      if (it === label) return;
      if (Math.abs(label.y - it.y) > 8) return;
      if (it.x <= label.x + 5) return;
      var dx = it.x - label.x;
      if (dx < bestDx) { bestDx = dx; best = it; }
    });
    return best;
  }

  /* Newer e-Fixed Deposit slips use a table: a header row (Deposit Amount |
   * Tenure | Fixed Rate Interest | Date of Issue | Date Of Maturity | Maturity
   * Value) with the values on the row below. Reads that band. */
  function parseTable(items) {
    var ten = null, rateH = null;
    items.forEach(function (it) {
      if (/^Tenure$/i.test(it.str) && !ten) ten = it;
      if (/^Fixed Rate$/i.test(it.str) && !rateH) rateH = it;
    });
    if (!ten || !rateH) return null;
    var band = items.filter(function (it) {
      return it.y < ten.y - 5 && it.y > ten.y - 60 && it.y > rateH.y - 60;
    });
    /* Merge into x-adjacent cells (a value may span two lines, e.g. "15 Mar"
     * over "2022"); within a cell, top line first. */
    band.sort(function (a, b) { return a.x - b.x || b.y - a.y; });
    var cells = [], cur = null, cx = -1;
    band.forEach(function (it) {
      if (cur && it.x - cx < 20) cur.push(it);
      else { cur = [it]; cells.push(cur); }
      cx = it.x;
    });
    var row = cells.map(function (c) {
      c.sort(function (a, b) { return b.y - a.y; });
      return c.map(function (i) { return i.str; }).join(' ');
    }).join('  ');
    var out = { amount: 0, days: 0, rate: 0, issueDate: '', maturityDate: '', maturityValue: 0 };
    var amts = row.match(/₹\s*[\d,]+(?:\.\d{2})?/g) || [];
    if (amts.length) out.amount = money(amts[0]) || 0;
    if (amts.length > 1) out.maturityValue = money(amts[amts.length - 1]) || 0;
    var t = row.match(/(\d{2,4})\s*(Months?|Days?)/i);
    if (t) out.days = /month/i.test(t[2]) ? Math.round(+t[1] * 30) : +t[1];
    var r = row.match(/(\d{1,2}\.\d{1,4})\s*%/);
    if (r) out.rate = +r[1];
    var dates = [], dm = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/gi, m;
    while ((m = dm.exec(row))) dates.push(isoFromMon(m[0]));
    if (dates.length >= 2) { out.issueDate = dates[0]; out.maturityDate = dates[1]; }
    else if (dates.length === 1) out.maturityDate = dates[0];
    return (out.amount || out.days || out.rate || out.issueDate) ? out : null;
  }

  /* items: [{x, y, str}] from pdf.js text content; name: file name (optional). */
  function parse(items, name) {
    var f = {
      account: '', holder: '', pan: '', amount: 0, days: 0, rate: 0,
      issueDate: '', maturityDate: '', maturityValue: 0, repayAc: '',
      format: '', complete: false, fromFile: []
    };
    var all = items.map(function (i) { return i.str; }).join('\n');

    if (/Confirmation of e-Fixed Deposit/i.test(all) || /e-Fixed Deposit/i.test(all)) f.format = 'epos';
    else if (/CONFIRMATION OF DEPOSIT/i.test(all)) f.format = 'legacy';
    else f.format = 'unknown';

    var acc = all.match(/130910DP\d{8}/) || all.match(/130910SCSS\d{6}/) || all.match(/130910[A-Z]{2}\d{6,8}/);
    if (acc) f.account = acc[0];

    var cust = findLabel(items, /Customer Name|Consumer Name/i);
    if (cust) {
      var h = valueOnLine(cust, items) || valueBelow(cust, items);
      if (h && /^[A-Z](?:[A-Z ]+)$/.test(h.str.replace(/\s+/g, ' '))) f.holder = h.str;
    }

    /* Same-row value only when it looks like the field's value; otherwise the
     * value sits below the label (older format). */
    function pick(label, validate) {
      var v = valueOnLine(label, items);
      if (v && validate(v.str)) return v.str;
      v = valueBelow(label, items);
      if (v && validate(v.str)) return v.str;
      return null;
    }
    var isMoney = function (s) { return /[\d,]+(\.\d+)?/.test(s) && /\d/.test(s); };
    var isDate = function (s) { return /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i.test(s); };
    var isAcct = function (s) { return /^\d{9,}$/.test((s || '').replace(/\s/g, '')); };

    /* Newer table layout: read the header+value band first. */
    var tbl = parseTable(items);
    if (tbl) {
      f.amount = tbl.amount; f.days = tbl.days; f.rate = tbl.rate;
      f.issueDate = tbl.issueDate; f.maturityDate = tbl.maturityDate; f.maturityValue = tbl.maturityValue;
    }

    var amtLabel = findLabel(items, /Deposit Amount/i);
    if (amtLabel && !f.amount) {
      var a = pick(amtLabel, isMoney);
      if (a) f.amount = money(a) || 0;
    }

    var period = all.match(/for a period of\s+(\d{2,4})\s+Days/i) || all.match(/\b(\d{2,3})\s*days\b/i);
    if (period && !f.days) f.days = +period[1];
    var rateM = all.match(/at the rate of\s+(\d{1,2}(?:\.\d+)?)\s*%/i) || all.match(/\b(\d{1,2}\.\d{2})\s*%\s*per\s+annum/i);
    if (rateM && !f.rate) f.rate = +rateM[1];

    ['Date of Issue', 'Date of Maturity', 'Maturity Value'].forEach(function (label) {
      if (f.issueDate && f.maturityDate && f.maturityValue) return;
      var li = findLabel(items, new RegExp('^' + label.replace(/ /g, '\\s+') + '$', 'i'), 20);
      if (!li) return;
      var s = /^Maturity Value/i.test(label) ? pick(li, isMoney) : pick(li, isDate);
      if (s == null) return;
      if (/Date of Issue/i.test(label) && !f.issueDate) f.issueDate = isoFromMon(s) || '';
      else if (/Date of Maturity/i.test(label) && !f.maturityDate) f.maturityDate = isoFromMon(s) || '';
      else if (/^Maturity Value/i.test(label) && !f.maturityValue) f.maturityValue = money(s) || 0;
    });

    var rep = findLabel(items, /Repayment Account Number|Debit Account Number/i);
    if (rep) {
      var r = pick(rep, isAcct);
      if (r) f.repayAc = r.replace(/\s/g, '');
    }

    var panM = all.match(/\b([A-Z]{5}\d{4}[A-Z])\b/);
    if (panM) f.pan = panM[1];

    /* Fill gaps from the file name (reliable even for font-garbled legacy slips). */
    var fn = parseFilename(name);
    if (fn) {
      if (!f.account && fn.account) { f.account = fn.account; f.fromFile.push('account'); }
      if (!f.maturityDate && fn.maturityDate) { f.maturityDate = fn.maturityDate; f.fromFile.push('maturity date'); }
      if (!f.maturityValue && fn.maturityValue) { f.maturityValue = fn.maturityValue; f.fromFile.push('maturity value'); }
    }

    /* Legacy slips: amount is often garbled; recover it from the lakh-format
     * figure if there is a single unambiguous candidate. */
    if (!f.amount && f.format !== 'epos') {
      var am = amountFromAll(all, f.maturityValue);
      if (am) { f.amount = am; f.fromFile.push('amount (from slip)'); }
    }

    /* Legacy slips hide the issue date; derive it from maturity minus term. */
    if (!f.issueDate && f.maturityDate && f.days) {
      try {
        var d = new Date(f.maturityDate + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - f.days);
        f.issueDate = d.toISOString().slice(0, 10);
        f.fromFile.push('issue date (derived)');
      } catch (e) {}
    }

    f.complete = !!(f.account && f.amount && f.rate && f.issueDate && f.maturityDate);
    return f;
  }

  /* itemsFromTextContent: raw pdf.js textContent items -> [{x,y,str}] */
  function fromTextContent(items) {
    return (items || [])
      .filter(function (it) { return it.str && it.str.trim(); })
      .map(function (it) { return { x: it.transform[4], y: it.transform[5], str: it.str.trim() }; });
  }

  /* Legacy slips print the amount in lakh format "4,00,000.00" (= 400,000.00;
   * last group is paise). Prefer a single unambiguous candidate. */
  function amountFromAll(all, maturityValue) {
    var re = /(\d{1,2})[.,](\d{2})[.,](\d{3})[.\-]?(\d{2})/g, m, c = [];
    while ((m = re.exec(all))) {
      // "4,00,000.00": group1*lakhs + group2*thousands + group3 + group4 paise
      c.push((+m[1]) * 100000 + (+m[2]) * 1000 + (+m[3]) + (+m[4]) / 100);
    }
    if (!c.length) return 0;
    var unique = [];
    c.forEach(function (v) { if (unique.indexOf(v) < 0) unique.push(v); });
    if (unique.length === 1) {
      // a lone figure matching the maturity value is the maturity, not the principal
      if (maturityValue && Math.abs(unique[0] - maturityValue) < 0.5) return 0;
      return unique[0];
    }
    if (unique.length === 2) {
      var a = unique[0], b = unique[1];
      var aEq = maturityValue && Math.abs(a - maturityValue) < 0.5;
      var bEq = maturityValue && Math.abs(b - maturityValue) < 0.5;
      if (aEq && !bEq) return b;
      if (bEq && !aEq) return a;
      if (aEq && bEq) return 0; // both are the maturity value; principal unreadable
      return Math.min(a, b);
    }
    return 0;
  }

  /* PNB names slips like Y_PNB_FD_<YYYYMMDD>_<accLast4>_<maturityValue>.pdf.
   * This reliably yields the maturity date, account suffix and maturity value
   * even when the slip's proprietary font garbles the text layer. */
  function parseFilename(name) {
    var out = { maturityDate: '', account: '', maturityValue: 0 };
    var m = String(name || '').match(/_([0-9]{8})_([0-9]{3,8})_([0-9]+)\.pdf$/i);
    if (!m) return null;
    out.maturityDate = m[1].slice(0, 4) + '-' + m[1].slice(4, 6) + '-' + m[1].slice(6, 8);
    out.account = '130910DP' + m[2];
    out.maturityValue = +m[3];
    return out;
  }

  /* Resolve the worker path relative to the main pdf.min.js script so it
   * works from any base path (localhost, /investments/, installed PWA). */
  function workerSrc() {
    try {
      var s = document.querySelector('script[src*="pdf.min.js"]');
      if (s && s.src) { var u = new URL(s.src); u.pathname = u.pathname.replace(/pdf\.min\.js$/, 'pdf.worker.min.js'); return u.href; }
    } catch (e) {}
    try { return new URL('vendor/pdf.worker.min.js', document.baseURI).href; }
    catch (e) { return 'vendor/pdf.worker.min.js'; }
  }

  /* Load a File/Blob/ArrayBuffer with pdf.js and parse all pages. */
  function parsePdf(data, pdfjsLib, name) {
    return new Promise(function (resolve, reject) {
      if (!pdfjsLib) { reject(new Error('pdf.js not loaded')); return; }
      if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc();
      }
      var task = pdfjsLib.getDocument({
        data: data,
        disableFontFace: true,
        isEvalSupported: false
      });
      task.promise.then(function (pdf) {
        var items = [];
        var p = Promise.resolve();
        for (var i = 1; i <= pdf.numPages; i++) {
          (function (pageIdx) {
            p = p.then(function () {
              return pdf.getPage(pageIdx).then(function (page) {
                return page.getTextContent().then(function (tc) {
                  items = items.concat(fromTextContent(tc.items));
                });
              });
            });
          })(i);
        }
        p.then(function () { resolve(parse(items, name)); }, reject);
      }).catch(reject);
    });
  }

  return { parse: parse, parsePdf: parsePdf, fromTextContent: fromTextContent, isoFromMon: isoFromMon, money: money, parseFilename: parseFilename };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FdParse;
