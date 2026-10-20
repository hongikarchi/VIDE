/* VIDE Next 목업 공통 동작 v7 — 테마(밝음 기본), 탭, 대화/터미널, 접기, 레일 묶음 5 → 탐색기 블록, 검색칸 거르기, UI 언어 전체 전환(applyLang), 폴더 접기·+ 폴더, 선택 창, 데모 넘기기. 제품 코드 아님. */
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
  $$('[data-agent-toggle]').forEach(function (b) { b.addEventListener('click', function () { app.classList.toggle('agent-closed'); }); });
  $$('[data-explorer-toggle]').forEach(function (b) { b.addEventListener('click', function () { app.classList.toggle('explorer-closed'); }); });
  /* 접힌 대화 다시 열기: 오른쪽 위 작은 단추 */
  if (app && !document.querySelector('.reopen')) {
    var ro = document.createElement('button'); ro.type = 'button'; ro.className = 'iconbtn reopen'; ro.title = '대화 열기'; ro.setAttribute('data-en-title', 'Open chat'); ro.setAttribute('data-agent-toggle', '');
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
      if (cur && cur.dataset.sec === a.dataset.sec && !app.classList.contains('explorer-closed')) { app.classList.add('explorer-closed'); return; }
      if (q && q.value) q.setAttribute('data-live', ''); /* 검색 중 묶음을 바꾸면 그 묶음도 같은 글자로 거른다(09 첫 값 포함) */
      app.classList.remove('explorer-closed'); showSec(a.dataset.sec);
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
