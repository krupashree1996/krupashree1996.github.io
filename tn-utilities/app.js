/* TN Utilities app v1 — TANGEDCO/CMWSSB/GCC utility bill & receipt tracking, fully offline */
(function () {
  'use strict';
  var App = {};
  var pdfjsLib = window.pdfjsLib;
  var Parser = window.Parser;
  var Calc = window.Calc;

  /* ---------- tiny DOM helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtMoney(x) { return Calc.fmtMoney(x); }
  function fmtNum(x) { return Calc.fmtNum(x); }
  function fmtDate(d) { return d || '—'; }
  function tsOf(d) { // dd/mm/yyyy -> ms
    var m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0;
  }
  function toast(msg, kind) {
    var t = el('div', 'toast ' + (kind || 'ok'));
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 3600);
  }
  function modal(node, open) {
    $('modalBox').replaceChildren();
    if (node) $('modalBox').appendChild(node);
    $('modal').classList.toggle('open', !!open);
    $('modal').setAttribute('aria-hidden', String(!open));
    if (open) {
      var f = $('modalBox').querySelector('button, input, select, [tabindex], a');
      if (f) f.focus();
    }
  }
  function closeModal() { $('modal').classList.remove('open'); }
  $('modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  function saveFile(name, text, mime) {
    var b = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function download(name, text, mime) { saveFile(name, text, mime || 'application/octet-stream'); }

  /* ---------- state ---------- */
  var STORE_KEY = 'eb.tracker.session';
  var DAY_MS = 86400000;
  var DATA = null;
  var importingData = false;
  var RATE_TABLES_VERSION = 2;
  var CUR_BELOW = [[1, 400, 4.95], [401, 500, 6.65]];
  var CUR_ABOVE = [[1, 400, 4.95], [401, 500, 6.65], [501, 600, 8.80], [601, 800, 9.95], [801, 1000, 11.05], [1001, null, 12.15]];
  var OLD_BELOW = [[1, 200, 0], [201, 400, 4.70], [401, 500, 6.30]];
  var OLD_ABOVE = [[1, 100, 0], [101, 400, 4.70], [401, 500, 6.30], [501, 600, 8.40], [601, 800, 9.45], [801, 1000, 10.50], [1001, null, 11.55]];
  function defaultData() {
    return {
      version: Calc.SCHEMA_VERSION,
      profile: { name: '', scNo: '', tariff: '' },
      cycle: 'Bi-monthly',
      since: '',
      consumers: [],
      rateTables: { below: CUR_BELOW, above: CUR_ABOVE },
      rateTablesVersion: RATE_TABLES_VERSION,
      docFolder: '',
      records: []
    };
  }
  function tablesEqualSel(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2]) return false;
    return true;
  }
  function tablesEqual(a, b) {
    return !!(a && b && tablesEqualSel(a.below, b.below) && tablesEqualSel(a.above, b.above));
  }
  /* Self-heal stale rate tables: previous app sessions saved the pre-Oct-2025
   * default tables under DATA / localStorage; detect them and offer the
   * current tariff once. 'custom' tables are left alone (and not re-prompted). */
  function ensureRateTables() {
    if (!DATA.rateTables) { DATA.rateTables = defaultData().rateTables; DATA.rateTablesVersion = RATE_TABLES_VERSION; return; }
    if (tablesEqual(DATA.rateTables, defaultData().rateTables)) { DATA.rateTablesVersion = RATE_TABLES_VERSION; return; }
    if (tablesEqual(DATA.rateTables, { below: OLD_BELOW, above: OLD_ABOVE })) {
      DATA.rateTablesVersion = undefined;
      if (window.confirm('Detected the pre-Oct-2025 default rate tables.\n\n' +
        'Use the current tariff?\n  1-400 @4.95, 401-500 @6.65, 501-600 @8.80,\n  601-800 @9.95, 801-1000 @11.05, 1001+ @12.15 (no free units).\n\nOK = use current tariff · Cancel = keep old tables (not asked again)')) {
        DATA.rateTables = defaultData().rateTables;
        DATA.rateTablesVersion = RATE_TABLES_VERSION;
        return;
      }
      DATA.rateTablesVersion = 'custom';
      return;
    }
    if (DATA.rateTablesVersion !== 'custom') DATA.rateTablesVersion = 'custom';
  }
  function loadData() {
    if (window.DATA && (importingData || (Array.isArray(window.DATA.records) && window.DATA.records.length > 0))) DATA = Calc.migrateBundle(window.DATA);
    else DATA = Calc.migrateBundle(defaultData());
    if (!DATA.profile) DATA.profile = defaultData().profile;
    if (!DATA.docFolder) DATA.docFolder = '';
    if (!DATA.rateTables) DATA.rateTables = defaultData().rateTables;
    if (!Array.isArray(DATA.records)) DATA.records = [];
    if (!Array.isArray(DATA.consumers)) DATA.consumers = [];
    if (!DATA.consumers.length) rebuildConsumers();
    if (!normSc(DATA.profile.scNo) || DATA.profile.scNo === '0') {
      for (var i = 0; i < DATA.consumers.length; i++) {
        if (normSc(DATA.consumers[i].scNo)) { DATA.profile.scNo = DATA.consumers[i].scNo; break; }
      }
    }
    DATA.records.sort(function (a, b) { return tsOf(b.periodTo) - tsOf(a.periodTo); });
  }
  function normSc(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
  function rebuildConsumers() {
    var map = {};
    sortedRecords().forEach(function (r) {
      var sc = normSc(r.scNo);
      if (!sc) return;
      if (!map[sc]) map[sc] = { scNo: sc, name: '', tariff: '', since: '' };
      if (r.consumerName && !map[sc].name) map[sc].name = r.consumerName;
      if (r.tariff && !map[sc].tariff) map[sc].tariff = r.tariff;
      if (!map[sc].since && r.periodTo) map[sc].since = r.periodTo;
    });
    DATA.consumers = Object.keys(map).sort().map(function (k) { return map[k]; });
  }
  function upsertConsumer(obj, sincePeriod) {
    if (!obj) return null;
    var sc = normSc(obj.scNo);
    if (!sc) return null;
    var c = null;
    DATA.consumers.forEach(function (x) { if (normSc(x.scNo) === sc) c = x; });
    if (!c) { c = { scNo: sc, name: '', tariff: '', since: '' }; DATA.consumers.push(c); }
    if (obj.consumerName && !c.name) c.name = obj.consumerName;
    if (obj.tariff) c.tariff = obj.tariff;
    if (!c.since && sincePeriod) c.since = sincePeriod;
    return c;
  }
  function knownSc(sc) {
    var s = normSc(sc);
    if (!s) return '';
    for (var i = 0; i < DATA.consumers.length; i++) if (normSc(DATA.consumers[i].scNo) === s) return DATA.consumers[i].scNo;
    return '';
  }
  /* What the S/C check compares against: the primary connection —
   * DATA.profile.scNo (healed at load from the roster when blank or "0"). A
   * bill for any OTHER S/C therefore warns "doesn't match profile" and goes
   * through the accept gate, even when the S/C is already a known roster
   * consumer. On a fresh app (no profile and no roster yet) it uses the bill's
   * own S/C so the very first import verifies clean; committing any bill then
   * registers the connection (parallel profiles via the roster + selector). */
  function billProfileSc(billSc) {
    if (normSc(DATA.profile.scNo)) return DATA.profile.scNo;
    if (!DATA.consumers.length) return normSc(billSc);
    return knownSc(billSc);
  }
  function curSc() {
    var want = localStorage.getItem('eb.tracker.curSc');
    var s;
    if (want) { s = knownSc(want); if (s) return s; }
    if (DATA.consumers.length) return DATA.consumers[0].scNo;
    return normSc(DATA.profile.scNo);
  }
  function setCurSc(sc) {
    var s = normSc(sc);
    if (s) try { localStorage.setItem('eb.tracker.curSc', s); } catch (e) {}
  }
  function recordsFor(sc) {
    var s = normSc(sc);
    return DATA.records.filter(function (r) { return normSc(r.scNo) === s; });
  }
  function selectedConsumer() {
    var sc = curSc();
    for (var i = 0; i < DATA.consumers.length; i++) if (normSc(DATA.consumers[i].scNo) === sc) return DATA.consumers[i];
    return DATA.profile;
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(DATA)); } catch (e) { /* origin sealed */ }
  }
  function sortedRecords() {
    return DATA.records.slice().sort(function (a, b) { return tsOf(b.periodTo) - tsOf(a.periodTo); });
  }
  function lastCommitted(periodTo, excludePeriodTo, sc) {
    var best = null;
    var t = tsOf(periodTo);
    DATA.records.forEach(function (r) {
      if (!r.periodTo) return;
      if (sc && normSc(r.scNo) !== normSc(sc)) return;
      var rt = tsOf(r.periodTo);
      if (!rt) return;
      if (excludePeriodTo && String(r.periodTo) === String(excludePeriodTo)) return;
      if (rt > t + 10 * DAY_MS) return;
      if (!best || rt > tsOf(best.periodTo)) best = r;
    });
    return best;
  }
  function prevFor(bill) {
    return lastCommitted(bill.periodFrom || bill.periodTo, bill.periodTo, bill.scNo);
  }
  /* nearest already-recorded entry with periodFrom >= this bill's periodTo
   * (boundary-touching = adjacent next bill); used for the forward continuity
   * check when bills are uploaded out of order. */
  function nextFor(bill) {
    var t = tsOf(bill.periodTo);
    if (!isFinite(t) || !DATA.records.length) return null;
    var best = null, bestT = Infinity;
    DATA.records.forEach(function (r) {
      if (!r.periodFrom) return;
      if (normSc(r.scNo) !== normSc(bill.scNo)) return;
      var rt = tsOf(r.periodFrom);
      if (!isFinite(rt) || rt < t - 10 * DAY_MS) return;
      if (String(r.periodTo) === String(bill.periodTo)) return;
      if (rt < bestT) { best = r; bestT = rt; }
    });
    return best;
  }

  /* ---------- state machine ---------- */
  var S = { phase: 'landing', bc: null, bChecks: null, bx: {}, pending: null, later: null,     rc: null, rx: {}, manualRcpt: null, u: null, uChecks: null, ux: {}, _ufile: null };

  /* ---------- utility selection (elec / water / pt) ---------- */
  function curUtil() {
    try { var u = localStorage.getItem('eb.tracker.curUtil'); if (u === 'water' || u === 'pt') return u; } catch (e) {}
    return 'elec';
  }
  function setCurUtil(u) {
    if (u !== 'elec' && u !== 'water' && u !== 'pt') return;
    try { localStorage.setItem('eb.tracker.curUtil', u); } catch (e) {}
  }
  function connRoster(type) {
    return (type === 'pt' ? DATA.ptConsumers : DATA.waterConsumers) || [];
  }
  function recordsForUtil(type) {
    return DATA.records.filter(function (r) { return r.type === type; });
  }
  function curConn(type) {
    var arr = connRoster(type);
    if (arr.length) return arr[0];
    var found = null;
    DATA.records.forEach(function (r) { if (r.type === type) found = r; });
    return found;
  }
  function upsertConn(type, o) {
    var key = type === 'pt' ? 'ptConsumers' : 'waterConsumers';
    if (!Array.isArray(DATA[key])) DATA[key] = [];
    var noKey = normSc(o.no || '');
    if (!noKey) return null;
    var arr = DATA[key];
    var c = null;
    arr.forEach(function (x) { if (normSc(x.no) === noKey) c = x; });
    if (!c) { c = { no: noKey, label: '', name: '' }; arr.push(c); }
    if (o.label && !c.label) c.label = o.label;
    if (o.name && !c.name) c.name = o.name;
    return c;
  }
  function utilUsedSet(type) {
    var s = new Set();
    recordsForUtil(type).forEach(function (r) { if (r.paidOn && r.paidOn.receiptNo) s.add(String(r.paidOn.receiptNo)); });
    return s;
  }
  function landingText() {
    var u = curUtil();
    if (u === 'water') return { t: 'Import a water receipt', h: 'Drop a CMWSSB water e-Receipt / receipt (PDF) to record it as paid.' };
    if (u === 'pt') return { t: 'Import a property tax receipt', h: 'Drop a GCC property tax receipt (PDF) to record it as paid.' };
    return { t: 'Start with a bill', h: 'Select a TANGEDCO bill PDF to import and verify.' };
  }

  /* ---------- IndexedDB docs ---------- */
  var DBP = null;
  function openDB() {
    if (DBP) return DBP;
    DBP = new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('IndexedDB unavailable')); return; }
      var req = indexedDB.open('eb-tracker-docs', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('docs', { keyPath: 'id' }); };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { toast('Local document storage is unavailable — attachments will not be saved on this device.', 'warn'); rej(req.error); };
    });
    return DBP;
  }
  function putDoc(id, kind, name, blob) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('docs', 'readwrite');
        tx.objectStore('docs').put({ id: id, kind: kind, name: name, added: new Date().toISOString(), blob: blob });
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function getDoc(id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('docs', 'readonly');
        var r = tx.objectStore('docs').get(id);
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    });
  }
  function delDoc(id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('docs', 'readwrite');
        tx.objectStore('docs').delete(id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function viewRec(r) {
    var refs = (r.docs || []).slice();
    function tryRef(i) {
      if (i >= refs.length) { tryDerived(r); return; }
      var ref = refs[i];
      getDoc(ref.docId).then(function (d) {
        if (d) { openStoredDoc(d); return; }
        if (DATA.docFolder && ref.name) { openOriginalFromFolder(ref.name); return; }
        tryRef(i + 1);
      }, function () { tryRef(i + 1); });
    }
    if (refs.length) tryRef(0);
    else tryDerived(r);
  }
  function tryDerived(r) {
    var to = String(r.periodTo || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (DATA.docFolder && to) {
      var cand = 'bi_' + to[3] + '_' + to[2] + '.pdf';
      toast('No attachment stored — opening ' + cand + ' from your PDFs-origin folder…', 'warn');
      openOriginalFromFolder(cand);
      return;
    }
    toast('No document attached for this record — use Attach first.', 'warn');
  }
  function shortDate(d) {
    var m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? m[1] + '/' + m[2] + '/' + m[3].slice(2) : d;
  }
  function openStoredDoc(d) {
    var u = URL.createObjectURL(d.blob);
    var w = window.open(u, '_blank');
    if (!w) toast('Opening was blocked — allow pop-ups for this app.', 'warn');
    setTimeout(function () { URL.revokeObjectURL(u); }, 120000);
  }
  function openOriginalFromFolder(name) {
    var bn = String(name).split(/[\/\\]/).pop();
    var folder = String(DATA.docFolder).replace(/\\/g, '/').replace(/^file:\/+/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!folder || !bn) { toast('Missing folder or file name for the document link.', 'warn'); return; }
    var url = 'file:///' + folder.split('/').map(function (x) { return /^[A-Za-z]:$/.test(x) ? x : encodeURIComponent(x); }).join('/') + '/' + encodeURIComponent(bn);
    var w = window.open(url, '_blank');
    if (!w) toast('Opening the original file was blocked — allow pop-ups, or use Attach.', 'warn');
  }

  /* ---------- PDF -> parsed object ---------- */
  function pdfText(arrayBuffer) {
    return pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false }).promise
      .then(function (doc) { return doc.getPage(1); })
      .then(function (page) { return page.getTextContent(); })
      .then(function (tc) { return Parser.groupLines(tc); });
  }
  function parsePdfBytes(ab) {
    return pdfText(ab).then(function (lines) {
      if (Parser.isReceipt(lines)) return { kind: 'receipt', obj: Parser.parseReceipt(lines), lines: lines };
      if (Parser.isPT(lines)) return { kind: 'pt', obj: Parser.parsePT(lines), lines: lines };
      if (Parser.isWater(lines)) return { kind: 'water', obj: Parser.parseWater(lines), lines: lines };
      return { kind: 'bill', obj: Parser.parseBill(lines), lines: lines };
    });
  }
  function readFile(file) {
    return file.arrayBuffer().then(function (ab) { return parsePdfBytes(ab); });
  }

  /* ---------- OCR (scanned receipts) ---------- */
  var tessPromise = null;
  function injectScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function ensureTess() {
    if (tessPromise) return tessPromise;
    tessPromise = Promise.all([
      injectScript('lib/tess_assets.js'),
      injectScript('lib/tesseract.min.js')
    ]).then(function () {
      var A = window.TESS_ASSETS || (typeof TESS_ASSETS !== 'undefined' ? TESS_ASSETS : null);
      if (!A || !A.worker || !A.core || !window.Tesseract) throw new Error('OCR assets missing');
      var fetchShim =
        "self.fetch = function(url){\n" +
        "  var m = String(url).match(/(eng|tam)\\.traineddata\\.gz$/);\n" +
        "  if (!m) return Promise.reject(new Error('offline: cannot fetch ' + url));\n" +
        "  try {\n" +
        "    var bin = atob(self.__TESS_DATA[m[1]]);\n" +
        "    var arr = new Uint8Array(bin.length);\n" +
        "    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);\n" +
        "    return Promise.resolve({ ok: true, status: 200, arrayBuffer: function(){ return Promise.resolve(arr.buffer); } });\n" +
        "  } catch (e) { return Promise.reject(new Error('bad training data')); }\n" +
        "};\n" +
        "var __TESS_DATA = { eng: " + JSON.stringify(A.eng) + ", tam: " + JSON.stringify(A.tam) + " };\n";
      var code = fetchShim + new TextDecoder().decode(b64ToBytes(A.worker)) + new TextDecoder().decode(b64ToBytes(A.core));
      var blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      return { blobUrl: blobUrl };
    });
    return tessPromise;
  }
  function ocrText(blob) { // blob = PNG image
    return ensureTess().then(function (env) {
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: env.blobUrl,
        workerBlobURL: true,
        corePath: 'inline-ignored.js',
        langPath: 'offline',
        cachePath: '',
        cacheMethod: 'none',
        gzip: true
      }).then(function (w) {
        return w.recognize(blob, {}, { text: true })
          .then(function (r) { return w.terminate().then(function () { return r.data; }); }, function (e) { return w.terminate().then(function () { throw e; }); });
      });
    });
  }
  function renderPng(arrBuf) {
    return pdfjsLib.getDocument({ data: arrBuf }).promise
      .then(function (doc) { return doc.getPage(1); })
      .then(function (page) {
        var vp = page.getViewport({ scale: 2.5 });
        var c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(function () {
          return new Promise(function (res, rej) {
            c.toBlob(function (b) { b ? res(b) : rej(new Error('canvas empty')); }, 'image/png');
          });
        });
      });
  }
  function ocr(file) {
    if (!/\.pdf$/i.test(file.name)) return ocrText(file);
    return file.arrayBuffer().then(renderPng).then(ocrText);
  }

  /* ---------- rendering ---------- */
  function show(id) {
    ['landing', 'verifyBill', 'awaitReceipt', 'manualRcpt', 'verifyReceipt', 'verifyUtil', 'done'].forEach(function (x) {
      var n = $(x);
      if (!n) return;
      n.style.display = (x === id ? 'block' : 'none');
      n.setAttribute('aria-hidden', String(x !== id));
    });
  }
  function step(idx) {
    $('stepper').innerHTML = '';
    $('stepper').removeAttribute('aria-hidden');
    var steps = [['1', 'Bill'], ['2', 'Verify'], ['3', 'Await receipt'], ['4', 'Receipt'], ['5', 'Paid']];
    steps.forEach(function (s, i) {
      var d = el('div', 'st ' + (i < idx ? 'done' : i === idx ? 'now' : ''));
      d.appendChild(el('span', 'n', s[0]));
      d.appendChild(el('span', '', s[1]));
      if (i === 0) { d.style.cursor = 'pointer'; d.title = 'Import a new bill at any time'; d.onclick = function () { goImport(null); }; }
      $('stepper').appendChild(d);
      if (i < steps.length - 1) $('stepper').appendChild(el('span', 'sep', '—'));
    });
  }
  function stepUtil() {
    $('stepper').innerHTML = '';
    $('stepper').removeAttribute('aria-hidden');
    var steps = [['1', 'Import'], ['2', 'Verify'], ['3', 'Recorded']];
    steps.forEach(function (s, i) {
      var d = el('div', 'st ' + (i < 1 ? 'done' : i === 1 ? 'now' : ''));
      d.appendChild(el('span', 'n', s[0]));
      d.appendChild(el('span', '', s[1]));
      if (i === 0) { d.style.cursor = 'pointer'; d.title = 'Import a new receipt at any time'; d.onclick = function () { goImport(null); }; }
      $('stepper').appendChild(d);
      if (i < steps.length - 1) $('stepper').appendChild(el('span', 'sep', '—'));
    });
  }
  function kvRow(l, v) {
    var d = el('div');
    d.appendChild(el('b', '', l));
    var s = el('span', '', v);
    d.appendChild(s);
    return d;
  }
  function objAsKv(obj, skip) {
    var box = el('div', 'kv');
    skip = skip || {};
    [
      ['Name', obj.consumerName || '—', 'name'],
      ['S/C', obj.scNo || '—', 'sc'],
      ['Period', (obj.periodFrom || '—') + ' → ' + (obj.periodTo || '—'), 'period'],
      ['Units', fmtNum(obj.units), 'units'],
      ['Prev → Present', fmtNum(obj.prevReading) + ' → ' + fmtNum(obj.presentReading) + (isFinite(obj.mf) ? ' (MF ' + fmtNum(obj.mf) + ')' : ''), 'read'],
      ['Energy', fmtMoney(obj.energyCharges), 'energy'],
      ['Fixed', fmtMoney(obj.fixedCharges), 'fixed'],
      ['Subsidy', '-' + fmtMoney(obj.govtSubsidy), 'sub'],
      ['Net payable', fmtMoney(obj.netTotal), 'net'],
      ['Total', fmtMoney(obj.totalPayable), 'total']
    ].forEach(function (r) {
      if (skip[r[2]]) return;
      box.appendChild(kvRow(r[0], r[1]));
    });
    return box;
  }
  function checkRow(c, onAccept, onRaise, hasExceptions) {
    var row = el('div', 'check');
    row.appendChild(el('span', 'st ' + c.status));
    var lbl = el('span', 'lbl', c.label);
    if (c.message) lbl.appendChild(el('div', 'meta', c.message));
    else {
      var meta = []; var parts = '';
      if (c.expected != null) parts += 'expected ' + (typeof c.expected === 'string' ? c.expected : fmtNum(c.expected));
      if (c.actual != null) parts += (parts ? ', ' : '') + 'got ' + (typeof c.actual === 'string' ? c.actual : fmtNum(c.actual));
      if (c.delta != null) parts += (parts ? ', ' : '') + 'Δ ' + (c.delta === 0 ? '0' : fmtNum(c.delta));
      if (c.ref) parts += (parts ? ', ' : '') + c.ref;
      if (parts) lbl.appendChild(el('div', 'meta', parts));
    }
    row.appendChild(lbl);
    var badge = el('span', 'badge ' + c.status, (c.status === 'accepted' ? 'accepted' : c.status));
    row.appendChild(badge);
    if ((c.status === 'fail' || c.status === 'warn') && !hasExceptions) {
      var btns = el('div', 'btns');
      var a = el('button', '', 'It’s okay');
      var b = el('button', 'danger', 'Raise concern');
      a.onclick = function () { onAccept(c.key); };
      b.onclick = function () { onRaise(c.key, c); };
      btns.appendChild(a); btns.appendChild(b);
      row.appendChild(btns);
    }
    return row;
  }
  function checksBox(checks, bx, onAccept, onRaise) {
    var box = el('div', 'checks');
    var pending = [];
    checks.forEach(function (c) {
      box.appendChild(checkRow(c, onAccept, onRaise, !!bx[c.key]));
      if ((c.status === 'fail' || c.status === 'warn') && !bx[c.key]) pending.push(c.label);
    });
    var p = el('div', 'pending');
    if (pending.length) p.textContent = 'Decide on ' + pending.length + ' flagged item' + (pending.length > 1 ? 's' : '') + ' to continue.';
    else p.textContent = 'All checked.';
    return { box: box, pendingEl: p, nPending: pending.length };
  }

  function renderBill() {
    show('verifyBill');
    $('vbPeriod').textContent = S.bc.periodTo || S.bc.periodFrom || 'bill';
    $('vbExtract').replaceChildren ? $('vbExtract').replaceChildren() : ($('vbExtract').innerHTML = '');
    $('vbExtract').appendChild(objAsKv(S.bc));
    var applied = Calc.applyExceptions(S.bChecks.checks, S.bx);
    var box = checksBox(applied.checks, S.bx, function (key) {
      S.bx[key] = 'accepted by user';
      renderBill();
    }, function (key, c) {
      S.bc = null; S.bChecks = null; S.bx = {};
      toast('Concern raised — import cancelled.', 'bad');
      renderStage();
    });
    $('vbChecks').replaceChildren();
    $('vbChecks').appendChild(box.box);
    $('vbChecks').appendChild(box.pendingEl);
    var ok = !Calc.hasBlocking(applied.checks, S.bx);
    var btn = $('vbCommit');
    btn.disabled = !ok;
    btn.title = ok ? '' : 'Resolve flagged items first';
  }
  function renderReceipt() {
    show('verifyReceipt');
    var fields = fieldsOf(S.rc);
    $('vrPeriod').textContent = S.pending ? (S.pending.periodTo || '') : 'receipt';
    $('vrExtract').replaceChildren ? $('vrExtract').replaceChildren() : ($('vrExtract').innerHTML = '');
    var kv = el('div', 'kv');
    [['Receipt no.', fields.receiptNo], ['S/C', fields.scNo], ['Name', S.rc.consumerName || '—'], ['Amount', fmtMoney(fields.amount)], ['Date', fields.date + (fields.time ? ' ' + fields.time : '')]]
      .forEach(function (r) { kv.appendChild(kvRow(r[0], r[1])); });
    if (fields.blank) {
      kv.appendChild(kvRow('OCR', 'no text extracted'));
      var note = el('div', 'actions');
      note.appendChild(el('button', 'primary', 'Recognize scan with OCR'));
      kv.appendChild(note);
      kv.querySelector('button').onclick = function () { runOcr(); };
    }
    $('vrExtract').appendChild(kv);
    var pay = { receiptNo: S.rc.receiptNo || '', scNo: S.rc.scNo || '', paidAmount: S.rc.amount };
    var vr = Calc.verifyReceipt(pay, S.pending, { usedReceiptNo: usedSet() });
    var applied = Calc.applyExceptions(vr, S.rx);
    var box = checksBox(applied.checks, S.rx, function (key) {
      S.rx[key] = 'accepted by user';
      renderReceipt();
    }, function (key, c) {
      S.rc = null; S.rx = {}; S.pending = null;
      toast('Concern raised — receipt import cancelled.', 'bad');
      renderStage();
    });
    $('vrChecks').replaceChildren();
    $('vrChecks').appendChild(box.box);
    $('vrChecks').appendChild(box.pendingEl);
    var ok = !Calc.hasBlocking(applied.checks, S.rx);
    $('vrCommit').disabled = !ok;
  }
  function fieldsOf(rc) {
    return { receiptNo: rc.receiptNo || '', scNo: rc.scNo || '', amount: rc.amount, date: rc.paidDate || '', time: rc.paidTime || '', blank: !(rc.receiptNo || rc.scNo || isFinite(rc.amount) || rc.paidDate) };
  }
  function usedSet() {
    var s = new Set();
    DATA.records.forEach(function (r) { if (r.paidOn && r.paidOn.receiptNo) s.add(r.paidOn.receiptNo); });
    return s;
  }
  function renderStage() {
    var missing = DATA.records.filter(function (r) { return r.type !== 'water' && r.type !== 'pt' && r.status === 'unpaid'; })
      .sort(function (a, b) { return tsOf(b.periodTo) - tsOf(a.periodTo); });
    if (S.bc) { step(2); renderBill(); }
    else if (S.rc) { step(4); renderReceipt(); }
    else if (S.u) { stepUtil(); renderUtil(); }
    else if (S.pending) { step(3); renderAwait(); }
    else if (missing.length) { step(3); S.pending = missing[0]; renderAwait(); }
    else {
      var lt = landingText();
      if (DATA.records.length) { step(5); show('done'); }
      else { step(0); show('landing'); $('landingTitle').textContent = lt.t; $('landingHint').textContent = lt.h; }
    }
  }
  function renderAwait() {
    show('awaitReceipt');
    var unpaid = DATA.records.filter(function (r) { return r.status === 'unpaid'; });
    var m = S.pending || unpaid[0];
    $('arTitle').textContent = 'Awaiting payment' + (unpaid.length > 1 ? ' — ' + unpaid.length + ' bills unpaid' : '');
    $('arBill').replaceChildren ? $('arBill').replaceChildren() : ($('arBill').innerHTML = '');
    $('arBill').appendChild(objAsKv(m));
    S.pending = m;
  }
  function chart() {
    var cv = $('chart');
    if (!cv || !window.Chart) return;
    var util = curUtil();
    var recs = ((util === 'elec' ? recordsFor(curSc()) : recordsForUtil(util)).slice())
      .sort(function (a, b) { return tsOf(a.periodTo) - tsOf(b.periodTo); });
    $('dTitle').textContent = util === 'elec' ? 'Units per period' : (util === 'water' ? 'Water payments' : 'Property tax payments');
    var conn = util === 'elec' ? null : curConn(util);
    var connNo = util === 'elec' ? curSc() : (conn && (conn.cmcNo || conn.propertyNo || conn.label || conn.no)) || '';
    $('dSub').textContent = connNo ? (util === 'elec' ? 'S/C ' : '') + connNo : '';
    var allTs = recs.map(function (r) { return tsOf(r.periodTo); });
    var maxT = allTs.length ? allTs[allTs.length - 1] : 0;
    var cutoff = maxT - 730 * 86400000;
    var vis = recs.filter(function (r) { return tsOf(r.periodTo) >= cutoff; });
    var labels = vis.map(function (r) { return shortPeriod(r.periodTo); });
    var units = vis.map(function (r) { return util === 'elec' ? (r.units || null) : null; });
    var amt = vis.map(function (r) { return r.totalPayable || r.amount || null; });
    var positions = [];
    for (var i = 1; i < vis.length; i++) {
      var prevConn = util === 'elec' ? vis[i - 1].scNo : (util === 'water' ? vis[i - 1].cmcNo : vis[i - 1].propertyNo);
      var curConn2 = util === 'elec' ? vis[i].scNo : (util === 'water' ? vis[i].cmcNo : vis[i].propertyNo);
      var nameChanged = !!vis[i].consumerName && !!vis[i - 1].consumerName && vis[i].consumerName !== vis[i - 1].consumerName;
      if (String(prevConn) !== String(curConn2) || nameChanged) positions.push(i);
    }
    if (!window.__chart) {
      window.__chart = new Chart(cv, {
        type: 'line',
        data: { labels: labels, datasets: [
          { label: 'Units', data: units, borderColor: '#0b5fd9', backgroundColor: 'rgba(11,95,217,.12)', yAxisID: 'y', tension: .25, pointRadius: 3 },
          { label: '₹', data: amt, borderColor: '#b54708', backgroundColor: 'rgba(181,71,8,.08)', yAxisID: 'y1', tension: .25, pointRadius: 2 }
        ] },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 } },
            y: { title: { display: true, text: 'units' } },
            y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: '₹' } }
          },
          animation: false,
          plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } }, transfers: positions }
        }
      });
    } else {
      var ch = window.__chart;
      ch.data.labels = labels;
      ch.data.datasets[0].data = units;
      ch.data.datasets[1].data = amt;
      ch.options.plugins.transfers = positions;
      ch.update();
    }
  }
  function shortPeriod(d) {
    var m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return d;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[+m[2] - 1] + ' ' + m[3].slice(2);
  }
  var transfersPlugin = {
    id: 'transfers',
    beforeDatasetsDraw: function (chart, args, opts) {
      var trans = (chart.options.plugins && chart.options.plugins.transfers) || [];
      if (!trans.length || !chart.scales.x || !chart.scales.y) return;
      var xa = chart.scales.x, ys = chart.scales.y, ctx = chart.ctx;
      for (var i = 0; i < trans.length; i++) {
        var px = xa.getPixelForValue(trans[i]);
        ctx.save();
        ctx.strokeStyle = '#9a6700'; ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(px, ys.top); ctx.lineTo(px, ys.bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#9a6700'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('name transfer', px, ys.top + 11);
        ctx.restore();
      }
    }
  };
  if (window.Chart) {
    try { if (!window.Chart.registry.plugins.get('transfers')) window.Chart.register(transfersPlugin); } catch (e) {}
  }
  function renderTable() {
    if (curUtil() !== 'elec') { renderUtilTable(curUtil()); return; }
    var tb = $('hist').querySelector('tbody');
    tb.innerHTML = '';
    var sc = curSc();
    var recs = recordsFor(sc).slice().sort(function (a, b) { return tsOf(a.periodTo) - tsOf(b.periodTo); });
    $('histTitle').textContent = 'History' + (sc ? ' — ' + sc : '');
    var transferIds = {};
    for (var i = 1; i < recs.length; i++) {
      if (recs[i].consumerName && recs[i - 1].consumerName && recs[i].consumerName !== recs[i - 1].consumerName) transferIds[recs[i].id] = 1;
    }
    recs = recs.slice().reverse(); // newest first
    recs.forEach(function (r) {
      var tr = document.createElement('tr');
      var tdP = document.createElement('td');
      tdP.textContent = shortDate(r.periodFrom) + ' → ' + shortDate(r.periodTo);
      if (r.consumerName) tdP.title = 'Consumer: ' + r.consumerName;
      if (transferIds[r.id]) tdP.appendChild(el('span', 'tchip', 'name transfer'));
      var u = document.createElement('td');
      u.className = 'num'; u.textContent = fmtNum(r.units);
      var e = document.createElement('td');
      e.className = 'num';
      var eraRec = Calc.tablesForBill(r);
      var rec = (eraRec ? Calc.proposedByTables(r.units, eraRec.tables) : Calc.proposedByTables(r.units, DATA.rateTables));
      e.textContent = fmtNum(rec.total);
      e.title = 'Energy recomputed from built-in tariff (era by bill period)';
      var a = document.createElement('td');
      a.className = 'num'; a.textContent = fmtMoney(r.totalPayable);
      var s = document.createElement('td');
      var b = el('span', 'badge ' + (r.status === 'paid' ? 'pass' : 'warn'), r.status);
      s.appendChild(b);
      var x = document.createElement('td');
      var re = el('button', 'mini', 're');
      re.title = 'Re-import a new bill for this period (duplicate dialog lets you replace or keep both)';
      re.onclick = function () { goImport(r); };
      var view = el('button', 'mini', 'doc');
      view.title = ((r.docs || []).map(function (d) { return d.name || ''; }).join(', ')) || 'no document attached';
      view.onclick = function () { viewRec(r); };
      var at = el('button', 'mini', 'attach');
      at.onclick = function () { attachTo(r); };
      x.appendChild(re); x.appendChild(view); x.appendChild(at);
      if (r.status !== 'paid') {
        var pay = el('button', 'mini', 'pay');
        pay.title = (S.pending === r ? 'Already awaiting payment for this bill' : 'Upload a receipt to pay this bill');
        pay.onclick = function () {
          if (!S.bc && !S.rc && S.pending === r) { toast('Already awaiting payment for this bill.', 'info'); return; }
          S.bc = null; S.bChecks = null; S.bx = {};
          S.rc = null; S.rx = {};
          S.pending = r;
          renderStage();
        };
        x.appendChild(pay);
      }
      var del = el('button', 'mini danger', 'del');
      del.title = 'Delete this record (and its stored documents)';
      del.onclick = function () { deleteRecord(r); };
      x.appendChild(del);
      tr.appendChild(tdP); tr.appendChild(u); tr.appendChild(e); tr.appendChild(a); tr.appendChild(s); tr.appendChild(x);
      tb.appendChild(tr);
    });
    var unpaid = recs.filter(function (r) { return r.status === 'unpaid'; });
    var tot = unpaid.reduce(function (s, r) { return s + (r.totalPayable || 0); }, 0);
    $('summaryRow').innerHTML = '';
    $('summaryRow').appendChild(kvRow('Unpaid', unpaid.length + ' bill' + (unpaid.length === 1 ? '' : 's')));
    $('summaryRow').appendChild(kvRow('Pending ₹', fmtMoney(tot)));
    $('summaryRow').appendChild(kvRow('Paid', recs.length - unpaid.length));
  }
  function renderUtilTable(type) {
    var isW = type === 'water';
    var tb = $('hist').querySelector('tbody');
    tb.innerHTML = '';
    var conn = curConn(type);
    var connNo = (conn && (isW ? (conn.cmcNo || conn.label || conn.no) : (conn.propertyNo || conn.label || conn.no))) || '';
    $('histTitle').textContent = (isW ? 'Water history' : 'Property tax history') + (connNo ? ' — ' + connNo : '');
    var recs = recordsForUtil(type).slice().sort(function (a, b) { return tsOf(b.periodTo) - tsOf(a.periodTo); });
    recs.forEach(function (r) {
      var tr = document.createElement('tr');
      var tdP = document.createElement('td');
      tdP.textContent = shortDate(r.periodTo) + (r.paidOn && r.paidOn.time ? ' · ' + r.paidOn.time : '');
      if (r.consumerName) tdP.title = 'Consumer: ' + r.consumerName;
      var tdA = document.createElement('td');
      tdA.className = 'num'; tdA.textContent = fmtMoney(r.totalPayable);
      var tdR = document.createElement('td');
      tdR.textContent = (r.paidOn && r.paidOn.receiptNo) || '—';
      tdR.title = (r.terms || []).map(function (t) { return t.term + ' ' + fmtMoney(t.amount); }).join('\n');
      var s = document.createElement('td');
      s.appendChild(el('span', 'badge pass', 'paid'));
      var x = document.createElement('td');
      var view = el('button', 'mini', 'doc');
      view.title = ((r.docs || []).map(function (d) { return d.name || ''; }).join(', ')) || 'no document attached';
      view.onclick = function () { viewRec(r); };
      var at = el('button', 'mini', 'attach');
      at.onclick = function () { attachTo(r); };
      var del = el('button', 'mini danger', 'del');
      del.title = 'Delete this record (and its stored documents)';
      del.onclick = function () { deleteRecord(r); };
      x.appendChild(view); x.appendChild(at); x.appendChild(del);
      tr.appendChild(tdP); tr.appendChild(tdA); tr.appendChild(tdR); tr.appendChild(s); tr.appendChild(x);
      tb.appendChild(tr);
    });
    var tot = recs.reduce(function (s, r) { return s + (r.totalPayable || 0); }, 0);
    $('summaryRow').innerHTML = '';
    $('summaryRow').appendChild(kvRow('Receipts', recs.length));
    $('summaryRow').appendChild(kvRow('Spent', fmtMoney(tot)));
    $('summaryRow').appendChild(kvRow('Unpaid', 0));
  }
  function attachTo(r) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.pdf,application/pdf,image/*,.png,.jpg,.jpeg';
    inp.onchange = function () {
      var f = inp.files[0];
      if (!f) return;
      var utilRec = r.type === 'water' || r.type === 'pt';
      if (/\.pdf$/i.test(f.name)) {
        readFile(f).then(function (p) {
          var label = '';
          if (p.kind === 'receipt') {
            label = p.obj.receiptNo || 'receipt';
            if (!utilRec && !Calc.close(p.obj.amount, r.totalPayable)) { toast('Receipt amount ' + fmtMoney(p.obj.amount) + ' ≠ bill ' + fmtMoney(r.totalPayable) + ' — not attaching.', 'bad'); return; }
          } else {
            if (utilRec) { toast('That PDF is a bill, not a receipt for this utility.', 'warn'); return; }
            var bill = p.obj;
            if (!Calc.close(bill.units, r.units)) { toast('Bill units ' + fmtNum(bill.units) + ' ≠ record ' + fmtNum(r.units) + ' — not attaching.', 'bad'); return; }
            toast('Bill matches record.');
            label = billToId(bill) || 'bill';
          }
          if (p.kind !== 'receipt' && !utilRec) toast('Bill matches record.');
          if (p.kind === 'receipt' && !utilRec) toast('Receipt matches bill amount.');
          var rid = 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
          putDoc(rid, p.kind, f.name, f).then(function () {
            r.docs = r.docs || [];
            r.docs.push({ docId: rid, kind: p.kind, name: f.name, label: label });
            persist(); renderTable(); toast('Document attached.');
          }, function (e) { toast('Could not store doc locally: ' + e.message, 'bad'); });
        }, function (e) { toast('Could not read PDF: ' + e.message, 'bad'); });
      } else {
        var rid2 = 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        putDoc(rid2, 'receipt-img', f.name, f).then(function () {
          r.docs = r.docs || [];
          r.docs.push({ docId: rid2, kind: 'receipt-img', name: f.name, label: 'receipt' });
          persist(); renderTable(); toast('Image attached.');
        });
      }
    };
    inp.click();
  }
  function billToId(bill) { return (bill.periodTo || '') + '-' + (bill.scNo || ''); }

  function renderScSel() {
    var sel = $('scSel');
    if (!sel) return;
    sel.innerHTML = '';
    DATA.consumers.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.scNo;
      o.textContent = c.scNo + (c.name ? ' — ' + c.name : '');
      sel.appendChild(o);
    });
    var cur = curSc();
    if (cur) sel.value = cur;
    sel.style.display = (curUtil() === 'elec' && DATA.consumers.length > 1) ? '' : 'none';
  }
  function renderAll() {
    var cur = selectedConsumer();
    $('profilechip').textContent = (cur.name || 'Set up consumer') + ' · S/C ' + (cur.scNo || '—');
    renderScSel();
    renderStage();
    chart();
    renderTable();
  }

  /* ---------- flow actions ---------- */
  function beginBill(file) {
    toast('Parsing…');
    var t0 = Date.now();
    readFile(file).then(function (p) {
      if (!p.obj) { toast('Could not read this PDF — no bill text found (try a clearer scan or the correct file).', 'bad'); return; }
      if (p.kind === 'receipt') {
        if (S.pending) return beginReceiptObj(p.obj);
        toast('That looks like a receipt — import it from the Awaiting-payment screen.', 'warn');
        return;
      }
      if (p.kind === 'water' || p.kind === 'pt') {
        S._ufile = file;
        return beginUtilObj(p);
      }
      var bill = p.obj;
      S.bc = bill;
      S.bx = {};
      S.pending = prevFor(bill) || null;
      S.later = nextFor(bill) || null;
      S.bChecks = Calc.verifyBill(bill, { auto: true, tables: DATA.rateTables, profileSc: billProfileSc(bill.scNo), prevRecord: S.pending, laterRecord: S.later });
      S.pending = null;
      S.later = null;
      if (!bill.scNo && !bill.periodTo) { toast('Could not read bill fields — is this a bill PDF?', 'bad'); S.bc = null; return; }
      bill.srcFile = file.name;
      bill.billFile = 'local';
      bill._file = file;
      step(2);
      renderBill();
      toast('Parsed in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's. ' + Calc.statusSummary(S.bChecks.checks).pass + ' checks passed.', 'ok');
    }, function (e) { toast('Could not parse PDF: ' + e.message, 'bad'); });
  }
  function goImport(r) {
    S.bc = null; S.bChecks = null; S.bx = {};
    S.rc = null; S.rx = {}; S.pending = null; S.later = null; S._rcFile = null;
    S.u = null; S.ux = {}; S._ufile = null;
    step(0);
    var lt = landingText();
    $('landingTitle').textContent = r ? ('Re-import ' + shortDate(r.periodFrom) + ' → ' + shortDate(r.periodTo)) : lt.t;
    $('landingHint').textContent = r ? '' : lt.h;
    show('landing');
  }
  function existingRecord(scNo, periodTo) {
    var sc = normSc(scNo);
    for (var i = 0; i < DATA.records.length; i++) {
      var r = DATA.records[i];
      if (normSc(r.scNo) === sc && (r.periodTo || '') === (periodTo || '')) return r;
    }
    return null;
  }
  function removeRecord(id) {
    for (var i = DATA.records.length - 1; i >= 0; i--) {
      if (DATA.records[i].id === id) { DATA.records.splice(i, 1); break; }
    }
  }
  function deleteRecord(r) {
    var m = el('div', 'card');
    m.appendChild(el('h3', '', 'Delete this record?'));
    m.appendChild(el('p', 'muted', 'Remove the ' + shortDate(r.periodFrom) + ' → ' + shortDate(r.periodTo) +
      ' bill' + (r.scNo ? ' (S/C ' + normSc(r.scNo) + ')' : '') + ' from history' +
      ((r.docs || []).length ? '. Its stored document(s) will also be removed' : '') + '. This cannot be undone.'));
    var act = el('div', 'actions');
    var yes = el('button', 'danger', 'Delete');
    yes.onclick = function () { closeModal(); doDelete(r); };
    var no = el('button', 'ghost', 'Cancel');
    no.onclick = function () { closeModal(); };
    act.appendChild(yes); act.appendChild(no);
    m.appendChild(act);
    modal(m, true);
  }
  function doDelete(r) {
    if (S.pending === r) S.pending = null;
    (r.docs || []).forEach(function (d) {
      if (d.docId) { delDoc(d.docId).catch(function () {}); }
    });
    removeRecord(r.id);
    persist(); renderAll();
    toast('Record deleted.', 'warn');
  }
  function commitBill() {
    if (!S.bc) return;
    var bill = S.bc;
    var dup = existingRecord(bill.scNo, bill.periodTo);
    if (dup) { askDuplicate(bill, dup); return; }
    doCommit(bill, null, false);
  }
  function askDuplicate(bill, dup) {
    var m = el('div', 'card');
    m.appendChild(el('h3', '', 'Bill already recorded'));
    m.appendChild(el('p', 'muted', 'A bill for S/C ' + (normSc(bill.scNo) || '?') + ' period ' + (bill.periodTo || '?') +
      ' is already in history' + (dup.status === 'paid' ? ' (paid)' : ' (unpaid)') + '. Replace it, keep both copies, or cancel?'));
    var act = el('div', 'actions');
    var repl = el('button', 'primary', 'Replace existing');
    repl.onclick = function () { closeModal(); doCommit(bill, dup, false); };
    var keep = el('button', 'ghost', 'Keep both');
    keep.onclick = function () { closeModal(); doCommit(bill, null, true); };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = function () { closeModal(); toast('Commit cancelled — existing bill kept.', 'warn'); };
    act.appendChild(repl); act.appendChild(keep); act.appendChild(cancel);
    m.appendChild(act);
    modal(m, true);
  }
  function doCommit(bill, dup, keepBoth) {
    if (dup && !keepBoth) removeRecord(dup.id);
    var scId = normSc(bill.scNo) || 'x';
    var baseId = 'b-' + scId + '-' + (bill.periodTo || Date.now());
    if (keepBoth) {
      var n = 1;
      while (DATA.records.some(function (r) { return r.id === baseId; })) {
        baseId = 'b-' + scId + '-' + (bill.periodTo || Date.now()) + '-' + (n++);
      }
    }
    var rec = {
      id: baseId,
      periodFrom: bill.periodFrom || '',
      periodTo: bill.periodTo || '',
      units: bill.units,
      prevReading: bill.prevReading,
      presentReading: bill.presentReading,
      mf: bill.mf,
      energyCharges: bill.energyCharges,
      fixedCharges: bill.fixedCharges || 0,
      govtSubsidy: bill.govtSubsidy || 0,
      netTotal: bill.netTotal,
      totalPayable: bill.totalPayable,
      scNo: bill.scNo,
      consumerName: bill.consumerName || '',
      layout: bill.layout,
      status: 'unpaid',
      committedAt: new Date().toISOString(),
      srcFile: bill.srcFile || '',
      accepted: Object.keys(S.bx),
      docs: []
    };
    if (bill.checksSnap) rec.checksSnap = bill.checksSnap;
    DATA.records.unshift(rec);
    upsertConsumer({ scNo: bill.scNo, consumerName: bill.consumerName || '', tariff: bill.tariff }, bill.periodTo);
    var f = bill._file;
    if (f) {
      putDoc(rec.id, 'bill', f.name, f).then(function () {
        rec.docs = [{ docId: rec.id, kind: 'bill', name: rec.srcFile, label: 'bill' }];
        persist(); renderTable(); renderAll();
      }, function () { toast('Could not save the bill PDF locally — the attachment may be missing.', 'warn'); });
    }
    S.bc = null; S.bx = {}; S.bChecks = null;
    S.pending = rec;
    setCurSc(rec.scNo);
    persist();
    renderAll();
    toast(dup ? 'Replaced existing bill for ' + (bill.periodTo || '') + '.'
      : (keepBoth ? 'Kept both copies for ' + (bill.periodTo || '') + '.' : 'Bill committed as unpaid (' + fmtMoney(rec.totalPayable) + ').'), 'ok');
  }
  function beginReceiptObj(rc) {
    if (!S.pending) { toast('No unpaid bill selected. Pick one from History → pay.', 'warn'); return; }
    S.rc = rc;
    S.rx = {};
    renderReceipt();
  }
  function ocrThenParse(d) {
    var t = d && d.text ? d.text : '';
    if (!String(t).trim()) { toast('OCR produced nothing.', 'bad'); return; }
    var rc = Parser.parseReceipt(String(t).split(/\r?\n/));
    rc._ocr = true;
    if (fieldsOf(rc).blank) { toast('OCRed but no receipt fields found — enter manually.', 'warn'); S.rc = rc; renderReceipt(); }
    else beginReceiptObj(rc);
  }
  function beginReceipt(file) {
    toast('Parsing receipt…');
    if (/\.pdf$/i.test(file.name)) {
      readFile(file).then(function (p) {
        if (!p.obj) { toast('Could not read this PDF — no text found (try OCR or a clearer scan).', 'bad'); return; }
        if (p.kind === 'bill') { toast('That looks like a bill — use Import bill.', 'warn'); return; }
        if (fieldsOf(p.obj).blank) {
          toast('No text in this PDF — trying OCR…', 'warn');
          ocr(file).then(ocrThenParse, function (e) { toast('OCR failed: ' + e.message + ' — enter manually.', 'bad'); });
        } else beginReceiptObj(p.obj);
      }, function (e) {
        toast('No text in this PDF — trying OCR…', 'warn');
        ocr(file).then(ocrThenParse, function (e2) { toast('OCR failed: ' + e2.message + ' — enter manually.', 'bad'); });
      });
    } else {
      ocr(file).then(ocrThenParse, function (e) { toast('OCR failed: ' + e.message + ' — enter manually.', 'bad'); });
    }
  }
  function runOcr() {
    var f = S._rcFile;
    if (!f) { toast('Please upload the receipt file first.', 'warn'); return; }
    toast('OCR running (one-time, ~10-30s)…');
    ocr(f).then(function (d) {
      var t = d && d.text ? d.text : '';
      var rc = Parser.parseReceipt(t.split(/\r?\n/));
      rc._ocr = true;
      S.rc = rc;
      toast('OCR done.');
      renderReceipt();
    }, function (e) { toast('OCR failed: ' + e.message, 'bad'); });
  }
  function commitReceipt() {
    if (!S.rc || !S.pending) return;
    var rec = S.pending;
    rec.status = 'paid';
    rec.paidOn = {
      date: S.rc.paidDate || '',
      time: S.rc.paidTime || '',
      receiptNo: S.rc.receiptNo || '',
      amount: S.rc.amount,
      portal: S.rc.portal || '',
      ocr: !!S.rc._ocr
    };
    rec.accepted = (rec.accepted || []).concat(Object.keys(S.rx));
    upsertConsumer({ scNo: rec.scNo, consumerName: S.rc.consumerName || rec.consumerName || '', tariff: rec.tariff }, rec.periodTo);
    var rcNo = S.rc.receiptNo || 'receipt';
    var f = S._rcFile;
    if (f) {
      var did = 'r-' + (normSc(rec.scNo) || 'x') + '-' + rec.periodTo;
      putDoc(did, 'receipt', f.name, f).then(function () {
        rec.docs = rec.docs || [];
        if (!rec.docs.some(function (d) { return d.docId === did; }))
          rec.docs.push({ docId: did, kind: 'receipt', name: f.name, label: rcNo });
        persist(); renderTable();
      }, function () { toast('Could not save the receipt PDF locally — the attachment may be missing.', 'warn'); });
    }
    S.rc = null; S.rx = {}; S.pending = null;
    persist();
    renderAll();
    toast('Marked paid.', 'ok');
  }

  /* ---------- single-stage utilities (water / property tax) ---------- */
  function beginUtilObj(p) {
    S.rc = null; S.rx = {};
    S.u = p;
    S.ux = {};
    renderStage();
  }
  function renderUtil() {
    if (!S.u) return;
    var u = S.u, o = u.obj, isW = u.kind === 'water';
    show('verifyUtil');
    $('vuKind').textContent = isW ? 'Water' : 'Property tax';
    $('vuExtract').replaceChildren ? $('vuExtract').replaceChildren() : ($('vuExtract').innerHTML = '');
    var kv = el('div', 'kv');
    if (isW) {
      [['CMC No.', o.cmcNo || '—'], ['Receipt No.', o.receiptNo || '—'], ['Name', o.consumerName || '—'],
       ['Paid on', (o.paidDate || '—') + (o.paidTime ? ' · ' + o.paidTime : '')],
       ['Amount', fmtMoney(o.amount)], ['Annual value', fmtMoney(o.annualValue)], ['Tax (half-year)', fmtMoney(o.tax)],
       ['Class', o.cls || '—'], ['Category', o.category || '—']].forEach(function (r) { kv.appendChild(kvRow(r[0], r[1])); });
    } else {
      [['Receipt No.', o.receiptNo || '—'], ['Name', o.consumerName || '—'], ['Property No.', o.propertyNo || '—'],
       ['Paid on', (o.paidDate || '—') + (o.paidTime ? ' · ' + o.paidTime : '')],
       ['Amount', fmtMoney(o.amount)]].forEach(function (r) { kv.appendChild(kvRow(r[0], r[1])); });
    }
    (o.items || []).forEach(function (it) { kv.appendChild(kvRow(it.term || 'item', fmtMoney(it.amount))); });
    if (o.grandTotal != null && o.grandTotal !== o.amount) kv.appendChild(kvRow('Grand total', fmtMoney(o.grandTotal)));
    if (o.paidTotal != null && o.paidTotal !== o.amount) kv.appendChild(kvRow('Paid after adjustments', fmtMoney(o.paidTotal)));
    if (o.mode) kv.appendChild(kvRow('Payment mode', o.mode));
    $('vuExtract').appendChild(kv);

    var conn = curConn(u.kind);
    var ctx = { usedReceiptNo: utilUsedSet(u.kind) };
    if (isW) ctx.cmcNo = (conn && (conn.cmcNo || conn.label || conn.no)) || '';
    else ctx.propertyNo = (conn && (conn.propertyNo || conn.label || conn.no)) || '';
    var v = isW ? Calc.verifyWater(o, ctx) : Calc.verifyPT(o, ctx);
    var applied = Calc.applyExceptions(v, S.ux);
    var box = checksBox(applied.checks, S.ux, function (key) {
      S.ux[key] = 'accepted by user';
      renderUtil();
    }, function (key, c) {
      S.u = null; S.ux = {}; S._ufile = null;
      toast('Concern raised — receipt import cancelled.', 'bad');
      renderStage();
    });
    $('vuChecks').replaceChildren();
    $('vuChecks').appendChild(box.box);
    $('vuChecks').appendChild(box.pendingEl);
    var dupNote = [];
    recordsForUtil(u.kind).forEach(function (r) {
      if (r.paidOn && r.paidOn.receiptNo && r.paidOn.receiptNo === o.receiptNo) dupNote.push(shortDate(r.periodTo));
    });
    $('vuDup').textContent = dupNote.length ? 'This receipt number is already recorded for ' + dupNote.join(', ') + ' — committing will ask you to replace or keep both.' : '';
    var ok = !Calc.hasBlocking(applied.checks, S.ux);
    $('vuCommit').disabled = !ok;
  }
  function commitUtil() {
    if (!S.u) return;
    var u = S.u, o = u.obj;
    var byNo = null;
    recordsForUtil(u.kind).forEach(function (r) {
      if (r.paidOn && r.paidOn.receiptNo && r.paidOn.receiptNo === (o.receiptNo || '')) byNo = r;
    });
    if (byNo) { askUtilDuplicate(u, byNo); return; }
    doCommitUtil(u, null, false);
  }
  function askUtilDuplicate(u, dup) {
    var isW = u.kind === 'water';
    var m = el('div', 'card');
    m.appendChild(el('h3', '', 'Receipt already recorded'));
    m.appendChild(el('p', 'muted', 'Receipt no. ' + (u.obj.receiptNo || '?') + (isW ? ' for CMC ' : ' for property ') +
      (isW ? (u.obj.cmcNo || '?') : (u.obj.propertyNo || '?')) + ' is already in history (paid ' + shortDate(dup.periodTo) + '). Replace it, keep both copies, or cancel?'));
    var act = el('div', 'actions');
    var repl = el('button', 'primary', 'Replace existing');
    repl.onclick = function () { closeModal(); doCommitUtil(u, dup, false); };
    var keep = el('button', 'ghost', 'Keep both');
    keep.onclick = function () { closeModal(); doCommitUtil(u, null, true); };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = function () { closeModal(); toast('Commit cancelled — existing receipt kept.', 'warn'); };
    act.appendChild(repl); act.appendChild(keep); act.appendChild(cancel);
    m.appendChild(act);
    modal(m, true);
  }
  function doCommitUtil(u, dup, keepBoth) {
    var o = u.obj, isW = u.kind === 'water';
    var connNo = isW ? (o.cmcNo || '') : (o.propertyNo || '');
    var connKey = normSc(connNo);
    if (dup && !keepBoth) removeRecord(dup.id);
    var stamp = String(o.paidDate || '').replace(/[^\d]/g, '');
    var id = (isW ? 'w-' : 'p-') + connKey + '-' + stamp + '-' + String(o.receiptNo || '').replace(/[^A-Za-z0-9-]/g, '');
    if (keepBoth) {
      var n = 2;
      while (DATA.records.some(function (r) { return r.id === id; })) { id = (id + '-' + (n++)); }
    }
    var rec = {
      id: id,
      type: u.kind,
      cmcNo: isW ? connNo : '',
      propertyNo: isW ? '' : connNo,
      consumerName: o.consumerName || '',
      periodTo: o.paidDate || '',
      amount: o.amount,
      totalPayable: o.amount,
      annualValue: o.annualValue,
      tax: o.tax,
      cls: o.cls,
      category: o.category,
      terms: (o.items || []).map(function (it) { return { term: it.term, amount: it.amount }; }),
      layout: o.layout || '',
      status: 'paid',
      paidOn: { date: o.paidDate || '', time: o.paidTime || '', receiptNo: o.receiptNo || '', amount: o.amount, portal: o.portal || '', ocr: !!o._ocr },
      committedAt: new Date().toISOString(),
      srcFile: (S._ufile && S._ufile.name) || o.srcFile || '',
      accepted: Object.keys(S.ux),
      docs: []
    };
    upsertConn(u.kind, { no: connKey, label: connNo, name: o.consumerName || '' });
    setCurUtil(u.kind);
    var f = S._ufile;
    if (f) {
      putDoc(rec.id, 'receipt', f.name, f).then(function () {
        rec.docs = [{ docId: rec.id, kind: 'receipt', name: f.name, label: o.receiptNo || 'receipt' }];
        persist(); renderAll();
      }, function () { toast('Could not save the receipt PDF locally — the attachment may be missing.', 'warn'); });
    }
    DATA.records.unshift(rec);
    S.u = null; S.ux = {}; S._ufile = null;
    persist();
    renderAll();
    toast((isW ? 'Water receipt' : 'Property tax receipt') + ' recorded as paid (' + fmtMoney(rec.totalPayable) + ').', 'ok');
  }

  /* ---------- manual receipt ---------- */
  function showManual() {
    show('manualRcpt');
  }
  function manualOk() {
    var rc = {
      receiptNo: $('rNo').value.trim(),
      scNo: $('rSc').value.trim(),
      amount: parseFloat($('rAmt').value),
      paidDate: $('rDate').value.trim(),
      paidTime: ''
    };
    if (!rc.receiptNo || !isFinite(rc.amount)) { toast('Receipt no. and amount required.', 'warn'); return; }
    S.rc = rc;
    renderReceipt();
  }

  /* ---------- persistence UI ---------- */
  function bundleText() {
    return '/* tn-utilities data bundle v' + (DATA.version || 1) + ' — regenerate via Save bundle */\nwindow.DATA = ' +
      JSON.stringify(DATA, null, 1) + ';\n';
  }
  function saveBundle() { download('bundle.js', bundleText(), 'text/javascript'); toast('bundle.js downloaded — replace data/bundle.js to keep this folder portable.', 'ok'); }
  function loadBundleFile(file) {
    file.text().then(function (t) {
      var s = t.replace(/^\s*window\.DATA\s*=\s*/, '');
      s = s.replace(/\s*;\s*$/, '');
      var d = JSON.parse(s);
      if (!d || !Array.isArray(d.records)) throw new Error('not a bundle');
      var migrated = Calc.migrateBundle(d);
      if (migrated.incompatible) {
        toast('This bundle is from a newer app version (schema ' + migrated.version + ') and can’t be loaded here. Update the app first.', 'bad');
        return;
      }
      DATA = migrated;
      window.DATA = migrated;
      importingData = true;
      loadData();
      importingData = false;
      persist();
      renderAll();
      toast('Bundle loaded: ' + migrated.records.length + ' records (schema v' + (migrated.version || '?') + ').', 'ok');
    }, function (e) { toast('Could not read bundle: ' + e.message, 'bad'); }).catch(function (e) { toast('Invalid bundle file: ' + e.message, 'bad'); });
  }
  function openRatesModal() {
    function gridFor(t, hdr) {
      var grid = el('div', 'rateGridRo');
      grid.innerHTML = '<b class="rowEl">From</b><b class="rowEl">To</b><b class="rowEl">' + (hdr || 'Rate \u20B9') + '</b>';
      t.forEach(function (row) {
        var rf = el('b', 'rowEl', row[0]);
        var rt = el('b', 'rowEl', row[1] == null ? 'and above' : row[1]);
        var rr = el('b', 'rowEl', row[2]);
        grid.appendChild(rf); grid.appendChild(rt); grid.appendChild(rr);
      });
      return grid;
    }
    var regs = Calc.REGIMES.slice().reverse(); // newest first
    var activeKey = null;
    if (DATA.records && DATA.records[0] && DATA.records[0].periodTo) {
      var ar = Calc.tablesForBill(DATA.records[0]);
      activeKey = ar && ar.regime.key;
    }
    if (!activeKey) activeKey = regs[0].key;
    var m = el('div');
    m.appendChild(el('h2', '', 'Tariff — built-in, by bill date'));
    m.appendChild(el('p', 'muted', 'Every TANGEDCO revision is pre-loaded and chosen from the bill\u2019s consumption period; a bill crossing a 1-Jul revision is prorated day-by-day. Use the dropdown to view any era: after 10-May-2026 is the free-200 scheme (R2026), 1-Jul-2024 \u2192 10-May-2026 is R2024/R2025, before 1-Jul-2024 is R2023/R2022.'));
    var selRow = el('div', 'form');
    var sel = el('select', 'eraSel');
    regs.forEach(function (r) {
      var o = el('option', '', r.key + ' \u00b7 ' + r.label);
      o.value = r.key;
      sel.appendChild(o);
    });
    sel.value = activeKey;
    var body = el('div');
    var basis = 'net';
    function netTotal(net, units) {
      var t = 0;
      (units <= 500 ? net.below : net.above).forEach(function (row) {
        if (units < row[0]) return;
        var hi = row[1] == null ? units : Math.min(units, row[1]);
        if (hi < row[0]) return;
        t += (hi - row[0] + 1) * row[2];
      });
      return Calc.round2(t);
    }
    function exampleNote(key, net) {
      var ex = null;
      (DATA.records || []).forEach(function (rc) {
        var rr = Calc.tablesForBill(rc);
        if (rr && rr.regime.key === key && !rr.cutover) ex = rc;
      });
      if (!ex || !isFinite(ex.units)) return null;
      return el('div', 'muted hint', 'Example: ' + ex.units + ' units \u2192 you pay ' +
        Calc.fmtMoney(netTotal(net, ex.units)) + ' (units \u00d7 net rates).');
    }
    function render(key) {
      body.innerHTML = '';
      regs.forEach(function (r) {
        if (r.key !== key) return;
        var box = el('div', 'mrow');
        var h = el('h4', '', r.label);
        if (r.key === activeKey) h.appendChild(el('span', 'tchip', 'current'));
        box.appendChild(h);
        var net = r.net;
        if (net) {
          var tog = el('div', 'form');
          var gl = el('label', 'lbl');
          var gi = el('input'); gi.type = 'radio'; gi.name = 'bR'; gi.value = 'gross'; gi.checked = basis === 'gross';
          gl.appendChild(gi); gl.appendChild(document.createTextNode(' Gross (printed basis)'));
          var nl = el('label', 'lbl');
          var ni = el('input'); ni.type = 'radio'; ni.name = 'bR'; ni.value = 'net'; ni.checked = basis === 'net';
          nl.appendChild(ni); nl.appendChild(document.createTextNode(' You pay (net)'));
          gi.onchange = function () { basis = 'gross'; render(key); };
          ni.onchange = function () { basis = 'net'; render(key); };
          tog.appendChild(gl); tog.appendChild(nl);
          box.appendChild(tog);
        } else {
          box.appendChild(el('div', 'hint', 'This era\u2019s subsidy is a flat rebate \u2014 it has no per-unit net table; gross rates shown.'));
        }
        var us = (basis === 'net' && net) ? { below: net.below, above: net.above } : { below: r.below, above: r.above };
        var onNet = basis === 'net' && net;
        box.appendChild(el('div', 'hint', '\u2264 500 units' + (onNet ? ' \u00b7 you pay (after govt subsidy)' : '')));
        box.appendChild(gridFor(us.below, onNet ? 'You pay \u20B9' : 'Rate \u20B9'));
        box.appendChild(el('div', 'hint', '> 500 units' + (onNet ? ' \u00b7 you pay (after govt subsidy)' : '')));
        box.appendChild(gridFor(us.above, onNet ? 'You pay \u20B9' : 'Rate \u20B9'));
        if (onNet) {
          var ex = exampleNote(key, net);
          if (ex) box.appendChild(ex);
          box.appendChild(el('div', 'muted hint', (r.key === 'R2026'
            ? 'First 200 units free, then 201\u2013400 @4.70 and 401\u2013500 @6.30 (free-200 scheme, provisional).'
            : 'First 100 units free, then 101\u2013200 @2.35, 201\u2013400 @4.70, 401\u2013500 @6.30; over 500 keep the 100-free shape (4.70/6.30/8.40/9.45/10.50/11.55).') +
            ' Net = gross \u2212 govt subsidy per slab; the app verifies on gross.'));
        }
        body.appendChild(box);
      });
    }
    sel.onchange = function () { basis = 'net'; render(sel.value); };
    selRow.appendChild(el('label', 'lbl', 'Show era'));
    selRow.appendChild(sel);
    m.appendChild(selRow);
    m.appendChild(body);
    render(activeKey);
    var act = el('div', 'actions');
    var close = el('button', 'primary', 'Close');
    close.onclick = function () { closeModal(); };
    act.appendChild(close);
    m.appendChild(act);
    modal(m, true);
  }
  function openProfileModal() {
    var m = el('div');
    m.appendChild(el('h2', '', 'Consumers (S/C numbers)'));
    m.appendChild(el('p', 'muted', 'One row per service connection. Records, chart and history are kept separately for each S/C.'));
    var list = el('div', 'form');
    var rows = [];
    function addRow(c) {
      var row = el('div', 'crow');
      var si = el('input', '', ''); si.value = c ? c.scNo : ''; si.placeholder = 'S/C no.'; si.maxLength = 11;
      var ni = el('input', '', ''); ni.value = c ? (c.name || '') : ''; ni.placeholder = 'Consumer name';
      var ti = el('input', '', ''); ti.value = c ? (c.tariff || '') : ''; ti.placeholder = 'Tariff (LA1A)';
      var del = el('button', 'mini danger', 'remove');
      row.appendChild(si); row.appendChild(ni); row.appendChild(ti); row.appendChild(del);
      rows.push({ sc: si, name: ni, tariff: ti });
      list.appendChild(row);
      del.onclick = function () {
        for (var i = 0; i < rows.length; i++) if (rows[i].sc === si) { rows.splice(i, 1); break; }
        row.remove();
      };
    }
    DATA.consumers.forEach(addRow);
    if (!DATA.consumers.length) addRow(null);
    m.appendChild(list);
    var add = el('button', 'ghost', '+ add another S/C');
    add.onclick = function () { addRow(null); };
    m.appendChild(add);
    var connBlock = el('div');
    connBlock.appendChild(el('h4', '', 'Water connections (CMC No.)'));
    var wList = el('div', 'form');
    var wRows = [];
    function addWRow(c) {
      var row = el('div', 'crow3');
      var ci = el('input', '', ''); ci.value = c ? (c.label || c.no || '') : ''; ci.placeholder = 'CMC No.';
      var ni = el('input', '', ''); ni.value = c ? (c.name || '') : ''; ni.placeholder = 'Name';
      var del = el('button', 'mini danger', 'remove');
      row.appendChild(ci); row.appendChild(ni); row.appendChild(del);
      wRows.push({ no: ci, name: ni });
      wList.appendChild(row);
      del.onclick = function () {
        for (var i = 0; i < wRows.length; i++) if (wRows[i].no === ci) { wRows.splice(i, 1); break; }
        row.remove();
      };
    }
    DATA.waterConsumers.forEach(addWRow);
    if (!DATA.waterConsumers.length) addWRow(null);
    connBlock.appendChild(wList);
    var wAdd = el('button', 'ghost', '+ add another water connection');
    wAdd.onclick = function () { addWRow(null); };
    connBlock.appendChild(wAdd);
    connBlock.appendChild(el('h4', '', 'Property tax connections (Property No.)'));
    var pList = el('div', 'form');
    var pRows = [];
    function addPRow(c) {
      var row = el('div', 'crow3');
      var ci = el('input', '', ''); ci.value = c ? (c.label || c.no || '') : ''; ci.placeholder = 'Property No.';
      var ni = el('input', '', ''); ni.value = c ? (c.name || '') : ''; ni.placeholder = 'Name';
      var del = el('button', 'mini danger', 'remove');
      row.appendChild(ci); row.appendChild(ni); row.appendChild(del);
      pRows.push({ no: ci, name: ni });
      pList.appendChild(row);
      del.onclick = function () {
        for (var i = 0; i < pRows.length; i++) if (pRows[i].no === ci) { pRows.splice(i, 1); break; }
        row.remove();
      };
    }
    DATA.ptConsumers.forEach(addPRow);
    if (!DATA.ptConsumers.length) addPRow(null);
    connBlock.appendChild(pList);
    var pAdd = el('button', 'ghost', '+ add another property connection');
    pAdd.onclick = function () { addPRow(null); };
    connBlock.appendChild(pAdd);
    m.appendChild(connBlock);
    var docBlock = el('div', 'form');
    docBlock.appendChild(el('h4', '', 'PDFs origin folder (optional)'));
    docBlock.appendChild(el('p', 'muted hint', 'Where the original bill/receipt PDFs live (e.g. your Downloads). Used to reopen a document from the bundle when it isn\'t stored on this machine. Only the file name is stored in the bundle — never the file itself.'));
    var di = el('input', '', ''); di.value = DATA.docFolder || ''; di.placeholder = 'C:\\Users\\You\\Downloads';
    docBlock.appendChild(di);
    m.appendChild(docBlock);
    var act = el('div', 'actions');
    var save = el('button', 'primary', 'Save');
    save.onclick = function () {
      var keep = {};
      DATA.consumers.forEach(function (o) { keep[normSc(o.scNo)] = o.since || ''; });
      var out = [];
      var oldNames = {};
      DATA.consumers.forEach(function (o) { oldNames[normSc(o.scNo)] = o.name || ''; });
      rows.forEach(function (r) {
        var sc = normSc(r.sc.value);
        if (!sc) return;
        out.push({ scNo: sc, name: r.name.value.trim() || oldNames[sc] || '', tariff: r.tariff.value.trim() || '', since: keep[sc] || '' });
      });
      if (!out.length) { toast('Add at least one S/C number.', 'warn'); return; }
      DATA.consumers = out;
      var wOut = [];
      wRows.forEach(function (r) {
        var label = r.no.value.trim();
        var key = normSc(label);
        if (!key) return;
        wOut.push({ no: key, label: label, name: r.name.value.trim() });
      });
      DATA.waterConsumers = wOut;
      var pOut = [];
      pRows.forEach(function (r) {
        var label = r.no.value.trim();
        var key = normSc(label);
        if (!key) return;
        pOut.push({ no: key, label: label, name: r.name.value.trim() });
      });
      DATA.ptConsumers = pOut;
      DATA.docFolder = String(di.value || '').trim();
      DATA.profile = { name: out[0].name || '', scNo: out[0].scNo || '', tariff: out[0].tariff || '' };
      if (!curSc() || !knownSc(curSc())) setCurSc(out[0].scNo);
      persist(); renderAll(); closeModal(); toast('Consumers saved.', 'ok');
    };
    act.appendChild(save);
    m.appendChild(act);
    modal(m, true);
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('profilechip').onclick = openProfileModal;
    $('profilechip').onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); openProfileModal(); } };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('modal').classList.contains('open')) closeModal(); });
    var scSel = $('scSel');
    if (scSel) scSel.onchange = function () { setCurSc(this.value); renderAll(); };
    var utilSel = $('utilSel');
    if (utilSel) {
      utilSel.value = curUtil();
      utilSel.onchange = function () { setCurUtil(this.value); goImport(null); renderAll(); };
    }
    $('btnRates').onclick = openRatesModal;
    $('btnSave').onclick = saveBundle;
    $('btnImport').onclick = function () {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.js';
      inp.onchange = function () { if (inp.files[0]) loadBundleFile(inp.files[0]); };
      inp.click();
    };
    var billDrop = $('billDrop'), billFile = $('billFile');
    $('billDrop').addEventListener('dragover', function (e) { e.preventDefault(); billDrop.classList.add('hover'); });
    $('billDrop').addEventListener('dragleave', function () { billDrop.classList.remove('hover'); });
    $('billDrop').addEventListener('drop', function (e) {
      e.preventDefault(); billDrop.classList.remove('hover');
      var f = e.dataTransfer.files[0];
      if (f) beginBill(f);
    });
    $('billFile').onchange = function () { if (this.files[0]) beginBill(this.files[0]); this.value = ''; };
    $('vbCommit').onclick = commitBill;
    $('vbCancel').onclick = function () { S.bc = null; S.bx = {}; S.bChecks = null; $('landingTitle').textContent = 'Start with a bill'; renderStage(); };
    var recDrop = $('receiptDrop'), recFile = $('receiptFile');
    $('receiptDrop').addEventListener('click', function () { recFile.click(); });
    $('receiptFile').onchange = function () {
      var f = this.files[0];
      if (!f) return;
      S._rcFile = f;
      beginReceipt(f);
      this.value = '';
    };
    $('btnManualRcpt').onclick = showManual;
    $('rCancel').onclick = renderStage;
    $('rOk').onclick = manualOk;
    $('vrCommit').onclick = commitReceipt;
    $('vrCancel').onclick = function () { S.rc = null; S.rx = {}; renderStage(); };
    $('vuCommit').onclick = commitUtil;
    $('vuCancel').onclick = function () { S.u = null; S.ux = {}; S._ufile = null; renderStage(); };
    $('dNewBill').onclick = function () {
      S.bc = null; S.bChecks = null; S.bx = {};
      S.rc = null; S.rx = {}; S.pending = null; S.later = null; S._rcFile = null;
      S.u = null; S.ux = {}; S._ufile = null;
      var lt = landingText();
      $('landingTitle').textContent = lt.t;
      $('landingHint').textContent = lt.h;
      step(0);
      show('landing');
      billDrop.click();
    };
  }

  /* ---------- boot ---------- */
  function boot() {
    if (!window.pdfjsLib) { document.body.innerHTML = '<div style="padding:40px">pdf.min.js failed to load under file://.</div>'; return; }
    try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch (e) {}
    loadData();
    wire();
    var st = null;
    try { st = localStorage.getItem(STORE_KEY); } catch (e) {}
    // stock seed or no bundle + a stored session => restore the local backup
    if (!Array.isArray(window.__seed) && (!DATA.records || !DATA.records.length) && st) {
      try {
        var bk = JSON.parse(st);
        if (bk && Array.isArray(bk.records) && bk.records.length) {
          window.DATA = bk; DATA = bk; loadData(); window.DATA = DATA;
          persist();
          toast('Restored last session from local backup.');
        }
      } catch (e) {}
    }
    window.DATA = DATA;
    ensureRateTables();
    persist();
    renderAll();
  }

  App.loadData = loadData;
  App.persist = persist;
  App.renderAll = renderAll;
  App.beginBill = beginBill;
  App.beginReceiptFile = beginReceipt;
  App.commitBill = commitBill;
  App.commitReceipt = commitReceipt;
  App.beginUtilObj = beginUtilObj;
  App.commitUtil = commitUtil;
  App.curUtil = curUtil;
  App.setCurUtil = setCurUtil;
  App.recordsForUtil = recordsForUtil;
  App.utilUsedSet = utilUsedSet;
  App.curConn = curConn;
  App.upsertConn = upsertConn;
  App.state = S;
  App.goImport = goImport;
  App.fmtMoney = fmtMoney;
  App.bundleText = bundleText;
  App.parsePdfBytes = parsePdfBytes;
  App.migrateBundle = Calc.migrateBundle;
  App.defaultData = defaultData;
  App.ensureRateTables = ensureRateTables;
  App.RATE_TABLES_VERSION = RATE_TABLES_VERSION;
  window.App = App;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();