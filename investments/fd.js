/* PNB FD slip PDF parser (browser, pdf.js based).
 * Works on text items {x, y, str} with spatial label->value association so
 * it is robust to pdf.js line-grouping differences. Handles the clean
 * "Confirmation of e-Fixed Deposit" format; older watermarked slips return
 * partial results for manual correction in the form. */
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

  /* items: [{x, y, str}] from pdf.js text content. */
  function parse(items) {
    var f = {
      account: '', holder: '', pan: '', amount: 0, days: 0, rate: 0,
      issueDate: '', maturityDate: '', maturityValue: 0, repayAc: '',
      format: '', complete: false
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

    var period = all.match(/for a period of\s+(\d{2,4})\s+Days/i);
    if (period) f.days = +period[1];
    var rateM = all.match(/at the rate of\s+(\d{1,2}(?:\.\d+)?)\s*%/i);
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

    f.complete = !!(f.account && f.amount && f.rate && f.issueDate && f.maturityDate);
    return f;
  }

  /* itemsFromTextContent: raw pdf.js textContent items -> [{x,y,str}] */
  function fromTextContent(items) {
    return (items || [])
      .filter(function (it) { return it.str && it.str.trim(); })
      .map(function (it) { return { x: it.transform[4], y: it.transform[5], str: it.str.trim() }; });
  }

  /* Load a File/Blob/ArrayBuffer with pdf.js and parse all pages. */
  function parsePdf(data, pdfjsLib) {
    return new Promise(function (resolve, reject) {
      if (!pdfjsLib) { reject(new Error('pdf.js not loaded')); return; }
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
        p.then(function (items) { resolve(parse(items)); }, reject);
      }).catch(reject);
    });
  }

  return { parse: parse, parsePdf: parsePdf, fromTextContent: fromTextContent, isoFromMon: isoFromMon, money: money };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FdParse;
