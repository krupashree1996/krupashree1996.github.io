(function () {
  var DATA = window.DATA || (window.DATA = { profile: { name: '' }, pans: [], meta: {}, ipos: [], applications: [] });
  var S = { tab: 'cal', curPan: '', chartTimer: 0 };
  var LS = 'ipo.tracker.session';
  var LS_PAN = 'ipo.tracker.curPan';
  var CLEANUP_DAYS = 45;
  var DEFAULT_CAL_URL = 'https://krupashree1996.github.io/ipo-exchange-scrape/data/ipos.json';

  function el(tag, cls, text) {
    var e = document.createElement(tag || 'div');
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function toast(msg, kind) {
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
    document.getElementById('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, 2800);
  }
  function modal(node, closable) {
    var box = document.getElementById('modalBox');
    box.innerHTML = '';
    box.appendChild(node);
    var m = document.getElementById('modal');
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    m.onclick = function (e) { if (closable && e.target === m) closeModal(); };
    document.getElementById('modal').setAttribute('data-closable', closable ? '1' : '0');
  }
  function closeModal() {
    var m = document.getElementById('modal');
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    document.getElementById('modalBox').innerHTML = '';
  }

  function load() {
    try {
      var raw = localStorage.getItem(LS);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.ipos) && Array.isArray(d.applications)) {
          DATA.ipos = d.ipos;
          DATA.applications = d.applications;
          if (Array.isArray(d.pans)) DATA.pans = d.pans;
          DATA.profile = d.profile || DATA.profile;
          DATA.meta = d.meta || {};
        }
      }
    } catch (e) {}
    try { S.curPan = localStorage.getItem(LS_PAN) || ''; } catch (e) {}
  }
  function flush() {
    try { localStorage.setItem(LS, JSON.stringify(DATA)); } catch (e) {}
  }
  var persisting = 0;
  function persist() {
    clearTimeout(persisting);
    persisting = setTimeout(flush, 250);
  }

  function holderOf(id) {
    for (var i = 0; i < DATA.pans.length; i++) if (DATA.pans[i].id === id) return DATA.pans[i];
    return null;
  }
  function holderLabel(h) {
    if (!h) return '\u2014';
    var s = h.name || '';
    if (h.pan) s += s ? ' \u00B7 ' + h.pan : h.pan;
    return s || 'PAN';
  }
  function ipoOf(id) {
    for (var i = 0; i < DATA.ipos.length; i++) if (DATA.ipos[i].id === id) return DATA.ipos[i];
    return null;
  }
  function filterApps(list) {
    if (!S.curPan) return list;
    return list.filter(function (a) { return a.panId === S.curPan; });
  }
  function myAppsFor(ipoId) { return filterApps(DATA.applications.filter(function (a) { return a.ipoId === ipoId; })); }
  function mySummary(ipo) { return Calc.ipoSummary(ipo, myAppsFor(ipo.id)); }
  function hasPrice(ipo) {
    if (ipo.listingPrice > 0) return true;
    return myAppsFor(ipo.id).some(function (a) { return a.soldPrice > 0; });
  }
  function viewTitle() {
    var h = holderOf(S.curPan);
    if (h) return (h.name || '') + ' \u00B7 ' + (h.pan || '');
    return S.curPan ? 'Selected PAN' : 'All PANs';
  }
  function priceText(i) {
    return Calc.price(i && i.bandHi);
  }
  function kvCell(k, v, title) {
    var s = el('span', 'cell');
    s.appendChild(el('span', 'cellK', k));
    s.appendChild(el('span', 'cellV', v == null ? '\u2014' : String(v)));
    if (title) s.title = title;
    return s;
  }
  function panTotals() {
    var map = {};
    DATA.pans.forEach(function (p) { map[p.id] = { lien: 0, apps: 0, ipoCount: 0 }; });
    DATA.applications.forEach(function (a) {
      if (!map[a.panId]) return;
      var ipo = ipoOf(a.ipoId);
      if (!ipo) return;
      map[a.panId].lien += Calc.lienAmount(a, ipo);
      map[a.panId].apps++;
    });
    DATA.ipos.forEach(function (i) {
      var seen = {};
      filterApps(DATA.applications.filter(function (a) { return a.ipoId === i.id; })).forEach(function (a) {
        if (a.panId && !seen[a.panId]) { seen[a.panId] = 1; if (map[a.panId]) map[a.panId].ipoCount++; }
      });
    });
    return map;
  }
  function renderPanBar() {
    var bar = document.getElementById('panBar');
    bar.innerHTML = '';
    if (!DATA.pans.length) { bar.hidden = true; return; }
    bar.hidden = false;
    var t = panTotals();
    bar.appendChild(el('span', 'panLabel', 'Total lien per PAN (all IPOs):'));
    DATA.pans.forEach(function (p) {
      var info = t[p.id] || { lien: 0, apps: 0 };
      var chip = el('span', 'chip panchip', holderLabel(p) + ' \u00B7 ' + Calc.inr(info.lien));
      chip.title = info.apps + ' application record(s)';
      bar.appendChild(chip);
    });
  }

  function buildPanSel() {
    var sel = document.getElementById('panSel');
    sel.innerHTML = '';
    var all = document.createElement('option');
    all.value = ''; all.textContent = 'All PANs';
    sel.appendChild(all);
    DATA.pans.forEach(function (h) {
      var o = document.createElement('option');
      o.value = h.id; o.textContent = holderLabel(h);
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
    var open = 0;
    DATA.ipos.forEach(function (i) { if (Calc.ipoStatus(i) === 'open') open++; });
    var pending = filterApps(DATA.applications).filter(function (a) { return a.status === 'applied'; }).length;
    var pnl = 0;
    DATA.ipos.forEach(function (i) { pnl += mySummary(i).pnl; });
    wrap.appendChild(el('span', 'chip', open ? open + ' open now' : (DATA.ipos.length ? 'no IPO open' : '0 IPOs')));
    wrap.appendChild(el('span', 'chip', pending ? pending + ' awaiting allotment' : '0 awaiting'));
    var c = el('span', 'chip pnl' + (pnl < 0 ? ' neg' : (pnl > 0 ? ' pos' : '')), 'P&L ' + Calc.compact(pnl));
    wrap.appendChild(c);
  }

  var STATUS_META = {
    watch: { label: 'Watch', cls: 'b-info' },
    upcoming: { label: 'Upcoming', cls: 'b-info' },
    open: { label: 'Open now', cls: 'b-open' },
    closed: { label: 'Closed', cls: 'b-gray' },
    listed: { label: 'Listed', cls: 'b-pass' }
  };
  function statusBadge(ipo) {
    var m = STATUS_META[Calc.ipoStatus(ipo)] || STATUS_META.watch;
    return el('span', 'badge ' + m.cls, m.label);
  }
  var APP_META = {
    applied: { label: 'Applied', cls: 'b-info' },
    allotted: { label: 'Allotted', cls: 'b-pass' },
    rejected: { label: 'Not allotted', cls: 'b-fail' }
  };
  function appBadge(a) {
    var m = APP_META[a.status] || APP_META.applied;
    return el('span', 'badge ' + m.cls, m.label);
  }
  function pnlCell(pnl, hasp) {
    var td = el('td', 'num');
    if (hasp) {
      td.textContent = pnl >= 0 ? '+' + Calc.inr(pnl) : Calc.inr(pnl);
      td.className += (pnl >= 0 ? ' pos' : ' neg');
    } else td.textContent = '\u2014';
    return td;
  }

  function renderCal() {
    var sec = document.getElementById('sec-cal');
    sec.innerHTML = '';
    var card = el('div', 'card');
    var head = el('div', 'cardHead');
    var h2 = el('h2', '', 'IPO calendar');
    var hint = el('span', 'chip', 'view: ' + viewTitle());
    var spacer = el('div', 'spacer');
    var add = el('button', 'primary', '+ Add IPO');
    add.onclick = function () { buildIpoForm(null); };
    head.appendChild(h2); head.appendChild(hint); head.appendChild(spacer); head.appendChild(add);
    card.appendChild(head);

    if (!DATA.ipos.length) {
      var p = el('p', 'muted', 'No IPOs yet. Add the first one manually, or set a calendar URL in Profile and use ');
      var b = el('button', 'mini', 'Fetch Online');
      b.onclick = fetchCalendar;
      p.appendChild(b);
      p.appendChild(document.createTextNode('.'));
      card.appendChild(p);
    } else {
      var sorted = Calc.sortIpos(DATA.ipos);
      sorted.forEach(function (ipo) { card.appendChild(ipoRow(ipo)); });
    }
    sec.appendChild(card);
  }
  function ipoRow(ipo) {
    var row = el('div', 'mrow ipoRow');
    row.setAttribute('data-symbol', ipo.symbol || ipo.name || '');
    var st = Calc.ipoStatus(ipo);

    var mainBox = el('div');
    var name = el('div', 'ipoName', ipo.name || 'Untitled');
    if (ipo.symbol) name.appendChild(el('span', 'muted small', '  ' + ipo.symbol));
    mainBox.appendChild(name);

    var defLots = Calc.defaultLots(ipo.category);
    var perAppShares = (ipo.shareLot || 0) * defLots;
    var totalValue = perAppShares && ipo.bandHi > 0 ? Math.round(ipo.bandHi * perAppShares) : null;
    var cells = el('div', 'rowCells');
    cells.appendChild(kvCell('Category', ipo.category || null));
    cells.appendChild(kvCell('Max price', priceText(ipo)));
    cells.appendChild(kvCell('Shares (' + defLots + ' lot' + (defLots > 1 ? 's' : '') + ')',
      perAppShares ? Calc.fmtNum(perAppShares) : null, (ipo.shareLot || 0) + ' sh/lot \u00D7 ' + defLots + ' lot default'));
    cells.appendChild(kvCell('Total value', totalValue == null ? null : Calc.inr(totalValue),
      Calc.price(ipo.bandHi) + ' \u00D7 ' + Calc.fmtNum(perAppShares) + ' shares'));
    cells.appendChild(kvCell('Close', Calc.fmtDate(ipo.closeDate)));
    cells.appendChild(kvCell('Refund', Calc.fmtDate(ipo.refundDate)));
    cells.appendChild(kvCell('Listing', Calc.fmtDate(ipo.listingDate)));
    mainBox.appendChild(cells);

    var badges = el('div', 'rowCols');
    badges.appendChild(statusBadge(ipo));
    if (ipo.subs != null) badges.appendChild(el('span', 'subs', 'subs ' + Calc.fmtSubs(ipo.subs)));
    if (ipo.gmp != null) badges.appendChild(el('span', 'gmp', 'GMP ' + Calc.price(ipo.gmp)));
    var appsAmt = mySummary(ipo).lien;
    if (myAppsFor(ipo.id).length && appsAmt > 0) {
      badges.appendChild(el('span', 'badge b-applied', 'applied ' + Calc.inr(appsAmt)));
    }
    if (myAppsFor(ipo.id).some(function (a) { return Calc.allotmentDue(a, ipo); })) {
      badges.appendChild(el('span', 'badge b-warn', 'check status'));
    }

    var acts = el('div', 'row-actions');
    var app = el('button', 'mini strong', '+ app');
    app.onclick = function () { applyModal(ipo); };
    acts.appendChild(app);
    if (st === 'listed' && !hasPrice(ipo) && myAppsFor(ipo.id).length) {
      var lp = el('button', 'mini', 'list');
      lp.title = 'Record the listing price to compute P&L';
      lp.onclick = function () { listingModal(ipo); };
      acts.appendChild(lp);
    }
    var ed = el('button', 'mini', 'edit');
    ed.onclick = function () { buildIpoForm(ipo); };
    acts.appendChild(ed);
    var del = el('button', 'mini danger', 'del');
    del.onclick = function () { deleteIpo(ipo); };
    acts.appendChild(del);

    row.appendChild(mainBox);
    row.appendChild(badges);
    row.appendChild(acts);

    var apps = myAppsFor(ipo.id);
    if (apps.length) {
      var s = mySummary(ipo);
      var mini = 'View includes ' + viewTitle() + ' \u00B7 ' + s.apps + ' app' + (s.apps > 1 ? 's' : '') +
        ' \u00B7 lien ' + Calc.inr(s.lien) + ' \u00B7 ' + s.shares + ' sh';
      if (hasPrice(ipo)) mini += ' \u00B7 P&L ' + (s.pnl >= 0 ? '+' : '') + Calc.inr(s.pnl);
      row.appendChild(el('div', 'appsMini', mini));
    }
    return row;
  }

  function renderApps() {
    var sec = document.getElementById('sec-apps');
    sec.innerHTML = '';
    var card = el('div', 'card');
    var head = el('div', 'cardHead');
    var h2 = el('h2', '', 'Applications');
    var hint = el('span', 'chip', 'view: ' + viewTitle());
    var spacer = el('div', 'spacer');
    var add = el('button', 'primary', '+ Apply IPO');
    if (!DATA.ipos.length) { add.disabled = true; add.title = 'Add or fetch IPOs first'; }
    add.onclick = function () { buildAppForm(null, null); };
    head.appendChild(h2); head.appendChild(hint); head.appendChild(spacer); head.appendChild(add);
    card.appendChild(head);

    if (!DATA.ipos.length) {
      card.appendChild(el('p', 'muted', 'No IPOs yet \u2014 add one in the IPO calendar first.'));
    } else if (!filterApps(DATA.applications).length) {
      card.appendChild(el('p', 'muted', 'No applications in this view yet. Open an IPO and use \u2018+ app\u2019 to record one.'));
    } else {
      var t = el('table');
      var th = el('thead');
      var tr = el('tr');
      ['IPO', 'Applied', 'Holder', 'Lots', 'Lien (qty \u00D7 price)', 'Status', 'Shares', 'P&L', ''].forEach(function (h, i) {
        var c = el('th', i >= 3 ? 'num' : '', h);
        tr.appendChild(c);
      });
      th.appendChild(tr); t.appendChild(th);
      var tb = el('tbody');
      var list = filterApps(DATA.applications).slice().sort(function (a, b) {
        if (a.appliedOn !== b.appliedOn) return a.appliedOn < b.appliedOn ? 1 : -1;
        return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
      });
      list.forEach(function (a) { tb.appendChild(appRow(a)); });
      t.appendChild(tb);
      var tot = { lien: 0, lots: 0 };
      list.forEach(function (a) {
        var ipo = ipoOf(a.ipoId);
        tot.lien += ipo ? Calc.lienAmount(a, ipo) : (a.amount || 0);
        tot.lots += a.lots || 0;
      });
      var foot = el('tfoot');
      var fr = el('tr');
      var fc1 = el('td', '', 'Total (' + list.length + ' applications)');
      fc1.colSpan = 4;
      fr.appendChild(fc1);
      fr.appendChild(el('td', 'num strong', Calc.inr(tot.lien)));
      var fc2 = el('td');
      fc2.colSpan = 4;
      fr.appendChild(fc2);
      foot.appendChild(fr);
      t.appendChild(foot);
      card.appendChild(t);
    }
    sec.appendChild(card);
  }
  function appRow(a) {
    var ipo = ipoOf(a.ipoId);
    var h = holderOf(a.panId);
    var tr = el('tr');
    tr.setAttribute('data-id', a.id);

    var td1 = el('td');
    td1.appendChild(el('div', '', ipo ? ipo.name : 'Unknown IPO'));
    if (ipo) td1.appendChild(el('div', 'ipoMeta', Calc.price(Calc.offerPrice(a, ipo)) + ' \u00D7 ' + Calc.qtyOf(a, ipo) + ' sh'));
    tr.appendChild(td1);

    tr.appendChild(el('td', '', Calc.fmtDate(a.appliedOn)));
    tr.appendChild(el('td', '', holderLabel(h)));
    var tdl = el('td', 'num'); tdl.textContent = Calc.fmtNum(a.lots || 0); tr.appendChild(tdl);
    var tdn = el('td', 'num'); tdn.textContent = Calc.inr(ipo ? Calc.lienAmount(a, ipo) : a.amount || 0); tr.appendChild(tdn);

    var tds = el('td');
    tds.appendChild(appBadge(a));
    if (Calc.allotmentDue(a, ipo)) tds.appendChild(el('span', 'badge b-warn', 'check'));
    if (a.status === 'applied') {
      var al = el('button', 'mini', 'Allot');
      al.title = 'Mark allotted (registrar result)';
      al.onclick = function () { quickAllot(a); };
      var rj = el('button', 'mini danger', 'Reject');
      rj.onclick = function () { quickReject(a); };
      tds.appendChild(el('span', 'miniGap'));
      tds.appendChild(al);
      tds.appendChild(rj);
    }
    tr.appendChild(tds);

    var sh = ipo ? Calc.sharesOf(a, ipo) : 0;
    tr.appendChild(el('td', 'num', sh ? Calc.fmtNum(sh) : '\u2014'));
    tr.appendChild(pnlCell(ipo ? Calc.pnlOf(a, ipo) : 0, sh > 0 && ipo && (Calc.effPrice(a, ipo) > 0)));

    var acts = el('td');
    var ed = el('button', 'mini', 'edit');
    ed.onclick = function () { buildAppForm(a, null); };
    var del = el('button', 'mini danger', 'del');
    del.onclick = function () { deleteApp(a); };
    acts.appendChild(ed); acts.appendChild(del);
    tr.appendChild(acts);
    return tr;
  }

  function histIpos() {
    return DATA.ipos.filter(function (i) {
      var st = Calc.ipoStatus(i);
      return (st === 'closed' || st === 'listed') && myAppsFor(i.id).length;
    }).sort(function (a, b) {
      var da = a.listingDate || a.closeDate || '', db = b.listingDate || b.closeDate || '';
      if (da !== db) return da < db ? 1 : -1;
      return (a.name || '').localeCompare(b.name || '');
    });
  }
  function renderHist() {
    var sec = document.getElementById('sec-hist');
    sec.innerHTML = '';
    var hist = histIpos();

    var card = el('div', 'card');
    var head = el('div', 'cardHead');
    head.appendChild(el('h2', '', 'History & results'));
    head.appendChild(el('span', 'chip', 'view: ' + viewTitle()));
    card.appendChild(head);

    var tot = { lien: 0, shares: 0, value: 0, pnl: 0 };
    hist.forEach(function (i) {
      var s = mySummary(i);
      tot.lien += s.lien; tot.shares += s.shares; tot.value += s.listValue; tot.pnl += s.pnl;
    });
    var kv = el('div', 'kv inline');
    kv.appendChild(statBox('Lien deployed', Calc.inr(tot.lien)));
    kv.appendChild(statBox('Allotted shares', Calc.fmtNum(tot.shares)));
    kv.appendChild(statBox('Value @ listing', hist.length && tot.value ? Calc.inr(tot.value) : '\u2014'));
    kv.appendChild(statBox('Net P&L', (tot.pnl >= 0 ? '+' : '') + Calc.inr(tot.pnl)));
    card.appendChild(kv);

    if (!hist.length) {
      card.appendChild(el('p', 'muted', 'Nothing closed with applications in this view yet.'));
    } else {
      var t = el('table');
      var th = el('thead');
      var trH = el('tr');
      ['IPO', 'Closed', 'Listed', 'Lien', 'Shares', 'Value', 'P&L', 'Result'].forEach(function (h, i) {
        trH.appendChild(el('th', i >= 3 ? 'num' : '', h));
      });
      th.appendChild(trH); t.appendChild(th);
      var tb = el('tbody');
      hist.forEach(function (i) {
        var s = mySummary(i);
        var hp = hasPrice(i);
        var tr = el('tr');
        tr.appendChild(el('td', '', i.name));
        tr.appendChild(el('td', '', Calc.fmtDate(i.closeDate)));
        tr.appendChild(el('td', '', Calc.fmtDate(i.listingDate)));
        tr.appendChild(el('td', 'num', Calc.inr(s.lien)));
        tr.appendChild(el('td', 'num', s.shares ? Calc.fmtNum(s.shares) : '\u2014'));
        tr.appendChild(el('td', 'num', hp && s.listValue ? Calc.inr(s.listValue) : '\u2014'));
        tr.appendChild(pnlCell(s.pnl, hp));
        var col = el('td');
        if (s.shares) col.appendChild(el('span', 'badge b-pass', s.allotted + '/' + s.apps + ' allotted'));
        else col.appendChild(el('span', 'badge b-fail', 'not allotted'));
        tr.appendChild(col);
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      card.appendChild(t);
    }
    sec.appendChild(card);

    var panCard = el('div', 'card');
    var ph = el('div', 'cardHead');
    ph.appendChild(el('h2', '', 'Per PAN'));
    ph.appendChild(el('span', 'chip', 'all PAN holders'));
    panCard.appendChild(ph);
    if (!DATA.pans.length) {
      panCard.appendChild(el('p', 'muted', 'No PAN holders yet \u2014 add them in Profile. Each application is filed under one holder.'));
    } else {
      var pt = el('table');
      var pth = el('thead');
      var ptr = el('tr');
      ['Holder', 'Applications', 'Lien', 'Shares', 'P&L'].forEach(function (h, i) {
        ptr.appendChild(el('th', i >= 2 ? 'num' : '', h));
      });
      pth.appendChild(ptr); pt.appendChild(pth);
      var ptb = el('tbody');
      var gTot = { apps: 0, lien: 0, shares: 0, pnl: 0 };
      DATA.pans.forEach(function (p) {
        var apps = DATA.applications.filter(function (a) { return a.panId === p.id; });
        var lien = 0, shares = 0, pnl = 0;
        apps.forEach(function (a) {
          var ipo = ipoOf(a.ipoId);
          if (!ipo) return;
          lien += Calc.lienAmount(a, ipo);
          shares += Calc.sharesOf(a, ipo);
          pnl += Calc.pnlOf(a, ipo);
        });
        gTot.apps += apps.length; gTot.lien += lien; gTot.shares += shares; gTot.pnl += pnl;
        var r = el('tr');
        r.appendChild(el('td', '', p.name + ' \u00B7 ' + (p.pan || '')));
        r.appendChild(el('td', 'num', Calc.fmtNum(apps.length)));
        r.appendChild(el('td', 'num', Calc.inr(lien)));
        r.appendChild(el('td', 'num', shares ? Calc.fmtNum(shares) : '\u2014'));
        r.appendChild(pnlCell(pnl, true));
        ptb.appendChild(r);
      });
      var rt = el('tr');
      rt.appendChild(el('td', '', 'All'));
      rt.appendChild(el('td', 'num', Calc.fmtNum(gTot.apps)));
      rt.appendChild(el('td', 'num', Calc.inr(gTot.lien)));
      rt.appendChild(el('td', 'num', gTot.shares ? Calc.fmtNum(gTot.shares) : '\u2014'));
      rt.appendChild(pnlCell(gTot.pnl, true));
      ptb.appendChild(rt);
      pt.appendChild(ptb);
      panCard.appendChild(pt);
    }
    sec.appendChild(panCard);

    var chCard = el('div', 'card');
    var chh = el('div', 'cardHead');
    chh.appendChild(el('h2', '', 'P&L by IPO'));
    chCard.appendChild(chh);
    var box = el('div', 'chartBox');
    var cv = document.createElement('canvas');
    cv.id = 'pnlChart';
    box.appendChild(cv);
    chCard.appendChild(box);
    sec.appendChild(chCard);
  }
  function statBox(label, value) {
    var d = el('div');
    d.appendChild(el('b', '', label));
    d.appendChild(el('span', '', value));
    return d;
  }
  function drawPnlChart() {
    var cv = document.getElementById('pnlChart');
    if (!cv) return;
    var box = cv.parentElement;
    var W = box.clientWidth || 480;
    var items = histIpos().map(function (i) { return { name: i.name, value: mySummary(i).pnl }; })
      .filter(function (i) { return i.value !== 0; })
      .slice(-14);
    var n = items.length;
    var H = n ? Math.max(140, n * 30 + 40) : 140;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!n) {
      ctx.fillStyle = '#98a2b3'; ctx.font = '13px system-ui'; ctx.textBaseline = 'middle';
      ctx.fillText('No P&L to chart in this view yet.', 14, H / 2);
      return;
    }
    var padL = 12, padR = 84, rowH = 30, top = 12;
    var plotW = W - padL - padR, half = plotW / 2;
    var maxV = Math.max(1, Math.max.apply(null, items.map(function (i) { return Math.abs(i.value); })));
    var zeroX = padL + half;
    ctx.strokeStyle = '#98a2b3';
    ctx.beginPath(); ctx.moveTo(zeroX, top - 8); ctx.lineTo(zeroX, top + n * rowH + 2); ctx.stroke();
    items.forEach(function (it, k) {
      var y = top + k * rowH + 16;
      ctx.fillStyle = '#475467'; ctx.font = '12px system-ui'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(short(it.name, 16), padL, y);
      var v = it.value;
      if (!v) return;
      var px = Math.abs(v) / maxV * half;
      var x = v > 0 ? zeroX : zeroX - px;
      ctx.fillStyle = v > 0 ? '#16804a' : '#b42318';
      ctx.fillRect(x, y - 10, Math.max(px, 2), 12);
      ctx.fillStyle = '#1b2430';
      ctx.textAlign = v > 0 ? 'left' : 'right';
      ctx.fillText(Calc.compact(v), v > 0 ? x + px + 6 : x - 6, y);
    });
  }
  function short(s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '\u2026';
  }

  function field(labelText, ctrl, wide) {
    var lab = el('label');
    if (wide) lab.className = 'wide';
    var t = el('span', '', labelText);
    if (ctrl.required && ctrl.required.value) t.appendChild(el('em', '', ' *'));
    lab.appendChild(t);
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
    i.id = id; i.type = 'number'; i.step = step || 'any';
    i.value = value == null ? '' : value;
    if (ph) i.placeholder = ph;
    return i;
  }
  function dateInput(id, value) {
    var i = document.createElement('input');
    i.id = id; i.type = 'date'; i.value = value || '';
    return i;
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
  function noteArea(id, value) {
    var t = document.createElement('textarea');
    t.id = id; t.rows = 3; t.value = value || '';
    return t;
  }
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function num(id) { var s = val(id); if (!s) return null; var n = Number(s); return isNaN(n) ? null : n; }
  function errBox() { var p = el('p', 'err'); return p; }

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

  function buildIpoForm(ipo) {
    var edit = !!ipo;
    var o = ipo || {};
    var f = formShell(edit ? 'Edit IPO' : 'Add an IPO');
    var form = f.form, err = f.err, actions = f.actions;

    form.appendChild(field('Company name', textInput('iName', o.name, 'e.g. Acme Motors', 80)));
    form.appendChild(field('Ticker', textInput('iSymbol', o.symbol, 'SYM', 10)));
    form.appendChild(field('Exchange', selectControl('iExchange', [{ v: 'NSE', l: 'NSE' }, { v: 'BSE', l: 'BSE' }], o.exchange || 'NSE')));
    form.appendChild(field('Category', selectControl('iCategory', [{ v: 'Mainline', l: 'Mainline' }, { v: 'SME', l: 'SME' }], o.category || 'Mainline')));
    var catSel = form.querySelector('#iCategory') || null;
    form.appendChild(field('Max price (\u20B9) *', numInput('iHi', o.bandHi == null ? '' : o.bandHi, 'offer price per share', '0.01')));
    form.appendChild(field('Shares per lot *', numInput('iLot', o.shareLot, 'e.g. 9', '1')));
    var minTouched = edit && o.minLots != null;
    var minIn = numInput('iMin', o.minLots != null ? o.minLots : Calc.defaultLots(o.category));
    minIn.addEventListener('input', function () { minTouched = true; });
    catSel.onchange = function () {
      if (!minTouched) minIn.value = Calc.defaultLots(catSel.value);
    };
    form.appendChild(field('Min lots', minIn));
    form.appendChild(field('Open date', dateInput('iOpen', o.openDate)));
    form.appendChild(field('Close date', dateInput('iClose', o.closeDate)));
    form.appendChild(field('Refund date', dateInput('iRefund', o.refundDate)));
    form.appendChild(field('Listing date', dateInput('iList', o.listingDate)));
    form.appendChild(field('Listing price (\u20B9/share)', numInput('iListPrice', o.listingPrice, 'for P&L mark-to-market')));
    form.appendChild(field('GMP (\u20B9/share)', numInput('iGmp', o.gmp, 'grey market, optional')));
    form.appendChild(field('Subscription (\u00D7)', numInput('iSubs', o.subs, 'e.g. 45.2 times')));
    form.appendChild(field('Registrar', textInput('iReg', o.registrar, 'e.g. Link Intime')));
    form.appendChild(field('RHP link', textInput('iRhp', o.rhp, 'https\u2026', 240)));
    form.appendChild(field('Status', selectControl('iStatus', [
      { v: 'auto', l: 'Auto (from dates)' }, { v: 'watch', l: 'Watchlist only' },
      { v: 'upcoming', l: 'Upcoming' }, { v: 'open', l: 'Open' },
      { v: 'closed', l: 'Closed' }, { v: 'listed', l: 'Listed' }
    ], o.status || 'auto')));
    form.appendChild(field('Notes', noteArea('iNotes', o.notes), true));

    var save = el('button', 'primary', edit ? 'Save changes' : 'Add IPO');
    save.onclick = function () { doSaveIpo(o, edit, err); };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    actions.appendChild(save); actions.appendChild(cancel);
    modal(f.box, true);
  }
  function doSaveIpo(o, edit, err) {
    var rec = edit ? JSON.parse(JSON.stringify(o)) : { id: Calc.uid('ipo'), createdAt: new Date().toISOString() };
    rec.name = val('iName');
    rec.symbol = val('iSymbol');
    rec.exchange = val('iExchange');
    rec.category = val('iCategory');
    var hi = num('iHi');
    rec.bandHi = hi && hi > 0 ? hi : null;
    rec.shareLot = num('iLot');
    rec.minLots = num('iMin') || Calc.defaultLots(rec.category);
    rec.openDate = val('iOpen') || null;
    rec.closeDate = val('iClose') || null;
    rec.refundDate = val('iRefund') || null;
    rec.listingDate = val('iList') || null;
    rec.listingPrice = num('iListPrice');
    rec.gmp = num('iGmp');
    rec.subs = num('iSubs');
    rec.registrar = val('iReg');
    rec.rhp = val('iRhp');
    var st = val('iStatus');
    rec.status = st === 'auto' ? null : st;
    rec.notes = val('iNotes');
    var problems = Calc.validIpo(rec);
    if (problems.length) { err.textContent = problems.join(' '); return; }
    if (edit) {
      for (var i = 0; i < DATA.ipos.length; i++) if (DATA.ipos[i].id === rec.id) { DATA.ipos[i] = rec; break; }
    } else {
      DATA.ipos.push(rec);
    }
    persist(); closeModal(); renderAll();
    toast(edit ? 'IPO updated.' : 'IPO added \u2014 it now shows in the calendar.', 'ok');
  }

  function buildAppForm(app, preselectIpo) {
    var edit = !!app;
    var a = app || {};
    var f = formShell(edit ? 'Edit application' : 'Record an application');
    var form = f.form, err = f.err, actions = f.actions;

    if (!DATA.ipos.length) {
      err.textContent = 'Add or fetch at least one IPO first (IPO calendar tab).';
      var okb = el('button', 'primary', 'Close');
      okb.onclick = closeModal;
      actions.appendChild(okb);
      modal(f.box, true);
      return;
    }
    if (!DATA.pans.length) {
      err.textContent = 'Add a PAN holder in Profile first \u2014 every application is filed under a PAN.';
      var pb = el('button', 'primary', 'Open profile');
      pb.onclick = function () { closeModal(); profileModal(); };
      actions.appendChild(pb);
      modal(f.box, true);
      return;
    }

    var ipoSel = selectControl('aIpo', Calc.sortIpos(DATA.ipos).map(function (i) {
      return { v: i.id, l: (i.name || '') + ' \u00B7 ' + priceText(i) + ' \u00B7 ' + (STATUS_META[Calc.ipoStatus(i)] || STATUS_META.watch).label };
    }), a.ipoId || preselectIpo || '');
    ipoSel.required = true;
    var panSel = selectControl('aPan', DATA.pans.map(function (p) {
      return { v: p.id, l: holderLabel(p) };
    }), a.panId || S.curPan || '');
    panSel.required = true;

    var defIpo = function () { return ipoOf(ipoSel.value); };
    var defPrice = function () { return a.price || (defIpo() && defIpo().bandHi); };
    var defLotsPick = function () { var i = defIpo(); return i ? Calc.defaultLots(i.category) : 3; };

    var lotsTouched = edit && a.lots != null;
    var lots = numInput('aLots', a.lots != null ? a.lots : defLotsPick(), 'number of lots');
    var price = numInput('aPrice', defPrice(), 'offer price per share', '0.01');
    price.required = true;

    var lienBox = el('div', 'kv small');
    var lienD = el('div');
    lienD.appendChild(el('b', '', 'Lien (mandate)'));
    var lienV = el('span', '', '\u20B90');
    lienD.appendChild(lienV);
    lienBox.appendChild(lienD);
    lienBox.className += ' lienmini';

    function updateLien() {
      var ipo = defIpo();
      var lotsV = num('aLots') || 0;
      var priceV = num('aPrice');
      if (priceV == null && ipo) priceV = ipo.bandHi;
      var lien = (ipo && ipo.shareLot) ? Math.round(lotsV * ipo.shareLot * (priceV || 0)) : 0;
      var span = lienBox.querySelector('span');
      span.textContent = Calc.inr(lien);
      span.textContent += ' = ' + lotsV + ' lots \u00D7 ' + (ipo ? ipo.shareLot : 0) + ' sh \u00D7 ' + Calc.price(priceV);
    }
    ipoSel.onchange = function () {
      price.value = defPrice();
      if (!lotsTouched) lots.value = defLotsPick();
      updateLien();
    };
    lots.oninput = function () { lotsTouched = true; updateLien(); };
    price.oninput = updateLien;

    form.appendChild(field('PAN holder *', panSel));
    form.appendChild(field('IPO *', ipoSel));
    form.appendChild(field('Applied on', dateInput('aOn', a.appliedOn || Calc.todayISO())));
    form.appendChild(field('Lots *', lots));
    form.appendChild(field('Offer price (\u20B9/share) *', price));
    var wlien = field('Lien amount', lienBox, true);

    var status = selectControl('aStatus', [
      { v: 'applied', l: 'Applied (awaiting allotment)' },
      { v: 'allotted', l: 'Allotted' },
      { v: 'rejected', l: 'Not allotted / refunded' }
    ], a.status || 'applied');

    var sharesWrap = el('div', 'wide sharesWrap');
    sharesWrap.appendChild(el('h4', '', 'If allotted (after registrar result)'));
    sharesWrap.appendChild(field('Allotted shares', numInput('aShares', a.shares || (a.status === 'allotted' ? (a.lots || 1) * (defIpo() ? defIpo().shareLot : 0) : ''), 'shares received')));
    var soldWrap = el('div', 'wide sub');
    soldWrap.appendChild(field('Sold on', dateInput('aSoldOn', a.soldOn)));
    soldWrap.appendChild(field('Sold price (\u20B9/share)', numInput('aSoldPrice', a.soldPrice, 'overrides listing price')));
    sharesWrap.appendChild(soldWrap);

    function syncStatus() {
      var st = document.getElementById('aStatus');
      var show = st.value === 'allotted';
      sharesWrap.style.display = show ? '' : 'none';
      if (show && !(num('aShares') > 0)) {
        var ipo = defIpo();
        document.getElementById('aShares').value = (num('aLots') || 1) * (ipo ? ipo.shareLot : 0);
      }
    }
    status.onchange = syncStatus;

    form.appendChild(field('Status', status));
    form.appendChild(wlien);
    form.appendChild(field('Notes', noteArea('aNotes', a.notes), true));
    form.appendChild(sharesWrap);

    var save = el('button', 'primary', edit ? 'Save changes' : 'Record application');
    save.onclick = function () { doSaveApp(a, edit, err); };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    actions.appendChild(save); actions.appendChild(cancel);
    modal(f.box, true);
    updateLien();
    syncStatus();
    setTimeout(updateLien, 0);
  }
  function applyModal(ipo) {
    var f = formShell('Apply \u2014 ' + (ipo.name || 'Untitled'));
    var form = f.form, err = f.err, actions = f.actions;

    if (!DATA.pans.length) {
      err.textContent = 'Add a PAN holder in Profile first \u2014 every application is filed under a PAN.';
      var pb = el('button', 'primary', 'Open profile');
      pb.onclick = function () { closeModal(); profileModal(); };
      actions.appendChild(pb);
      modal(f.box, true);
      return;
    }

    var defLots = Calc.defaultLots(ipo.category);
    var perPan = ipo.bandHi > 0 && ipo.shareLot ? Math.round(ipo.bandHi * ipo.shareLot * defLots) : 0;
    var applied = {};
    DATA.applications.forEach(function (a) { if (a.ipoId === ipo.id) applied[a.panId] = true; });
    form.appendChild(el('p', 'hint', 'Default per PAN: ' + Calc.price(ipo.bandHi) + ' \u00D7 ' +
      Calc.fmtNum(ipo.shareLot || 0) + ' sh/lot \u00D7 ' + defLots + ' lot = ' + Calc.inr(perPan) +
      '. Tick the PAN holder(s) you applied under. Fine-tune lots/price later via edit.'));
    form.appendChild(el('p', 'hint', 'For a custom lots/price entry use the Applications tab \u2018+ Apply IPO\u2019.'));

    var panPick = el('div', 'panPick');
    DATA.pans.forEach(function (p) {
      var dup = !!applied[p.id];
      var lab = el('label', 'panOpt');
      var c = document.createElement('input');
      c.type = 'checkbox';
      c.id = 'panCk' + p.id;
      if (dup) c.disabled = true;
      c.onchange = updateTotal;
      lab.appendChild(c);
      lab.appendChild(el('span', '', holderLabel(p) + (dup ? ' \u2014 already applied' : '')));
      panPick.appendChild(lab);
    });
    form.appendChild(field('Apply under', panPick, true));

    var tot = el('p', 'hint');
    tot.id = 'applyTot';
    form.appendChild(tot);
    function updateTotal() {
      var n = 0;
      DATA.pans.forEach(function (p) {
        var e = document.getElementById('panCk' + p.id);
        if (e && e.checked) n++;
      });
      tot.textContent = n ? 'Adds ' + n + ' application' + (n === 1 ? '' : 's') + ' \u00B7 total lien ' + Calc.inr(perPan * n)
        : 'Nothing ticked yet \u2014 tick at least one PAN holder.';
    }
    updateTotal();

    var save = el('button', 'primary', 'Apply');
    save.onclick = function () {
      var ticked = DATA.pans.filter(function (p) {
        var e = document.getElementById('panCk' + p.id);
        return e && e.checked;
      });
      if (!ticked.length) { err.textContent = 'Tick at least one PAN holder.'; return; }
      var created = ticked.length;
      ticked.forEach(function (p) {
        DATA.applications.push({
          id: Calc.uid('app'), createdAt: new Date().toISOString(),
          ipoId: ipo.id, panId: p.id, appliedOn: Calc.todayISO(),
          lots: defLots, price: ipo.bandHi, status: 'applied',
          shares: null, soldOn: null, soldPrice: null, notes: ''
        });
      });
      persist(); closeModal(); renderAll();
      toast('Applied ' + created + ' application' + (created === 1 ? '' : 's') + ' \u2014 lien ' + Calc.inr(perPan * created) + '.', 'ok');
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    actions.appendChild(save); actions.appendChild(cancel);
    modal(f.box, true);
  }
  function doSaveApp(a, edit, err) {
    var ipo = ipoOf(val('aIpo'));
    var rec = edit ? JSON.parse(JSON.stringify(a)) : { id: Calc.uid('app'), createdAt: new Date().toISOString() };
    rec.ipoId = val('aIpo');
    rec.panId = val('aPan');
    rec.appliedOn = val('aOn') || Calc.todayISO();
    rec.lots = num('aLots');
    rec.price = num('aPrice');
    if (rec.price == null) rec.price = ipo ? ipo.bandHi : null;
    rec.status = val('aStatus');
    rec.shares = num('aShares') || null;
    rec.soldOn = val('aSoldOn') || null;
    rec.soldPrice = num('aSoldPrice');
    rec.notes = val('aNotes');
    var problems = Calc.validApp(rec, ipo);
    if (problems.length) { err.textContent = problems.join(' '); return; }
    if (Calc.hasApp(DATA.applications, rec.ipoId, rec.panId, edit ? rec.id : null)) {
      err.textContent = 'This PAN already has an application for this IPO.';
      return;
    }
    if (edit) {
      for (var i = 0; i < DATA.applications.length; i++) if (DATA.applications[i].id === rec.id) { DATA.applications[i] = rec; break; }
    } else {
      DATA.applications.push(rec);
    }
    persist(); closeModal(); renderAll();
    toast(edit ? 'Application updated.' : 'Application recorded.', 'ok');
  }
  function quickAllot(a) {
    var ipo = ipoOf(a.ipoId);
    a.status = 'allotted';
    if (!(a.shares > 0) && ipo) a.shares = a.lots * ipo.shareLot;
    persist(); renderAll();
    toast('Marked allotted \u2014 shares ' + Calc.fmtNum(a.shares) + '.', 'ok');
  }
  function quickReject(a) {
    a.status = 'rejected';
    persist(); renderAll();
    toast('Marked not allotted \u2014 lien refunded.', 'warn');
  }

  function listingModal(ipo) {
    var f = formShell('Listing price');
    var form = f.form, err = f.err, actions = f.actions;
    form.appendChild(field('Listing price (\u20B9/share)', numInput('iListPrm', ipo.listingPrice, 'debut/closing price')));
    var save = el('button', 'primary', 'Save');
    save.onclick = function () {
      var v = num('iListPrm');
      if (v == null) { err.textContent = 'Enter a price, or use Cancel.'; return; }
      ipo.listingPrice = v;
      persist(); closeModal(); renderAll();
      toast('Listing price recorded \u2014 P&L updated.');
    };
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.onclick = closeModal;
    actions.appendChild(save); actions.appendChild(cancel);
    modal(f.box, true);
  }

  function profileModal() {
    var f = formShell('Profile & PAN holders');
    var form = f.form, err = f.err, actions = f.actions;
    form.appendChild(field('Profile name', textInput('pName', DATA.profile.name, 'your name (optional)')));
    form.appendChild(field('Calendar URL', textInput('pCalUrl', DATA.meta.calendarUrl || '', DEFAULT_CAL_URL, 320), true));
    form.appendChild(el('p', 'muted small wide', 'Leave empty to use the built-in default (a daily NSE+BSE snapshot). It is fetched only when you click Fetch Online, and nothing about you is ever sent with that request.'));

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
      pan.addEventListener('input', function () { pan.value = Calc.normPan ? Calc.normPan(pan.value) : pan.value; });
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
      DATA.profile.name = val('pName');
      DATA.meta.calendarUrl = val('pCalUrl');
      var newPans = [];
      Array.prototype.forEach.call(document.querySelectorAll('#panRows .crow'), function (row) {
        var input = row.querySelectorAll('input');
        var pan = Calc.normPan ? Calc.normPan(input[0].value) : input[0].value;
        var name = input[1].value.trim();
        if (!pan && !name) return;
        var holder = { id: row.getAttribute('data-id') || Calc.uid('pan'), pan: pan, name: name };
        var problems = Calc.validPan(holder);
        if (problems.length) { err.textContent = (name ? name + ': ' : '') + problems.join(' '); throw new Error('stop'); }
        newPans.push(holder);
      });
      DATA.pans = newPans;
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
  function deleteIpo(ipo) {
    var n = DATA.applications.filter(function (a) { return a.ipoId === ipo.id; }).length;
    confirmDel('Delete \u2018' + (ipo.name || 'Unnamed') + '\u2019 and its ' + n + ' application record(s)? This cannot be undone.',
      function () {
        DATA.applications = DATA.applications.filter(function (a) { return a.ipoId !== ipo.id; });
        DATA.ipos = DATA.ipos.filter(function (i) { return i.id !== ipo.id; });
        persist(); renderAll();
        toast('IPO and its applications deleted.', 'warn');
      });
  }
  function deleteApp(a) {
    var ipo = ipoOf(a.ipoId);
    confirmDel('Delete this application for \u2018' + (ipo ? ipo.name : 'Unknown IPO') + '\u2019? This cannot be undone.',
      function () {
        DATA.applications = DATA.applications.filter(function (x) { return x.id !== a.id; });
        persist(); renderAll();
        toast('Application deleted.', 'warn');
      });
  }

  function runCleanup() {
    var due = Calc.cleanupCandidates(DATA.ipos, DATA.applications, CLEANUP_DAYS);
    if (!due.length) return;
    var gone = {};
    due.forEach(function (i) { gone[i.id] = 1; });
    var nApps = DATA.applications.filter(function (a) { return gone[a.ipoId]; }).length;
    DATA.ipos = DATA.ipos.filter(function (i) { return !gone[i.id]; });
    DATA.applications = DATA.applications.filter(function (a) { return !gone[a.ipoId]; });
    persist(); renderAll();
    toast('Auto-cleaned ' + due.length + ' completed IPO' + (due.length > 1 ? 's' : '') + ' (' + nApps + ' application record' +
      (nApps === 1 ? '' : 's') + ') older than ' + CLEANUP_DAYS + ' days.', 'warn');
  }

  function saveBundle() {
    var blob = new Blob(['window.DATA = ' + JSON.stringify(DATA, null, 1) + ';\n'], { type: 'text/javascript' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'data/bundle.js';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Bundle downloaded. Place it in this app\u2019s data/ folder to move your data. Note: it compacts your personal data \u2014 treat it as private.');
  }
  function loadBundle(file) {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var s = String(rd.result);
        if (/\bwindow\.DATA\s*=/.test(s)) s = s.replace(/^[\s\S]*?=\s*/, '').replace(/;\s*$/, '');
        var d = JSON.parse(s);
        if (!d || !Array.isArray(d.ipos) || !Array.isArray(d.applications)) throw new Error('missing ipos/applications arrays');
        DATA.ipos = d.ipos;
        DATA.applications = d.applications;
        if (Array.isArray(d.pans)) DATA.pans = d.pans;
        DATA.profile = d.profile || {};
        DATA.meta = d.meta || {};
        persist(); renderAll();
        toast('Bundle loaded.');
      } catch (e2) {
        toast('Not a valid bundle: ' + e2.message, 'bad');
      }
    };
    rd.readAsText(file);
  }

  function findIpo(symbol, openDate) {
    var keySymbol = String(symbol || '').toUpperCase();
    for (var i = 0; i < DATA.ipos.length; i++) {
      var x = DATA.ipos[i];
      if (keySymbol && x.symbol && String(x.symbol).toUpperCase() === keySymbol &&
          (x.openDate || null) === (openDate || null)) return x;
    }
    return null;
  }
  function applyRemote(d) {
    if (!d || !Array.isArray(d.ipos)) throw new Error('payload has no ipos array');
    var CORE = ['name', 'symbol', 'exchange', 'category', 'bandHi', 'shareLot', 'minLots',
      'openDate', 'closeDate', 'refundDate', 'listingDate', 'registrar', 'rhp'];
    var added = 0, updated = 0, statused = 0;
    d.ipos.forEach(function (raw) {
      var r = Calc.normRemote(raw);
      if (!r) return;
      var match = findIpo(r.symbol, r.openDate);
      if (match) {
        CORE.forEach(function (k) { if (r[k] != null) match[k] = r[k]; });
        if (r.gmp != null) match.gmp = r.gmp;
        if (r.subs != null) match.subs = r.subs;
        updated++;
      } else {
        var rec = { id: Calc.uid('ipo'), createdAt: new Date().toISOString(), src: 'remote' };
        CORE.forEach(function (k) { rec[k] = r[k] != null ? r[k] : null; });
        if (r.gmp != null) rec.gmp = r.gmp; else rec.gmp = null;
        if (r.subs != null) rec.subs = r.subs; else rec.subs = null;
        rec.listingPrice = null;
        rec.status = null;
        rec.notes = '';
        DATA.ipos.push(rec);
        added++;
      }
    });
    if (Array.isArray(d.applications)) {
      d.applications.forEach(function (ra) {
        var st = String(ra.status || '').toLowerCase();
        if (st !== 'allotted' && st !== 'rejected') return;
        var holder = null;
        for (var h = 0; h < DATA.pans.length; h++) {
          if (Calc.normPan(DATA.pans[h].pan) === Calc.normPan(ra.pan)) { holder = DATA.pans[h]; break; }
        }
        if (!holder) return;
        var ipo = findIpo(ra.symbol, ra.openDate);
        if (!ipo) return;
        var changed = false;
        DATA.applications.forEach(function (a) {
          if (a.panId !== holder.id || a.ipoId !== ipo.id) return;
          a.status = st;
          if (st === 'allotted' && ra.shares > 0) a.shares = ra.shares;
          changed = true;
        });
        if (changed) statused++;
      });
    }
    persist(); renderAll();
    toast('Calendar refreshed: ' + added + ' added, ' + updated + ' updated' +
      (statused ? ', ' + statused + ' status' + (statused === 1 ? '' : 'es') + ' checked' : '') + '.', 'ok');
  }
  function fetchCalendar() {
    var url = (DATA.meta.calendarUrl || '').trim() || DEFAULT_CAL_URL;
    var btn = document.getElementById('btnFetch');
    btn.disabled = true;
    btn.textContent = 'Fetching\u2026';
    fetch(url, { mode: 'cors' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(applyRemote)
      .catch(function (e) { toast('Fetch Online failed: ' + e.message + ' (offline or CORS blocked).', 'bad'); })
      .finally(function () { btn.disabled = false; btn.textContent = 'Fetch Online'; });
  }

  function switchTab(t) {
    S.tab = t;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (b) {
      if (b.getAttribute('data-tab') === t) b.classList.add('now');
      else b.classList.remove('now');
    });
    document.getElementById('sec-cal').hidden = t !== 'cal';
    document.getElementById('sec-apps').hidden = t !== 'apps';
    document.getElementById('sec-hist').hidden = t !== 'hist';
    if (t === 'hist') requestAnimationFrame(drawPnlChart);
  }
  function renderAll() {
    buildPanSel();
    setProfileChip();
    renderPanBar();
    renderChips();
    renderCal();
    renderApps();
    renderHist();
    if (S.tab === 'hist') requestAnimationFrame(drawPnlChart);
  }

  function init() {
    load();
    runCleanup();
    document.getElementById('btnSave').onclick = saveBundle;
    document.getElementById('btnImport').onclick = function () { document.getElementById('importFile').click(); };
    document.getElementById('importFile').onchange = function () {
      if (this.files && this.files[0]) loadBundle(this.files[0]);
      this.value = '';
    };
    document.getElementById('btnFetch').onclick = fetchCalendar;
    document.getElementById('profilechip').onclick = profileModal;
    document.getElementById('panSel').onchange = function () {
      S.curPan = this.value;
      try { localStorage.setItem(LS_PAN, S.curPan); } catch (e) {}
      renderAll();
    };
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (b) {
      b.onclick = function () { switchTab(b.getAttribute('data-tab')); };
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (S.tab === 'hist') drawPnlChart(); }, 200);
    });
    window.addEventListener('beforeunload', flush);
    switchTab('cal');
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.App = { DATA: DATA, switchTab: switchTab, renderAll: renderAll, fetchCalendar: fetchCalendar, runCleanup: runCleanup };
})();