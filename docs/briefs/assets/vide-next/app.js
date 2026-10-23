/* VIDE Next 목업 공통 동작 v10 — 대화 패널 두 보기(세션 목록 ↔ 대화 · 새 세션 · 질문 카드 · 모델 메뉴), 테마(밝음 기본), 탭, 대화/터미널, 접기, 레일 묶음 5 → 탐색기 블록, 검색칸 거르기, UI 언어 전체 전환(applyLang), 폴더 접기·+ 폴더, 선택 창, 데모 넘기기. 제품 코드 아님. */
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
  /* 대화 v10: 두 보기(.agent[data-view] list|chat) · 목록 행 → 대화(.flow[data-sess], 없으면 stub = 행 제목 말 1 + 접힌 도구 행 1) · ‹ → 목록 · + → 새 세션(.new-on, .starter) · Enter → 새 세션이면 제목 앞 16자 + 목록 맨 위 행, 아니면 지금 대화에 말 추가 · 검색·칩 거르기 · × 행 지우기 · .ask 단추 → 완료 줄 · 모델 메뉴(행 제공자 것만). 도구 행은 details 기본 동작 */
  $$('.agent').forEach(function (ag) {
    var lv = ag.querySelector('.lv'); if (!lv) return;
    var head = ag.querySelector('.head.ch'), ht = head.querySelector('.t'), meta = ag.querySelector('.meta .m'), mb = ag.querySelector('.composer .model'), ta = ag.querySelector('.composer textarea');
    var st = ag.querySelector('.starter'), cx = ag.querySelector('.composer .ctx'), q = lv.querySelector('.q'), f0 = ag.querySelector('.flow'), menu = null;
    var MODELS = { Claude: ['Sonnet', 'Opus', 'Fable'], Codex: ['GPT-5 Codex', 'GPT-5'] }, EFF = ['medium', 'high'];
    var cur = lv.querySelector('.srow[data-sess="' + (f0 && f0.dataset.sess) + '"]') || lv.querySelector('.srow.sel');
    function view(v) { ag.setAttribute('data-view', v); if (menu) menu.hidden = true; }
    function dflt(r) { var s = r.querySelector('.sub'); r.dataset.p = r.dataset.p || (s && /^Codex/.test(s.textContent) ? 'Codex' : 'Claude'); r.dataset.m = r.dataset.m || MODELS[r.dataset.p][0]; r.dataset.e = r.dataset.e || 'medium'; }
    function setMeta(p, m, e, rest) { meta.innerHTML = [p, m, e].concat(rest ? [rest] : []).join(' · '); if (mb) mb.firstChild.nodeValue = m + ' · ' + e; applyLang(lang); }
    function rowMeta(r) { dflt(r); var s = r.querySelector('.sub'); setMeta(r.dataset.p, r.dataset.m, r.dataset.e, s ? s.innerHTML.replace(/^(Claude|Codex)( · )?/, '') : ''); }
    /* 자기 .flow가 없는 행 = 자리 흐름(행 제목 사용자 말 1 + 접힌 도구 행 1) */
    function stub(r) {
      var f = document.createElement('div'), t = r.querySelector('.t').textContent.replace(/^↳\s*/, ''), s = r.querySelector('.sub'), n = s ? s.textContent.replace(/^(Claude|Codex)( · )?/, '') : '';
      f.className = 'flow'; f.dataset.sess = r.dataset.sess;
      f.innerHTML = '<div class="msg user"><div class="body"><p></p></div></div><details class="tool"><summary><span class="st">✓</span><b data-en="Read records">기록 읽기</b><span class="n"></span></summary><pre class="out"></pre></details>';
      f.querySelector('.msg p').textContent = t; f.querySelector('.n').textContent = n ? '· ' + n : '';
      f.querySelector('.out').textContent = 'read  session  ' + r.dataset.sess + '\ntitle ' + t + '\nscope ' + (n || '-');
      ag.insertBefore(f, ag.querySelector('.term')); return f;
    }
    function open(r) {
      cur = r; ag.classList.remove('new-on'); $$('.srow', lv).forEach(function (x) { x.classList.toggle('sel', x === r); });
      var g = r.querySelector('.g-new'), fs = $$('.flow', ag), f = fs.filter(function (x) { return x.dataset.sess === r.dataset.sess; })[0] || stub(r); if (g) g.remove(); fs = $$('.flow', ag);
      fs.forEach(function (x) { x.hidden = x !== f; }); if (cx) cx.hidden = r.dataset.sess !== (f0 && f0.dataset.sess);
      head.querySelector('.st').innerHTML = r.querySelector('.st').innerHTML; ht.removeAttribute('data-en'); ht.removeAttribute('data-ko'); ht.textContent = r.querySelector('.t').textContent;
      rowMeta(r); view('chat');
    }
    function prov() { var c = st && st.querySelector('.prov .on'); return c && c.dataset.p !== 'auto' ? c.dataset.p : 'Claude'; }
    function fresh() { ag.classList.add('new-on'); view('chat'); head.querySelector('.st').innerHTML = ''; ht.removeAttribute('data-ko'); ht.textContent = '새 세션'; ht.setAttribute('data-en', 'New session'); setMeta(prov(), MODELS[prov()][0], 'medium'); if (ta) ta.focus(); }
    function filt() { var v = q.value.trim().toLowerCase(), run = lv.querySelector('.tools [data-f=run].on');
      $$('.grp', lv).forEach(function (g) { var n = 0; $$('.srow', g).forEach(function (r) { r.hidden = !!(v && r.querySelector('.t').textContent.toLowerCase().indexOf(v) < 0) || !!(run && r.querySelector('.st').textContent !== '●'); if (!r.hidden) n++; }); g.hidden = !n; }); }
    q.addEventListener('input', filt);
    lv.addEventListener('click', function (e) {
      var c = e.target.closest('.tools .eps button'), r = e.target.closest('.srow');
      if (c) { $$('.tools .eps button', lv).forEach(function (x) { x.classList.toggle('on', x === c); }); filt(); }
      if (r && e.target.closest('.x')) { r.remove(); filt(); } else if (r) open(r);
    });
    lv.addEventListener('keydown', function (e) { var r = e.target.closest('.srow'); if (r && e.key === 'Enter') open(r); });
    $$('[data-agent-back]', ag).forEach(function (b) { b.addEventListener('click', function () { view('list'); }); });
    $$('[data-agent-new]', ag).forEach(function (b) { b.addEventListener('click', fresh); });
    if (st) st.addEventListener('click', function (e) { var c = e.target.closest('.prov button'), k = e.target.closest('.cards .art-card');
      if (c) { $$('.prov button', st).forEach(function (x) { x.classList.toggle('on', x === c); }); setMeta(prov(), MODELS[prov()][0], 'medium'); }
      if (k && ta) { ta.value = k.querySelector('.t').textContent; ta.focus(); } });
    if (ta) ta.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return; e.preventDefault(); var v = ta.value.trim(); if (!v) return; ta.value = '';
      var m = document.createElement('div'); m.className = 'msg user'; m.innerHTML = '<div class="body"><p></p></div>'; m.querySelector('p').textContent = v;
      if (!ag.classList.contains('new-on')) { var cf = $$('.flow', ag).filter(function (x) { return !x.hidden; })[0]; if (cf) { cf.appendChild(m); cf.scrollTop = 1e6; } return; }
      var id = 'n' + Date.now(), p = prov(), f = document.createElement('div'), r = document.createElement('div'), g = lv.querySelector('.grp');
      f.className = 'flow'; f.dataset.sess = id; f.appendChild(m); f.insertAdjacentHTML('beforeend', '<div class="working"><span class="spin">⟳</span><span data-en="Thinking">생각 중</span></div>'); ag.insertBefore(f, ag.querySelector('.term'));
      r.className = 'srow'; r.setAttribute('role', 'button'); r.tabIndex = 0; r.dataset.sess = id; r.dataset.p = p;
      r.innerHTML = '<span class="st">●</span><span class="t"></span><time data-en="now">방금</time><span class="x" title="닫기" data-en-title="Close">×</span><span class="sub" hidden>' + p + '</span>'; r.querySelector('.t').textContent = v.slice(0, 16).trimEnd();
      g.insertBefore(r, g.querySelector('.srow')); filt(); open(r);
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
    /* 처음: 메타 첫 세 낱말 = 지금 행의 제공자·모델·effort. .agent.new-on(13)이면 새 세션 상태 */
    if (cur && meta) { var ps = meta.innerHTML.split(' · '); cur.dataset.p = ps[0]; cur.dataset.m = ps[1]; cur.dataset.e = ps[2]; if (mb) mb.firstChild.nodeValue = ps[1] + ' · ' + ps[2]; }
    if (ag.classList.contains('new-on')) fresh();
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
