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

  /* items: [{x, y, str}] from pdf.js text content; name: file name (optional). */
  function parse(items, name) {
    var f = {
      account: '', holder: '', pan: '', amount: 0, days: 0, rate: 0,
      issueDate: '', maturityDate: '', maturityValue: 0, repayAc: '',
      format: '', complete: false, fromFile: []
    };
    var all = items.map(function (i) { return i.str; }).join('\n');

    if (/Confirmation of e-Fixed Deposit/i.test(all)) f.format = 'epos';
    else if (/CONFIRMATION OF DEPOSIT/i.test(all)) f.format = 'legacy';
    else f.format = 'unknown';

    var acc = all.match(/130910DP\d{8}/) || all.match(/130910SCSS\d{6}/) || all.match(/130910[A-Z]{2}\d{6,8}/);
    if (acc) f.account = acc[0];

    var cust = findLabel(items, /Customer Name/i);
    if (cust) {
      var h = valueBelow(cust, items);
      if (h && /^[A-Z][A-Z .]{2,}$/.test(h.str)) f.holder = h.str;
    }

    var amtLabel = findLabel(items, /Deposit Amount/i);
    if (amtLabel) {
      var a = valueBelow(amtLabel, items);
      if (a) f.amount = money(a.str) || 0;
    }

    var period = all.match(/for a period of\s+(\d{2,4})\s+Days/i) || all.match(/\b(\d{2,3})\s*days\b/i);
    if (period) f.days = +period[1];
    var rateM = all.match(/at the rate of\s+(\d{1,2}(?:\.\d+)?)\s*%/i) || all.match(/\b(\d{1,2}\.\d{2})\s*%\s*per\s+annum/i);
    if (rateM) f.rate = +rateM[1];

    ['Date of Issue', 'Date of Maturity', 'Maturity Value'].forEach(function (label) {
      var li = findLabel(items, new RegExp('^' + label.replace(/ /g, '\\s+') + '$', 'i'), 20);
      if (!li) return;
      var v = valueBelow(li, items);
      if (!v) return;
      if (/Date of Issue/i.test(label)) f.issueDate = isoFromMon(v.str) || '';
      else if (/Date of Maturity/i.test(label)) f.maturityDate = isoFromMon(v.str) || '';
      else f.maturityValue = money(v.str) || 0;
    });

    var rep = findLabel(items, /Repayment Account Number|Debit Account Number/i);
    if (rep) { var r = valueBelow(rep, items); if (r) f.repayAc = (r.str || '').replace(/\s/g, ''); }

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
        var p = Promise.resolve();
        for (var i = 1; i <= pdf.numPages; i++) p = p.then(function (acc) {
          return pdf.getPage(i).then(function (page) {
            return page.getTextContent().then(function (tc) {
              return acc.concat(fromTextContent(tc.items));
            });
          });
        }, []);
        p.then(function (items) { resolve(parse(items, name)); }, reject);
      }).catch(reject);
    });
  }

  return { parse: parse, parsePdf: parsePdf, fromTextContent: fromTextContent, isoFromMon: isoFromMon, money: money, parseFilename: parseFilename };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FdParse;
