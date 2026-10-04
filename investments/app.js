/* Investments tracker — Fixed deposits (PNB) module.
 * Vanilla JS, no build step. Data persists to localStorage + optional bundle
 * export. PNB confirmation PDFs are parsed in-browser with the vendored pdf.js. */
(function () {
  var DATA = window.DATA || (window.DATA = { profile: { name: '' }, pans: [], meta: {}, fds: [], commodities: [], notes: '', archived: [] });
  if (!Array.isArray(DATA.archived)) DATA.archived = [];
  if (!Array.isArray(DATA.commodities)) DATA.commodities = [];
  var S = { tab: 'fd', curPan: '' };
  var LS = 'investments.session';
  var LS_PAN = 'investments.curPan';
  var SCHEMA_VERSION = 1;
  var APP_VERSION = 17;

  function el(tag, cls, text) {
    var e = document.createElement(tag || 'div');
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (e.tagName === 'BUTTON') e.type = 'button'; // never an implicit form submit (navigates to ?)
    return e;
  }
  function toast(msg, kind) {
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    document.getElementById('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function modal(node, closable) {
    var box = document.getElementById('modalBox');
    box.innerHTML = '';
    box.appendChild(node);
    var m = document.getElementById('modal');
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    m.onclick = function (e) { if (closable && e.target === m) closeModal(); };
  }
  function closeModal() {
    var m = document.getElementById('modal');
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    document.getElementById('modalBox').innerHTML = '';
  }

  /* ---- persistence ---- */
  var newerSession = false, corruptSession = false;
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(LS); } catch (e) {}
    if (raw) {
      try {
        var d = JSON.parse(raw);
        if (d && typeof d.version === 'number' && d.version > SCHEMA_VERSION) {
          newerSession = true;
          toast('Saved data is from a newer app version (schema ' + d.version + '). Update the app first — nothing was overwritten.', 'warn');
        } else if (d && Array.isArray(d.fds)) {
          DATA.fds = d.fds;
          DATA.archived = Array.isArray(d.archived) ? d.archived : [];
          // XIRR is display data derived from the record; recompute so a new
          // definition (e.g. net-of-TDS) applies to records archived by an
          // older build without a data migration.
          DATA.archived.forEach(function (a) { a.xirr = Calc.fdXirr(a); });
          var r = archiveMatured();
          if (r.moved || r.pruned) {
            flush();
            var msgs = [];
            if (r.moved) msgs.push('archived ' + r.moved + ' matured FD' + (r.moved > 1 ? 's' : '') + ' to history');
            if (r.pruned) msgs.push('removed ' + r.pruned + ' past 1.5 FYs');
            toast(msgs.join(' · '), 'ok');
          }
          if (Array.isArray(d.pans)) DATA.pans = d.pans;
          DATA.commodities = Array.isArray(d.commodities) ? d.commodities : [];
          DATA.profile = d.profile || DATA.profile;
          DATA.meta = d.meta || {};
          DATA.notes = d.notes || '';
          resyncHolders();
        } else {
          corruptSession = true;
        }
      } catch (e) {
        corruptSession = true;
        try { localStorage.setItem(LS + '.corrupt', raw); } catch (e2) {}
      }
      if (corruptSession) {
        toast('Saved session could not be read — defaults shown, raw data kept as ' + LS + '.corrupt.', 'bad');
      }
    }
    try { S.curPan = localStorage.getItem(LS_PAN) || ''; } catch (e) {}
  }
  var flushWarned = false;
  function flush() {
    if (newerSession || corruptSession) return;
    try {
      localStorage.setItem(LS, JSON.stringify({ version: SCHEMA_VERSION, pans: DATA.pans, profile: DATA.profile, meta: DATA.meta, fds: DATA.fds, commodities: DATA.commodities, notes: DATA.notes, archived: DATA.archived }));
      flushWarned = false;
    } catch (e) {
      if (!flushWarned) { flushWarned = true; toast('Storage full or sealed — changes will not be saved. Save a bundle to keep them.', 'bad'); }
    }
  }
  var persisting = 0;
  function persist() { clearTimeout(persisting); persisting = setTimeout(flush, 250); }

  /* On load: matured FDs move to history as the FULL record (entries, TDS,
   * repay account, notes, …) + XIRR; history past 1.5 FYs (1-Oct cutoff) is
   * deleted. Returns { moved, pruned }. */
  function archiveMatured(today) {
    today = today || Calc.todayISO();
    var keep = [], moved = 0;
    DATA.fds.forEach(function (fd) {
      if (Calc.fdStatus(fd, today) === 'matured') {
        var a = Object.assign({}, fd); // deep-ish copy: entries is the only array
        a.entries = (fd.entries || []).map(function (e) { return Object.assign({}, e); });
        a.xirr = Calc.fdXirr(fd);
        a.archivedAt = today;
        a.isMatured = true; // moved on/after its maturity date: still editable (final payout)
        DATA.archived.push(a);
        moved++;
      } else keep.push(fd);
    });
    if (moved) DATA.fds = keep;
    var before = DATA.archived.length;
    DATA.archived = DATA.archived.filter(function (a) { return !Calc.fdAutoRemove(a, today); });
    return { moved: moved, pruned: before - DATA.archived.length };
  }

  /* ---- lookups / filtering ---- */
  function holderOf(id) { for (var i = 0; i < DATA.pans.length; i++) if (DATA.pans[i].id === id) return DATA.pans[i]; return null; }
  /* Re-link each record to a holder by PAN so an fd that was saved before its
   * holder was registered (or whose panId went stale across a bundle import)
   * resolves name↔PAN without a manual edit-and-save. */
  function resyncHolders() {
    function fix(rec) {
      if (holderOf(rec.panId)) {
        if (rec.holder === undefined) rec.holder = (holderOf(rec.panId).name || '');
        return;
      }
      var id = panIdForPanText(rec.pan);
      if (id) {
        rec.panId = id;
        rec.holder = holderOf(id).name || rec.holder || '';
      }
    }
    DATA.fds.forEach(fix);
    (DATA.archived || []).forEach(fix);
  }
  function filterFds(list) {
    if (!S.curPan) return list;
    return list.filter(function (f) { return f.panId === S.curPan; });
  }
  function viewTitle() {
    var h = holderOf(S.curPan);
    if (h) return (h.name || h.pan || 'holder');
    return S.curPan ? 'Selected PAN' : 'All PANs';
  }

  function buildPanSel() {
    var sel = document.getElementById('panSel');
    sel.innerHTML = '';
    var all = document.createElement('option');
    all.value = ''; all.textContent = 'All PANs';
    sel.appendChild(all);
    DATA.pans.forEach(function (h) {
      var o = document.createElement('option');
      o.value = h.id; o.textContent = Calc.holderLabel(h);
      if (h.id === S.curPan) o.selected = true;
      sel.appendChild(o);
    });
    sel.style.display = DATA.pans.length ? '' : 'none';
  }
  function setProfileChip() {
    var c = document.getElementById('profilechip');
    c.textContent = DATA.profile.name || (DATA.pans.length ? DATA.pans.length + ' PAN' : 'Set profile');
  }
  function renderChips() {
    var wrap = document.getElementById('sumChips');
    wrap.textContent = '';
    var s = Calc.fdSummary(filterFds(DATA.fds));
    wrap.appendChild(el('span', 'chip', s.count ? s.count + ' FD' + (s.count > 1 ? 's' : '') : 'no FDs'));
    wrap.appendChild(el('span', 'chip', s.active + ' active · ' + s.matured + ' matured'));
    wrap.appendChild(el('span', 'chip pnl', 'invested ' + Calc.compact(s.invested)));
  }

  /* ---- form helpers ---- */
  function field(labelText, ctrl, wide) {
    var lab = el('label');
    if (wide) lab.className = 'wide';
    lab.appendChild(el('span', '', labelText));
    lab.appendChild(ctrl);
    return lab;
  }
  function textInput(id, value, ph, max) {
    var i = document.createElement('input');
    i.id = id; i.value = value == null ? '' : value;
    if (ph) i.placeholder = ph;
    if (max) i.maxLength = max;
    return i;
  }
  function numInput(id, value, ph, step) {
    var i = document.createElement('input');
    i.id = id; i.type = 'number'; i.step = step || 'any'; i.min = '0';
    i.value = value == null ? '' : value;
    if (ph) i.placeholder = ph;
    return i;
  }
  /* Text field (type DD/MM/YYYY) with a calendar button that opens a month
   * grid; tapping a day writes the value into the field. */
  function dateInput(id, value) {
    var wrap = el('span', 'dateinWrap');
    var i = document.createElement('input');
    i.id = id; i.type = 'text'; i.placeholder = 'DD/MM/YYYY'; i.maxLength = 10;
    i.setAttribute('inputmode', 'text');
    i.value = Calc.isoToDDMMYYYY(value || '');
    i.classList.add('datein');
    var b = el('button', 'dateCalBtn', '\uD83D\uDDD3\uFE0F');
    b.type = 'button'; b.title = 'Pick date from calendar';
    b.setAttribute('data-datein', id);
    b.onclick = function (e) { e.stopPropagation(); openDatePicker(i, b); };
    wrap.appendChild(i); wrap.appendChild(b);
    return wrap;
  }
  var calPop = null;
  function closeDatePicker() {
    if (calPop && calPop.el) calPop.el.remove();
    document.removeEventListener('mousedown', onDocDownPick, true);
    document.removeEventListener('keydown', onEscPick, true);
    calPop = null;
  }
  function onDocDownPick(e) { if (calPop && !calPop.el.contains(e.target)) closeDatePicker(); }
  function onEscPick(e) { if (e.key === 'Escape') { e.stopPropagation(); closeDatePicker(); } }
  function openDatePicker(field, btn) {
    if (calPop) closeDatePicker();
    var parsed = Calc.parseDDMMYYYY(field.value);
    var base = parsed ? Calc.parseISO(parsed) : new Date();
    var y = base.getFullYear(), m = base.getMonth();
    var sel = parsed || '';
    var p = el('div', 'calPop');
    p.id = 'calPop';
    var head = el('div', 'calHead');
    var back = el('button', 'calNav', '\u2039'); back.title = 'Previous month';
    var label = el('div', 'calLabel');
    var fwd = el('button', 'calNav', '\u203A'); fwd.title = 'Next month';
    head.appendChild(back); head.appendChild(label); head.appendChild(fwd);
    p.appendChild(head);
    var grid = el('div', 'calGrid');
    p.appendChild(grid);
    function render() {
      label.textContent = (m + 1) + '/' + String(y).slice(2);
      grid.textContent = '';
      ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { grid.appendChild(el('div', 'calDow', d)); });
      var first = new Date(y, m, 1);
      var startDow = first.getDay();
      var dim = new Date(y, m + 1, 0).getDate();
      var today = new Date();
      for (var k = 0; k < startDow; k++) grid.appendChild(el('div', 'calBlk'));
      for (var d = 1; d <= dim; d++) {
        (function (d) {
          var c = el('div', 'calDay', String(d));
          var iso = y + '-' + pad2(m + 1) + '-' + pad2(d);
          if (d === today.getDate() && m === today.getMonth() && y === today.getFullYear()) c.classList.add('today');
          if (iso === sel) c.classList.add('sel');
          c.onclick = function () {
            field.value = pad2(d) + '/' + pad2(m + 1) + '/' + y;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            closeDatePicker();
            field.focus();
          };
          grid.appendChild(c);
        })(d);
      }
    }
    back.onclick = function (e) { e.stopPropagation(); m--; if (m < 0) { m = 11; y--; } render(); };
    fwd.onclick = function (e) { e.stopPropagation(); m++; if (m > 11) { m = 0; y++; } render(); };
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    render();
    // anchor above/below the button
    document.body.appendChild(p);
    var r = btn.getBoundingClientRect();
    p.style.position = 'fixed';
    p.style.right = '8px';
    var below = r.bottom + p.offsetHeight + 4 < window.innerHeight;
    p.style.top = (below ? r.bottom + 4 : (r.top - p.offsetHeight - 4)) + 'px';
    calPop = { el: p };
    document.addEventListener('mousedown', onDocDownPick, true);
    document.addEventListener('keydown', onEscPick, true);
  }
  function readDate(id) { return Calc.parseDDMMYYYY(val(id)); }
  function dateErrors(ids) {
    var out = [];
    (ids || []).forEach(function (id) {
      var raw = val(id);
      if (raw && !Calc.parseDDMMYYYY(raw)) out.push('Date \u2018' + raw + '\u2019 should be DD/MM/YYYY.');
    });
    return out;
  }
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function num(id) { var s = val(id); if (!s) return null; var n = Number(s); return isNaN(n) ? null : n; }
  function errBox() { return el('p', 'err'); }
  function formShell(title) {
    var box = el('div', 'card');
    box.appendChild(el('h2', '', title));
    var form = el('form', 'form');
    box.appendChild(form);
    var err = errBox();
    box.appendChild(err);
    var actions = el('div', 'actions');
    box.appendChild(actions);
    return { box: box, form: form, err: err, actions: actions };
  }

  /* ---- PAN helpers for the FD form ---- */
  function panOptions() {
    return DATA.pans.map(function (h) { return { v: h.id, l: Calc.holderLabel(h) }; });
  }
  function panIdForPanText(pan) {
    if (!pan) return '';
    for (var i = 0; i < DATA.pans.length; i++) if (Calc.normPan(DATA.pans[i].pan) === Calc.normPan(pan)) return DATA.pans[i].id;
    return '';
  }

  /* Shared field builder + save for FD records. `rec` is a plain object with the
   * values to prefill; returns { form: el, read: fn -> record }. */
  function fdFields(rec) {
    rec = rec || {};
    var form = el('div', 'form');
    form.appendChild(field('Account number *', textInput('fAcc', rec.account, '130910DP…')));
    form.appendChild(field('Type', selectControl('fType', [
      { v: 'fd', l: 'FD — fixed deposit (compounded)' },
      { v: 'scss', l: 'SCSS — Senior Citizens’ Saver Scheme (paid out)' },
      { v: 'rbi', l: 'RBI FRB — floating-rate bond (paid out)' }
    ], Calc.normFdType(rec))));
    var panOpts = panOptions();
    if (panOpts.length) form.appendChild(field('PAN holder', selectControl('fPanId', panOpts, rec.panId || '')));
    form.appendChild(field('PAN (if holder not listed)', textInput('fPan', rec.pan, 'ABCDE1234F')));
    form.appendChild(field('Invested amount (₹) *', numInput('fAmt', rec.amount, 'e.g. 400000')));
    form.appendChild(field('Interest rate (% p.a.) *', numInput('fRate', rec.rate, 'e.g. 8.1')));
    form.appendChild(field('Issue date *', dateInput('fIssue', rec.issueDate)));
    form.appendChild(field('Maturity date *', dateInput('fMaturity', rec.maturityDate)));
    form.appendChild(field('Term (days, auto)', numInput('fDays', rec.days, 'blank = from dates')));
    form.appendChild(field('Maturity value (₹, bank)', numInput('fMv', rec.maturityValue, 'leave blank to compute')));
    form.appendChild(field('TDS rate (%)', numInput('fTds', rec.tdsRate == null ? (Calc.normFdType(rec) === 'fd' ? 10 : 0) : rec.tdsRate, 'SCSS/FRB: 0 unless interest > ₹50,000')));
    form.appendChild(field('Interest type', selectControl('fImode', [{ v: 'compound', l: 'Compound (credited in)' }, { v: 'payout', l: 'Payout (paid out)' }], Calc.normInterestMode(rec))));
    form.appendChild(field('Repay account', textInput('fRepay', rec.repayAc, 'repayment a/c')));
    form.appendChild(field('Notes', textInput('fNotes', rec.notes, ''), true));
    // Picking SCSS / FRB in an open form flips TDS to 0 and interest type to
    // payout (they pay out and are TDS-free by default); back to FD restores 10.
    // Maturity value is also hidden: payout instruments return only the
    // principal at maturity, so a bank-stated value is meaningless for them.
    // Note: query within the local `form`, not the document — the form isn't
    // in the DOM yet when fdFields() runs (buildFdForm appends it later).
    var typeSel = form.querySelector('#fType');
    var mvField = form.querySelector('#fMv');
    if (mvField) mvField = mvField.parentNode; // the <label> wrapper
    function syncMvVisibility() {
      if (mvField) mvField.style.display =
        Calc.normFdType(typeSel.value) !== 'fd' ? 'none' : '';
    }
    syncMvVisibility();
    if (typeSel) typeSel.addEventListener('change', function () {
      var notFd = Calc.normFdType(typeSel.value) !== 'fd';
      var tds = form.querySelector('#fTds');
      var imode = form.querySelector('#fImode');
      if (notFd) { if (imode) imode.value = 'payout'; if (tds) tds.value = '0'; }
      else { if (imode && imode.value === 'payout') imode.value = 'compound'; if (tds && !tds.value) tds.value = '10'; }
      syncMvVisibility();
    });
    function read() {
      var panId = document.getElementById('fPanId') ? val('fPanId') : (rec.panId || '');
      var t = document.getElementById('fType') ? val('fType') : 'fd';
      var notFd = Calc.normFdType(t) !== 'fd';
      var tdsVal = num('fTds');
      var rec2 = {
        account: val('fAcc').toUpperCase(),
        type: t,
        panId: panId || panIdForPanText(val('fPan')),
        pan: val('fPan'),
        amount: num('fAmt'),
        rate: num('fRate'),
        issueDate: readDate('fIssue'),
        maturityDate: readDate('fMaturity'),
        maturityValue: notFd ? 0 : num('fMv'),
        tdsRate: notFd ? (tdsVal == null ? 0 : tdsVal) : tdsVal,
        interestMode: notFd ? 'payout' : (document.getElementById('fImode') ? val('fImode') : (rec.interestMode || 'compound')),
        repayAc: val('fRepay'),
        notes: val('fNotes')
      };
      rec2.entries = rec.entries ? rec.entries.slice() : [];
      var d = num('fDays');
      rec2.days = d != null ? d : (rec2.issueDate && rec2.maturityDate ? daysBetween(rec2.issueDate, rec2.maturityDate) : (rec.days != null ? rec.days : null));
      rec2.holder = (holderOf(rec2.panId) && holderOf(rec2.panId).name) || (rec.holder || '');
      return rec2;
    }
    return { form: form, read: read };
  }

  /* Same slip twice = same account number, so a duplicate import is detected by
   * account. Returns the existing FD or null. Ignored when editing (edit path). */
  function duplicateFd(rec, edit, o) {
    if (edit) return null;
    var a = (rec.account || '').trim().toUpperCase();
    if (!a) return null;
    var hit = null;
    DATA.fds.forEach(function (x) { if ((x.account || '').trim().toUpperCase() === a) hit = x; });
    if (!hit) (DATA.archived || []).forEach(function (x) { if ((x.account || '').trim().toUpperCase() === a) hit = x; });
    return hit;
  }

  function commitFd(rec, edit, o, arch) {
    if (edit && arch) {
      var i2 = -1;
      (DATA.archived || []).forEach(function (x, i) { if (x.id === o.id) i2 = i; });
      DATA.archived[i2] = Object.assign({ id: o.id, archivedAt: o.archivedAt, isMatured: o.isMatured }, rec);
      DATA.archived[i2].xirr = Calc.fdXirr(DATA.archived[i2]); // refresh XIRR after editing maturity value etc.
    } else if (edit) {
      var idx = -1;
      DATA.fds.forEach(function (x, i) { if (x.id === o.id) idx = i; });
      DATA.fds[idx] = Object.assign({ id: o.id, createdAt: o.createdAt }, rec);
    } else {
      DATA.fds.push(Object.assign({ id: Calc.uid('fd'), createdAt: new Date().toISOString() }, rec));
    }
  }

  /* ---- FD add/edit form ----
   * fd = record to edit (null for a new FD); dup = record to prefill from
   * (new FD copying every field — dates, payouts included — with a fresh
   * account number). */
  function buildFdForm(fd, dup, arch) {
    var edit = !!fd;
    var o = fd || (dup ? {
      type: dup.type,
      panId: dup.panId, pan: dup.pan, amount: dup.amount, rate: dup.rate,
      days: dup.days, tdsRate: dup.tdsRate, interestMode: dup.interestMode,
      repayAc: dup.repayAc, holder: dup.holder,
      issueDate: dup.issueDate, maturityDate: dup.maturityDate, maturityValue: dup.maturityValue,
      entries: dup.entries ? dup.entries.map(function (e) { return Object.assign({}, e); }) : []
    } : {});
    var f = formShell(edit ? (arch ? 'Edit FD (history)' : 'Edit FD') : (dup ? 'Duplicate FD' : 'Add FD'));
    var actions = f.actions;
    var ff = fdFields(o);
    f.form.appendChild(ff.form);
    var dWarn = el('div', 'dateWarn');
    dWarn.style.display = 'none';
    f.form.appendChild(dWarn);
    function refreshDateCheck() {
      var chk = Calc.fdDateCheck(ff.read());
      dWarn.textContent = chk ? ('Date / tenure mismatch: ' + chk) : '';
      dWarn.style.display = chk ? 'block' : 'none';
    }
    ['fIssue', 'fMaturity', 'fDays'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) { e.addEventListener('input', refreshDateCheck); e.addEventListener('change', refreshDateCheck); }
    });
    if (edit) refreshDateCheck();
    var save = el('button', 'primary', edit ? 'Save changes' : 'Add FD');
    save.onclick = function () {
      var rec = ff.read();
      refreshDateCheck(); // non-blocking date/tenure sanity check
      var errs = Calc.validFd(rec).concat(dateErrors(['fIssue', 'fMaturity']));
      if (errs.length) { f.err.textContent = errs.join('  |  '); return; }
      var dup = duplicateFd(rec, edit, o);
      if (dup && dup.id !== o.id) { f.err.textContent = 'This FD is already in your list (account ' + dup.account + '). Open it to edit instead.'; return; }
      commitFd(rec, edit, o, arch);
      persist(); closeModal(); renderAll();
      toast(edit ? 'FD updated.' : 'FD added.', 'ok');
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    actions.appendChild(save); actions.appendChild(cancel);
    modal(f.box, true);
  }
  function selectControl(id, opts, value) {
    var s = document.createElement('select');
    s.id = id;
    opts.forEach(function (o) {
      var x = document.createElement('option');
      x.value = o.v; x.textContent = o.l;
      if (String(o.v) === String(value)) x.selected = true;
      s.appendChild(x);
    });
    return s;
  }
  function daysBetween(a, b) {
    var x = Calc.parseISO(a), y = Calc.parseISO(b);
    if (!x || !y) return null;
    return Math.round((y - x) / 86400000);
  }

  /* ---- render: FD list ---- */
  function statusBadge(fd) {
    var s = Calc.fdStatus(fd);
    if (s === 'active') return el('span', 'badge b-active', 'Active');
    if (s === 'matured') return el('span', 'badge b-matured', 'Matured');
    return el('span', 'badge b-unknown', '—');
  }
  function fdRow(fd) {
    var row = el('div', 'mrow fdRow');
    row.setAttribute('data-account', fd.account || '');
    var today = Calc.todayISO();
    var status = Calc.fdStatus(fd, today);

    var main = el('div');
    main.appendChild(el('div', 'fdAcc', fd.account || 'No account'));
    var meta = el('div', 'fdMeta', Calc.holderLabel(holderOf(fd.panId)) || 'Unassigned');
    if (fd.holder && !fd.panId) meta.textContent = fd.holder + (fd.pan ? ' · ' + fd.pan : '');
    main.appendChild(meta);

    var cells = el('div', 'rowCells');
    cells.style.justifyContent = 'flex-end';
    var exp = Calc.fdExpectedTotal(fd);
    var usedMv = fd.maturityValue > 0;
    var eSum = Calc.fdEntrySummary(fd);
    cells.appendChild(fdCell('Invested', Calc.inr(fd.amount)));
    cells.appendChild(fdCell('Rate', fd.rate != null ? fd.rate + '%' : '—'));
    if (eSum.count) {
      var fyRow = Calc.fdFySummary([fd]);
      cells.appendChild(fdCell('Interest (paid)', Calc.inr(eSum.net),
        eSum.count + ' payout' + (eSum.count > 1 ? 's' : '') + ' · TDS ' + Calc.inr(eSum.tax) +
        '\n' + fyRow.cur.label + ': ' + Calc.inr(fyRow.cur.interest) + ' int · TDS ' + Calc.inr(fyRow.cur.tax) +
        '\n' + fyRow.prev.label + ': ' + Calc.inr(fyRow.prev.interest) + ' int · TDS ' + Calc.inr(fyRow.prev.tax)));
      var payout = Calc.normInterestMode(fd) === 'payout';
      cells.appendChild(fdCell('Worth now', Calc.inr(payout ? (fd.amount || 0) : eSum.after),
        payout ? 'principal (interest paid out)' : 'invested + interest paid out'));
    } else {
      cells.appendChild(fdCell('Interest', Calc.inr(Calc.fdInterest(fd)), !usedMv ? 'simple interest (est.)' : 'from PNB value'));
      var expTip = usedMv ? 'bank-stated maturity value' : (Calc.normFdType(fd) !== 'fd' ? 'principal returned at maturity (interest paid out)' : 'computed (P + simple interest)');
      cells.appendChild(fdCell('Expected total', Calc.inr(exp), expTip));
    }
    cells.appendChild(fdCell('Maturity', Calc.fmtDate(fd.maturityDate), fd.maturityDate ? ('issued ' + Calc.fmtDate(fd.issueDate)) : ''));

    var badges = el('div', 'rowCols');
    if (Calc.normFdType(fd) !== 'fd') badges.appendChild(el('span', 'badge b-type', Calc.fdTypeLabel(fd.type)));
    badges.appendChild(statusBadge(fd));
    if (!eSum.count) {
      var tax = Calc.fdTax(fd);
      if (tax > 0) badges.appendChild(el('span', 'badge b-partial', 'TDS ' + Calc.inr(tax)));
    }

    var acts = el('div', 'row-actions');
    var intb = el('button', 'mini', 'interest');
    intb.onclick = function () { buildInterestForm(fd); };
    var ed = el('button', 'mini', 'edit');
    ed.onclick = function () { buildFdForm(fd); };
    var dup = el('button', 'mini', 'duplicate');
    dup.title = 'New FD with the same holder, rate, TDS and repayment details — set a new account number and dates';
    dup.onclick = function () { buildFdForm(null, fd); };
    var del = el('button', 'mini danger', 'del');
    del.onclick = function () { deleteFd(fd); };
    acts.appendChild(intb); acts.appendChild(ed); acts.appendChild(dup); acts.appendChild(del);

    row.appendChild(main);
    row.appendChild(badges);
    row.appendChild(acts);
    main.appendChild(cells);
    return row;
  }
  function fdCell(k, v, title) {
    var c = el('div', 'fdCell');
    c.appendChild(el('small', '', k));
    c.appendChild(el('b', '', v == null ? '—' : String(v)));
    if (title) c.title = title;
    return c;
  }
  function deleteFd(fd) {
    confirmDel('Delete FD \u2018' + (fd.account || 'No account') + '\u2019? This cannot be undone.', function () {
      DATA.fds = DATA.fds.filter(function (x) { return x.id !== fd.id; });
      persist(); renderAll();
      toast('FD deleted.', 'warn');
    });
  }

  /* ---- Interest ledger (per-payout rows) ---- */
  function fdById(id) { for (var i = 0; i < DATA.fds.length; i++) if (DATA.fds[i].id === id) return DATA.fds[i]; return null; }
  /* Works for an active FD or a freshly-archived matured record, so the final
   * (maturity-day) payout can still be recorded after the FD moved to history. */
  function buildInterestForm(fd) {
    if (fd.archivedAt) fd.xirr = Calc.fdXirr(fd); // refresh the archived XIRR after edits
    var f = formShell('Interest \u2014 ' + (fd.account || 'No account'));
    f.box.id = 'interestModal';
    var mode = Calc.normInterestMode(fd);
    f.form.appendChild(field('Interest type', selectControl('imMode', [
      { v: 'compound', l: 'Compound (credited into principal)' },
      { v: 'payout', l: 'Payout (paid out, principal fixed)' }
    ], mode)));
    f.form.appendChild(el('p', 'hint', mode === 'compound'
      ? 'Each payout is credited into the running principal; the "calc" column is a simple-interest estimate on that running amount, to cross-check against the bank figure.'
      : 'Each payout is paid out; the "calc" column is a simple-interest estimate on the original principal, to cross-check against the bank figure.'));
    var box = el('div', 'intList');
    f.form.appendChild(box);

    // -1 = adding a new payout; >= 0 = editing entries[editIndex].
    var editIndex = -1;
    function startEdit(entry) {
      editIndex = fd.entries.indexOf(entry);
      document.getElementById('imDate').value = Calc.isoToDDMMYYYY(entry.date || '');
      document.getElementById('imInt').value = entry.int;
      document.getElementById('imTax').value = entry.tax || 0;
      saveBtn.textContent = 'Save changes';
      f.err.textContent = '';
    }
    renderInterestList(fd, box, false, startEdit);
    var addForm = el('div', 'intAdd');
    addForm.appendChild(field('Date', dateInput('imDate', '')));
    addForm.appendChild(field('Gross interest (₹)', numInput('imInt', '', 'e.g. 7589')));
    addForm.appendChild(field('TDS (₹)', numInput('imTax', '', 'e.g. 759')));
    addForm.appendChild(el('p', 'hint', 'Leave TDS blank for 0. Net = gross \u2212 TDS.'));
    f.form.appendChild(addForm);
    var saveBtn = el('button', 'primary', 'Add payout');
    saveBtn.onclick = function () {
      var d = readDate('imDate');
      var rawD = val('imDate');
      var g = num('imInt');
      if (rawD && !d) { f.err.textContent = 'Date should be DD/MM/YYYY.'; return; }
      if (!d || !(g > 0)) { f.err.textContent = 'Enter a date (DD/MM/YYYY) and a gross interest amount.'; return; }
      var t = num('imTax');
      if (fd.entries == null) fd.entries = [];
      // Collision check ignores the row being edited, so changing only its date
      // is fine, but reusing another payout's date + gross is still flagged.
      var dupE = fd.entries.some(function (e, i) { return i !== editIndex && e.date === d && e.int === g; });
      if (dupE) { f.err.textContent = 'A payout for ' + d + ' (₹' + Calc.inr(g) + ') is already recorded.'; return; }
      if (editIndex >= 0) {
        fd.entries[editIndex] = { date: d, int: g, tax: t || 0 };
      } else {
        fd.entries.push({ date: d, int: g, tax: t || 0 });
      }
      // Keep the ledger chronologically ordered on disk too, so a refresh shows
      // the same date-sorted table (earliest first).
      fd.entries.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      fd.interestMode = val('imMode') || mode;
      persist(); renderAll(); buildInterestForm(fd);
      toast(editIndex >= 0 ? 'Payout updated.' : 'Payout added.', 'ok');
    };
    var cancel = el('button', 'ghost', 'Close');
    cancel.onclick = closeModal;
    f.actions.appendChild(saveBtn); f.actions.appendChild(cancel);
    modal(f.box, true);
  }
  function renderInterestList(fd, box, readOnly, onEdit) {
    box.textContent = '';
    var rows = Calc.fdEntries(fd);
    if (!rows.length) {
      box.appendChild(el('p', 'muted', readOnly ? 'No payouts were recorded for this FD.' : 'No payouts recorded yet.'));
      return;
    }
    var tbl = el('table', 'intTable');
    var thead = el('tr');
    ['Date', 'Days', 'Gross', 'TDS', 'Net', 'Worth after', 'Calc (est.)'].concat(readOnly ? [] : ['']).forEach(function (h) { thead.appendChild(el('th', '', h)); });
    tbl.appendChild(thead);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', '', Calc.fmtDate(r.date)));
      tr.appendChild(el('td', '', r.days != null ? String(r.days) : '\u2014'));
      tr.appendChild(el('td', '', Calc.inr(r.int)));
      tr.appendChild(el('td', '', Calc.inr(r.tax)));
      tr.appendChild(el('td', 'num', Calc.inr(r.net)));
      tr.appendChild(el('td', 'num', Calc.inr(r.after)));
      var calc = el('td', 'num', r.expected != null ? Calc.inr(r.expected) : '\u2014');
      if (r.expected != null && r.int > 0) {
        var diff = r.int - r.expected;
        calc.title = 'bank \u2212 calc = ' + Calc.inr(diff);
        calc.className = 'num ' + (Math.abs(diff) <= 5 ? 'ok' : 'warn');
      }
      tr.appendChild(calc);
      if (!readOnly) {
        var act = el('td', '');
        var ed = el('button', 'mini', '\u270E\uFE0F');
        ed.type = 'button'; // inside the form — without this it submits (navigates to ?)
        ed.title = 'Edit this payout';
        ed.onclick = function () { if (onEdit) onEdit(fd.entries[r.idx]); };
        var rm = el('button', 'mini danger', '\u00d7');
        rm.type = 'button';
        rm.title = 'Delete this payout';
        rm.onclick = function () {
          confirmDel('Delete the payout on ' + Calc.fmtDate(r.date) + '?', function () {
            fd.entries = fd.entries.filter(function (e) { return !(e.date === r.date && e.int === r.int); });
            persist(); renderAll(); buildInterestForm(fd);
          });
        };
        act.appendChild(ed);
        act.appendChild(rm);
        tr.appendChild(act);
      }
      tbl.appendChild(tr);
    });
    box.appendChild(tbl);
    var s = Calc.fdEntrySummary(fd);
    box.appendChild(el('p', 'hint', 'Total: ' + s.count + ' payout' + (s.count > 1 ? 's' : '') + ' \u00b7 gross ' + Calc.inr(s.gross) + ' \u00b7 TDS ' + Calc.inr(s.tax) + ' \u00b7 net interest ' + Calc.inr(s.net) + ' \u00b7 worth now ' + Calc.inr(s.after)));
    if (s.count) {
      var fy = Calc.fdFySummary([fd]);
      var fyBits = [
        fy.cur.label + ': ' + Calc.inr(fy.cur.interest) + ' int \u00b7 TDS ' + Calc.inr(fy.cur.tax),
        fy.prev.label + ': ' + Calc.inr(fy.prev.interest) + ' int \u00b7 TDS ' + Calc.inr(fy.prev.tax)
      ];
      var olderCount = s.count - fy.cur.count - fy.prev.count;
      if (olderCount > 0) {
        fyBits.push('older FYs: ' + olderCount + ' payout' + (olderCount > 1 ? 's' : '') + ' \u00b7 ' + Calc.inr(s.gross - fy.cur.interest - fy.prev.interest) + ' int \u00b7 TDS ' + Calc.inr(s.tax - fy.cur.tax - fy.prev.tax));
      }
      box.appendChild(el('p', 'hint', 'By financial year (recorded payouts, 1 Apr \u2013 31 Mar) \u2014 ' + fyBits.join('  \u00b7  ')));
    }
  }

  function renderFd() {
    var sec = document.getElementById('sec-fd');
    sec.innerHTML = '';
    var card = el('div', 'card');
    var head = el('div', 'cardHead');
    head.appendChild(el('h2', '', 'Fixed deposits'));
    head.appendChild(el('span', 'chip', 'view: ' + viewTitle()));
    head.appendChild(el('div', 'spacer'));
    var add = el('button', 'primary', '+ Add FD');
    add.onclick = function () { buildFdForm(null); };
    var imp = el('button', 'ghost', 'Import PNB PDF');
    imp.onclick = function () { document.getElementById('pdfFile').click(); };
    head.appendChild(add); head.appendChild(imp);
    card.appendChild(head);

    var s = Calc.fdSummary(filterFds(DATA.fds));
    if (s.count) {
      /* FY tiles must include MATURED FDs too: interest credited to an FD in a
       * financial year is that year's income even if the deposit matured before
       * the year end, so excluding the archive under-reports the TDS figure. */
      var fy = Calc.fdFySummary(filterFds(DATA.fds).concat(filterFds(DATA.archived || [])));
      var closeNow = 0, closeNowCount = 0;
      filterFds(DATA.fds).forEach(function (fd) {
        var v = Calc.fdCloseNowValue(fd);
        if (v != null) { closeNow += v; closeNowCount++; }
      });
      var kv = el('div', 'kv inline');
      kv.appendChild(kvin('Invested', Calc.inr(s.invested)));
      kv.appendChild(kvin('Close now', closeNowCount ? Calc.inr(closeNow) : '—', 'pos'));
      kv.appendChild(kvin('Expected total', Calc.inr(s.expected)));
      kv.appendChild(kvin(fy.cur.label + ' interest', fy.cur.count ? Calc.inr(fy.cur.interest) : '₹0', fy.cur.count ? 'pos' : 'muted'));
      kv.appendChild(kvin(fy.cur.label + ' TDS', fy.cur.count ? Calc.inr(fy.cur.tax) : '₹0', fy.cur.count ? '' : 'muted'));
      kv.appendChild(kvin(fy.prev.label + ' interest', fy.prev.count ? Calc.inr(fy.prev.interest) : '₹0', fy.prev.count ? 'pos' : 'muted'));
      kv.appendChild(kvin(fy.prev.label + ' TDS', fy.prev.count ? Calc.inr(fy.prev.tax) : '₹0', fy.prev.count ? '' : 'muted'));
      card.appendChild(kv);
      card.appendChild(el('p', 'hint', 'FY = 1 Apr – 31 Mar, from recorded payouts only, and includes matured FDs (interest credited in that FY is that FY’s income). Close now = principal + credited interest + simple interest accrued to today at the current rate (ignores the bank\u2019s break penalty of ~1% on accrued interest).'));
    }

    if (!filterFds(DATA.fds).length) {
      card.appendChild(el('p', 'muted', 'No active FDs. Add one manually or import a PNB confirmation PDF.'));
    } else {
      Calc.sortFds(filterFds(DATA.fds)).forEach(function (fd) { card.appendChild(fdRow(fd)); });
    }
    sec.appendChild(card);
    renderArchived(sec);
  }
  function renderArchived(sec) {
    var list = filterFds(DATA.archived || []);
    if (!list.length) return;
    var card = el('div', 'card');
    var head = el('div', 'cardHead');
    head.appendChild(el('h2', '', 'Matured · history'));
    head.appendChild(el('span', 'chip', 'kept till 1.5 FYs past maturity, then removed each 1 Oct'));
    head.appendChild(el('div', 'spacer'));
    var clr = el('button', 'ghost', 'Clear history');
    clr.onclick = function () {
      confirmDel('Clear the ' + list.length + ' archived record' + (list.length > 1 ? 's' : '') + ' for this holder?', function () {
        DATA.archived = (DATA.archived || []).filter(function (a) { return filterFds([a]).length === 0; });
        persist(); renderAll();
      });
    };
    head.appendChild(clr);
    card.appendChild(head);
    var tbl = el('table', 'intTable archTable');
    var thead = el('tr');
    ['Account', 'Invested', 'Rate', 'Issue → Maturity', 'Interest (net)', 'TDS', 'Maturity value', 'XIRR', ''].forEach(function (h) { thead.appendChild(el('th', '', h)); });
    tbl.appendChild(thead);
    list.slice().sort(function (a, b) { return (b.maturityDate || '').localeCompare(a.maturityDate || ''); }).forEach(function (a) {
      var sum = Calc.fdEntrySummary(a);
      var tr = el('tr');
      tr.appendChild(el('td', '', a.account || '—'));
      tr.appendChild(el('td', '', Calc.inr(a.amount)));
      tr.appendChild(el('td', '', a.rate != null ? a.rate + '%' : '—'));
      tr.appendChild(el('td', '', Calc.fmtDate(a.issueDate) + ' → ' + Calc.fmtDate(a.maturityDate)));
       var fyA = sum.count ? Calc.fdFySummary([a]) : null;
       var fyTip = fyA
         ? '\n' + fyA.cur.label + ': ' + Calc.inr(fyA.cur.interest) + ' int · TDS ' + Calc.inr(fyA.cur.tax) +
           '\n' + fyA.prev.label + ': ' + Calc.inr(fyA.prev.interest) + ' int · TDS ' + Calc.inr(fyA.prev.tax)
         : '';
       var netCell = el('td', 'num', sum.count ? Calc.inr(sum.net) : '—');
       var taxCell = el('td', 'num', sum.count ? Calc.inr(sum.tax) : '—');
       if (sum.count) {
         netCell.title = 'Net interest by financial year (recorded payouts, 1 Apr – 31 Mar)' + fyTip;
         taxCell.title = 'TDS by financial year (recorded payouts, 1 Apr – 31 Mar)' + fyTip;
       }
       tr.appendChild(netCell);
       tr.appendChild(taxCell);
       tr.appendChild(el('td', 'num', a.maturityValue > 0 ? Calc.inr(a.maturityValue) : '—'));
      var x = el('td', 'num', a.xirr != null ? (a.xirr * 100).toFixed(2) + '% p.a.' : '—');
      if (sum.count) x.title = 'XIRR (net of TDS) from initial amount, final value and ' + sum.count + ' recorded payout' + (sum.count > 1 ? 's' : '');
      tr.appendChild(x);
      var act = el('td', '');
      // Editable if it matured on the day it was archived — either the new flag,
      // or an already-archived record where archivedAt === maturityDate (covers
      // FDs that matured today under the previous version; no migration needed).
      if (a.isMatured || (a.archivedAt && a.maturityDate && a.archivedAt === a.maturityDate)) {
        var itb = el('button', 'mini', 'interest');
        itb.title = 'Record the final (maturity-day) interest payout';
        itb.onclick = function () { buildInterestForm(a); };
        act.appendChild(itb);
      }
       var det = el('button', 'mini', 'payouts');
       var edA = el('button', 'mini', 'edit');
       edA.title = 'Edit this record (e.g. fill in the bank maturity value, rate or TDS)';
       edA.onclick = function () { buildFdForm(a, null, true); };
       var dupA = el('button', 'mini', 'duplicate');
       dupA.title = 'New FD with the same holder, rate, TDS and repayment details — set a new account number and dates';
       dupA.onclick = function () { buildFdForm(null, a); };
       var rm = el('button', 'mini danger', '×');
       rm.onclick = function () {
         confirmDel('Delete this archived record (and its payout history)?', function () {
           DATA.archived = (DATA.archived || []).filter(function (o) {
             return !(o.account === a.account && o.maturityDate === a.maturityDate && o.archivedAt === a.archivedAt);
           });
           persist(); renderAll();
         });
       };
        act.appendChild(det); act.appendChild(edA); act.appendChild(dupA); act.appendChild(rm);
      tr.appendChild(act);
      tbl.appendChild(tr);
      // full record detail row (collapsed): payout ledger + all stored fields
      var drow = el('tr', 'archDetail');
      drow.hidden = true;
      drow.setAttribute('data-for', a.account + '|' + a.maturityDate + '|' + a.archivedAt);
      var cell = el('td', 'archDetailCell');
      cell.setAttribute('colspan', '9');
      cell.appendChild(archivedDetail(a));
      drow.appendChild(cell);
      tbl.appendChild(drow);
      det.onclick = function () {
        drow.hidden = !drow.hidden;
        det.textContent = drow.hidden ? 'payouts' : 'hide';
      };
    });
    var wrap = el('div', 'archWrap');
    wrap.appendChild(tbl);
    card.appendChild(wrap);
    var chartPts = list.filter(function (a) { return a.xirr != null && a.maturityDate; })
      .map(function (a) { return { date: a.maturityDate, v: a.xirr, account: a.account || '' }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    if (chartPts.length >= 1) {
      var cw = el('div', 'xirrChart');
      cw.appendChild(el('h3', '', 'XIRR by maturity date'));
      cw.appendChild(xirrChart(chartPts));
      cw.appendChild(el('p', 'hint', 'Annualized return (XIRR) for each matured FD, oldest maturity first.'));
      card.appendChild(cw);
    }
    card.appendChild(el('p', 'hint', 'Matured FDs are kept in history for 1.5 financial years (removed each 1 Oct), with their full payout ledger. XIRR is net of TDS: initial amount, final value less TDS withheld, and (for payout-mode bonds) the recorded net payouts.'));
    sec.appendChild(card);
  }
  /* Expandable full record for an archived FD: payout ledger + all fields. */
  function archivedDetail(a) {
    var wrap = el('div');
    var info = el('p', 'hint',
      'Mode: ' + Calc.normInterestMode(a) +
      (a.tdsRate != null ? ' · TDS rate ' + a.tdsRate + '%' : '') +
      (a.repayAc ? ' · Repay a/c ' + a.repayAc : '') +
      (a.pan ? ' · PAN ' + a.pan : '') +
      (a.name ? ' · ' + a.name : '') +
      (a.notes ? ' · ' + a.notes : '') +
      ' · archived ' + Calc.fmtDate(a.archivedAt));
    wrap.appendChild(info);
    var box = el('div', 'intList');
    renderInterestList(a, box, true);
    wrap.appendChild(box);
    return wrap;
  }
  function xirrChart(pts) {
    var W = 640, H = 220, m = { l: 44, r: 16, t: 16, b: 30 };
    var pw = W - m.l - m.r, ph = H - m.t - m.b;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'xirrSvg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'XIRR by maturity date');
    function S(tag, at, txt) {
      var e = document.createElementNS(ns, tag);
      for (var k in at) e.setAttribute(k, at[k]);
      if (txt != null) e.textContent = txt;
      svg.appendChild(e);
      return e;
    }
    function txt(tag, at, s) {
      var e = document.createElementNS(ns, tag);
      for (var k in at) e.setAttribute(k, at[k]);
      e.textContent = s;
      svg.appendChild(e);
      return e;
    }
    var minD = Calc.parseISO(pts[0].date).getTime();
    var maxD = Calc.parseISO(pts[pts.length - 1].date).getTime();
    var span = (maxD - minD) || 1;
    var vals = pts.map(function (p) { return p.v * 100; });
    var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
    // Integer-percentage scale fitted to the data (e.g. 5..8) so small
    // differences between FDs are readable instead of a full-height spike.
    var lo = Math.floor(minV), hi = Math.ceil(maxV);
    if (hi - lo < 2) { lo -= 1; hi += 1; }
    lo -= 0.15; hi += 0.15; // headroom so edge dots/labels are not clipped
    function X(d) { return m.l + (d - minD) / span * pw; }
    function Y(v) { return m.t + (1 - (v - lo) / (hi - lo)) * ph; }
    // gridlines + y labels on whole percents
    var step = (hi - lo) <= 5 ? 1 : Math.ceil((hi - lo) / 5), i;
    for (i = Math.max(lo, Math.ceil(lo)); i <= hi; i += step) {
      var yy = Y(i);
      S('line', { x1: m.l, y1: yy, x2: W - m.r, y2: yy, class: 'grid' });
      txt('text', { x: m.l - 6, y: yy + 3, class: 'ax', 'text-anchor': 'end' }, i);
    }
    // zero baseline (only when 0 is in range)
    if (lo <= 0 && hi >= 0) S('line', { x1: m.l, y1: Y(0), x2: W - m.r, y2: Y(0), class: 'zero' });
    // x labels (first, mid, last maturity date)
    txt('text', { x: m.l, y: H - 8, class: 'ax', 'text-anchor': 'start' }, Calc.fmtDate(pts[0].date));
    if (pts.length > 2) txt('text', { x: m.l + pw / 2, y: H - 8, class: 'ax', 'text-anchor': 'middle' }, Calc.fmtDate(pts[Math.floor(pts.length / 2)].date));
    txt('text', { x: W - m.r, y: H - 8, class: 'ax', 'text-anchor': 'end' }, Calc.fmtDate(pts[pts.length - 1].date));
    // line + points
    var path = pts.map(function (p, idx) {
      return (idx ? 'L' : 'M') + X(Calc.parseISO(p.date).getTime()).toFixed(1) + ' ' + Y(p.v * 100).toFixed(1);
    }).join(' ');
    S('path', { d: path, class: 'line' });
    pts.forEach(function (p) {
      var c = S('circle', { cx: X(Calc.parseISO(p.date).getTime()).toFixed(1), cy: Y(p.v * 100).toFixed(1), r: 4, class: 'dot' });
      var ti = document.createElementNS(ns, 'title');
      ti.textContent = (p.account || '') + ' · ' + Calc.fmtDate(p.date) + ' · ' + (p.v * 100).toFixed(2) + '% p.a.';
      c.appendChild(ti);
    });
    return svg;
  }
  function kvin(label, value, cls) {
    var d = el('div');
    d.appendChild(el('b', '', label));
    d.appendChild(el('span', cls || '', value == null ? '—' : String(value)));
    return d;
  }

  /* ---- PDF import ---- */
  function setPdfBusy(busy, msg) {
    document.getElementById('btnPdf').disabled = busy;
    if (msg) document.getElementById('btnPdf').textContent = msg;
  }
  function importPdf(file) {
    if (!file) return;
    if (!window.pdfjsLib) { toast('PDF engine not available.', 'bad'); return; }
    var pdfjsLib = window.pdfjsLib;
    setPdfBusy(true, 'Reading…');
    var rd = new FileReader();
    rd.onload = function () {
      var buf = new Uint8Array(rd.result);
        FdParse.parsePdf(buf, pdfjsLib, file.name).then(function (parsed) {
          setPdfBusy(false, 'Import PNB FD PDF');
          if (parsed.complete) autoImport(parsed, file.name);
          else importPreview(parsed, file.name);
        }).catch(function (e) {
        setPdfBusy(false, 'Import PNB FD PDF');
        toast('Could not read that PDF: ' + (e && e.message ? e.message : 'error'), 'bad');
      });
    };
    rd.onerror = function () { setPdfBusy(false, 'Import PNB FD PDF'); toast('Could not read the file.', 'bad'); };
    rd.readAsArrayBuffer(file);
  }
  /* Complete reads skip the review step and go straight into the list. */
  function autoImport(parsed, fname) {
    var rec = {
      account: (parsed.account || '').toUpperCase(),
      panId: panIdForPanText(parsed.pan),
      pan: parsed.pan || '',
      amount: parsed.amount,
      rate: parsed.rate,
      issueDate: parsed.issueDate,
      maturityDate: parsed.maturityDate,
      maturityValue: parsed.maturityValue,
      tdsRate: 10,
      interestMode: 'compound',
      repayAc: parsed.repayAc || '',
      holder: parsed.holder || '',
      notes: 'Imported from ' + fname,
      entries: []
    };
    // Keep the slip's printed tenure when present (it's what reveals a maturity
    // year typo); only fall back to the date span when the slip had no tenure.
    rec.days = parsed.days || (rec.issueDate && rec.maturityDate ? daysBetween(rec.issueDate, rec.maturityDate) : null);
    var probs = Calc.validFd(rec);
    if (probs.length) { toast('Complete read but invalid: ' + probs.join(' '), 'warn'); importPreview(parsed, fname); return; }

    // A complete slip whose printed maturity contradicts issue + tenure. When the
    // tenure-implied date also matches the file name, the printed year is a typo —
    // correct to the file name and say so. Otherwise hand off to the review screen.
    if (rec.days) {
      var implied = Calc.dateAdd(rec.issueDate, rec.days);
      var fileM = Calc.fdFileMaturity(rec);
      var off = Math.abs(Math.round((Calc.parseISO(rec.maturityDate) - Calc.parseISO(implied)) / 86400000));
      if (off > 60) {
        if (fileM && Math.abs(Math.round((Calc.parseISO(fileM) - Calc.parseISO(implied)) / 86400000)) <= 10) {
          rec.maturityDate = fileM;
          rec.days = parsed.days;
          commitFd(rec, false, {});
          persist(); renderAll();
          toast('Corrected maturity from \u2018' + fname + '\u2019: ' + Calc.fmtDate(rec.maturityDate) +
                ' (issue ' + Calc.fmtDate(rec.issueDate) + ' + ' + rec.days + ' days).', 'warn');
          return;
        }
        toast('Complete read but date/tenure mismatch \u2014 opening review: ' + Calc.fdDateCheck(rec), 'warn');
        importPreview(parsed, fname);
        return;
      }
    }
    var dup = duplicateFd(rec, false, {});
    if (dup) { toast('\u2018' + fname + '\u2019 already imported (account ' + dup.account + ').', 'warn'); return; }
    commitFd(rec, false, {});
    persist(); renderAll();
    toast('Added ' + rec.account + ' from \u2018' + fname + '\u2019.', 'ok');
  }
  function importPreview(parsed, fname) {
    var f = formShell('Import PNB FD');
    f.box.id = 'importModal';
    var err = f.err, actions = f.actions;
    var st = el('div', 'parseStatus ' + (parsed.complete ? 'ok' : 'warn'));
    st.textContent = parsed.complete
      ? 'Read ' + (parsed.format === 'epos' ? 'the e-Fixed Deposit slip' : 'the slip') + ' from \u2018' + fname + '\u2019. Verify the fields below.'
      : 'Partial read of \u2018' + fname + '\u2019 (older PNB format). Fill in the missing fields.';
    f.form.appendChild(st);

    var pre = Object.assign({ panId: panIdForPanText(parsed.pan) }, parsed);
    var ff = fdFields(pre);
    f.form.appendChild(ff.form);
    if (parsed.holder) f.form.appendChild(el('p', 'hint', 'Holder on slip: ' + parsed.holder));
    if (parsed.fromFile && parsed.fromFile.length) f.form.appendChild(el('p', 'hint', 'Taken from the file name: ' + parsed.fromFile.join(', ') + '.'));

    // Date / tenure consistency: flag a slip whose maturity date doesn't match
    // its issue date + tenure (e.g. a year typo in the printed maturity).
    var chk = Calc.fdDateCheck({
      issueDate: parsed.issueDate, maturityDate: parsed.maturityDate, days: parsed.days,
      notes: 'Imported from ' + fname
    });
    if (chk) {
      var warn = el('div', 'dateWarn');
      warn.appendChild(el('strong', '', 'Date / tenure mismatch: '));
      warn.appendChild(document.createTextNode(chk));
      f.form.appendChild(warn);
    }

    var save = el('button', 'primary', 'Add FD');
    save.onclick = function () {
      var rec = ff.read();
      var probs = Calc.validFd(rec).concat(dateErrors(['fIssue', 'fMaturity']));
      if (probs.length) { err.textContent = probs.join('  |  '); return; }
      var dup = duplicateFd(rec, false, {});
      if (dup) { err.textContent = 'This FD is already in your list (account ' + dup.account + '). Open it to edit, or correct the account number if it\u2019s a different FD.'; return; }
      commitFd(rec, false, {});
      persist(); closeModal(); renderAll();
      toast('FD imported from ' + fname + '.', 'ok');
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    actions.appendChild(save); actions.appendChild(cancel);
    modal(f.box, true);
  }

  /* ---- Commodities tab (gold / SGB) ---- */
  function filterCommodities() {
    if (!S.curPan) return DATA.commodities;
    return DATA.commodities.filter(function (c) { return c.panId === S.curPan; });
  }
  function renderCommodities() {
    var sec = document.getElementById('sec-commodities');
    sec.innerHTML = '';
    var card = el('div', 'card');
    var head = el('div', 'cardHead');
    head.appendChild(el('h2', '', 'Commodities · gold / SGB'));
    head.appendChild(el('span', 'chip', 'view: ' + viewTitle()));
    head.appendChild(el('div', 'spacer'));
    var add = el('button', 'primary', '+ Add holding');
    add.onclick = function () { commodityForm(null); };
    head.appendChild(add);
    card.appendChild(head);
    card.appendChild(el('p', 'hint', 'Return is driven by the gold price, not a fixed rate. Record the current value (or units × price) and any SGB coupon receipts; XIRR uses the actual cash flows.'));

    var list = filterCommodities();
    if (!list.length) {
      card.appendChild(el('p', 'muted', 'No holdings yet. Add an SGB or gold holding to start tracking.'));
    } else {
      var cost = 0;
      list.forEach(function (c) { cost += c.invested || 0; });
      var kv = el('div', 'kv inline');
      kv.appendChild(kvin('Cost', Calc.inr(cost)));
      var openV = 0, openCount = 0;
      list.forEach(function (c) {
        var v = Calc.commodityMarketValue(c);
        if (v != null && !c.soldValue) { openV += v; openCount++; }
      });
      kv.appendChild(kvin('Open value', openCount ? Calc.inr(openV) : '—', 'pos'));
      var coupons = 0;
      list.forEach(function (c) { coupons += Calc.commodityCouponSummary(c).total; });
      kv.appendChild(kvin('Coupons received', Calc.inr(coupons)));
      card.appendChild(kv);

      var tbl = el('table', 'intTable');
      var thead = el('tr');
      ['Holding', 'Cost', 'Value', 'Gain', 'Return', 'Coupons', 'XIRR', ''].forEach(function (h) { thead.appendChild(el('th', '', h)); });
      tbl.appendChild(thead);
      list.forEach(function (c) { tbl.appendChild(commodityRow(c)); });
      var cwrap = el('div', 'archWrap');
      cwrap.appendChild(tbl);
      card.appendChild(cwrap);
    }
    sec.appendChild(card);
  }
  function commodityRow(c) {
    var today = Calc.todayISO();
    var mv = Calc.commodityMarketValue(c);
    var fv = Calc.commodityFinalValue(c, today);
    var ret = Calc.commodityReturnPct(c, today);
    var xirr = Calc.commodityXirr(c, today);
    var cs = Calc.commodityCouponSummary(c);
    var gain = (fv != null && c.invested > 0) ? fv + cs.total - c.invested : null;

    var tr = el('tr');
    var nameCell = el('td', '');
    var label = (c.name || 'No name');
    if (c.panId || c.pan) label += ' · ' + (Calc.holderLabel(holderOf(c.panId)) || c.pan || 'holder');
    nameCell.appendChild(el('b', '', label));
    var sub = [];
    sub.push(Calc.fmtDate(c.purchaseDate));
    if (c.soldDate) sub.push('→ sold ' + Calc.fmtDate(c.soldDate));
    else sub.push((c.units > 0 ? c.units + ' g · ' : '') + 'valued ' + Calc.fmtDate(c.valuedOn || today));
    var metaEl = el('div', 'fdMeta', sub.join(' '));
    nameCell.appendChild(metaEl);
    tr.appendChild(nameCell);
    tr.appendChild(el('td', 'num', Calc.inr(c.invested)));
    var valCell = el('td', 'num', fv != null ? Calc.inr(fv) : '—');
    valCell.title = c.soldValue > 0 ? 'redemption value' : (c.currentValue > 0 ? 'recorded current value' : 'units × price');
    tr.appendChild(valCell);
    var gainCell = el('td', 'num', gain != null ? Calc.inr(gain) : '—');
    gainCell.className = 'num ' + (gain != null && gain > 0 ? 'ok' : (gain != null && gain < 0 ? 'warn' : ''));
    tr.appendChild(gainCell);
    var retCell = el('td', 'num', ret != null ? ret.toFixed(1) + '%' : '—');
    retCell.className = 'num ' + (ret != null && ret > 0 ? 'ok' : (ret != null && ret < 0 ? 'warn' : ''));
    tr.appendChild(retCell);
    tr.appendChild(el('td', 'num', cs.count ? Calc.inr(cs.total) : '—'));
    tr.appendChild(el('td', 'num', xirr != null ? (xirr * 100).toFixed(2) + '% p.a.' : '—'));
    var act = el('td', '');
    var ed = el('button', 'mini', 'edit');
    ed.onclick = function () { commodityForm(c); };
    var cp = el('button', 'mini', 'coupon');
    cp.title = 'Record an SGB coupon payment';
    cp.onclick = function () { commodityCoupon(c); };
    var del = el('button', 'mini danger', 'del');
    del.onclick = function () {
      confirmDel('Delete ' + (c.name || 'this holding') + '? This cannot be undone.', function () {
        DATA.commodities = DATA.commodities.filter(function (x) { return x.id !== c.id; });
        persist(); renderAll();
        toast('Holding deleted.', 'warn');
      });
    };
    act.appendChild(ed); act.appendChild(cp); act.appendChild(del);
    tr.appendChild(act);
    return tr;
  }
  function commodityForm(c) {
    c = c || {};
    var f = formShell(c.id ? 'Edit holding' : 'Add commodity holding');
    var form = f.form;
    form.appendChild(field('Name *', textInput('cName', c.name, 'e.g. SGB 2026, Sovereign Gold')));
    form.appendChild(field('Type', selectControl('cKind', [
      { v: 'sgb', l: 'SGB — Sovereign Gold Bond' },
      { v: 'gold', l: 'Gold (ETF / physical)' },
      { v: 'other', l: 'Other commodity' }
    ], c.kind || 'sgb')));
    var panOpts = panOptions();
    if (panOpts.length) form.appendChild(field('PAN holder', selectControl('cPanId', panOpts, c.panId || '')));
    form.appendChild(field('PAN (if holder not listed)', textInput('cPan', c.pan, 'ABCDE1234F')));
    form.appendChild(field('Cost / invested (₹) *', numInput('cCost', c.invested, 'e.g. 120000')));
    form.appendChild(field('Units (g equivalent, SGB = qty)', numInput('cUnits', c.units, 'blank = use current value')));
    form.appendChild(field('Current price per unit (₹)', numInput('cPrice', c.unitPrice, 'blank = use current value')));
    form.appendChild(field('Current value (₹)', numInput('cValue', c.currentValue, 'used when units × price not set')));
    form.appendChild(field('Valued on', dateInput('cValuedOn', c.valuedOn)));
    form.appendChild(field('Purchase date *', dateInput('cPurchase', c.purchaseDate)));
    form.appendChild(field('Redemption / sold value (₹)', numInput('cSold', c.soldValue, 'blank = still holding')));
    form.appendChild(field('Redemption / sold date', dateInput('cSoldOn', c.soldDate)));
    form.appendChild(field('Notes', textInput('cNotes', c.notes, ''), true));

    function read() {
      var rec = {
        id: c.id || Calc.uid('commodity'),
        name: val('cName').trim(),
        kind: val('cKind'),
        panId: document.getElementById('cPanId') ? val('cPanId') : (c.panId || ''),
        pan: val('cPan'),
        invested: num('cCost'),
        units: num('cUnits'),
        unitPrice: num('cPrice'),
        currentValue: num('cValue'),
        valuedOn: readDate('cValuedOn'),
        purchaseDate: readDate('cPurchase'),
        soldValue: num('cSold'),
        soldDate: readDate('cSoldOn'),
        notes: val('cNotes')
      };
      rec.panId = rec.panId || panIdForPanText(rec.pan);
      rec.coupons = c.coupons ? c.coupons.slice() : [];
      return rec;
    }
    var save = el('button', 'primary', c.id ? 'Save' : 'Add holding');
    save.onclick = function () {
      var rec = read();
      var probs = Calc.validCommodity(rec);
      if (probs.length) { f.err.textContent = probs.join('  |  '); return; }
      var i = -1;
      DATA.commodities.forEach(function (x, ix) { if (x.id === rec.id) i = ix; });
      if (i >= 0) DATA.commodities[i] = rec; else DATA.commodities.push(rec);
      persist(); closeModal(); renderAll();
      toast(c.id ? 'Holding updated.' : 'Holding added.', 'ok');
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    f.actions.appendChild(save); f.actions.appendChild(cancel);
    modal(f.box, true);
  }
  function commodityCoupon(c) {
    c.coupons = c.coupons || [];
    var f = formShell('Coupon — ' + (c.name || c.id));
    f.form.appendChild(el('p', 'hint', 'SGB pays a 2.5% p.a. coupon on face value, semi-annually. Record each receipt; it feeds the return and XIRR.'));
    f.form.appendChild(field('Date', dateInput('cpDate', '')));
    f.form.appendChild(field('Amount (₹)', numInput('cpAmt', '', 'e.g. 3000')));
    var save = el('button', 'primary', 'Add coupon');
    save.onclick = function () {
      var d = readDate('cpDate');
      var a = num('cpAmt');
      if (!d || !(a > 0)) { f.err.textContent = 'Enter a date (DD/MM/YYYY) and an amount.'; return; }
      c.coupons.push({ date: d, amount: a });
      c.coupons.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
      persist(); closeModal(); renderAll();
      toast('Coupon recorded.', 'ok');
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    f.actions.appendChild(save); f.actions.appendChild(cancel);
    modal(f.box, true);
  }

  /* ---- Notes tab ---- */
  function renderNotes() {
    var sec = document.getElementById('sec-notes');
    sec.innerHTML = '';
    var card = el('div', 'card');
    card.appendChild(el('h2', '', 'Notes'));
    var t = document.createElement('textarea');
    t.id = 'notesArea';
    t.rows = 12;
    t.value = DATA.notes || '';
    t.style.width = '100%';
    t.placeholder = 'Scratch pad for investments…';
    card.appendChild(t);
    var save = el('button', 'primary', 'Save notes');
    save.onclick = function () { DATA.notes = t.value; persist(); toast('Notes saved.', 'ok'); };
    var acts = el('div', 'actions');
    acts.appendChild(save);
    card.appendChild(acts);
    sec.appendChild(card);
  }

  /* ---- profile / PAN modal ---- */
  function profileModal() {
    var f = formShell('Profile & PAN holders');
    var form = f.form, err = f.err, actions = f.actions;
    form.appendChild(field('Profile name', textInput('pName', DATA.profile.name, 'your name (optional)')));
    var holderCard = el('div', 'wide');
    holderCard.appendChild(el('h4', '', 'PAN holders'));
    var rows = el('div');
    rows.id = 'panRows';
    function panRow(holder) {
      var row = el('div', 'crow');
      var pan = document.createElement('input');
      pan.maxLength = 10;
      pan.placeholder = 'PAN (10 chars)';
      pan.value = holder ? holder.pan : '';
      pan.addEventListener('input', function () { pan.value = Calc.normPan(pan.value); });
      var name = textInput('', holder ? holder.name : '', 'Holder name', 80);
      var rm = el('button', 'mini danger', 'remove');
      rm.onclick = function () { row.remove(); };
      row.appendChild(pan); row.appendChild(name); row.appendChild(rm);
      if (holder) row.setAttribute('data-id', holder.id);
      return row;
    }
    if (!DATA.pans.length) rows.appendChild(panRow(null));
    else DATA.pans.forEach(function (p) { rows.appendChild(panRow(p)); });
    holderCard.appendChild(rows);
    var addPan = el('button', 'ghost', '+ Add PAN');
    addPan.onclick = function () { rows.appendChild(panRow(null)); };
    holderCard.appendChild(addPan);
    form.appendChild(holderCard);
    form.onsubmit = function (e) { e.preventDefault(); };

    var save = el('button', 'primary', 'Save');
    save.onclick = function () {
      var newPans = [], problems = [];
      Array.prototype.forEach.call(document.querySelectorAll('#panRows .crow'), function (row) {
        var inputs = row.querySelectorAll('input');
        var pan = Calc.normPan(inputs[0].value);
        var name = inputs[1].value.trim();
        if (!pan && !name) return;
        var holder = { id: row.getAttribute('data-id') || Calc.uid('pan'), pan: pan, name: name };
        var p = Calc.validPan(holder);
        if (p.length) { problems.push((name ? name + ': ' : '') + p.join(' ')); return; }
        for (var i = 0; i < newPans.length; i++) {
          if (newPans[i].pan && newPans[i].pan === pan) { problems.push(name + ': duplicate PAN.'); return; }
        }
        newPans.push(holder);
      });
      if (problems.length) { err.textContent = problems.join('  |  '); return; }
      DATA.profile.name = val('pName');
      DATA.pans = newPans;
      var newIds = {};
      newPans.forEach(function (h) { newIds[h.id] = 1; });
      DATA.fds = DATA.fds.map(function (fd) {
        var out = JSON.parse(JSON.stringify(fd));
        if (out.panId && !newIds[out.panId]) { out.panId = ''; out.pan = out.pan || out.holder; }
        return out;
      });
      if (S.curPan && !newIds[S.curPan]) S.curPan = '';
      resyncHolders();
      persist(); closeModal(); renderAll();
      toast('Profile saved.', 'ok');
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    actions.appendChild(save); actions.appendChild(cancel);
    modal(f.box, true);
  }
  function confirmDel(message, onYes) {
    var box = el('div', 'card');
    box.appendChild(el('h3', '', 'Delete?'));
    box.appendChild(el('p', 'muted', message));
    var actions = el('div', 'actions');
    var yes = el('button', 'danger', 'Delete');
    yes.onclick = function () { closeModal(); onYes(); };
    var no = el('button', 'ghost', 'Cancel');
    no.onclick = closeModal;
    actions.appendChild(yes); actions.appendChild(no);
    box.appendChild(actions);
    modal(box, true);
  }

  /* ---- bundle export / import ---- */
  function saveBundle() {
    var out = { version: SCHEMA_VERSION, pans: DATA.pans, profile: DATA.profile, meta: DATA.meta, fds: DATA.fds, commodities: DATA.commodities || [], notes: DATA.notes, archived: DATA.archived || [] };
    var blob = new Blob(['window.DATA = ' + JSON.stringify(out, null, 1) + ';\n'], { type: 'text/javascript' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'investments_' + Calc.todayISO().replace(/-/g, '') + '.js';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Bundle downloaded. Restore it with \u2018Open bundle\u2019, or place it in this app\u2019s data/ folder as bundle.js to move your data.');
  }
  function loadBundle(file) {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var s = String(rd.result);
        var d;
        if (s.indexOf('window.DATA =') >= 0) {
          s = s.replace(/^[\s\S]*?window\.DATA\s*=\s*/, '').replace(/;\s*$/, '');
          d = JSON.parse(s);
        } else {
          d = JSON.parse(s); // also accept a bare JSON bundle (renamed/extracted backup)
        }
        if (!d || !Array.isArray(d.fds)) throw new Error('missing fds array');
        if (typeof d.version === 'number' && d.version > SCHEMA_VERSION) {
          toast('This bundle is from a newer app version (schema ' + d.version + '). Update the app first.', 'warn');
          return;
        }
        DATA.fds = d.fds;
        DATA.archived = Array.isArray(d.archived) ? d.archived : [];
        if (Array.isArray(d.pans)) DATA.pans = d.pans;
        DATA.commodities = Array.isArray(d.commodities) ? d.commodities : [];
        DATA.profile = d.profile || DATA.profile;
        DATA.meta = d.meta || {};
        DATA.notes = d.notes || '';
        resyncHolders();
        persist(); renderAll();
        toast('Bundle loaded.', 'ok');
      } catch (e) {
        toast('Could not load bundle: ' + e.message, 'bad');
      }
    };
    rd.readAsText(file);
  }

  /* ---- version badge ---- */
  function showVersion() {
    var badge = document.getElementById('verBadge');
    if (!badge) return;
    var v = 'v' + APP_VERSION;
    badge.hidden = false;
    badge.textContent = v;
    badge.title = 'Build ' + v;
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    try {
      var ch = new MessageChannel();
      ch.port1.onmessage = function (ev) {
        var swv = ev.data && ev.data.version;
        if (swv) badge.title = 'Build ' + v + ' · SW cache ' + swv;
      };
      navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
    } catch (e) {}
  }

  /* ---- tabs / wiring / init ---- */
  function switchTab(t) {
    S.tab = t;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (b) {
      if (b.getAttribute('data-tab') === t) b.classList.add('now');
      else b.classList.remove('now');
    });
    document.getElementById('sec-fd').hidden = t !== 'fd';
    document.getElementById('sec-commodities').hidden = t !== 'commodities';
    document.getElementById('sec-notes').hidden = t !== 'notes';
  }
  function renderAll() {
    buildPanSel();
    setProfileChip();
    renderChips();
    renderFd();
    renderCommodities();
    renderNotes();
  }

  function init() {
    load();
    document.getElementById('btnSave').onclick = saveBundle;
    document.getElementById('btnImport').onclick = function () { document.getElementById('importFile').click(); };
    document.getElementById('importFile').onchange = function () {
      if (this.files && this.files[0]) loadBundle(this.files[0]);
      this.value = '';
    };
    document.getElementById('btnPdf').onclick = function () { document.getElementById('pdfFile').click(); };
    document.getElementById('pdfFile').onchange = function () {
      if (this.files && this.files[0]) importPdf(this.files[0]);
      this.value = '';
    };
    document.getElementById('profilechip').onclick = profileModal;
    document.getElementById('profilechip').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); profileModal(); }
    });
    document.getElementById('panSel').onchange = function () {
      S.curPan = this.value;
      try { localStorage.setItem(LS_PAN, S.curPan); } catch (e) {}
      renderAll();
    };
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (b) {
      b.onclick = function () { switchTab(b.getAttribute('data-tab')); };
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    window.addEventListener('beforeunload', flush);
    switchTab('fd');
    renderAll();
    showVersion();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.App = { DATA: DATA, switchTab: switchTab, renderAll: renderAll, buildFdForm: buildFdForm, buildInterestForm: buildInterestForm, archiveMatured: archiveMatured, importPdf: importPdf, importPreview: importPreview, autoImport: autoImport, resyncHolders: resyncHolders, commodityForm: commodityForm, renderCommodities: renderCommodities };
})();
