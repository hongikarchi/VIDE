/* VIDE Next 목업 공통 동작 — 테마 토글, 알약 탭, 에이전트 대화/터미널 전환, 패널 접기, 스위치. 제품 코드 아님. */
(function () {
  function $$(q, r) { return [].slice.call((r || document).querySelectorAll(q)); }
  var root = document.documentElement, key = 'vide-next-theme';
  /* 테마: 기본 어두움, light 저장 */
  try { if (localStorage.getItem(key) === 'light') root.setAttribute('data-theme', 'light'); } catch (e) {}
  $$('[data-theme-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var light = root.getAttribute('data-theme') === 'light';
      if (light) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', 'light');
      try { if (light) localStorage.removeItem(key); else localStorage.setItem(key, 'light'); } catch (e) {}
    });
  });
  /* 탭: .tabs 안 [data-tab=id] → 같은 [data-tabscope] 안의 .tabpane#id */
  $$('.tabs').forEach(function (tabs) {
    $$('[data-tab]', tabs).forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        $$('[data-tab]', tabs).forEach(function (x) { x.classList.toggle('on', x === b); });
        var scope = tabs.closest('[data-tabscope]') || document;
        $$('.tabpane', scope).forEach(function (p) { p.classList.toggle('on', p.id === b.dataset.tab); });
      });
    });
  });
  /* 에이전트: 대화 | 터미널 */
  $$('[data-agent-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      var agent = b.closest('.agent');
      agent.classList.toggle('term-on', b.dataset.agentView === 'term');
      $$('[data-agent-view]', agent).forEach(function (x) { x.classList.toggle('on', x === b); });
    });
  });
  $$('[data-agent-toggle]').forEach(function (b) { b.addEventListener('click', function () { document.querySelector('.app').classList.toggle('agent-closed'); }); });
  $$('[data-explorer-toggle]').forEach(function (b) { b.addEventListener('click', function () { document.querySelector('.app').classList.toggle('explorer-closed'); }); });
  /* 스위치·세그먼트: 보이기만 */
  $$('.toggle').forEach(function (t) { t.addEventListener('click', function () { t.classList.toggle('on'); }); });
  $$('.seg').forEach(function (g) {
    $$('button', g).forEach(function (b) {
      if (b.hasAttribute('data-agent-view')) return;
      b.addEventListener('click', function () { $$('button', g).forEach(function (x) { x.classList.toggle('on', x === b); }); });
    });
  });
  /* 데모 넘기기: ← → 키 */
  document.addEventListener('keydown', function (e) {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    var a = e.key === 'ArrowRight' ? document.querySelector('.demo-nav a.next') : e.key === 'ArrowLeft' ? document.querySelector('.demo-nav a.prev') : null;
    if (a && !a.classList.contains('off')) location.href = a.getAttribute('href');
  });
})();
