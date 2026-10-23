/* VIDE Next 목업 공통 동작 v12 — v12(9판): 서랍 [+ 새 세션]은 서랍 유지 + 임시 행(.srow.draft) · 자료 파일 행 → 가운데 미리보기 탭 · 탭 모형(미리보기/고정 · 우클릭 · 끌어 놓기 2분할 · Ctrl+\ 오른쪽 분할 · 고정 8 상한) · 열 둘 다 접기 = Ctrl+Shift+\. v11 —스플리터·가장자리 띠(v11), 대화 패널 두 보기(세션 목록 ↔ 대화 · 새 세션 · 질문 카드 · 모델 메뉴), 테마(밝음 기본), 탭, 대화/터미널, 접기, 레일 묶음 5 → 탐색기 블록, 검색칸 거르기, UI 언어 전체 전환(applyLang), 폴더 접기·+ 폴더, 선택 창, 데모 넘기기. 제품 코드 아님. */
(function () {
  function $$(q, r) { return [].slice.call((r || document).querySelectorAll(q)); }
  var root = document.documentElement, key = 'vide-next-theme';
  /* 테마: 기본 밝음, dark 저장 (레일 왼쪽 아래 단추) */
  /* 어둠 테마용 그림: img[data-dark-src] (11 랜딩 캡처) */
  function themeImgs() { var d = root.getAttribute('data-theme') === 'dark'; $$('img[data-dark-src]').forEach(function (i) { if (!i.dataset.lightSrc) i.dataset.lightSrc = i.getAttribute('src'); i.setAttribute('src', d ? i.dataset.darkSrc : i.dataset.lightSrc); }); }
  try { if (localStorage.getItem(key) === 'dark') root.setAttribute('data-theme', 'dark'); } catch (e) {}
  themeImgs();
  $$('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var dark = root.getAttribute('data-theme') === 'dark';
      if (dark) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
      try { if (dark) localStorage.removeItem(key); else localStorage.setItem(key, 'dark'); } catch (e) {}
      themeImgs();
    });
  });
  /* 탭: [data-tab=id] 단추 → 같은 [data-tabscope] 안의 .tabpane#id. aria-pressed로 표시 */
  $$('[data-tab]').forEach(function (b) {
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      var scope = b.closest('[data-tabscope]') || document;
      $$('[data-tab]', scope).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); x.classList.toggle('on', x === b); });
      $$('.tabpane', scope).forEach(function (p) { p.classList.toggle('on', p.id === b.dataset.tab); });
    });
  });
  /* 해시로 탭 열기: #dec 등이 [data-tab] 값과 같으면 그 단추를 누른다 */
  var h = location.hash.slice(1);
  if (h) { var hb = $$('[data-tab]').filter(function (x) { return x.dataset.tab === h; })[0]; if (hb) hb.click(); }
  /* 에이전트: 터미널 단추(aria-pressed) */
  $$('[data-agent-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      var agent = b.closest('.agent');
      var on = b.getAttribute('aria-pressed') !== 'true';
      agent.classList.toggle('term-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  });
  var app = document.querySelector('.app');
  /* 스플리터 v11: .split[data-split=explorer|agent] 끌기 → --explorer(160~420) · --agent(300~640). 최소 미만 = 접힘(.explorer-closed/.agent-closed) + 가장자리 띠 .edge(클릭·끌기로 펼침). 더블클릭 = 기본(230/380). 손잡이 ←→ 16px · Enter 접기/펼치기. Ctrl+B 탐색기 · Ctrl+Alt+B 대화 · Ctrl+Shift+\ 둘 다(Ctrl+\ 는 가운데 오른쪽 분할). 'vide-w'에 기억 */
  var W = { explorer: { min: 160, max: 420, def: 230, dir: 1 }, agent: { min: 300, max: 640, def: 380, dir: -1 } }, wKey = 'vide-w', ws = {};
  try { ws = JSON.parse(localStorage.getItem(wKey)) || {}; } catch (e) {}
  function wOf(k) { return ws[k] || W[k].def; }
  function shut(k) { return app.classList.contains(k + '-closed'); }
  /* 가운데 열 최소 320px: 탐색기+대화 ≤ 창 너비 − 레일 − 320. 끌기·복원·resize 모두 같은 규칙 */
  var MID = 320;
  function room(k) {
    var o = k === 'explorer' ? 'agent' : 'explorer', ow = shut(o) ? 0 : wOf(o);
    var rail = parseFloat(getComputedStyle(root).getPropertyValue('--rail')) || 44;
    return Math.max(W[k].min, Math.min(W[k].max, window.innerWidth - rail - MID - ow));
  }
  function fit() { ['agent', 'explorer'].forEach(function (k) { if (!shut(k)) setW(k, wOf(k), true); }); }
  function setW(k, v, noSave) {
    var c = W[k], closed = v < c.min, s = app.querySelector('.split[data-split=' + k + ']');
    if (!closed) { ws[k] = v = Math.min(room(k), Math.round(v)); root.style.setProperty('--' + k, v + 'px'); }
    app.classList.toggle(k + '-closed', closed); ws[k + 'C'] = closed;
    if (s) { s.setAttribute('aria-valuenow', wOf(k)); s.dataset.w = closed ? '' : wOf(k); }
    if (!noSave) try { localStorage.setItem(wKey, JSON.stringify(ws)); } catch (e) {}
  }
  function setOpen(k, open) { if (app) setW(k, open ? wOf(k) : 0); }
  if (app) {
    Object.keys(W).forEach(function (k) { if (ws[k]) root.style.setProperty('--' + k, ws[k] + 'px'); if (k + 'C' in ws) app.classList.toggle(k + '-closed', !!ws[k + 'C']); });
    fit(); window.addEventListener('resize', fit);
    var drag = null, moved = false;
    $$(':scope>.split[data-split], :scope>.edge[data-edge]', app).forEach(function (el) {
      var k = el.dataset.split || el.dataset.edge;
      el.addEventListener('pointerdown', function (e) {
        if (e.button) return; e.preventDefault(); moved = false;
        drag = { k: k, x: e.clientX, w: shut(k) ? 0 : wOf(k), s: app.querySelector('.split[data-split=' + k + ']') };
        app.classList.add('dragging'); if (drag.s) drag.s.classList.add('on');
      });
      if (el.dataset.edge) { el.addEventListener('click', function () { if (!moved) { setOpen(k, true); var sp = app.querySelector(':scope>.split[data-split=' + k + ']'); if (sp) sp.focus(); } moved = false; }); return; }
      el.addEventListener('dblclick', function () { setW(k, W[k].def); });
      el.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
        if (d) setW(k, Math.max(W[k].min, wOf(k) + d * W[k].dir)); else if (e.key === 'Enter') { var o = shut(k); setOpen(k, o); if (!o) { var ed = app.querySelector(':scope>.edge[data-edge=' + k + ']'); if (ed) ed.focus(); } } else return;
        e.preventDefault(); e.stopPropagation();
      });
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag) return; var dx = e.clientX - drag.x; if (Math.abs(dx) > 3) moved = true;
      if (moved) setW(drag.k, drag.w + dx * W[drag.k].dir, true);
    });
    window.addEventListener('pointerup', function () {
      if (!drag) return; app.classList.remove('dragging'); if (drag.s) drag.s.classList.remove('on');
      if (moved) { if (shut(drag.k) && drag.w) ws[drag.k] = drag.w; setW(drag.k, shut(drag.k) ? 0 : wOf(drag.k)); } drag = null;
    });
    document.addEventListener('keydown', function (e) {
      if (!e.ctrlKey) return;
      var bs = e.code === 'Backslash' || e.key === '\\' || e.key === '|';
      var ks = bs && e.shiftKey ? ['explorer', 'agent'] : !e.shiftKey && /^b$/i.test(e.key) ? [e.altKey ? 'agent' : 'explorer'] : null; if (!ks) return;
      e.preventDefault(); var open = ks.some(shut); ks.forEach(function (k) { setOpen(k, open); });
    });
  }
  /* 눌림 표시만 하는 단추: [data-press] (라디오처럼 같은 data-group 안에서 하나만) */
  $$('[data-press]').forEach(function (b) {
    b.addEventListener('click', function () {
      var g = b.dataset.group;
      if (g) { $$('[data-group="' + g + '"]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }
      else b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    });
  });
  /* 탐색기 v6: 폴더 접기·펼치기(.row[data-fold]) · + 폴더(button.add → input.newf, Enter 추가 / Esc 취소, 메모리만) */
  function depth(r) { return parseFloat(r.style.getPropertyValue('--d')) || 0; }
  function kids(r) { var out = [], d = depth(r), n = r.nextElementSibling; while (n && depth(n) > d) { out.push(n); n = n.nextElementSibling; } return out; }
  function fold(r) {
    var tw = r.querySelector('.tw'), open = tw.classList.contains('open');
    tw.classList.toggle('open', !open); tw.textContent = open ? '›' : '⌄';
    /* 접으면 하위 전부 숨김, 펼치면 직계만 보이고 하위 폴더는 자기 꺾쇠(.tw.open) 상태대로 */
    var ks = kids(r);
    if (open) { ks.forEach(function (k) { k.hidden = true; }); return; }
    var shut = Infinity;
    ks.forEach(function (k) {
      var kd = depth(k); if (kd <= shut) shut = Infinity;
      k.hidden = kd > shut;
      if (!k.hidden && k.hasAttribute('data-fold') && !k.querySelector('.tw').classList.contains('open')) shut = kd;
    });
  }
  /* + 폴더: r = 부모 폴더 행이면 그 아래 하위 폴더, r = null이면 tree 맨 아래 최상위(--d:0, 자료 머리 새 폴더) */
  function addRow(r, tree) {
    var old = document.querySelector('.explorer .row.new'); if (old) old.remove();
    tree = tree || r.closest('.tree');
    var base = tree && tree.dataset.sec === 'base';
    if (r) { /* 접힌 폴더에 넣으면 그 폴더를 펼친 꼴로(꺾쇠 ⌄) */
      var ptw = r.querySelector('.tw'); if (ptw && ptw.textContent === '›') { ptw.classList.add('open'); ptw.textContent = '⌄'; r.setAttribute('data-fold', ''); }
    }
    /* 새 폴더 행의 hover 단추 = 부모(최상위면 그 트리의 첫 폴더) 것과 같게(자료: 새 폴더 · 가져오기 / 그 밖: +) */
    var src = r || tree.querySelector('.row[data-fold]'), ad = src && src.querySelector('.adds'), addHtml = ad ? ad.outerHTML : '<button type="button" class="add" title="새 폴더" data-en-title="New folder">+</button>';
    var row = document.createElement('div'); row.className = 'row new'; row.style.setProperty('--d', r ? depth(r) + 1 : 0);
    row.innerHTML = '<span class="tw"></span><svg class="i sm"><use href="#i-folder"/></svg><input class="newf" placeholder="' + (base ? '새 폴더' : 'new-folder') + '"' + (base ? ' data-en-ph="New folder"' : '') + ' spellcheck="false">';
    if (r) r.parentNode.insertBefore(row, r.nextSibling); else tree.appendChild(row);
    applyLang(lang); var inp = row.querySelector('input'); inp.focus();
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { row.remove(); return; }
      if (e.key !== 'Enter') return;
      var v = inp.value.trim(); if (!v) { row.remove(); return; }
      row.className = 'row'; row.setAttribute('data-fold', ''); row.innerHTML = '<span class="tw">›</span><svg class="i sm"><use href="#i-folder"/></svg><span class="grow"></span>' + addHtml;
      row.querySelector('.grow').textContent = v; applyLang(lang);
    });
  }
  /* 모두 접기: 하위 행 전부 숨김, 폴더 꺾쇠 › */
  function collapseAll(tree) {
    $$('.row', tree).forEach(function (r) {
      if (depth(r) > 0) r.hidden = true;
      var tw = r.querySelector('.tw'); if (r.hasAttribute('data-fold') && tw) { tw.classList.remove('open'); tw.textContent = '›'; }
    });
  }
  /* 가져오기(메모리만): r = 폴더 행이면 그 폴더 맨 아래, null이면 트리 맨 아래 최상위에 합성 파일 행 '새 자료.pdf'(선택 상태) */
  function importRow(r, tree) {
    tree = tree || r.closest('.tree');
    if (r) { var ptw = r.querySelector('.tw'); if (ptw && !ptw.classList.contains('open')) fold(r); }
    var ks = r ? kids(r) : [], at = r ? (ks.length ? ks[ks.length - 1] : r) : null;
    var row = document.createElement('div'); row.className = 'row file'; row.dataset.kind = 'pdf'; row.style.setProperty('--d', r ? depth(r) + 1 : 0); row.tabIndex = 0;
    row.innerHTML = '<span class="tw"></span><svg class="i sm f-pdf"><use href="#i-f-pdf"/></svg><span class="grow">새 자료.pdf</span>';
    if (at) at.parentNode.insertBefore(row, at.nextSibling); else tree.appendChild(row);
    if (r) { var m = r.querySelector('.meta'); if (m && /^\d+$/.test(m.textContent.trim())) m.textContent = +m.textContent + 1; }
    $$('.row.sel', tree).forEach(function (x) { x.classList.remove('sel'); }); row.classList.add('sel'); row.focus();
  }
  /* 탐색기 열기(목업): 잠깐 눌림 표시만 */
  function press(el) { if (!el) return; el.classList.add('pressed'); setTimeout(function () { el.classList.remove('pressed'); }, 450); }
  /* 이름 바꾸기(메모리만): .grow → input.newf, Enter 반영 / Esc 취소 */
  function renameRow(r) {
    var g = r.querySelector('.grow'); if (!g) return;
    var inp = document.createElement('input'); inp.className = 'newf'; inp.value = g.textContent; inp.spellcheck = false;
    g.hidden = true; g.parentNode.insertBefore(inp, g.nextSibling); inp.focus(); inp.select();
    function done(ok) { if (ok && inp.value.trim()) g.textContent = inp.value.trim(); inp.remove(); g.hidden = false; }
    inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', function () { if (inp.isConnected) done(true); });
  }
  /* 자료 폴더 우클릭 = .ctx.menu 5항목(새 폴더 · 가져오기 · 이름 바꾸기 · 탐색기에서 열기 · 삭제) */
  var fmenu = null;
  function folderMenu(r, x, y) {
    if (!fmenu) {
      var FM = [['folder', '새 폴더', 'New folder'], ['import', '가져오기', 'Import'], ['rename', '이름 바꾸기', 'Rename'], ['reveal', '탐색기에서 열기', 'Show in Explorer'], null, ['delete', '삭제', 'Delete']];
      fmenu = document.createElement('div'); fmenu.className = 'ctx menu abs'; fmenu.setAttribute('role', 'menu'); fmenu.hidden = true;
      fmenu.innerHTML = FM.map(function (m) { return m ? '<button type="button" role="menuitem" data-act="' + m[0] + '"><span data-en="' + m[2] + '">' + m[1] + '</span></button>' : '<hr>'; }).join('');
      document.body.appendChild(fmenu);
      fmenu.addEventListener('click', function (ev) {
        var b = ev.target.closest('button'); if (!b) return; fmenu.hidden = true;
        var t = fmenu._r, a = b.dataset.act; if (!t || !t.isConnected) return;
        if (a === 'folder') addRow(t);
        else if (a === 'import') importRow(t);
        else if (a === 'reveal') press(t);
        else if (a === 'rename') renameRow(t);
        else if (a === 'delete') { kids(t).forEach(function (k) { k.remove(); }); t.remove(); }
      });
      document.addEventListener('pointerdown', function (ev) { if (!fmenu.hidden && !fmenu.contains(ev.target)) fmenu.hidden = true; }, true);
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') fmenu.hidden = true; });
      window.addEventListener('resize', function () { fmenu.hidden = true; }); window.addEventListener('blur', function () { fmenu.hidden = true; });
    }
    fmenu._r = r; applyLang(lang); fmenu.hidden = false;
    fmenu.style.left = Math.max(4, Math.min(x, window.innerWidth - fmenu.offsetWidth - 4)) + 'px';
    fmenu.style.top = Math.max(4, Math.min(y, window.innerHeight - fmenu.offsetHeight - 4)) + 'px';
  }
  /* 자료 파일 우클릭 = .ctx.menu 4항목(열기 · 오른쪽에 열기 · 아래에 열기 · 탐색기에서 열기). 옆으로 열기 = openFile 뒤 split */
  var flmenu = null;
  function fileMenu(r, x, y) {
    if (!flmenu) {
      var FL = [['open', '열기', 'Open'], ['open-right', '오른쪽에 열기', 'Open to the right'], ['open-down', '아래에 열기', 'Open below'], null, ['reveal', '탐색기에서 열기', 'Show in Explorer']];
      flmenu = document.createElement('div'); flmenu.className = 'ctx menu abs'; flmenu.setAttribute('role', 'menu'); flmenu.hidden = true; flmenu.dataset.menu = 'file';
      flmenu.innerHTML = FL.map(function (m) { return m ? '<button type="button" role="menuitem" data-act="' + m[0] + '"><span data-en="' + m[2] + '">' + m[1] + '</span></button>' : '<hr>'; }).join('');
      document.body.appendChild(flmenu);
      flmenu.addEventListener('click', function (ev) {
        var b = ev.target.closest('button'); if (!b) return; flmenu.hidden = true;
        var t = flmenu._r, a = b.dataset.act; if (!t || !t.isConnected) return;
        if (a === 'reveal') { press(t); return; }
        var tab = openFile(t, a !== 'open'); if (tab && a !== 'open') split(tab, a === 'open-down' ? 'bottom' : 'right', true);
      });
      document.addEventListener('pointerdown', function (ev) { if (!flmenu.hidden && !flmenu.contains(ev.target)) flmenu.hidden = true; }, true);
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') flmenu.hidden = true; });
      window.addEventListener('resize', function () { flmenu.hidden = true; }); window.addEventListener('blur', function () { flmenu.hidden = true; });
    }
    flmenu._r = r; applyLang(lang); flmenu.hidden = false;
    flmenu.style.left = Math.max(4, Math.min(x, window.innerWidth - flmenu.offsetWidth - 4)) + window.scrollX + 'px';
    flmenu.style.top = Math.max(4, Math.min(y, window.innerHeight - flmenu.offsetHeight - 4)) + window.scrollY + 'px';
  }
  $$('.explorer .tree[data-sec=base]').forEach(function (t) {
    var h = t.querySelector('.tree-head');
    if (h) h.addEventListener('click', function (e) {
      var x = e.target.closest('.ext'); if (x) { e.preventDefault(); press(x); return; }
      var b = e.target.closest('[data-head]'); if (!b) return; e.preventDefault();
      if (b.dataset.head === 'folder') addRow(null, t); else if (b.dataset.head === 'import') importRow(null, t); else if (b.dataset.head === 'collapse') collapseAll(t);
    });
    t.addEventListener('contextmenu', function (e) {
      var f = e.target.closest('.row.file'); if (f) { e.preventDefault(); fileMenu(f, e.clientX, e.clientY); return; }
      var r = e.target.closest('.row[data-fold]'); if (!r || r.classList.contains('new')) return; e.preventDefault(); folderMenu(r, e.clientX, e.clientY);
    });
  });
  $$('.explorer .tree').forEach(function (t) {
    t.addEventListener('click', function (e) {
      var r = e.target.closest('.row'); if (!r) return;
      var ad = e.target.closest('.add');
      if (ad) { e.preventDefault(); e.stopPropagation(); if (ad.dataset.add === 'import') importRow(r); else addRow(r); return; }
      /* 자료 파일 행: 한 번 = 미리보기 탭, 두 번 = 고정 */
      if (r.classList.contains('file')) { e.preventDefault(); openFile(r, false); return; }
      if (!r.hasAttribute('data-fold')) return;
      if (r.tagName === 'A' && !e.target.closest('.tw')) return;
      e.preventDefault(); fold(r);
    });
    t.addEventListener('dblclick', function (e) { var r = e.target.closest('.row.file'); if (r) openFile(r, true); });
  });
  /* 레일 v7: 묶음 5(a[data-sec]) → 탐색기 .tree[data-sec] 하나만 표시(가운데 유지). 처음 = .sel 있는 블록 > 'vide-sec' > base. 이미 보이는 묶음을 다시 누르면 탐색기 접기·펼치기 */
  var secKey = 'vide-sec', trees = $$('.explorer .tree[data-sec]');
  function showSec(sec) {
    if (!trees.some(function (t) { return t.dataset.sec === sec; })) sec = 'base';
    trees.forEach(function (t) { t.hidden = t.dataset.sec !== sec; });
    $$('.rail a[data-sec]').forEach(function (a) { a.classList.toggle('on', a.dataset.sec === sec); });
    filt();
  }
  $$('.rail a[data-sec]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (!trees.length) return;
      e.preventDefault();
      var cur = trees.filter(function (t) { return !t.hidden; })[0];
      if (cur && cur.dataset.sec === a.dataset.sec && !shut('explorer')) { setOpen('explorer', false); return; }
      if (q && q.value) q.setAttribute('data-live', ''); /* 검색 중 묶음을 바꾸면 그 묶음도 같은 글자로 거른다(09 첫 값 포함) */
      setOpen('explorer', true); showSec(a.dataset.sec);
      try { localStorage.setItem(secKey, a.dataset.sec); } catch (err) {}
    });
  });
  /* 검색칸(.proj input.q): 보이는 블록의 행을 거른다. 맞는 행과 그 위 폴더만 보이고, 비우면 원래 펼침으로 */
  var q = document.querySelector('.explorer .proj input.q');
  function filt() {
    $$('.explorer .tree .row[data-h0]').forEach(function (r) { r.hidden = r.getAttribute('data-h0') === '1'; r.removeAttribute('data-h0'); });
    $$('.explorer .tree .row.none').forEach(function (r) { r.remove(); });
    var v = q ? q.value.trim().toLowerCase() : '', t = trees.filter(function (x) { return !x.hidden; })[0];
    if (!v || !t || !q.hasAttribute('data-live')) return;
    var rows = $$('.row', t).filter(function (r) { return !r.closest('.res'); }), hit = 0;
    rows.forEach(function (r) { r.setAttribute('data-h0', r.hidden ? '1' : '0'); r.hidden = true; });
    rows.forEach(function (r, i) {
      if (r.textContent.toLowerCase().indexOf(v) < 0) return;
      r.hidden = false; hit++;
      for (var d = depth(r), j = i - 1; j >= 0 && d > 0; j--) if (depth(rows[j]) < d) { rows[j].hidden = false; d = depth(rows[j]); }
    });
    if (!hit) { var z = document.createElement('div'); z.className = 'row none'; z.innerHTML = '<span class="tw"></span><svg class="i sm"><use href="#i-search"/></svg><span class="grow meta">0</span>'; t.appendChild(z); }
  }
  if (q) q.addEventListener('input', function () { q.setAttribute('data-live', ''); filt(); });
  /* UI 언어 전체 전환: [data-en] 글자(원래 한글은 data-ko에 보관) · [data-en-ph] placeholder · [data-en-tip] 툴팁 · [data-en-title] title · [data-en-label] aria-label. 'vide-lang'에 기억 */
  var langKey = 'vide-lang', lang = 'ko';
  function swap(sel, attr, set) {
    $$(sel).forEach(function (el) {
      var en = el.getAttribute(sel.slice(1, -1)), ko = 'data-ko' + attr;
      if (!el.hasAttribute(ko)) el.setAttribute(ko, attr ? (el.getAttribute(attr === '-ph' ? 'placeholder' : attr === '-tip' ? 'data-tip' : attr === '-label' ? 'aria-label' : 'title') || '') : el.textContent);
      set(el, lang === 'en' ? en : el.getAttribute(ko));
    });
  }
  function applyLang(l) {
    lang = l; root.setAttribute('lang', l);
    swap('[data-en]', '', function (el, v) { el.textContent = v; });
    swap('[data-en-ph]', '-ph', function (el, v) { el.setAttribute('placeholder', v); });
    swap('[data-en-tip]', '-tip', function (el, v) { el.setAttribute('data-tip', v); });
    swap('[data-en-title]', '-title', function (el, v) { el.setAttribute('title', v); });
    swap('[data-en-label]', '-label', function (el, v) { el.setAttribute('aria-label', v); });
    $$('[data-lang-toggle]').forEach(function (b) { b.setAttribute('aria-pressed', String(l === 'en')); });
  }
  $$('[data-lang-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      applyLang(lang === 'en' ? 'ko' : 'en');
      try { if (lang === 'en') localStorage.setItem(langKey, 'en'); else localStorage.removeItem(langKey); } catch (e) {}
    });
  });
  /* 처음 상태: 묶음 · 언어 */
  if (trees.length) {
    var selT = document.querySelector('.explorer .tree[data-sec] .row.sel'), saved = null;
    try { saved = localStorage.getItem(secKey); } catch (e) {}
    showSec(selT ? selT.closest('.tree').dataset.sec : saved || 'base');
  }
  try { if (localStorage.getItem(langKey) === 'en') applyLang('en'); } catch (e) {}
  /* 대화 v10: 두 보기(.agent[data-view] list|chat) · 목록 행 → 대화(.flow[data-sess], 없으면 stub = 행 제목 말 1 + 접힌 도구 행 1) · ‹ → 목록 · + → 새 세션(.new-on, .starter) · Enter → 새 세션이면 제목 앞 16자 + 목록 맨 위 행, 아니면 지금 대화에 말 추가 · 검색·칩 거르기 · × 행 지우기 · .ask 단추 → 완료 줄 · 모델 메뉴(행 제공자 것만). 도구 행은 details 기본 동작 */
  $$('.agent').forEach(function (ag) {
    var lv = ag.querySelector('.lv'); if (!lv) return;
    var head = ag.querySelector('.head.ch'), ht = head.querySelector('.t'), meta = ag.querySelector('.meta .m'), mb = ag.querySelector('.composer .model'), ta = ag.querySelector('.composer textarea');
    var st = ag.querySelector('.starter'), cx = ag.querySelector('.composer .ctx'), q = lv.querySelector('.q'), f0 = ag.querySelector('.flow'), menu = null;
    var MODELS = { Claude: ['Sonnet', 'Opus', 'Fable'], Codex: ['GPT-5 Codex', 'GPT-5'] }, EFF = ['medium', 'high'];
    var cur = lv.querySelector('.srow[data-sess="' + (f0 && f0.dataset.sess) + '"]') || lv.querySelector('.srow.sel');
    function view(v) { ag.setAttribute('data-view', 'chat'); ag.classList.toggle('sess-open', v === 'list'); if (menu) menu.hidden = true; }
    function dflt(r) { var s = r.querySelector('.sub'); r.dataset.p = r.dataset.p || (s && /^Codex/.test(s.textContent) ? 'Codex' : 'Claude'); r.dataset.m = r.dataset.m || MODELS[r.dataset.p][0]; r.dataset.e = r.dataset.e || 'medium'; }
    function setMeta(p, m, e, rest) { meta.innerHTML = [p, m, e].concat(rest ? [rest] : []).join(' · '); if (mb) mb.firstChild.nodeValue = m + ' · ' + e; applyLang(lang); }
    function rowMeta(r) { dflt(r); var s = r.querySelector('.sub'); setMeta(r.dataset.p, r.dataset.m, r.dataset.e, s ? s.innerHTML.replace(/^(Claude|Codex)( · )?/, '') : ''); }
    /* 자기 .flow가 없는 행 = 자리 흐름(행 제목 사용자 말 1 + 접힌 도구 행 1) */
    function stub(r) {
      var f = document.createElement('div'), t = r.querySelector('.t').textContent.replace(/^↳\s*/, ''), s = r.querySelector('.sub'), n = s ? s.textContent.replace(/^(Claude|Codex)( · )?/, '') : '';
      f.className = 'flow'; f.dataset.sess = r.dataset.sess;
      f.innerHTML = '<div class="msg user"><div class="body"><p></p></div></div><div class="steps"><div class="cap"><span data-en="Steps">단계</span> 1</div><details class="tool"><summary><span class="st">✓</span><b data-en="Read records">기록 읽기</b><span class="n"></span></summary><pre class="out"></pre></details></div>';
      f.querySelector('.msg p').textContent = t; f.querySelector('.n').textContent = n;
      f.querySelector('.out').textContent = 'read  session  ' + r.dataset.sess + '\ntitle ' + t + '\nscope ' + (n || '-');
      ag.insertBefore(f, ag.querySelector('.term')); return f;
    }
    /* 새 세션 임시 행: 서랍 맨 위 .srow.sel.draft(글리프 없음 · 새 세션 · 지금). 첫 Enter에 제목 행으로, 다른 행을 고르면 사라진다 */
    function dropDraft(keep) { $$('.srow.draft', lv).forEach(function (x) { if (x !== keep) x.remove(); }); }
    function draftRow() {
      dropDraft(); var g = lv.querySelector('.grp'), r = document.createElement('div'); if (!g) return null;
      r.className = 'srow sel draft'; r.setAttribute('role', 'button'); r.tabIndex = 0;
      r.innerHTML = '<span class="st"></span><span class="t" data-en="New session">새 세션</span><time data-en="Now">지금</time>';
      $$('.srow', lv).forEach(function (x) { x.classList.remove('sel'); }); g.insertBefore(r, g.querySelector('.srow')); g.hidden = false; return r;
    }
    function open(r, keep) {
      cur = r; ag.classList.remove('new-on'); dropDraft(r); $$('.srow', lv).forEach(function (x) { x.classList.toggle('sel', x === r); });
      var g = r.querySelector('.g-new'), fs = $$('.flow', ag), f = fs.filter(function (x) { return x.dataset.sess === r.dataset.sess; })[0] || stub(r); if (g) g.remove(); fs = $$('.flow', ag);
      fs.forEach(function (x) { x.hidden = x !== f; }); if (cx) cx.hidden = r.dataset.sess !== (f0 && f0.dataset.sess);
      head.querySelector('.st').innerHTML = r.querySelector('.st').innerHTML; ht.removeAttribute('data-en'); ht.removeAttribute('data-ko'); ht.textContent = r.querySelector('.t').textContent;
      rowMeta(r); if (keep) { if (menu) menu.hidden = true; } else view('chat');
    }
    function prov() { var c = st && st.querySelector('.prov .on'); return c && c.dataset.p !== 'auto' ? c.dataset.p : 'Claude'; }
    /* keep = 서랍 머리 [+ 새 세션]: 서랍(sess-open)을 닫지 않는다 */
    function fresh(keep) { ag.classList.add('new-on'); if (keep) { if (menu) menu.hidden = true; } else view('chat'); draftRow(); head.querySelector('.st').innerHTML = ''; ht.removeAttribute('data-ko'); ht.textContent = '새 세션'; ht.setAttribute('data-en', 'New session'); setMeta(prov(), MODELS[prov()][0], 'medium'); if (ta) ta.focus(); }
    function filt() { var v = q.value.trim().toLowerCase(), run = lv.querySelector('.tools [data-f=run].on');
      $$('.grp', lv).forEach(function (g) { var n = 0; $$('.srow', g).forEach(function (r) { r.hidden = !!(v && r.querySelector('.t').textContent.toLowerCase().indexOf(v) < 0) || !!(run && r.querySelector('.st').textContent !== '●'); if (!r.hidden) n++; }); g.hidden = !n; }); }
    q.addEventListener('input', filt);
    lv.addEventListener('click', function (e) {
      var c = e.target.closest('.tools .eps button'), r = e.target.closest('.srow');
      if (c) { $$('.tools .eps button', lv).forEach(function (x) { x.classList.toggle('on', x === c); }); filt(); }
      if (r && e.target.closest('.x')) { r.remove(); filt(); } else if (r && r.classList.contains('draft')) view('chat'); else if (r) open(r);
    });
    lv.addEventListener('keydown', function (e) { var r = e.target.closest('.srow'); if (r && e.key === 'Enter') { if (r.classList.contains('draft')) view('chat'); else open(r); } });
    $$('[data-agent-back]', ag).forEach(function (b) { b.addEventListener('click', function () { view(ag.classList.contains('sess-open') ? 'chat' : 'list'); }); });
    $$('[data-agent-new]', ag).forEach(function (b) { b.addEventListener('click', function () { fresh(!!b.closest('.lv')); }); });
    if (st) st.addEventListener('click', function (e) { var c = e.target.closest('.prov button'), k = e.target.closest('.cards .art-card');
      if (c) { $$('.prov button', st).forEach(function (x) { x.classList.toggle('on', x === c); }); setMeta(prov(), MODELS[prov()][0], 'medium'); }
      if (k && ta) { ta.value = k.querySelector('.t').textContent; ta.focus(); } });
    if (ta) ta.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return; e.preventDefault(); var v = ta.value.trim(); if (!v) return; ta.value = '';
      var m = document.createElement('div'), d = new Date(), hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      m.className = 'msg user'; m.innerHTML = '<div class="top"><time></time></div><div class="body"><p></p></div>'; m.querySelector('p').textContent = v; m.querySelector('time').textContent = hm;
      if (!ag.classList.contains('new-on')) { var cf = $$('.flow', ag).filter(function (x) { return !x.hidden; })[0]; if (cf) { cf.appendChild(m); cf.scrollTop = 1e6; } return; }
      /* 새 세션 첫 요청: 임시 행이 있으면 그 행이 제목 행이 된다(서랍 열림 상태 유지) */
      var id = 'n' + Date.now(), p = prov(), f = document.createElement('div'), r = lv.querySelector('.srow.draft'), g = lv.querySelector('.grp'), had = !!r;
      f.className = 'flow'; f.dataset.sess = id; f.appendChild(m); f.insertAdjacentHTML('beforeend', '<div class="working"><span class="spin">⟳</span><span data-en="Thinking">생각 중</span></div>'); ag.insertBefore(f, ag.querySelector('.term'));
      if (!r) r = document.createElement('div');
      r.className = 'srow'; r.setAttribute('role', 'button'); r.tabIndex = 0; r.dataset.sess = id; r.dataset.p = p;
      r.innerHTML = '<span class="st">●</span><span class="t"></span><time data-en="now">방금</time><span class="x" title="닫기" data-en-title="Close">×</span><span class="sub" hidden>' + p + '</span>'; r.querySelector('.t').textContent = v.slice(0, 16).trimEnd();
      if (!had) g.insertBefore(r, g.querySelector('.srow')); filt(); open(r, ag.classList.contains('sess-open'));
    });
    ag.addEventListener('click', function (e) { var b = e.target.closest('.ask:not(.done) button'); if (!b) return; var a = b.closest('.ask'), f = a.closest('.flow');
      a.className = 'ask done'; a.innerHTML = '<span class="st">✓</span><span></span>'; a.lastChild.textContent = b.dataset.done || b.textContent; if (b.dataset.doneEn) a.lastChild.setAttribute('data-en', b.dataset.doneEn);
      $$('.working', f).forEach(function (w) { w.remove(); }); $$('details.tool .st .spin', f).forEach(function (s) { s.parentNode.textContent = '✓'; }); applyLang(lang); });
    if (mb) mb.addEventListener('click', function (e) {
      e.stopPropagation(); if (!cur || ag.classList.contains('new-on')) return; dflt(cur);
      if (!menu) { menu = document.createElement('div'); menu.className = 'menu'; menu.hidden = true; mb.parentNode.insertBefore(menu, mb.nextSibling); menu.addEventListener('click', function (ev) { var b = ev.target.closest('button'); if (!b || !cur) return; cur.dataset[b.dataset.k] = b.dataset.v; rowMeta(cur); menu.hidden = true; }); }
      if (!menu.hidden) { menu.hidden = true; return; }
      function btn(k, v) { return '<button type="button" data-k="' + k + '" data-v="' + v + '"' + (cur.dataset[k] === v ? ' class="on"' : '') + '>' + v + '</button>'; }
      menu.innerHTML = MODELS[cur.dataset.p].map(function (m) { return btn('m', m); }).join('') + '<hr>' + EFF.map(function (x) { return btn('e', x); }).join(''); menu.hidden = false;
    });
    document.addEventListener('click', function (e) { if (menu && !menu.contains(e.target)) menu.hidden = true; });
    /* 처음: 메타 첫 세 낱말 = 지금 행의 제공자·모델·effort. .agent.new-on(13)이면 새 세션 상태, .sess-open도 있으면(12) 서랍 유지 + 임시 행 */
    if (cur && meta) { var ps = meta.innerHTML.split(' · '); cur.dataset.p = ps[0]; cur.dataset.m = ps[1]; cur.dataset.e = ps[2]; if (mb) mb.firstChild.nodeValue = ps[1] + ' · ' + ps[2]; }
    if (ag.classList.contains('new-on')) fresh(ag.classList.contains('sess-open'));
  });
  /* 가운데 탭 모형 v12 — .center > .group(.tabs-bar + .pane…) 1~2개. 처음 = 지금 가운데 내용을 .group.on 하나로 감싼다(장이 .group 2개 + .split[data-split=center]를 이미 쓰면 그대로).
     자료 파일 행 한 번 = 미리보기 탭(.tab.prev 이탤릭, 하나를 덮어씀) · 두 번/탭 더블클릭 = 고정 · 탭 클릭 = 그 묶음의 칸 · ×(고정 탭은 hover) = 닫기(묶음이 비면 분할 해제) ·
     우클릭 = .ctx.menu 7항목 · 탭 끌기 = 놓기 영역 5칸(.drop .dz[data-z]) → 왼/오 = .center.split-x, 위/아래 = .split-y, 가운데 = 그 묶음으로 옮김 · 분할 최대 2 ·
     경계 .split[data-split=center] 끌기 · 더블클릭 50% · Ctrl+\ = 오른쪽 분할 · 고정 탭 8 넘으면 가장 오래 안 본 탭 닫음(미리보기 제외) + 탭 줄 끝 .cap 배지. 둘째 칸 내용 = 뷰어 stub(.viewer: 얇은 줄 + 종이) */
  var center = app ? app.querySelector(':scope>.center') : null, CL = 0, CAP = 8, cmenu = null, tdrag = null, justDragged = false;
  var LINES = [72, 96, 88, 94, 61, 's', 90, 84, 97, 70, 's', 93, 80, 66, 91, 58];
  function tabsOf(g) { return $$(':scope>.tabs-bar>.tab', g); }
  function barOf(g) { return g.querySelector(':scope>.tabs-bar'); }
  function gOn() { return center.querySelector(':scope>.group.on') || center.querySelector(':scope>.group'); }
  function isSplit() { return center.classList.contains('split-x') || center.classList.contains('split-y'); }
  function tabName(t) { var c = t.cloneNode(true); $$('.x, svg', c).forEach(function (x) { x.remove(); }); return c.textContent.trim(); }
  function tabIcon(t) { var u = t.querySelector('svg use'); return u ? u.getAttribute('href') : '#i-doc'; }
  function prepTab(t) {
    t.setAttribute('draggable', 'false');
    if (!t.querySelector('.x')) { var x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; t.appendChild(x); }
    if (t._seen == null) t._seen = t.classList.contains('on') ? ++CL : 0;
  }
  function prepBar(bar) {
    if (!bar.querySelector(':scope>.cap')) { var c = document.createElement('span'); c.className = 'cap'; c.hidden = true; c.textContent = CAP; c.setAttribute('title', '고정 탭 상한 ' + CAP + ' · 넘으면 오래 안 본 탭 닫힘'); c.setAttribute('data-en-title', 'Pinned tab limit ' + CAP + ' · oldest closes'); bar.appendChild(c); }
    if (!bar._wheel) { bar._wheel = 1; bar.addEventListener('wheel', function (e) { if (bar.scrollWidth > bar.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { bar.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false }); }
    $$(':scope>.tab', bar).forEach(prepTab);
  }
  function addTab(g, t) { var bar = barOf(g); bar.insertBefore(t, bar.querySelector(':scope>.cap')); }
  function mkTab(name, icon, prev) {
    var t = document.createElement('a'); t.className = 'tab' + (prev ? ' prev' : ''); t.href = '#';
    t.innerHTML = '<svg class="i sm"><use href="' + icon + '"/></svg><span class="nm"></span><span class="x">×</span>'; t.querySelector('.nm').textContent = name; prepTab(t); return t;
  }
  /* 뷰어 내용 = 파일 이름별 합성 문서(데이터, 한 곳에서만). 17·18의 첫 화면 종이도 같은 글. 없는 파일은 형식별 자리 그림 */
  var DOCS = {
    '09.23 1차 회의록.pdf': [
      '<div class="dh"><span>설계 협의</span><span>1 / 3</span></div><h2>1차 설계 협의 회의록</h2><dl><dt>일시</dt><dd>2026.09.23 (수) 14:00–15:30</dd><dt>장소</dt><dd>현장 사무실 회의실</dd><dt>참석</dt><dd>발주처 담당 · 설계 PM · 구조 담당 · 설비 담당</dd></dl><h3>안건</h3><ol><li>기둥 C2A 위치 조정</li><li>증축층 적재하중</li><li>파사드 샘플 일정</li></ol><h3>결정</h3><ol><li>기둥 C2A 동쪽 600 이동, 구조 검토 후 확정</li><li>증축층 적재하중 3.5 kN/m² 적용</li></ol><h3>다음 일정</h3><p>09.30 2차 회의 · 구조 검토 회신 10.09까지</p>',
      '<div class="dh"><span>설계 협의</span><span>2 / 3</span></div><h3>1. 기둥 C2A 위치 조정</h3><p>로비 폭 확보를 위해 C2A를 동쪽으로 600 옮기는 안.</p><p>보 G2 길이 7,200 → 7,800. 구조 담당 단면 재검토.</p><p class="k">→ 결정 1 · 회신 10.09</p><h3>2. 증축층 적재하중</h3><p>사무실 용도 기준 3.5 kN/m² 적용.</p><p>하중표는 구조 담당이 메일로 공유.</p><p class="k">→ 결정 2</p><h3>3. 파사드 샘플 일정</h3><p>샘플 2종 09.26 회신 예정.</p><p>색상은 2차 회의에서 비교.</p><p class="k">→ 보류</p>',
      '<div class="dh"><span>설계 협의</span><span>3 / 3</span></div><h3>할 일</h3><ol><li>구조 검토 회신 · 구조 담당 · 10.09</li><li>하중표 공유 · 구조 담당 · 09.30</li><li>샘플 회신 · 발주처 담당 · 09.26</li></ol>'
    ],
    '09.30 2차 회의록.pdf': [
      '<div class="dh"><span>설계 협의</span><span>1 / 2</span></div><h2>2차 설계 협의 회의록</h2><dl><dt>일시</dt><dd>2026.09.30 (수) 10:00–11:00</dd><dt>장소</dt><dd>설계 사무실</dd><dt>참석</dt><dd>발주처 담당 · 설계 PM · 구조 담당</dd></dl><h3>안건</h3><ol><li>파사드 샘플 색상 비교</li><li>하중표 확인</li></ol><h3>결정</h3><ol><li>샘플 B안 채택</li><li>하중표 v2 기준 적용</li></ol><h3>다음 일정</h3><p>10.07 3차 회의</p>',
      '<div class="dh"><span>설계 협의</span><span>2 / 2</span></div><h3>할 일</h3><ol><li>샘플 B안 발주 · 설계 PM · 10.02</li><li>하중표 v2 배포 · 구조 담당 · 10.01</li></ol>'
    ]
  };
  var ZOOM = '<span class="zm"><button type="button" data-z="-1" title="축소" data-en-title="Zoom out">−</button><span class="zv">100%</span><button type="button" data-z="1" title="확대" data-en-title="Zoom in">+</button></span>';
  var EXT = '<span class="grow"></span><button type="button" class="ext"><span data-en="Open externally">외부에서 열기</span> ↗</button>';
  function bars(ws) { return ws.map(function (w) { return w === 's' ? '<i class="s"></i>' : '<i style="width:' + w + '%"></i>'; }).join(''); }
  /* 형식별 보기: pdf = 쪽·확대 + 종이 · docx/hwp = 종이 + '렌더' 배지(라이브러리 렌더, RESEARCH-22 §3) · eml = 종이 한 장 · img = 확대 + 그림 · html = 주소 칩 + 흰 화면(쪽·종이 없음) · xlsx = 셀 격자 + 시트 탭 · dwg = 외부 프로그램 */
  function viewer(name, kind, icon) {
    var p = document.createElement('div'), doc = DOCS[name], bar, body, n;
    p.className = 'pane'; p.hidden = true;
    if (kind === 'html') {
      bar = '<span class="addr"></span><button type="button" class="ext"><span data-en="Open externally">외부에서 열기</span> ↗</button>';
      body = '<div class="web"><div class="wh"></div><div class="wn"><span>조문</span><span>별표</span><span>부칙</span></div>' + bars([92, 86, 95, 60, 's', 90, 82, 74, 's', 88, 93, 57]) + '</div>';
    } else if (kind === 'xlsx') {
      var R = [['구분', '층', '면적(m²)', '비고'], ['로비', '1F', '212.4', ''], ['사무실 A', '2F', '486.0', ''], ['사무실 B', '2F', '318.2', ''], ['회의실', '3F', '96.5', '증축'], ['기계실', 'B1', '142.8', ''], ['계', '', '1,255.9', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', ''], ['', '', '', '']];
      bar = ZOOM + EXT;
      body = '<div class="sheet"><table><tr><th></th><th>A</th><th>B</th><th>C</th><th>D</th><th>E</th></tr>' + R.map(function (r, i) { return '<tr><th>' + (i + 1) + '</th>' + r.map(function (c, k) { return '<td' + (k === 2 && i ? ' class="n"' : '') + '>' + c + '</td>'; }).join('') + '<td></td></tr>'; }).join('') + '</table></div><div class="stabs"><span class="on">요약</span><span>상세</span></div>';
    } else if (kind === 'img') {
      bar = ZOOM + EXT; body = '<div class="vpage"><div class="paper"><div class="pic"><svg class="i"><use href="' + icon + '"/></svg></div></div></div>';
    } else if (kind === 'dwg') {
      bar = '<span class="badge" data-en="External app">외부 프로그램</span>' + EXT; body = '<div class="vpage"><div class="paper"><div class="pic"><svg class="i"><use href="' + icon + '"/></svg></div></div></div>';
    } else {
      n = doc ? doc.length : kind === 'pdf' ? 3 : kind === 'eml' ? 1 : 2;
      bar = '<span class="pg">1 / ' + n + '</span><span class="sep"></span>' + ZOOM + (kind === 'docx' || kind === 'hwp' ? '<span class="badge" data-en="Rendered" title="라이브러리 렌더" data-en-title="Library render">렌더</span>' : '') + EXT;
      body = '<div class="vpage">' + (doc ? doc.map(function (h) { return '<div class="paper doc">' + h + '</div>'; }).join('')
        : '<div class="paper"><div class="h"></div>' + bars(LINES) + '</div>' + (n > 1 ? '<div class="paper"><div class="h"></div></div>' : '')) + '</div>';
    }
    p.innerHTML = '<section class="viewer" data-kind="' + kind + '"><div class="vbar">' + bar + '</div>' + body + '</section>';
    $$('.paper > .h, .web .wh', p).forEach(function (h, i) { h.textContent = i ? '' : name; });
    var a = p.querySelector('.addr'); if (a) a.textContent = 'BaseData\\…\\' + name;
    return p;
  }
  /* 파일 탭만 뷰어를 만든다. 페이지 링크 탭(data-file 없음 · 칸 없음)에는 만들지 않고 그 묶음의 처음 칸이나 빈 칸을 보인다 */
  function ensurePane(t) { if (t._pane || !t.dataset.file) return; var g = t.closest('.group'); t._pane = viewer(t.dataset.file, t.dataset.kind || 'doc', tabIcon(t)); g.appendChild(t._pane); }
  /* 가장 최근에 본 탭(_seen 최대) — 닫기·옮기기 뒤 활성 */
  function recent(ts) { return ts.slice().sort(function (a, b) { return (b._seen || 0) - (a._seen || 0); })[0]; }
  /* 상한 배지: 고정 탭 6개 이상일 때만 'n/8' */
  function capUpd() { $$(':scope>.group', center).forEach(function (g) { var b = barOf(g), c = b && b.querySelector(':scope>.cap'); if (!c) return; var n = tabsOf(g).filter(function (x) { return !x.classList.contains('prev'); }).length; c.hidden = n < 6; c.textContent = n + '/' + CAP; }); }
  function focusGroup(g) { $$(':scope>.group', center).forEach(function (x) { x.classList.toggle('on', x === g); }); }
  function showPane(g, t) {
    $$(':scope>.pane, :scope>.empty', g).forEach(function (p) { p.hidden = true; });
    if (t) ensurePane(t);
    if (t && t._pane) { t._pane.hidden = false; return; }
    if (g._home && g._home.parentNode === g) { g._home.hidden = false; return; }
    var e = g.querySelector(':scope>.empty'); if (!e) { e = document.createElement('div'); e.className = 'empty'; e.textContent = 'V'; g.appendChild(e); } e.hidden = false;
  }
  function activate(t) {
    var g = t.closest('.group'); ensurePane(t);
    tabsOf(g).forEach(function (x) { x.classList.toggle('on', x === t); });
    showPane(g, t); t._seen = ++CL; focusGroup(g); capUpd();
    if (t.scrollIntoView) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function enforceCap(g) {
    var pinned = tabsOf(g).filter(function (x) { return !x.classList.contains('prev'); });
    while (pinned.length > CAP) {
      var v = pinned.filter(function (x) { return !x.classList.contains('on'); }).sort(function (a, b) { return a._seen - b._seen; })[0]; if (!v) break;
      closeTab(v); pinned.splice(pinned.indexOf(v), 1);
    }
  }
  function pinTab(t) { t.classList.remove('prev'); enforceCap(t.closest('.group')); capUpd(); }
  function unsplit(g) {
    var s = center.querySelector(':scope>.split[data-split=center]'); if (s) s.remove();
    g.remove(); center.classList.remove('split-x', 'split-y');
    var r = center.querySelector(':scope>.group'); if (r) { r.style.flex = ''; focusGroup(r); }
  }
  function closeTab(t) {
    var g = t.closest('.group'), ts = tabsOf(g), i = ts.indexOf(t), on = t.classList.contains('on');
    if (t._pane) { if (t._pane === g._home) g._home = null; t._pane.remove(); }
    t.remove(); ts.splice(i, 1);
    if (!ts.length) { if (isSplit()) unsplit(g); else showPane(g, null); capUpd(); return; }
    if (on) activate(recent(ts)); else capUpd();
  }
  function setRatio(p) {
    var gs = $$(':scope>.group', center), s = center.querySelector(':scope>.split[data-split=center]'); if (gs.length < 2) return;
    p = Math.max(15, Math.min(85, p)); gs[0].style.flex = p + ' 1 0'; gs[1].style.flex = (100 - p) + ' 1 0';
    if (s) { s.setAttribute('aria-valuenow', Math.round(p)); s.dataset.w = Math.round(p) + '%'; }
  }
  function ratio() { var g = center.querySelector(':scope>.group'), x = center.classList.contains('split-x'), r = center.getBoundingClientRect(), b = g.getBoundingClientRect(); return x ? b.width / r.width * 100 : b.height / r.height * 100; }
  function bindSplit(s) {
    s.addEventListener('pointerdown', function (e) {
      if (e.button) return; e.preventDefault(); s.classList.add('on'); center.classList.add('resizing');
      var r = center.getBoundingClientRect(), x = center.classList.contains('split-x');
      function mv(ev) { setRatio(x ? (ev.clientX - r.left) / r.width * 100 : (ev.clientY - r.top) / r.height * 100); }
      function up() { s.classList.remove('on'); center.classList.remove('resizing'); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); }
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    s.addEventListener('dblclick', function () { setRatio(50); });
    s.addEventListener('keydown', function (e) {
      var d = /ArrowRight|ArrowDown/.test(e.key) ? 5 : /ArrowLeft|ArrowUp/.test(e.key) ? -5 : 0; if (!d) return;
      e.preventDefault(); e.stopPropagation(); setRatio(ratio() + d);
    });
  }
  /* 다른 묶음으로: move = 옮김(원래 묶음에 탭이 하나뿐이면: 분할 중이면 옮기고 그 묶음 닫음, 아니면 복사) */
  function moveTo(t, g, move) {
    var src = t.closest('.group'), ts = tabsOf(src), n;
    ensurePane(t);
    if (move && (ts.length > 1 || (isSplit() && src !== g))) {
      var was = t.classList.contains('on'), i = ts.indexOf(t), rest = ts.filter(function (x) { return x !== t; });
      addTab(g, t); g.appendChild(t._pane); t.classList.remove('on');
      if (!rest.length) unsplit(src); else if (was) { var a = recent(rest); tabsOf(src).forEach(function (x) { x.classList.toggle('on', x === a); }); showPane(src, a); }
      n = t;
    } else {
      /* 복사: 파일 탭 = 같은 파일 뷰어 · 페이지 탭 = 칸 복제 · 링크 탭(칸 없음) = 같은 링크 */
      n = mkTab(tabName(t), tabIcon(t), false); var on0 = t.querySelector('.nm') || t.querySelector('span[data-en]'), nn = n.querySelector('.nm');
      if (on0 && on0.hasAttribute('data-en')) { nn.setAttribute('data-en', on0.getAttribute('data-en')); nn.setAttribute('data-ko', on0.getAttribute('data-ko') || on0.textContent); }
      if (t.dataset.file) { n.dataset.file = t.dataset.file; n.dataset.kind = t.dataset.kind || 'doc'; n._pane = viewer(t.dataset.file, n.dataset.kind, tabIcon(t)); }
      else if (t._pane) { n._pane = t._pane.cloneNode(true); n._pane.hidden = true; $$('[id]', n._pane).forEach(function (x) { x.removeAttribute('id'); }); n.setAttribute('href', t.getAttribute('href')); }
      else n.setAttribute('href', t.getAttribute('href'));
      if (n._pane) g.appendChild(n._pane); addTab(g, n);
    }
    activate(n); enforceCap(g); applyLang(lang);
  }
  function split(t, z, move) {
    var src = t.closest('.group');
    if (isSplit()) { var other = $$(':scope>.group', center).filter(function (x) { return x !== src; })[0]; if (other) moveTo(t, other, move); return; }
    var g = document.createElement('div'), bar = document.createElement('div'), s = document.createElement('div'), horiz = z === 'left' || z === 'right';
    g.className = 'group'; bar.className = 'tabs-bar'; g.appendChild(bar); prepBar(bar);
    s.className = 'split'; s.dataset.split = 'center'; s.setAttribute('role', 'separator'); s.tabIndex = 0;
    s.setAttribute('aria-orientation', horiz ? 'vertical' : 'horizontal'); s.setAttribute('aria-label', '분할 경계'); s.setAttribute('data-en-label', 'Split');
    center.classList.add(horiz ? 'split-x' : 'split-y');
    if (z === 'left' || z === 'top') { center.insertBefore(g, src); center.insertBefore(s, src); } else { center.appendChild(s); center.appendChild(g); }
    bindSplit(s); setRatio(50); moveTo(t, g, move);
  }
  function openFile(r, pin) {
    if (!center || !center.querySelector(':scope>.group')) return;
    var name = r.querySelector('.grow').textContent, kind = r.dataset.kind || 'doc', u = r.querySelector('svg use'), icon = u ? u.getAttribute('href') : '#i-doc';
    var tree = r.closest('.tree'); $$('.row.sel', tree).forEach(function (x) { x.classList.remove('sel'); }); r.classList.add('sel');
    /* 이미 열린 같은 파일(어느 묶음이든)이면 그 탭으로 */
    var all = []; $$(':scope>.group', center).forEach(function (x) { all = all.concat(tabsOf(x)); });
    var g = gOn(), t = tabsOf(g).filter(function (x) { return x.dataset.file === name; })[0] || all.filter(function (x) { return x.dataset.file === name; })[0];
    if (t) g = t.closest('.group');
    if (!t) {
      t = tabsOf(g).filter(function (x) { return x.classList.contains('prev'); })[0];
      if (t) { if (t._pane) t._pane.remove(); t.querySelector('svg use').setAttribute('href', icon); t.querySelector('.nm').textContent = name; }
      else { t = mkTab(name, icon, true); addTab(g, t); }
      t.dataset.file = name; t.dataset.kind = kind; t._pane = viewer(name, kind, icon); g.appendChild(t._pane);
    }
    activate(t); if (pin) pinTab(t); applyLang(lang); return t;
  }
  var MENU = [['split-right', '오른쪽에 분할', 'Split right', 'Ctrl+\\'], ['split-down', '아래에 분할', 'Split down'], 0, ['pin', '고정', 'Pin'], 0, ['close', '닫기', 'Close'], ['close-others', '다른 탭 닫기', 'Close others'], ['close-right', '오른쪽 탭 닫기', 'Close to the right'], ['close-all', '모두 닫기', 'Close all']];
  function act(a, t) {
    if (!t || !t.isConnected) return;
    var ts = tabsOf(t.closest('.group'));
    if (a === 'split-right') split(t, 'right', false);
    else if (a === 'split-down') split(t, 'bottom', false);
    else if (a === 'pin') pinTab(t);
    else if (a === 'close') closeTab(t);
    else if (a === 'close-others') { activate(t); ts.forEach(function (x) { if (x !== t) closeTab(x); }); }
    else if (a === 'close-right') ts.slice(ts.indexOf(t) + 1).forEach(closeTab);
    else if (a === 'close-all') ts.forEach(function (x) { if (x.isConnected) closeTab(x); });
  }
  function showMenu(t, x, y) {
    if (!cmenu) {
      cmenu = document.createElement('div'); cmenu.className = 'ctx menu'; cmenu.setAttribute('role', 'menu'); cmenu.hidden = true;
      cmenu.innerHTML = MENU.map(function (m) { return m ? '<button type="button" role="menuitem" data-act="' + m[0] + '"><span data-en="' + m[2] + '">' + m[1] + '</span>' + (m[3] ? '<span class="k">' + m[3] + '</span>' : '') + '</button>' : '<hr>'; }).join('');
      document.body.insertBefore(cmenu, document.body.firstChild); /* 탭 메뉴가 문서 첫 .ctx.menu(자료 폴더 메뉴보다 앞) */
      cmenu.addEventListener('click', function (ev) { var b = ev.target.closest('button'); if (!b || b.disabled) return; cmenu.hidden = true; act(b.dataset.act, cmenu._t); });
      document.addEventListener('pointerdown', function (ev) { if (!cmenu.hidden && !cmenu.contains(ev.target)) cmenu.hidden = true; }, true);
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') cmenu.hidden = true; });
      window.addEventListener('resize', function () { cmenu.hidden = true; }); window.addEventListener('blur', function () { cmenu.hidden = true; });
    }
    var ts = tabsOf(t.closest('.group')); cmenu._t = t;
    cmenu.querySelector('[data-act=pin]').disabled = !t.classList.contains('prev');
    cmenu.querySelector('[data-act=close-others]').disabled = ts.length < 2;
    cmenu.querySelector('[data-act=close-right]').disabled = ts.indexOf(t) === ts.length - 1;
    applyLang(lang); cmenu.hidden = false;
    cmenu.style.left = Math.max(4, Math.min(x, window.innerWidth - cmenu.offsetWidth - 4)) + 'px';
    cmenu.style.top = Math.max(4, Math.min(y, window.innerHeight - cmenu.offsetHeight - 4)) + 'px';
  }
  function endDrag(d) { $$('.center .drop').forEach(function (x) { x.remove(); }); document.body.classList.remove('tab-dragging'); if (d) d.t.classList.remove('drag'); }
  if (center && center.querySelector('.tabs-bar')) {
    var gs0 = $$(':scope>.group', center);
    if (!gs0.length) {
      var bar0 = center.querySelector(':scope>.tabs-bar'), g0 = document.createElement('div'), p0 = document.createElement('div');
      g0.className = 'group on'; p0.className = 'pane';
      $$(':scope>*', center).forEach(function (el) { if (el !== bar0) p0.appendChild(el); });
      g0.appendChild(bar0); g0.appendChild(p0); center.appendChild(g0); gs0 = [g0];
    } else if (!center.querySelector(':scope>.group.on')) gs0[0].classList.add('on');
    gs0.forEach(function (g) {
      var bar = barOf(g); if (!bar) return;
      var p = g.querySelector(':scope>.pane');
      if (!p) { p = document.createElement('div'); p.className = 'pane'; $$(':scope>*', g).forEach(function (el) { if (el !== bar) p.appendChild(el); }); g.appendChild(p); }
      prepBar(bar); var on = bar.querySelector(':scope>.tab.on'); if (on) on._pane = p; else g._home = p;
    });
    $$(':scope>.split[data-split=center]', center).forEach(bindSplit);
    center.addEventListener('dragstart', function (e) { if (e.target.closest && e.target.closest('.tabs-bar')) e.preventDefault(); });
    center.addEventListener('click', function (e) {
      var zb = e.target.closest('.viewer [data-z]');
      if (zb) { var v = zb.closest('.viewer'), z = Math.max(.5, Math.min(2, (parseFloat(v.dataset.z) || 1) + .25 * zb.dataset.z)); v.dataset.z = z; $$('.paper', v).forEach(function (p) { p.style.setProperty('--z', z); }); v.querySelector('.zv').textContent = Math.round(z * 100) + '%'; return; }
      var t = e.target.closest('.tabs-bar .tab'); if (!t) return;
      if (justDragged) { e.preventDefault(); justDragged = false; return; }
      if (e.target.closest('.x')) { e.preventDefault(); closeTab(t); return; }
      if (t._pane) { e.preventDefault(); activate(t); }
    });
    center.addEventListener('dblclick', function (e) { var t = e.target.closest('.tabs-bar .tab.prev'); if (t) pinTab(t); });
    center.addEventListener('contextmenu', function (e) { var t = e.target.closest('.tabs-bar .tab'); if (!t) return; e.preventDefault(); showMenu(t, e.clientX, e.clientY); });
    center.addEventListener('pointerdown', function (e) {
      justDragged = false; var g = e.target.closest('.center>.group'); if (g && !e.target.closest('.split')) focusGroup(g);
      var t = e.target.closest('.tabs-bar .tab'); if (!t || e.button || e.target.closest('.x')) return;
      tdrag = { t: t, x: e.clientX, y: e.clientY, on: false };
    });
    window.addEventListener('pointermove', function (e) {
      if (!tdrag) return;
      if (!tdrag.on) { if (Math.abs(e.clientX - tdrag.x) + Math.abs(e.clientY - tdrag.y) < 6) return; tdrag.on = true; tdrag.t.classList.add('drag'); document.body.classList.add('tab-dragging'); }
      var el = document.elementFromPoint(e.clientX, e.clientY), g = el && el.closest ? el.closest('.center>.group') : null;
      $$('.center .drop').forEach(function (d) { if (d.parentNode !== g) d.remove(); });
      tdrag.g = g; tdrag.z = null; if (!g) return;
      var d = g.querySelector(':scope>.drop');
      if (!d) { d = document.createElement('div'); d.className = 'drop'; d.innerHTML = ['left', 'right', 'top', 'bottom', 'center'].map(function (z) { return '<div class="dz" data-z="' + z + '"></div>'; }).join(''); g.appendChild(d); }
      var r = g.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      tdrag.z = fx < .25 ? 'left' : fx > .75 ? 'right' : fy < .25 ? 'top' : fy > .75 ? 'bottom' : 'center';
      $$('.dz', d).forEach(function (x) { x.classList.toggle('on', x.dataset.z === tdrag.z); });
    });
    window.addEventListener('pointercancel', function () { endDrag(tdrag); tdrag = null; });
    window.addEventListener('pointerup', function () {
      var d = tdrag; tdrag = null; if (!d) return; endDrag(d); if (!d.on) return;
      justDragged = true; if (!d.g || !d.z || !d.t.isConnected) return;
      var src = d.t.closest('.group');
      if (d.z === 'center' || isSplit()) { if (d.g !== src) moveTo(d.t, d.g, true); else if (isSplit() && d.z !== 'center') split(d.t, d.z, true); return; }
      split(d.t, d.z, true);
    });
    document.addEventListener('keydown', function (e) {
      if (!e.ctrlKey || e.shiftKey || e.altKey || !(e.code === 'Backslash' || e.key === '\\')) return;
      var t = barOf(gOn()).querySelector(':scope>.tab.on'); e.preventDefault(); if (t) split(t, 'right', false);
    });
  }
  /* 선택 창 닫기 */
  $$('[data-dialog-close]').forEach(function (b) { b.addEventListener('click', function () { var s = b.closest('.scrim'); if (s) s.remove(); }); });
  var dlgFirst = document.querySelector('.scrim .dialog [aria-pressed="true"]');
  if (dlgFirst) dlgFirst.focus();
  /* 데모 넘기기: ← → 키 (열린 선택 창은 Esc로 먼저 닫는다) */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { var c = document.querySelector('.scrim [data-dialog-close]'); if (c) { c.click(); return; } }
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    var a = e.key === 'ArrowRight' ? document.querySelector('.demo-nav a.next') : e.key === 'ArrowLeft' ? document.querySelector('.demo-nav a.prev') : null;
    if (a && !a.classList.contains('off')) location.href = a.getAttribute('href');
  });
})();
