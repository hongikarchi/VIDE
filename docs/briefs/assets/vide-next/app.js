/* VIDE Next 목업 공통 동작 v4 — 테마(밝음 기본), 탭, 대화/터미널, 접기, 선택 창, 데모 넘기기. 제품 코드 아님. */
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
  /* 접힌 패널 다시 열기: 레일의 탐색기 아이콘 / 오른쪽 위 작은 단추 */
  var railFiles = document.querySelector('.rail a[data-tip="탐색기"]');
  if (railFiles) railFiles.addEventListener('click', function (e) { if (app.classList.contains('explorer-closed')) { e.preventDefault(); app.classList.remove('explorer-closed'); } });
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
