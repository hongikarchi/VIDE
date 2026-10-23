/* VIDE Next 목업 공통 동작 v9 — 대화 세션(탭 줄·홈·모델 메뉴·목록), 테마(밝음 기본), 탭, 대화/터미널, 접기, 레일 묶음 5 → 탐색기 블록, 검색칸 거르기, UI 언어 전체 전환(applyLang), 폴더 접기·+ 폴더, 선택 창, 데모 넘기기. 제품 코드 아님. */
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
  /* 대화 v9: 탭 줄(.tab[data-sess] → .flow 전환 · 메타 = 제공자 · 모델 · effort · 나머지) · × 닫기 · + → 홈(.home, .add.on) · 홈 Enter → 새 탭(앞 16자 · 칩 제공자) · 칩 · 카드 · 모델 메뉴(세션 제공자 것만) · …/전체 › → .sessions(검색·접기·행 → 탭) */
  $$('.agent').forEach(function (ag) {
    var tabs = ag.querySelector('.tabs'); if (!tabs) return;
    var add = tabs.querySelector('.add'), more = tabs.querySelector('.more'), meta = ag.querySelector('.meta .m'), ss = ag.querySelector('.sessions'), home = ag.querySelector('.home');
    var mb = ag.querySelector('.composer .model'), hta = home && home.querySelector('textarea'), menu = null, REQ = '<bdi data-en="Req">요청</bdi> ';
    var MODELS = { Claude: ['Sonnet', 'Opus', 'Fable'], Codex: ['GPT-5 Codex', 'GPT-5'] }, EFF = ['medium', 'high'];
    function all() { return $$('.tab', tabs); }
    /* 보이는 탭 수: 패널 380px = 3, 340px(≤1280) = 2 (app.css .tab:nth-of-type와 같음). base = 탭 줄에 없는 세션 수(마크업은 3 기준) */
    function lim() { return window.matchMedia && matchMedia('(max-width:1280px)').matches ? 2 : 3; }
    var base = (more ? parseInt(more.textContent.replace(/\D/g, ''), 10) || 0 : 0) - Math.max(0, all().length - 3);
    function count() { if (more) { var n = base + Math.max(0, all().length - lim()); more.textContent = '…' + n; more.hidden = !n; } }
    /* 닫은 뒤 자리가 비고 넘침이 있으면 목록에서 탭 줄에 없는 첫 세션을 끝에 올린다 */
    function refill(gone) { while (base > 0 && all().length < lim()) { var r = ss && $$('.srow', ss).filter(function (x) { return x.dataset.sess !== gone && !/^↳/.test(x.querySelector('.t').textContent) && !tabs.querySelector('.tab[data-sess="' + x.dataset.sess + '"]'); })[0]; if (!r) break;
      var sub = r.querySelector('.sub'), t = mkTab(r.dataset.sess, r.querySelector('.t').textContent, r.querySelector('.st').innerHTML, sub ? (/^Codex/.test(sub.textContent) ? 'Codex' : 'Claude') : ''); tabs.insertBefore(t, add); base--; applyLang(lang); } count(); }
    function srowSub(id) { return ss && ss.querySelector('.srow[data-sess="' + id + '"] .sub'); }
    function dflt(t) { var r = srowSub(t.dataset.sess); t.dataset.p = t.dataset.p || (r && /^Codex/.test(r.textContent) ? 'Codex' : 'Claude'); t.dataset.m = t.dataset.m || MODELS[t.dataset.p][0]; t.dataset.e = t.dataset.e || 'medium'; }
    function setMeta(t) { var r = srowSub(t.dataset.sess), rest = t.dataset.rest || (r ? r.innerHTML.replace(/^(Claude|Codex) · /, '') : REQ + '1');
      if (meta) meta.innerHTML = [t.dataset.p, t.dataset.m, t.dataset.e, rest].join(' · '); if (mb) mb.firstChild.nodeValue = t.dataset.m + ' · ' + t.dataset.e; applyLang(lang); }
    /* 장에 없는 세션의 짧은 본문(말 수 = 메타 '요청 n') · 그 밖은 접힘 줄 + 제목 말 + 결과 */
    function U(t) { return '<div class="msg user"><div class="who" data-en="Me">나</div><div class="body"><p>' + t + '</p></div></div>'; }
    function A(t, tm) { return '<div class="msg ai"><div class="who">VIDE</div><div class="body"><p>' + t + '</p>' + (tm ? '<time>' + tm + '</time>' : '') + '</div></div>'; }
    var SNIP = {
      s02: U('기록 모아 줘.') + A('<bdi data-en="Records">기록</bdi> 180 · <bdi data-en="Mismatch">어긋남</bdi> 2', '15:40'),
      s04: U('C2A 어디?') + A('X3 · Y2') + U('D-03 근거') + A('← 4, 5') + U('이 기둥 600 동쪽으로.') + A('<bdi data-en="Columns">기둥</bdi> 1 · <bdi data-en="Plans">평면</bdi> 1', '16:12'),
      s05: U('1층 보 경간 봐줘.') + A('12 m ↑ 4') + U('트러스로.') + A('<svg class="i xs"><use href="#i-cube"/></svg>4', '15:40')
    };
    function mk(id) { var f = document.createElement('div'); f.className = 'flow'; f.dataset.sess = id;
      if (SNIP[id]) f.innerHTML = SNIP[id];
      else { var r = ss && ss.querySelector('.srow[data-sess="' + id + '"]'), sub = r && r.querySelector('.sub'), n = sub ? parseInt((sub.textContent.match(/(요청|Req)\s*(\d+)/) || [0, 0, 1])[2], 10) : 1, tl = r ? r.querySelector('.t').textContent.replace(/^↳ /, '') : '';
        f.innerHTML = (n > 1 ? '<div class="fold">⋯ <bdi data-en="Req">요청</bdi> ' + (n - 1) + '</div>' : '') + U(tl) + A(sub ? sub.innerHTML.replace(/^(Claude|Codex) · <bdi[^>]*>[^<]*<\/bdi> \d+ · /, '') : '·', r && r.querySelector('time') ? r.querySelector('time').textContent : ''); }
      ag.insertBefore(f, ag.querySelector('.term')); return f; }
    var cx = ag.querySelector('.composer .ctx'), s0 = (tabs.querySelector('.tab.on') || {}).dataset; s0 = s0 && s0.sess;
    function flow(id) { var fs = $$('.flow', ag), f = fs.filter(function (x) { return x.dataset.sess === id; })[0];
      if (!f) { f = mk(id); fs.push(f); }
      fs.forEach(function (x) { x.hidden = x !== f; }); f.hidden = false;
      if (cx && !cx.querySelector('.ghost')) cx.hidden = id !== s0; }
    function list(on) { if (ss) ss.hidden = !on; }
    function go(t) {
      all().forEach(function (x) { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)); });
      ag.classList.toggle('home-on', !t); if (home) home.hidden = !!t; if (add) add.classList.toggle('on', !t); list(false); if (menu) menu.hidden = true;
      if (!t) return; var g = t.querySelector('.g-new'); if (g) g.remove(); dflt(t); flow(t.dataset.sess); setMeta(t);
    }
    function mkTab(id, title, st, p) { var t = document.createElement('button'); t.type = 'button'; t.className = 'tab'; t.setAttribute('role', 'tab'); t.dataset.sess = id; t.title = title; if (p) t.dataset.p = p;
      t.innerHTML = '<span class="st"></span><span class="t"></span><span class="x" title="닫기" data-en-title="Close">×</span>'; t.firstChild.innerHTML = st || ''; t.children[1].textContent = title; return t; }
    function open(id, title, st, p) { var t = tabs.querySelector('.tab[data-sess="' + id + '"]');
      if (!t) { t = mkTab(id, title, st, p); }
      tabs.insertBefore(t, tabs.firstChild); count(); go(t); return t; }
    function rowOpen(r) { var sub = r.querySelector('.sub'); open(r.dataset.sess, r.querySelector('.t').textContent, r.querySelector('.st').innerHTML, sub ? (/^Codex/.test(sub.textContent) ? 'Codex' : 'Claude') : ''); }
    tabs.addEventListener('click', function (e) { var t = e.target.closest('.tab'); if (!t) return;
      if (e.target.closest('.x')) { var on = t.classList.contains('on'), sid = t.dataset.sess; t.remove(); refill(sid); if (on) go(all()[0] || null); } else go(t); });
    $$('[data-agent-new]', ag).forEach(function (b) { b.addEventListener('click', function () { go(null); if (hta) hta.focus(); }); });
    $$('[data-agent-list]', ag).forEach(function (b) { b.addEventListener('click', function () { if (ss) list(ss.hidden); }); });
    var sq = ss && ss.querySelector('.q');
    if (sq) sq.addEventListener('input', function () { var v = sq.value.trim().toLowerCase(); ss.classList.toggle('filtering', !!v);
      $$('.grp', ss).forEach(function (g) { var n = 0; $$('.srow', g).forEach(function (r) { r.hidden = !!v && r.querySelector('.t').textContent.toLowerCase().indexOf(v) < 0; if (!r.hidden) n++; }); g.hidden = !!v && !n; }); });
    if (ss) ss.addEventListener('click', function (e) {
      var h = e.target.closest('h3[role=button]'), r = e.target.closest('.srow'); if (h) { h.parentNode.classList.toggle('shut'); return; } if (!r) return;
      if (e.target.closest('.x')) { var b = r.parentNode.querySelector('h3 bdi'); if (b && b.nextSibling) b.nextSibling.nodeValue = b.nextSibling.nodeValue.replace(/\d+/, function (n) { return Math.max(0, n - 1); }); r.remove(); } else rowOpen(r); });
    if (home) home.addEventListener('click', function (e) {
      var c = e.target.closest('.prov button'), k = e.target.closest('.cards .art-card'), r = e.target.closest('.recent .srow');
      if (c) $$('.prov button', home).forEach(function (x) { x.classList.toggle('on', x === c); });
      if (k && hta) { hta.value = k.querySelector('.t').textContent; hta.focus(); }
      if (r) rowOpen(r);
    });
    if (hta) hta.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return; e.preventDefault(); var v = hta.value.trim(); if (!v) return;
      var c = home.querySelector('.prov .on'), p = c && c.dataset.p !== 'auto' ? c.dataset.p : 'Claude', id = 'n' + Date.now(), f = document.createElement('div');
      f.className = 'flow'; f.dataset.sess = id; f.setAttribute('data-new', ''); f.innerHTML = '<div class="msg user"><div class="who" data-en="Me">나</div><div class="body"><p></p></div></div>'; f.querySelector('p').textContent = v;
      ag.insertBefore(f, ag.querySelector('.term')); hta.value = '';
      var t = open(id, v.slice(0, 16).trimEnd(), '●', p); t.dataset.rest = REQ + '1'; setMeta(t);
    });
    if (mb) mb.addEventListener('click', function (e) {
      e.stopPropagation(); var t = tabs.querySelector('.tab.on'); if (!t) return;
      if (!menu) { menu = document.createElement('div'); menu.className = 'menu'; menu.hidden = true; mb.parentNode.insertBefore(menu, mb.nextSibling); menu.addEventListener('click', function (ev) { var b = ev.target.closest('button'), cur = tabs.querySelector('.tab.on'); if (!b || !cur) return; cur.dataset[b.dataset.k] = b.dataset.v; setMeta(cur); menu.hidden = true; }); }
      if (!menu.hidden) { menu.hidden = true; return; }
      function btn(k, v) { return '<button type="button" data-k="' + k + '" data-v="' + v + '"' + (t.dataset[k] === v ? ' class="on"' : '') + '>' + v + '</button>'; }
      menu.innerHTML = MODELS[t.dataset.p].map(function (m) { return btn('m', m); }).join('') + '<hr>' + EFF.map(function (x) { return btn('e', x); }).join(''); menu.hidden = false;
    });
    document.addEventListener('click', function (e) { if (menu && !menu.contains(e.target)) menu.hidden = true; });
    /* 처음: .tab.on에 메타 첫 세 낱말(제공자·모델·effort)·나머지를 담는다. 홈이 열린 꼴(13)이면 홈 */
    var on0 = tabs.querySelector('.tab.on');
    if (on0 && meta) { var ps = meta.innerHTML.split(' · '); on0.dataset.p = on0.dataset.p || ps[0]; on0.dataset.m = on0.dataset.m || ps[1]; on0.dataset.e = on0.dataset.e || ps[2]; on0.dataset.rest = ps.slice(3).join(' · '); if (mb) mb.firstChild.nodeValue = on0.dataset.m + ' · ' + on0.dataset.e; }
    if (home && !home.hidden) go(null);
    count();
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
