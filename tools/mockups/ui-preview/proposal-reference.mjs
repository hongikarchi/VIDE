// Proposal screens for SPEC-09 (참고 이미지로 의도 확인, PLAN-26 T-090), injected into the real
// built UI by snapshot.mjs after the real screens are captured. Not implemented: every piece is
// labelled '제안 (아직 구현 안 됨)'. The reference image is drawn here (no photo, no download).
// Colours come from src/ui/tokens.css; only the illustration itself has its own colours.

const PROPOSAL = '제안 (아직 구현 안 됨)';

/** A facade with vertical timber louvers and an entrance canopy, 800 x 560. */
function facade({ masks, lasso, leaders }) {
  const fins = [];
  for (let x = 146; x <= 650; x += 18)
    fins.push(
      `<rect x="${x}" y="74" width="6" height="314" fill="url(#fin)"/><rect x="${x + 6}" y="74" width="2" height="314" fill="#00000022"/>`,
    );
  const floors = [70, 150, 230, 310]
    .map(
      (y) =>
        `<rect x="140" y="${y + 6}" width="520" height="70" fill="url(#glass)"/><rect x="140" y="${y + 6}" width="520" height="70" fill="url(#glare)"/>`,
    )
    .join('');
  const slabs = [146, 226, 306, 386]
    .map((y) => `<rect x="126" y="${y}" width="548" height="8" fill="#cbc4b6"/>`)
    .join('');
  const mullions = [];
  for (let x = 140; x <= 660; x += 65)
    mullions.push(`<rect x="${x}" y="398" width="3" height="72" fill="#2e3a40"/>`);
  const region = (letter, d, x, y, active) => `
    <path d="${d}" fill="color-mix(in srgb, var(--accent) ${active ? 30 : 34}%, transparent)" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${x}" cy="${y}" r="15" fill="var(--accent)"/><text x="${x}" y="${y + 5}" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="Inter, sans-serif">${letter}</text>`;
  return `<svg class="rx-facade" viewBox="0 0 800 560" role="img" aria-label="참고 이미지 예시: 수직 목재 루버가 있는 5층 건물 정면(직접 그린 그림)">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9e2e7"/><stop offset="1" stop-color="#f1efe9"/></linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6d7d86"/><stop offset="1" stop-color="#46545b"/></linearGradient>
    <linearGradient id="glare" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff00"/><stop offset=".45" stop-color="#ffffff1f"/><stop offset=".55" stop-color="#ffffff00"/></linearGradient>
    <linearGradient id="fin" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#c08a56"/><stop offset="1" stop-color="#9b6a3d"/></linearGradient>
  </defs>
  <rect width="800" height="560" fill="url(#sky)"/>
  <rect x="0" y="470" width="800" height="90" fill="#cdc8be"/><rect x="0" y="470" width="800" height="5" fill="#b9b3a7"/>
  <rect x="110" y="58" width="580" height="14" fill="#d3ccbf"/>
  <rect x="120" y="70" width="560" height="400" fill="#e6e0d4"/>
  ${floors}${slabs}${fins.join('')}
  <rect x="140" y="398" width="520" height="72" fill="#3f4c53"/>${mullions.join('')}
  <rect x="368" y="408" width="64" height="62" fill="#262f34"/>
  <rect x="318" y="390" width="164" height="7" fill="#2b2b2b"/><rect x="318" y="397" width="164" height="10" fill="#00000026"/>
  <g fill="#6f8a5e"><circle cx="64" cy="402" r="34"/><circle cx="92" cy="420" r="28"/><circle cx="44" cy="430" r="24"/></g>
  <rect x="62" y="430" width="6" height="40" fill="#6b5a46"/>
  <g fill="#3a3a3a"><circle cx="470" cy="436" r="5"/><rect x="465" y="442" width="10" height="28" rx="4"/></g>
  ${masks.map((m) => region(m.letter, m.d, m.x, m.y, m.active)).join('')}
  ${lasso ? `<path d="${lasso}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-dasharray="7 5" stroke-linecap="round"/><circle cx="${lasso.split(' ').slice(-2)[0].replace(/[A-Z]/g, '')}" cy="${lasso.split(' ').slice(-1)[0]}" r="5" fill="var(--accent)"/>` : ''}
  ${(leaders ?? [])
    .map(
      ([x1, y1, x2, y2]) =>
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--text-1)" stroke-width="1.5"/><circle cx="${x2}" cy="${y2}" r="5" fill="var(--bg-elevated)" stroke="var(--text-1)" stroke-width="2"/>`,
    )
    .join('')}
</svg>`;
}

const maskA = {
  letter: 'A',
  d: 'M 432 160 C 470 150 610 152 652 162 C 664 220 662 320 650 378 C 590 386 480 384 436 376 C 426 300 424 220 432 160 Z',
  x: 432,
  y: 160,
};
const maskB = {
  letter: 'B',
  d: 'M 310 382 L 490 382 L 492 412 L 308 414 Z',
  x: 310,
  y: 382,
};

const css = `
.rx-stage { grid-row: 3 / 5; grid-column: 1 / -1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); overflow: auto; }
.rx-head { display: flex; align-items: center; gap: var(--s2); padding: var(--s3) var(--s4); border-bottom: var(--hairline) solid var(--border); background: var(--bg-elevated); }
.rx-head h2 { margin: 0; font-size: var(--fs-lg); font-weight: 600; letter-spacing: var(--tracking); }
.rx-head .rx-meta { color: var(--text-3); font-size: var(--fs-sm); }
.rx-head .rx-spacer { flex: 1; }
.rx-proposal { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: var(--hairline) dashed var(--text-3); border-radius: var(--radius-pill); color: var(--text-2); font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; background: var(--bg-surface); }
.rx-chip { padding: 1px 7px; border-radius: var(--radius-pill); background: var(--bg-surface); color: var(--text-2); font-size: var(--fs-xs); border: var(--hairline) solid var(--border); }
.rx-tabrow-note { align-self: center; margin-left: auto; margin-right: var(--s2); }
/* Editor */
.rx-editor { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 248px; }
.rx-canvas { min-width: 0; display: flex; flex-direction: column; }
.rx-tools { display: flex; align-items: center; gap: 6px; padding: var(--s2) var(--s4); border-bottom: var(--hairline) solid var(--border-subtle); background: var(--bg-elevated); font-size: var(--fs-sm); }
.rx-seg { display: inline-flex; border: var(--hairline) solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.rx-seg button { border: 0; border-radius: 0; padding: 5px 10px; font-size: var(--fs-sm); background: var(--bg-elevated); color: var(--text-2); }
.rx-seg button + button { border-left: var(--hairline) solid var(--border); }
.rx-seg button[aria-pressed='true'] { background: var(--bg-active); color: var(--text-1); font-weight: 600; }
.rx-tools .rx-sep { width: 1px; height: 18px; background: var(--border); margin: 0 4px; }
.rx-tools label { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }
.rx-tools input[type='range'] { width: 90px; }
.rx-tools .rx-hint { margin-left: auto; color: var(--text-3); }
.rx-image-wrap { flex: 1; min-height: 0; display: grid; place-items: center; padding: var(--s6); background: var(--bg-recessed); }
.rx-image-wrap .rx-facade { width: 100%; max-width: 860px; height: auto; border-radius: var(--radius-sm); box-shadow: var(--shadow-float); background: #fff; }
.rx-regions { border-left: var(--hairline) solid var(--border); background: var(--bg-elevated); display: flex; flex-direction: column; min-height: 0; }
.rx-regions h3 { margin: 0; padding: var(--s3) var(--s4) var(--s2); font-size: var(--fs-sm); font-weight: 600; color: var(--text-2); }
.rx-region { margin: 0 var(--s2) 6px; padding: var(--s2) 10px; border-radius: var(--radius-sm); display: grid; grid-template-columns: 22px 1fr; gap: 4px 8px; align-items: center; }
.rx-region[data-active] { background: var(--bg-selected); }
.rx-letter { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: #fff; font-size: var(--fs-xs); font-weight: 700; }
.rx-region strong { font-size: var(--fs-md); font-weight: 600; }
.rx-region input { grid-column: 2; width: 100%; box-sizing: border-box; font-size: var(--fs-sm); padding: 5px 7px; border: var(--hairline) solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-1); }
.rx-region small { grid-column: 2; color: var(--text-3); font-size: var(--fs-xs); }
.rx-add { margin: 2px var(--s4); align-self: flex-start; font-size: var(--fs-sm); }
.rx-regions .rx-foot { margin-top: var(--s3); padding: var(--s4); border-top: var(--hairline) solid var(--border-subtle); display: grid; gap: var(--s2); }
.rx-regions .rx-foot p { margin: 0; color: var(--text-3); font-size: var(--fs-xs); line-height: 1.5; }
.rx-cta { width: 100%; padding: 9px 12px !important; font-size: var(--fs-md) !important; font-weight: 600; }
/* Board */
.rx-board { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: var(--s4); padding: var(--s4); align-content: start; }
.rx-pane { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.rx-pane-head { display: flex; align-items: baseline; gap: 6px; font-size: var(--fs-sm); color: var(--text-2); }
.rx-pane-head strong { color: var(--text-1); font-weight: 600; }
.rx-figure { position: relative; border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-recessed); border: var(--hairline) solid var(--border); aspect-ratio: 800 / 560; }
.rx-figure .rx-facade { display: block; width: 100%; height: 100%; }
.rx-bubble { position: absolute; max-width: 46%; padding: 7px 10px 8px; background: var(--bg-elevated); color: var(--text-1); border: var(--hairline) solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-float); font-size: var(--fs-sm); line-height: 1.45; cursor: pointer; }
.rx-bubble b { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: var(--fs-md); }
.rx-bubble b .rx-letter { width: 18px; height: 18px; font-size: 10.5px; }
.rx-bubble .rx-q { display: block; margin-top: 3px; color: var(--warn); font-size: var(--fs-xs); }
.rx-bubble .rx-edit { display: block; margin-top: 4px; color: var(--text-3); font-size: var(--fs-xs); }
.rx-bubble[data-focus] { outline: 1.5px solid var(--text-1); outline-offset: 1px; }
.rx-gen { position: absolute; inset: 0; display: grid; place-items: center; }
.rx-gen img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: grayscale(1); opacity: .28; }
.rx-gen-card { position: relative; display: grid; justify-items: center; gap: 6px; padding: var(--s4) var(--s6); border-radius: var(--radius-md); background: var(--bg-floating); border: var(--hairline) solid var(--border); text-align: center; }
.rx-gen-card strong { font-size: var(--fs-md); }
.rx-gen-card small { color: var(--text-3); font-size: var(--fs-xs); }
.rx-spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--text-1); }
.rx-caption { color: var(--text-3); font-size: var(--fs-xs); line-height: 1.5; }
.rx-values { grid-column: 1 / -1; width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.rx-values caption { text-align: left; padding: 0 0 6px; color: var(--text-2); font-weight: 600; }
.rx-values th, .rx-values td { text-align: left; padding: 6px 8px; border-bottom: var(--hairline) solid var(--border-subtle); vertical-align: top; }
.rx-values th { color: var(--text-3); font-weight: 500; font-size: var(--fs-xs); }
.rx-values .rx-src { margin-left: 4px; padding: 0 5px; border-radius: var(--radius-pill); background: var(--bg-surface); color: var(--text-3); font-size: var(--fs-xs); }
.rx-values .rx-src[data-src='user'] { background: var(--info-subtle); color: var(--info); }
.rx-states { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: var(--s2); border-top: var(--hairline) solid var(--border-subtle); color: var(--text-3); font-size: var(--fs-xs); }
.rx-states span[data-on] { color: var(--text-1); font-weight: 600; }
.rx-states i { font-style: normal; opacity: .6; }
/* AI column */
.rx-msg-user { margin: 0 0 10px auto; max-width: 88%; padding: 8px 10px; border-radius: var(--radius-md); background: var(--bg-surface); font-size: var(--fs-md); line-height: 1.5; }
.rx-attach { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 5px; border: var(--hairline) solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); }
.rx-attach svg { width: 52px; height: 36px; border-radius: 4px; flex-shrink: 0; }
.rx-attach span { flex: 1; min-width: 0; font-size: var(--fs-sm); }
.rx-attach button { font-size: var(--fs-sm); }
.rx-answer p { margin: 0 0 8px; line-height: 1.6; }
.rx-answer ul { margin: 0 0 8px; padding-left: 18px; line-height: 1.6; }
.rx-confirm { margin-top: 8px; padding: 10px; border: var(--hairline) solid var(--border); border-radius: var(--radius-md); background: var(--bg-elevated); display: grid; gap: 8px; }
.rx-confirm-head { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); font-weight: 600; }
.rx-confirm-head .rx-proposal { margin-left: auto; }
.rx-confirm ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; font-size: var(--fs-sm); }
.rx-confirm li { display: flex; gap: 6px; align-items: baseline; }
.rx-confirm li .rx-letter { width: 18px; height: 18px; font-size: 10.5px; flex-shrink: 0; }
.rx-confirm .rx-actions { display: flex; gap: 6px; align-items: center; }
.rx-confirm .rx-actions .primary-button { font-size: var(--fs-sm); padding: 7px 12px; }
.rx-confirm small { color: var(--text-3); font-size: var(--fs-xs); }
`;

const tabRow = (label, title) => `
<div class="workspace-tablist" role="tablist" aria-label="작업공간">
  <span class="workspace-context-tab" data-active=""><button type="button" role="tab" aria-selected="true" title="${title}">${label}</button><button type="button" class="workspace-tab-close" aria-label="${label} 탭 닫기">×</button></span>
</div>
<span class="rx-proposal rx-tabrow-note" title="SPEC-09 · PLAN-26 T-090">${PROPOSAL}</span>`;

function editor() {
  return `
<div class="rx-stage" aria-label="참고 이미지 영역 표시 (제안)">
  <div class="rx-head"><h2>참고 이미지 · facade.jpg</h2><span class="rx-meta">첨부 원본은 바꾸지 않음 · 영역은 따로 저장</span><span class="rx-spacer"></span><span class="rx-proposal">${PROPOSAL}</span></div>
  <div class="rx-editor">
    <div class="rx-canvas">
      <div class="rx-tools" role="toolbar" aria-label="영역 표시 도구">
        <span class="rx-seg"><button type="button" aria-pressed="false">붓</button><button type="button" aria-pressed="true">올가미</button><button type="button" aria-pressed="false">사각형</button><button type="button" aria-pressed="false">지우개</button></span>
        <span class="rx-sep"></span>
        <label>굵기 <input type="range" min="4" max="80" value="28" aria-label="붓 굵기"></label>
        <span class="rx-sep"></span>
        <button type="button" title="되돌리기 · Ctrl+Z">↶</button><button type="button" title="다시 하기 · Ctrl+Shift+Z">↷</button>
        <span class="rx-hint">영역 B 그리는 중 · 첫 점으로 돌아오면 닫힘 · 휠로 확대</span>
      </div>
      <div class="rx-image-wrap">${facade({
        masks: [maskA],
        lasso: 'M 312 384 L 486 381 L 490 410 L 360 413',
      })}</div>
    </div>
    <aside class="rx-regions" aria-label="영역">
      <h3>영역 2</h3>
      <div class="rx-region"><span class="rx-letter">A</span><strong>수직 루버</strong><input value="간격과 깊이 느낌만 가져오기" aria-label="영역 A 메모"><small>올가미 1 · 붓 2획</small></div>
      <div class="rx-region" data-active=""><span class="rx-letter">B</span><strong>입구 차양</strong><input value="형태만, 색은 빼고" aria-label="영역 B 메모"><small>그리는 중</small></div>
      <button type="button" class="link-button rx-add">+ 새 영역 (C)</button>
      <div class="rx-foot">
        <p>영역이 없으면 이미지 전체를 영역 A로 봅니다. 영역마다 메모 한 줄을 AI에 함께 보냅니다.</p>
        <button type="button" class="primary-button rx-cta">이해 확인</button>
        <p>지금 대화 · Claude Opus 5.5에 이미지와 영역 2개를 보냅니다. 답이 오면 이 탭이 '이해 확인'으로 바뀝니다.</p>
      </div>
    </aside>
  </div>
</div>`;
}

function board(capture) {
  // Leader lines in image units; bubbles placed in % of the same box.
  const figure = facade({
    masks: [maskA, maskB],
    leaders: [
      [300, 120, 545, 265],
      [560, 478, 420, 396],
    ],
  });
  return `
<div class="rx-stage" aria-label="이해 확인 보드 (제안)">
  <div class="rx-head"><h2>이해 확인 · 파사드 루버</h2><span class="rx-chip">판 1</span><span class="rx-meta">말풍선 준비 · 이미지 생성 중</span><span class="rx-spacer"></span><span class="rx-proposal">${PROPOSAL}</span></div>
  <div class="rx-board">
    <section class="rx-pane" aria-label="참고 이미지와 AI가 읽은 것">
      <div class="rx-pane-head"><strong>참고 이미지</strong> facade.jpg · 영역 2 · AI가 읽은 것</div>
      <div class="rx-figure">${figure}
        <div class="rx-bubble" data-focus="" style="left:2.5%;top:4%"><b><span class="rx-letter">A</span>수직 루버</b>간격 약 600 · 깊이 300 느낌 · 목재 톤<span class="rx-q">? 끝 처리 · 재료</span><span class="rx-edit">눌러서 A만 고치기</span></div>
        <div class="rx-bubble" style="left:52%;top:72%"><b><span class="rx-letter">B</span>입구 차양 · 형태만</b>길이 약 4 m · 얇은 수평 판</div>
      </div>
      <div class="rx-caption">말풍선 글자는 VIDE가 겹쳐 그립니다(생성 이미지에 글자를 넣지 않음). 말풍선을 누르면 그 영역만 다시 해석합니다.</div>
    </section>
    <section class="rx-pane" aria-label="우리 건물에 입혀 본 이미지">
      <div class="rx-pane-head"><strong>우리 건물에 입혀 본 이미지</strong> 참고용 · 산출물에 저장</div>
      <div class="rx-figure"><div class="rx-gen">${capture ? `<img src="${capture}" alt="">` : ''}
        <div class="rx-gen-card"><span class="rx-spinner" aria-hidden="true"></span><strong>우리 건물에 입혀 본 이미지 · 생성 중</strong><small>Codex 이미지 생성 · 0:42 · 보통 1~2분</small><button type="button">생성 취소</button></div>
      </div></div>
      <div class="rx-caption">입력: 지금 3D 뷰 캡처 + 영역을 그린 참고 이미지 + 판 1 해석. 한 장에 한 번 실행(대화 세션 없음). 실패해도 [맞음]은 누를 수 있습니다.</div>
    </section>
    <table class="rx-values"><caption>읽은 값 · 판 1 (말풍선과 같은 해석)</caption>
      <thead><tr><th>영역</th><th>요소</th><th>읽은 값</th><th>메모</th><th>확인할 것</th><th>적용 대상</th></tr></thead>
      <tbody>
        <tr><td><span class="rx-letter">A</span></td><td>수직 루버</td><td>간격 600<span class="rx-src">추정</span> · 깊이 300<span class="rx-src">추정</span> · 목재 톤<span class="rx-src">추정</span></td><td>간격과 깊이 느낌만 가져오기</td><td>끝 처리 · 재료</td><td>남측 파사드 (핀)</td></tr>
        <tr><td><span class="rx-letter">B</span></td><td>입구 차양</td><td>길이 4 m<span class="rx-src">추정</span> · 형태만<span class="rx-src" data-src="user">사용자</span></td><td>형태만, 색은 빼고</td><td>—</td><td>주 출입구</td></tr>
      </tbody></table>
    <div class="rx-states" aria-label="보드 상태"><span>답하는 중</span><i>→</i><span>말풍선 준비</span><i>→</i><span data-on="">이미지 생성 중</span><i>→</i><span>이미지 준비 / 실패</span><i>→</i><span>확정</span></div>
  </div>
</div>`;
}

const thumb = facade({ masks: [] }).replace('class="rx-facade"', '');

function chatEditor() {
  return `
<article class="chat-message" aria-label="제안 예시 대화">
  <div class="rx-msg-user">이 이미지의 루버 느낌을 남측 파사드에 넣고 싶어
    <div class="rx-attach">${thumb}<span>facade.jpg · 1.2 MB</span><button type="button">영역 표시</button></div>
  </div>
  <div class="rx-answer"><p>원하는 부분을 이미지에 표시해 주시면 그 부분만 읽고, 이해한 내용을 말풍선과 이미지로 먼저 보여 드리겠습니다.</p>
  <p class="rx-caption"><span class="rx-proposal">${PROPOSAL}</span></p></div>
</article>`;
}

function chatBoard() {
  return `
<article class="work-view chat-message" aria-label="제안 예시 대화">
  <div class="rx-msg-user">이 이미지의 루버 느낌을 남측 파사드에 넣고 싶어 · 영역 A·B</div>
  <header class="work-head"><h3 class="card-title">참고 이미지 이해 확인 · 판 1</h3><span class="card-state" data-state="succeeded">답변</span></header>
  <div class="rx-answer">
    <p>이렇게 이해했습니다.</p>
    <ul>
      <li><b>A</b> 2~5층 전면의 수직 루버입니다. 간격은 약 600, 깊이는 약 300 정도로 보이고, 가는 목재 톤 판입니다.</li>
      <li><b>B</b> 입구 위 얇은 수평 차양입니다. 메모대로 색은 빼고 형태만 씁니다(길이 약 4 m).</li>
    </ul>
    <p>끝 처리와 실제 재료는 이미지로 정할 수 없습니다. 값은 모두 이미지에서 추정한 값입니다. 오른쪽 이미지는 우리 건물에 입혀 보는 중입니다.</p>
  </div>
  <section class="rx-confirm" aria-label="이해 확인">
    <div class="rx-confirm-head">이해 확인 · 판 1<span class="rx-proposal">${PROPOSAL}</span></div>
    <ol>
      <li><span class="rx-letter">A</span><span>수직 루버 · 간격 약 600 · 깊이 약 300 · 적용: 남측 파사드(핀)</span></li>
      <li><span class="rx-letter">B</span><span>입구 차양 · 형태만 · 길이 약 4 m · 적용: 주 출입구</span></li>
    </ol>
    <div class="rx-actions"><button type="button" class="primary-button">맞음 → 모델링 반영</button><button type="button">다시</button></div>
    <small>[맞음]은 이 해석을 다음 턴으로 자동 모드에 보냅니다 · 열린 문서에 바로 적용 · 실행마다 되돌리기</small>
  </section>
</article>`;
}

/** Injected in the page (stringified): replaces the centre and the AI column with the proposal. */
export function injectProposal({ kind, css, tabs, stage, chat }) {
  document.getElementById('rx-proposal-style')?.remove();
  document.querySelector('.rx-stage')?.remove();
  const workspace = document.querySelector('section.workspace');
  const style = document.createElement('style');
  style.id = 'rx-proposal-style';
  style.textContent = css;
  workspace.prepend(style);
  const bar = document.getElementById('workspace-tabs');
  bar.removeAttribute('data-empty');
  bar.innerHTML = tabs;
  // Only the tab row and the proposal stay in the centre column.
  for (const node of workspace.children)
    if (node !== bar && node !== style) node.style.display = 'none';
  workspace.insertAdjacentHTML('beforeend', stage);
  const conversation = document.getElementById('conversation');
  conversation.innerHTML = chat;
  document.body.dataset.proposal = kind;
}

export function proposalPayload(kind, capture) {
  return kind === 'mask'
    ? {
        kind,
        css,
        tabs: tabRow('참고 이미지 · facade.jpg', '참고 이미지 · facade.jpg · 영역 표시'),
        stage: editor(),
        chat: chatEditor(),
      }
    : {
        kind,
        css,
        tabs: tabRow('이해 확인 · 파사드 루버', '이해 확인 · 파사드 루버 · 판 1'),
        stage: board(capture),
        chat: chatBoard(),
      };
}
