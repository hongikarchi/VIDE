/* VIDE Next 목업 공통 동작 v6 — 테마(밝음 기본), 탭, 대화/터미널, 접기, 탐색기 한/영·폴더 접기·+ 폴더, 선택 창, 데모 넘기기. 제품 코드 아님. */
(function () {
  function $$(q, r) { return [].slice.call((r || document).querySelectorAll(q)); }
  var root = document.documentElement, key = 'vide-next-theme';
  /* 테마: 기본 밝음, dark 저장 (레일 왼쪽 아래 단추) */
  try { if (localStorage.getItem(key) === 'dark') root.setAttribute('data-theme', 'dark'); } catch (e) {}
  $$('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var dark = root.getAttribute('data-theme') === 'dark';
      if (dark) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'dark');
      try { if (dark) localStorage.removeItem(key); else localStorage.setItem(key, 'dark'); } catch (e) {}
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
  $$('[data-agent-toggle]').forEach(function (b) { b.addEventListener('click', function () { app.classList.toggle('agent-closed'); }); });
  $$('[data-explorer-toggle]').forEach(function (b) { b.addEventListener('click', function () { app.classList.toggle('explorer-closed'); }); });
  /* 레일 보기: 이 장에 그 사이드바가 있으면 장(가운데)을 유지한 채 바꾸고, 이미 보이면 접기·펼치기만. 없으면 링크대로 이동 */
  var sides = { '탐색기': '.app>aside.explorer', '검색': '.app>aside.panel.search', '이력': '.app>aside.panel.history' };
  function showSide(tip) {
    Object.keys(sides).forEach(function (k) {
      var el = document.querySelector(sides[k]); if (el) el.hidden = k !== tip;
      var a = document.querySelector('.rail a[data-tip="' + k + '"]'); if (a) a.classList.toggle('on', k === tip);
    });
    app.classList.remove('explorer-closed');
  }
  $$('.rail a[data-tip]').forEach(function (a) {
    var q = sides[a.dataset.tip]; if (!q) return;
    a.addEventListener('click', function (e) {
      var el = document.querySelector(q); if (!el) return;
      e.preventDefault();
      if (!el.hidden) app.classList.toggle('explorer-closed'); else showSide(a.dataset.tip);
    });
  });
  if (location.hash === '#tree' && document.querySelector('.app>aside.panel') && document.querySelector(sides['탐색기'])) showSide('탐색기');
  /* 접힌 대화 다시 열기: 오른쪽 위 작은 단추 */
  if (app && !document.querySelector('.reopen')) {
    var ro = document.createElement('button'); ro.type = 'button'; ro.className = 'iconbtn reopen'; ro.title = '대화 열기'; ro.setAttribute('data-agent-toggle', '');
    ro.innerHTML = '<svg class="i sm"><use href="#i-collapse"/></svg>';
    ro.addEventListener('click', function () { app.classList.remove('agent-closed'); });
    app.parentNode.insertBefore(ro, app.nextSibling);
  }
  /* 눌림 표시만 하는 단추: [data-press] (라디오처럼 같은 data-group 안에서 하나만) */
  $$('[data-press]').forEach(function (b) {
    b.addEventListener('click', function () {
      var g = b.dataset.group;
      if (g) { $$('[data-group="' + g + '"]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }
      else b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    });
  });
  /* 탐색기 v6: 한/영 토글 — [data-ko][data-en] 글자를 바꾸고 'vide-lang'에 기억 */
  var langKey = 'vide-lang', lang = 'ko';
  try { if (localStorage.getItem(langKey) === 'en') lang = 'en'; } catch (e) {}
  function setLang(l) {
    lang = l;
    $$('[data-ko][data-en]').forEach(function (el) { el.textContent = el.getAttribute('data-' + l); });
    $$('button.lang').forEach(function (b) { b.textContent = l === 'en' ? '한' : 'EN'; b.setAttribute('aria-pressed', String(l === 'en')); });
  }
  if (lang === 'en') setLang('en');
  $$('button.lang').forEach(function (b) {
    b.addEventListener('click', function () {
      setLang(lang === 'en' ? 'ko' : 'en');
      try { if (lang === 'en') localStorage.setItem(langKey, 'en'); else localStorage.removeItem(langKey); } catch (e) {}
    });
  });
  /* 탐색기 v6: 폴더 접기·펼치기(.row[data-fold]) · + 폴더(button.add → input.newf, Enter 추가 / Esc 취소, 메모리만) */
  function depth(r) { return parseFloat(r.style.getPropertyValue('--d')) || 0; }
  function kids(r) { var out = [], d = depth(r), n = r.nextElementSibling; while (n && depth(n) > d) { out.push(n); n = n.nextElementSibling; } return out; }
  function fold(r) {
    var tw = r.querySelector('.tw'), open = tw.classList.contains('open');
    tw.classList.toggle('open', !open); tw.textContent = open ? '›' : '⌄';
    kids(r).forEach(function (k) { k.hidden = open; if (!open && k.hasAttribute('data-fold')) { var t = k.querySelector('.tw'); t.classList.add('open'); t.textContent = '⌄'; } });
  }
  function addRow(r) {
    var old = document.querySelector('.explorer .row.new'); if (old) old.remove();
    /* 접힌 폴더에 넣으면 그 폴더를 펼친 꼴로(꺾쇠 ⌄) */
    var ptw = r.querySelector('.tw'); if (ptw && ptw.textContent === '›') { ptw.classList.add('open'); ptw.textContent = '⌄'; r.setAttribute('data-fold', ''); }
    var row = document.createElement('div'); row.className = 'row new'; row.style.setProperty('--d', depth(r) + 1);
    row.innerHTML = '<span class="tw"></span><svg class="i sm"><use href="#i-folder"/></svg><input class="newf" placeholder="new-folder" spellcheck="false">';
    r.parentNode.insertBefore(row, r.nextSibling);
    var inp = row.querySelector('input'); inp.focus();
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { row.remove(); return; }
      if (e.key !== 'Enter') return;
      var v = inp.value.trim(); if (!v) { row.remove(); return; }
      row.className = 'row'; row.innerHTML = '<span class="tw">›</span><svg class="i sm"><use href="#i-folder"/></svg><span class="grow"></span><button type="button" class="add" title="new-folder">+</button>';
      row.querySelector('.grow').textContent = v;
    });
  }
  $$('.explorer .tree').forEach(function (t) {
    t.addEventListener('click', function (e) {
      var r = e.target.closest('.row'); if (!r) return;
      if (e.target.closest('.add')) { e.preventDefault(); e.stopPropagation(); addRow(r); return; }
      if (!r.hasAttribute('data-fold')) return;
      if (r.tagName === 'A' && !e.target.closest('.tw')) return;
      e.preventDefault(); fold(r);
    });
  });
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
