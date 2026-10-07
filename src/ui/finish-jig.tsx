import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './gateway.ts';
import {
  EMPTY_SHEET,
  FINISH_ROOMS_MAX,
  ROOM_ELEMENTS,
  type FinishLibrary,
  type FinishRoom,
  type FinishSheet,
  type FinishState,
  type FinishTitle,
  type RoomElement,
} from '../contracts/finish.ts';
import {
  ASSIGN_ISSUE_TEXT,
  assignIssue,
  categoryText,
  codeScheduleCsv,
  codeScheduleRows,
  elementName,
  facetCount,
  familyName,
  finishName,
  kindName,
  layersOf,
  libraryCsv,
  num,
  parseRoomPaste,
  resetThickness,
  roomScheduleCsv,
  roomScheduleRows,
  roomsText,
  searchCodes,
  setThickness,
  totalOf,
  usedCodes,
  warningsOf,
  withUsed,
  type FinishFilter,
  type PasteResult,
} from '../jigs/finish.ts';
import { sectionSvg } from './finish-section.ts';
import './finish-jig.css';

// 마감 일람표 jig (SPEC-11, Design SCR-28, PLAN-43 T-198): a built-in screen jig with four tabs —
// 라이브러리 · 마감 선정, 실별 배정, 납품 출력, 체계 · 기준. The library comes from the engine
// (`GET /finish/library`, the official library vide/finish-codes); the project's rooms and sheet
// are saved per project (`PUT …/finish/rooms`, `…/finish/sheet`). No AI and no host document.

type Tab = 'lib' | 'rooms' | 'out' | 'sys';
const TABS: { id: Tab; label: string }[] = [
  { id: 'lib', label: '라이브러리 · 마감 선정' },
  { id: 'rooms', label: '실별 배정' },
  { id: 'out', label: '납품 출력' },
  { id: 'sys', label: '체계 · 기준' },
];
const TMAX = 1200;
/** Cards drawn at once; narrow the filters for the rest (SPEC-11.3). */
const CARD_CAP = 180;
const QUIET = ['FINISH_CODE_INVALID', 'INVALID_INPUT', 'NETWORK_UNAVAILABLE', 'ACTION_TIMEOUT'];

let libraryLoad: Promise<FinishLibrary> | undefined;
function loadLibrary() {
  libraryLoad ??= (api('/finish/library') as Promise<FinishLibrary>).catch((error) => {
    libraryLoad = undefined;
    throw error;
  });
  return libraryLoad;
}
const newId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Prints one sheet: a copy goes to the page body, the print CSS hides everything else. */
function printNode(node: HTMLElement | null) {
  if (!node) return;
  const root = document.createElement('div');
  root.className = 'finish-print-root';
  root.append(node.cloneNode(true));
  document.body.append(root);
  document.body.dataset.finishPrint = '';
  let done = false;
  const clean = () => {
    if (done) return;
    done = true;
    root.remove();
    delete document.body.dataset.finishPrint;
    window.removeEventListener('afterprint', clean);
  };
  window.addEventListener('afterprint', clean);
  try {
    window.print();
  } finally {
    setTimeout(clean, 500);
  }
}
const errorCode = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? '');

// ── Saved state ─────────────────────────────────────────────────────────────────────────────
/**
 * The project's rooms and sheet with saving: edits show at once, each part is sent whole after a
 * short pause (text) or at once, one request at a time. A refused list goes back to the last
 * saved state (SPEC-11.6); an unreachable engine keeps the edit and tries again on the next one.
 */
function useFinishState(projectId: string) {
  const [state, setState] = useState<FinishState>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(0);
  const [notice, setNotice] = useState('');
  const saved = useRef<FinishState | undefined>(undefined);
  const local = useRef<FinishState | undefined>(undefined);
  const timers = useRef<Record<'rooms' | 'sheet', number | undefined>>({
    rooms: undefined,
    sheet: undefined,
  });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let live = true;
    setState(undefined);
    setError('');
    (api(`/projects/${projectId}/finish`) as Promise<FinishState>)
      .then((value) => {
        if (!live) return;
        saved.current = value;
        local.current = value;
        setState(value);
      })
      .catch(() => live && setError('이 프로젝트의 마감 자료를 읽지 못했습니다.'));
    return () => {
      live = false;
    };
  }, [projectId]);
  const send = useCallback(
    (part: 'rooms' | 'sheet') => {
      timers.current[part] = undefined;
      setSaving((n) => n + 1);
      queue.current = queue.current
        .then(async () => {
          const current = local.current;
          if (!current) return;
          const body = part === 'rooms' ? { rooms: current.rooms } : current.sheet;
          try {
            const result = (await api(`/projects/${projectId}/finish/${part}`, 'PUT', body, {
              quiet: QUIET,
            })) as FinishState;
            saved.current = result;
            const now = local.current!;
            // The engine adds assigned codes to 채택; other local edits stay.
            const next: FinishState =
              part === 'rooms'
                ? {
                    rooms: now.rooms,
                    sheet: { ...now.sheet, adopted: withUsed(now.sheet.adopted, result.rooms) },
                  }
                : { rooms: now.rooms, sheet: { ...now.sheet, adopted: result.sheet.adopted } };
            local.current = next;
            setState(next);
            setNotice('');
          } catch (failure) {
            const code = errorCode(failure);
            if (code === 'FINISH_CODE_INVALID' || code === 'INVALID_INPUT') {
              const back = saved.current ?? { rooms: [], sheet: EMPTY_SHEET };
              local.current = back;
              setState(back);
              setNotice(
                '저장하지 못했습니다: 규칙에 맞지 않는 코드나 값이 있어 마지막 저장 상태로 돌렸습니다.',
              );
            } else setNotice('저장하지 못했습니다. 다음 변경 때 다시 저장합니다.');
          }
        })
        .finally(() => setSaving((n) => n - 1));
    },
    [projectId],
  );
  const change = useCallback(
    (part: 'rooms' | 'sheet', next: FinishState, delay: number) => {
      local.current = next;
      setState(next);
      window.clearTimeout(timers.current[part]);
      if (delay > 0) timers.current[part] = window.setTimeout(() => send(part), delay);
      else send(part);
    },
    [send],
  );
  const setRooms = useCallback(
    (rooms: FinishRoom[], delay = 0) => {
      const now = local.current;
      if (!now) return;
      change(
        'rooms',
        { rooms, sheet: { ...now.sheet, adopted: withUsed(now.sheet.adopted, rooms) } },
        delay,
      );
    },
    [change],
  );
  const setSheet = useCallback(
    (sheet: FinishSheet, delay = 0) => {
      const now = local.current;
      if (!now) return;
      change('sheet', { rooms: now.rooms, sheet }, delay);
    },
    [change],
  );
  // Pending text edits go out when the jig closes.
  useEffect(
    () => () => {
      for (const part of ['rooms', 'sheet'] as const)
        if (timers.current[part] !== undefined) {
          window.clearTimeout(timers.current[part]);
          send(part);
        }
    },
    [send],
  );
  return { state, error, saving: saving > 0, notice, setRooms, setSheet, local };
}

// ── Jig ─────────────────────────────────────────────────────────────────────────────────────
export function FinishJig({ projectId }: { projectId: string }) {
  const [lib, setLib] = useState<FinishLibrary>();
  const [libError, setLibError] = useState('');
  const [tab, setTab] = useState<Tab>('lib');
  const [detail, setDetail] = useState<string | null>(null);
  const finish = useFinishState(projectId);
  useEffect(() => {
    loadLibrary()
      .then(setLib)
      .catch(() => setLibError('마감 코드 라이브러리를 읽지 못했습니다.'));
  }, []);
  if (libError) return <p className="jig-intro">{libError}</p>;
  if (finish.error) return <p className="jig-intro">{finish.error}</p>;
  if (!lib || !finish.state) return <p className="jig-intro">불러오는 중…</p>;
  const { rooms, sheet } = finish.state;
  const adopted = sheet.adopted;
  const used = new Set(usedCodes(rooms));
  const toggle = (codes: string[], on: boolean) => {
    const set = new Set(adopted);
    for (const code of codes)
      if (on) set.add(code);
      else if (!used.has(code)) set.delete(code);
    finish.setSheet({ ...sheet, adopted: [...set].sort() });
  };
  const ctx: JigCtx = {
    lib,
    rooms,
    sheet,
    used,
    toggle,
    openDetail: setDetail,
    setRooms: finish.setRooms,
    setSheet: finish.setSheet,
  };
  return (
    <div className="finish-jig">
      <div className="finish-head">
        <div className="finish-tabs" role="tablist" aria-label="마감 일람표">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`finish-tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls="finish-panel"
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span className="finish-save" role="status">
          {finish.notice || (finish.saving ? '저장 중…' : '')}
        </span>
      </div>
      <div
        className="finish-panel"
        id="finish-panel"
        role="tabpanel"
        aria-labelledby={`finish-tab-${tab}`}
      >
        {tab === 'lib' ? <LibraryTab ctx={ctx} /> : null}
        {tab === 'rooms' ? <RoomsTab ctx={ctx} /> : null}
        {tab === 'out' ? <OutputTab ctx={ctx} /> : null}
        {tab === 'sys' ? <SystemTab lib={lib} /> : null}
      </div>
      {detail ? <Detail ctx={ctx} code={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}
interface JigCtx {
  lib: FinishLibrary;
  rooms: FinishRoom[];
  sheet: FinishSheet;
  used: Set<string>;
  toggle: (codes: string[], on: boolean) => void;
  openDetail: (code: string) => void;
  setRooms: (rooms: FinishRoom[], delay?: number) => void;
  setSheet: (sheet: FinishSheet, delay?: number) => void;
}

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────
/**
 * A drawing from finish-section.ts. Its size is set through the style object after it is drawn:
 * the page's CSP refuses style attributes in markup, and the app's svg rule is an 18px icon.
 */
function Svg({ markup, className }: { markup: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const svg = ref.current?.querySelector('svg');
    if (!svg) return;
    svg.style.width = '100%';
    svg.style.height = `${svg.getAttribute('height') ?? 0}px`;
  }, [markup]);
  return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: markup }} />;
}
const sectionOf = (ctx: JigCtx, code: string, options: { w: number; leader?: boolean }) => {
  const entry = ctx.lib.codes[code];
  return sectionSvg(layersOf(ctx.lib, code, ctx.sheet.thk), {
    axis: entry.el === 'W' ? 'x' : 'y',
    up: entry.el === 'F',
    band: options.leader ? (entry.el === 'W' ? 92 : 74) : entry.el === 'W' ? 40 : 34,
    ...options,
  });
};

function CodeCard({
  ctx,
  code,
  on,
  onPick,
  pickLabel,
}: {
  ctx: JigCtx;
  code: string;
  on: boolean;
  onPick: (code: string) => void;
  pickLabel: string;
}) {
  const { lib, sheet } = ctx;
  const entry = lib.codes[code];
  const total = totalOf(lib, code, sheet.thk);
  const warnings = warningsOf(lib, code, sheet.thk).length;
  const layers = layersOf(lib, code, sheet.thk);
  const svg = useMemo(
    () => (total > 3 ? sectionOf(ctx, code, { w: entry.el === 'W' ? 300 : 120 }) : ''),
    // The drawing changes with this code's thicknesses only.
    [code, total, JSON.stringify(sheet.thk[code] ?? {})],
  );
  return (
    <article className="finish-card" data-on={on} data-warn={warnings > 0} aria-label={code}>
      <button
        type="button"
        className="finish-card-pick"
        aria-pressed={on}
        aria-label={`${code} ${pickLabel}`}
        onClick={() => onPick(code)}
      />
      <div className="finish-card-head">
        <span className="finish-check" aria-hidden="true">
          {on ? '✓' : ''}
        </span>
        <strong className="finish-code">{code}</strong>
        <span className="finish-card-family">
          {elementName(lib, entry.el)} · {familyName(lib, entry.el, entry.fam)}
          <br />
          {finishName(lib, entry.fin_d)}
        </span>
      </div>
      <div className="finish-card-name">{entry.nm}</div>
      <div className="finish-card-finish">
        → {entry.fin ? <b>{entry.fin}</b> : <span className="finish-faint">마감 없음 (노출)</span>}
      </div>
      {svg ? (
        <Svg className="finish-secbox" markup={svg} />
      ) : (
        <div className="finish-thin">
          <span className="finish-thin-bar" />
          <span>{layers.map((layer) => layer.nm).join(' / ') || '구조체면'}</span>
        </div>
      )}
      {entry.tags.length ? (
        <div className="finish-tags">
          {entry.tags.map((tag) => (
            <span key={tag} className="finish-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div className="finish-card-foot">
        {total > 0 ? (
          <span>
            <b className="finish-mono">{num(total)}</b> mm
          </span>
        ) : (
          <span>구조체면 · 별도 두께 없음</span>
        )}
        {sheet.thk[code] ? <span className="finish-flag">THK 조정됨</span> : null}
        {warnings ? <span className="finish-flag">상한 초과 {warnings}</span> : null}
        <button type="button" className="finish-small" onClick={() => ctx.openDetail(code)}>
          상세 · THK
        </button>
      </div>
    </article>
  );
}

/** Cards grouped by category band and finish (W3xx → W31xx), each band with its counts. */
function GroupedCards({
  ctx,
  codes,
  isOn,
  onPick,
  word,
  bulk,
  pickLabel,
}: {
  ctx: JigCtx;
  codes: string[];
  isOn: (code: string) => boolean;
  onPick: (code: string) => void;
  word: string;
  bulk?: (codes: string[], on: boolean) => void;
  pickLabel: string;
}) {
  const { lib } = ctx;
  const capped = codes.slice(0, CARD_CAP);
  const groups = new Map<string, { el: string; fam: number; fins: Map<number, string[]> }>();
  for (const code of capped) {
    const entry = lib.codes[code];
    const key = `${entry.el}|${entry.fam}`;
    if (!groups.has(key)) groups.set(key, { el: entry.el, fam: entry.fam, fins: new Map() });
    const group = groups.get(key)!;
    if (!group.fins.has(entry.fin_d)) group.fins.set(entry.fin_d, []);
    group.fins.get(entry.fin_d)!.push(code);
  }
  return (
    <div className="finish-groups">
      {[...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, group]) => {
          const fins = [...group.fins.entries()].sort(([a], [b]) => a - b);
          const all = fins.flatMap(([, list]) => list);
          const onCount = all.filter(isOn).length;
          return (
            <section key={key} className="finish-group">
              <h3 className="finish-band">
                <span className="finish-mono">
                  {group.el}
                  {group.fam}xx
                </span>
                <span>{familyName(lib, group.el, group.fam)}</span>
                <span className="finish-band-count">
                  <b>{onCount}</b> / {all.length} {word}
                  {bulk ? (
                    <button
                      type="button"
                      className="finish-small"
                      onClick={() => bulk(all, onCount !== all.length)}
                    >
                      {onCount === all.length ? '전체 해제' : '전체 채택'}
                    </button>
                  ) : null}
                </span>
              </h3>
              {fins.map(([fin, list]) => {
                const n = list.filter(isOn).length;
                return (
                  <div key={fin}>
                    <h4 className="finish-subband">
                      <span className="finish-mono">
                        {group.el}
                        {group.fam}
                        {fin}xx
                      </span>
                      <span>{finishName(lib, fin)}</span>
                      <span className="finish-band-count">
                        {n} / {list.length}
                        {bulk ? (
                          <button
                            type="button"
                            className="finish-small"
                            onClick={() => bulk(list, n !== list.length)}
                          >
                            {n === list.length ? '해제' : '모두 채택'}
                          </button>
                        ) : null}
                      </span>
                    </h4>
                    <div className="finish-grid">
                      {list.map((code) => (
                        <CodeCard
                          key={code}
                          ctx={ctx}
                          code={code}
                          on={isOn(code)}
                          onPick={onPick}
                          pickLabel={pickLabel}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      {codes.length > CARD_CAP ? (
        <p className="finish-note">
          조건에 맞는 <b>{codes.length}</b>개 중 <b>{CARD_CAP}</b>개만 표시했습니다. 필터를 좁히면
          나머지가 보입니다.
        </p>
      ) : null}
    </div>
  );
}

const DEFAULT_FILTER: FinishFilter = {
  el: 'W',
  fam: [],
  fin: [],
  tag: [],
  q: '',
  tmax: TMAX,
  show: 'all',
};
const flip = (list: string[] | undefined, value: string) =>
  (list ?? []).includes(value) ? (list ?? []).filter((v) => v !== value) : [...(list ?? []), value];

/** The filter rail (SPEC-11.3 2): search, shown, element, categories, finishes, tags, total. */
function Rail({
  ctx,
  filter,
  onChange,
  showChoice = true,
  fixedElement = false,
}: {
  ctx: JigCtx;
  filter: FinishFilter;
  onChange: (filter: FinishFilter) => void;
  showChoice?: boolean;
  fixedElement?: boolean;
}) {
  const { lib, sheet } = ctx;
  const context = { adopted: sheet.adopted, thk: sheet.thk };
  const group = (label: string, body: ReactNode, clear?: () => void) => (
    <div className="finish-fgroup" role="group" aria-label={label}>
      <div className="finish-flabel">
        <span>{label}</span>
        {clear ? (
          <button type="button" onClick={clear}>
            해제
          </button>
        ) : null}
      </div>
      {body}
    </div>
  );
  const families = lib.system.families[filter.el ?? ''] ?? {};
  return (
    <div className="finish-rail">
      {group(
        '검색',
        <input
          type="search"
          value={filter.q ?? ''}
          placeholder="코드·재료·구성"
          aria-label="마감 코드 검색"
          onChange={(event) => onChange({ ...filter, q: event.target.value })}
        />,
      )}
      {showChoice
        ? group(
            '표시',
            <div className="finish-chips">
              {(
                [
                  ['all', '전체'],
                  ['adopted', '채택'],
                  ['rest', '미채택'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="finish-chip"
                  aria-pressed={filter.show === value}
                  onClick={() => onChange({ ...filter, show: value })}
                >
                  {label}
                </button>
              ))}
            </div>,
          )
        : null}
      {fixedElement
        ? null
        : group(
            '부위',
            <div className="finish-chips">
              {lib.system.elements.map((element) => {
                const n = facetCount(lib, filter, 'el', element.k, context);
                return (
                  <button
                    key={element.k}
                    type="button"
                    className="finish-chip"
                    aria-pressed={filter.el === element.k}
                    disabled={!n && filter.el !== element.k}
                    onClick={() => onChange({ ...filter, el: element.k, fam: [] })}
                  >
                    {element.ko} <small>{n}</small>
                  </button>
                );
              })}
            </div>,
          )}
      {group(
        '카테고리 (바탕군)',
        <div className="finish-chips">
          {Object.entries(families).map(([key, name]) => {
            const n = facetCount(lib, filter, 'fam', key, context);
            if (!n) return null;
            return (
              <button
                key={key}
                type="button"
                className="finish-chip finish-chip-wide"
                aria-pressed={(filter.fam ?? []).includes(key)}
                onClick={() => onChange({ ...filter, fam: flip(filter.fam, key) })}
              >
                <span>
                  {filter.el}
                  {key}xx · {name}
                </span>
                <small>{n}</small>
              </button>
            );
          })}
        </div>,
        filter.fam?.length ? () => onChange({ ...filter, fam: [] }) : undefined,
      )}
      {group(
        '마감재',
        <div className="finish-chips">
          {lib.system.finishes.map((entry) => {
            const n = facetCount(lib, filter, 'fin', entry.k, context);
            if (!n) return null;
            return (
              <button
                key={entry.k}
                type="button"
                className="finish-chip"
                aria-pressed={(filter.fin ?? []).includes(entry.k)}
                onClick={() => onChange({ ...filter, fin: flip(filter.fin, entry.k) })}
              >
                {entry.k} {entry.ko} <small>{n}</small>
              </button>
            );
          })}
        </div>,
        filter.fin?.length ? () => onChange({ ...filter, fin: [] }) : undefined,
      )}
      {group(
        '속성 (모두 만족)',
        <div className="finish-chips">
          {lib.system.tags.map((entry) => {
            const n = facetCount(lib, filter, 'tag', entry.k, context);
            if (!n) return null;
            return (
              <button
                key={entry.k}
                type="button"
                className="finish-chip"
                title={entry.d}
                aria-pressed={(filter.tag ?? []).includes(entry.k)}
                onClick={() => onChange({ ...filter, tag: flip(filter.tag, entry.k) })}
              >
                {entry.k} <small>{n}</small>
              </button>
            );
          })}
        </div>,
        filter.tag?.length ? () => onChange({ ...filter, tag: [] }) : undefined,
      )}
      {group(
        '총두께',
        <label className="finish-range">
          <input
            type="range"
            min={0}
            max={TMAX}
            step={10}
            value={filter.tmax ?? TMAX}
            aria-label="총두께 상한"
            onChange={(event) => onChange({ ...filter, tmax: Number(event.target.value) })}
          />
          <span className="finish-mono">{num(filter.tmax ?? TMAX)} mm 이하</span>
        </label>,
        (filter.tmax ?? TMAX) < TMAX ? () => onChange({ ...filter, tmax: TMAX }) : undefined,
      )}
    </div>
  );
}

// ── 1. 라이브러리 · 마감 선정 ─────────────────────────────────────────────────────────────────
let keptFilter: FinishFilter = DEFAULT_FILTER;
function LibraryTab({ ctx }: { ctx: JigCtx }) {
  const { lib, sheet } = ctx;
  const [filter, setFilterState] = useState<FinishFilter>(keptFilter);
  const setFilter = (next: FinishFilter) => setFilterState((keptFilter = next));
  const list = searchCodes(lib, filter, { adopted: sheet.adopted, thk: sheet.thk });
  const count = (el: string) => sheet.adopted.filter((code) => code.startsWith(el)).length;
  const isOn = (code: string) => sheet.adopted.includes(code);
  return (
    <div className="finish-cols">
      <Rail ctx={ctx} filter={filter} onChange={setFilter} />
      <div className="finish-main">
        <div className="finish-sum">
          <span className="finish-big finish-mono">{sheet.adopted.length}</span>
          <span className="finish-faint">개 채택</span>
          <span className="finish-breakdown">
            바닥 <b>{count('F')}</b> · 벽 <b>{count('W')}</b> · 천장 <b>{count('C')}</b>
          </span>
          <span className="finish-spacer" />
          <span className="finish-faint">
            표시 <b>{list.length}</b> / 전체 {Object.keys(lib.codes).length}
          </span>
          <button
            type="button"
            onClick={() =>
              download(`마감라이브러리_${list.length}.csv`, libraryCsv(lib, list, sheet.thk))
            }
          >
            CSV
          </button>
        </div>
        {list.length ? (
          <GroupedCards
            ctx={ctx}
            codes={list}
            isOn={isOn}
            onPick={(code) => ctx.toggle([code], !isOn(code))}
            word="채택"
            bulk={ctx.toggle}
            pickLabel="채택"
          />
        ) : (
          <p className="finish-empty">조건에 맞는 코드가 없습니다. 필터를 줄여 보세요.</p>
        )}
        <p className="finish-note">
          카드를 누르면 이 프로젝트에 채택됩니다. [상세 · THK]에서 층별 두께를 바꾸면 단면 그림과
          출력에 바로 반영됩니다. 실에 배정한 코드는 채택을 해제할 수 없습니다.
        </p>
      </div>
    </div>
  );
}

/** 상세 · THK 조절 (SPEC-11.3 3~6): the section with a leader, the layer table, warnings. */
function Detail({ ctx, code, onClose }: { ctx: JigCtx; code: string; onClose: () => void }) {
  const { lib, sheet } = ctx;
  const [shown, setShown] = useState(code);
  useEffect(() => setShown(code), [code]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const entry = lib.codes[shown];
  if (!entry) return null;
  const layers = layersOf(lib, shown, sheet.thk);
  const total = totalOf(lib, shown, sheet.thk);
  const warnings = layers.filter((layer) => layer.over);
  const on = sheet.adopted.includes(shown);
  const setLayer = (index: number, value: number | null) =>
    ctx.setSheet({ ...sheet, thk: setThickness(lib, sheet.thk, shown, index, value) }, 400);
  const sources = layers.filter((layer) => layer.src || layer.note);
  return (
    <div
      className="finish-scrim"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="finish-modal" role="dialog" aria-label={`${shown} 상세`}>
        <div className="finish-modal-head">
          <strong className="finish-mono">{shown}</strong>
          <span className="finish-faint">
            {entry.nm} → {entry.fin || '노출'}
          </span>
          <span className="finish-spacer" />
          {sheet.thk[shown] ? (
            <button
              type="button"
              onClick={() => ctx.setSheet({ ...sheet, thk: resetThickness(sheet.thk, shown) })}
            >
              기본 두께로 복원
            </button>
          ) : null}
          <button
            type="button"
            className={on ? undefined : 'finish-primary'}
            disabled={on && ctx.used.has(shown)}
            title={on && ctx.used.has(shown) ? '실에 배정된 코드입니다' : undefined}
            onClick={() => ctx.toggle([shown], !on)}
          >
            {on ? '채택 해제' : '프로젝트에 채택'}
          </button>
          <button type="button" className="finish-x" aria-label="닫기" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="finish-modal-body">
          <div>
            {total > 3 ? (
              <Svg
                className="finish-secbox"
                markup={sectionOf(ctx, shown, { w: 640, leader: true })}
              />
            ) : (
              <p className="finish-secbox finish-note">
                구조체면에 직접 처리하는 구성이라 그릴 두께가 없습니다.
                <br />
                <b>{layers.map((layer) => layer.nm).join(' / ') || '—'}</b>
              </p>
            )}
            <table className="finish-layers">
              <thead>
                <tr>
                  <th>층 (바탕 → 마감)</th>
                  <th>THK</th>
                  <th>조절</th>
                  <th>권장 범위</th>
                </tr>
              </thead>
              <tbody>
                {layers.map((layer) => {
                  const max = Math.max(layer.hi, layer.hard ?? layer.hi);
                  return (
                    <tr key={layer.i} data-over={layer.over}>
                      <td>
                        <div>{layer.nm}</div>
                        <div className="finish-faint finish-xs">
                          {kindName(lib, layer.kind)}
                          {layer.src ? ` · ${layer.src}` : ''}
                        </div>
                      </td>
                      <td>
                        <input
                          type="number"
                          className="finish-thk finish-mono"
                          step={0.1}
                          min={0}
                          value={num(layer.t)}
                          disabled={layer.fixed}
                          aria-label={`${layer.nm} 두께`}
                          onChange={(event) =>
                            setLayer(
                              layer.i,
                              event.target.value === '' ? null : Number(event.target.value),
                            )
                          }
                        />
                      </td>
                      <td>
                        {layer.fixed ? (
                          <span className="finish-faint">고정</span>
                        ) : (
                          <input
                            type="range"
                            min={layer.lo}
                            max={max}
                            step={0.5}
                            value={Math.min(Math.max(layer.t, layer.lo), max)}
                            aria-label={`${layer.nm} 두께 조절`}
                            onChange={(event) => setLayer(layer.i, Number(event.target.value))}
                          />
                        )}
                      </td>
                      <td className="finish-mono finish-faint finish-xs">
                        {layer.fixed
                          ? '—'
                          : `${num(layer.lo)}~${num(layer.hi)}${layer.hard != null ? ` / 상한 ${num(layer.hard)}` : ''}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {warnings.map((layer) => (
              <div key={layer.i} className="finish-alt" role="note">
                <b>
                  ⚠ {layer.nm} {num(layer.t)}mm — 실무 상한 {num(layer.hard ?? 0)}mm 초과
                </b>
                <span>
                  {layer.alt ||
                    '일반적인 시공 범위를 벗어난 두께입니다. 구성을 나누는 방법을 검토하세요.'}
                </span>
              </div>
            ))}
          </div>
          <div className="finish-side">
            <div className="finish-panelbox">
              <div className="finish-flabel">구성 요약</div>
              <dl className="finish-kv">
                <dt>코드</dt>
                <dd className="finish-mono">{shown}</dd>
                <dt>부위</dt>
                <dd>{elementName(lib, entry.el)}</dd>
                <dt>카테고리</dt>
                <dd>{categoryText(lib, entry)}</dd>
                <dt>마감재</dt>
                <dd>
                  {entry.fin_d} {finishName(lib, entry.fin_d)}
                </dd>
                <dt>구성</dt>
                <dd>{entry.nm}</dd>
                <dt>마감</dt>
                <dd>{entry.fin || '—'}</dd>
                <dt>구조체</dt>
                <dd>{entry.struct || '—'}</dd>
                <dt>총두께</dt>
                <dd className="finish-mono">
                  <b>{num(total)}</b> mm
                </dd>
                <dt>속성</dt>
                <dd>{entry.tags.join(' · ') || '—'}</dd>
              </dl>
            </div>
            {entry.note ? (
              <div className="finish-panelbox">
                <div className="finish-flabel">설계 주의</div>
                <p className="finish-note">{entry.note}</p>
              </div>
            ) : null}
            {sources.length ? (
              <div className="finish-panelbox">
                <div className="finish-flabel">두께 근거</div>
                {sources.map((layer) => (
                  <div key={layer.i} className="finish-xs finish-faint">
                    <b>{layer.nm}</b> — {layer.src}
                    {layer.note ? <i> {layer.note}</i> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {entry.siblings.length ? (
              <div className="finish-panelbox">
                <div className="finish-flabel">같은 구성 · 다른 마감</div>
                <div className="finish-tags">
                  {entry.siblings.map((sibling) => (
                    <button
                      key={sibling}
                      type="button"
                      className="finish-tag finish-mono"
                      onClick={() => setShown(sibling)}
                    >
                      {sibling}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 2. 실별 배정 ────────────────────────────────────────────────────────────────────────────
function RoomsTab({ ctx }: { ctx: JigCtx }) {
  const { lib, rooms, sheet } = ctx;
  const [pick, setPick] = useState<{ roomId: string; element: RoomElement }>();
  const [paste, setPaste] = useState(false);
  const [message, setMessage] = useState('');
  const update = (id: string, change: Partial<FinishRoom>, delay = 0) =>
    ctx.setRooms(
      rooms.map((room) => (room.id === id ? { ...room, ...change } : room)),
      delay,
    );
  const add = () => {
    if (rooms.length >= FINISH_ROOMS_MAX)
      return setMessage(`실은 ${FINISH_ROOMS_MAX}개까지입니다.`);
    const last = rooms[rooms.length - 1];
    ctx.setRooms([
      ...rooms,
      { id: newId(), floor: last?.floor ?? '', no: '', name: '새 실', F: [], W: [], C: [] },
    ]);
  };
  let lastFloor = '';
  return (
    <div className="finish-rooms">
      <div className="finish-bar">
        <span className="finish-faint">
          <b>{rooms.length}</b>개 실 · 채택 <b>{sheet.adopted.length}</b>개 중 배정{' '}
          <b>{usedCodes(rooms).length}</b>개
        </span>
        <span className="finish-spacer" />
        <button type="button" onClick={add}>
          실 추가
        </button>
        <button type="button" onClick={() => setPaste(true)} aria-expanded={paste}>
          붙여넣기로 추가
        </button>
      </div>
      {message ? (
        <p className="finish-note" role="alert">
          {message}
        </p>
      ) : null}
      {paste ? (
        <PastePanel
          ctx={ctx}
          onClose={() => setPaste(false)}
          onAdd={(added) => {
            ctx.setRooms([...rooms, ...added]);
            setPaste(false);
            setMessage(`실 ${added.length}개를 추가했습니다.`);
          }}
        />
      ) : null}
      {!sheet.adopted.length ? (
        <p className="finish-empty">
          아직 채택한 마감이 없습니다. [+ 코드]에서 전체 라이브러리로 고르거나, 라이브러리 탭에서
          먼저 고르세요.
        </p>
      ) : null}
      <div className="finish-tablewrap">
        <table className="finish-room-table" aria-label="실별 배정">
          <thead>
            <tr>
              <th>층별</th>
              <th>실번호</th>
              <th>실명</th>
              <th>바닥 F</th>
              <th>벽 W</th>
              <th>천장 C</th>
              <th aria-label="삭제" />
            </tr>
          </thead>
          <tbody>
            {rooms.map((room) => {
              const newFloor = room.floor && room.floor !== lastFloor;
              if (room.floor) lastFloor = room.floor;
              const label = room.name || room.no || '실';
              return (
                <tr key={room.id} data-new-floor={Boolean(newFloor)}>
                  {(['floor', 'no', 'name'] as const).map((key) => (
                    <td key={key}>
                      <input
                        className="finish-cell-input"
                        value={room[key]}
                        maxLength={100}
                        aria-label={`${label} ${key === 'floor' ? '층별' : key === 'no' ? '실번호' : '실명'}`}
                        onChange={(event) => update(room.id, { [key]: event.target.value }, 600)}
                      />
                    </td>
                  ))}
                  {ROOM_ELEMENTS.map((element) => (
                    <td key={element}>
                      <div className="finish-slot">
                        {room[element].map((code) => {
                          const known = Boolean(lib.codes[code]);
                          return (
                            <span
                              key={code}
                              className="finish-pill"
                              data-off={!known}
                              title={
                                known
                                  ? `${lib.codes[code].nm} → ${lib.codes[code].fin || '노출'}`
                                  : '라이브러리에 없는 코드'
                              }
                            >
                              <button
                                type="button"
                                className="finish-mono"
                                onClick={() => known && ctx.openDetail(code)}
                              >
                                {code}
                              </button>
                              <button
                                type="button"
                                aria-label={`${label} ${elementName(lib, element)} ${code} 빼기`}
                                onClick={() =>
                                  update(room.id, {
                                    [element]: room[element].filter((c) => c !== code),
                                  })
                                }
                              >
                                ×
                              </button>
                            </span>
                          );
                        })}
                        <button
                          type="button"
                          className="finish-add"
                          aria-label={`${label} ${elementName(lib, element)} 코드 추가`}
                          onClick={() => setPick({ roomId: room.id, element })}
                        >
                          + 코드
                        </button>
                      </div>
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="finish-x"
                      aria-label={`${label} 실 삭제`}
                      onClick={() => ctx.setRooms(rooms.filter((r) => r.id !== room.id))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rooms.length ? (
          <p className="finish-empty">[실 추가]나 [붙여넣기로 추가]로 실을 넣으세요.</p>
        ) : null}
      </div>
      {pick ? (
        <Picker
          ctx={ctx}
          roomId={pick.roomId}
          element={pick.element}
          onClose={() => setPick(undefined)}
        />
      ) : null}
    </div>
  );
}

/** 코드 고르기 (SPEC-11.4 3): the element's adopted codes first, the whole library on request. */
function Picker({
  ctx,
  roomId,
  element,
  onClose,
}: {
  ctx: JigCtx;
  roomId: string;
  element: RoomElement;
  onClose: () => void;
}) {
  const { lib, rooms, sheet } = ctx;
  const [filter, setFilter] = useState<FinishFilter>({
    ...DEFAULT_FILTER,
    el: element,
    show: sheet.adopted.some((code) => code.startsWith(element)) ? 'adopted' : 'all',
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const cell = room[element];
  const list = searchCodes(lib, filter, { adopted: sheet.adopted, thk: sheet.thk });
  const toggleCode = (code: string) => {
    const has = cell.includes(code);
    if (!has && assignIssue(lib, element, code, cell)) return;
    ctx.setRooms(
      rooms.map((r) =>
        r.id === roomId
          ? { ...r, [element]: has ? cell.filter((c) => c !== code) : [...cell, code] }
          : r,
      ),
    );
  };
  const adoptedHere = sheet.adopted.filter((code) => code.startsWith(element)).length;
  return (
    <div
      className="finish-scrim"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="finish-modal" role="dialog" aria-label="마감 코드 선택">
        <div className="finish-modal-head">
          <strong>
            {room.name || '실'} · {elementName(lib, element)} 마감
          </strong>
          <span className="finish-faint">
            배정 <b>{cell.length}</b>개
          </span>
          <div className="finish-seg">
            <button
              type="button"
              aria-pressed={filter.show === 'adopted'}
              onClick={() => setFilter({ ...filter, show: 'adopted', fam: [], fin: [], tag: [] })}
            >
              채택 목록 ({adoptedHere})
            </button>
            <button
              type="button"
              aria-pressed={filter.show === 'all'}
              onClick={() => setFilter({ ...filter, show: 'all' })}
            >
              전체 라이브러리
            </button>
          </div>
          <input
            type="search"
            value={filter.q ?? ''}
            placeholder="검색"
            aria-label="코드 검색"
            onChange={(event) => setFilter({ ...filter, q: event.target.value })}
          />
          <span className="finish-spacer" />
          <span className="finish-faint">카드를 누르면 추가 / 해제</span>
          <button type="button" className="finish-primary" onClick={onClose}>
            완료
          </button>
        </div>
        <div className="finish-modal-body finish-modal-single">
          {list.length ? (
            <GroupedCards
              ctx={ctx}
              codes={list}
              isOn={(code) => cell.includes(code)}
              onPick={toggleCode}
              word="배정"
              pickLabel="배정"
            />
          ) : (
            <p className="finish-empty">
              {filter.show === 'adopted'
                ? `채택한 ${elementName(lib, element)} 마감이 없습니다. [전체 라이브러리]에서 고르면 자동으로 채택됩니다.`
                : '조건에 맞는 코드가 없습니다.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** 붙여넣기로 추가 (SPEC-11.4 4): parse, show what is left out, add on [추가]. */
function PastePanel({
  ctx,
  onClose,
  onAdd,
}: {
  ctx: JigCtx;
  onClose: () => void;
  onAdd: (rooms: FinishRoom[]) => void;
}) {
  const { lib, rooms } = ctx;
  const [text, setText] = useState('');
  const result: PasteResult | undefined = useMemo(
    () => (text.trim() ? parseRoomPaste(lib, text, newId) : undefined),
    [lib, text],
  );
  const over = result ? rooms.length + result.rooms.length > FINISH_ROOMS_MAX : false;
  return (
    <section className="finish-paste" aria-label="붙여넣기로 추가">
      <p className="finish-note">
        엑셀에서 <b>층별 · 실번호 · 실명 · 바닥 · 벽 · 천장</b> 순서의 열을 복사해 붙여 넣으세요. 한
        칸에 여러 코드는 공백이나 쉼표로 나눕니다. 머리글 줄은 건너뜁니다.
      </p>
      <textarea
        rows={6}
        value={text}
        aria-label="붙여넣을 표"
        placeholder={'1층\t101\t로비\tF0002\tW3101\tC0001'}
        onChange={(event) => setText(event.target.value)}
      />
      {result ? (
        <div className="finish-paste-result" role="status">
          <p>
            실 <b>{result.rooms.length}</b>개를 추가합니다
            {result.header ? ' (머리글 줄 건너뜀)' : ''}.
          </p>
          {result.skipped.length ? (
            <ul className="finish-skipped" aria-label="넣지 않는 코드">
              {result.skipped.map((skip, i) => (
                <li key={i}>
                  {skip.line}행 {elementName(lib, skip.element)}{' '}
                  <span className="finish-mono">{skip.code}</span> —{' '}
                  {ASSIGN_ISSUE_TEXT[skip.reason]}
                </li>
              ))}
            </ul>
          ) : null}
          {over ? <p role="alert">실은 {FINISH_ROOMS_MAX}개까지입니다.</p> : null}
        </div>
      ) : null}
      <div className="finish-bar">
        <button
          type="button"
          className="finish-primary"
          disabled={!result?.rooms.length || over}
          onClick={() => result && onAdd(result.rooms)}
        >
          추가
        </button>
        <button type="button" onClick={onClose}>
          취소
        </button>
      </div>
    </section>
  );
}

// ── 3. 납품 출력 ────────────────────────────────────────────────────────────────────────────
const TITLE_FIELDS: { key: keyof FinishTitle; label: string }[] = [
  { key: 'project', label: '공사명' },
  { key: 'drawingNo', label: '도면번호' },
  { key: 'date', label: '날짜' },
  { key: 'drawn', label: '작성' },
  { key: 'check', label: '검토' },
  { key: 'approved', label: '승인' },
];
let keptView: { sheet: 'rooms' | 'codes'; unused: 'hide' | 'ghost' } = {
  sheet: 'rooms',
  unused: 'hide',
};
function OutputTab({ ctx }: { ctx: JigCtx }) {
  const { lib, rooms, sheet } = ctx;
  const [view, setViewState] = useState(keptView);
  const setView = (next: typeof view) => setViewState((keptView = next));
  const [notesText, setNotesText] = useState(sheet.notes.join('\n'));
  const sheetRef = useRef<HTMLDivElement>(null);
  const setTitle = (key: keyof FinishTitle, value: string) =>
    ctx.setSheet({ ...sheet, title: { ...sheet.title, [key]: value } }, 600);
  const title = view.sheet === 'rooms' ? '실내재료마감표' : '마감 일람표';
  const csv = () =>
    view.sheet === 'rooms'
      ? download('실마감표.csv', roomScheduleCsv(lib, rooms, sheet.thk))
      : download('마감일람표.csv', codeScheduleCsv(lib, rooms, sheet, view.unused));
  return (
    <div className="finish-out">
      <div className="finish-opts">
        <div className="finish-opt">
          <div className="finish-flabel">표</div>
          <div className="finish-seg">
            <button
              type="button"
              aria-pressed={view.sheet === 'rooms'}
              onClick={() => setView({ ...view, sheet: 'rooms' })}
            >
              실 마감표
            </button>
            <button
              type="button"
              aria-pressed={view.sheet === 'codes'}
              onClick={() => setView({ ...view, sheet: 'codes' })}
            >
              마감 일람표
            </button>
          </div>
        </div>
        {view.sheet === 'codes' ? (
          <div className="finish-opt">
            <div className="finish-flabel">채택했으나 미배정인 코드</div>
            <div className="finish-seg">
              <button
                type="button"
                aria-pressed={view.unused === 'hide'}
                onClick={() => setView({ ...view, unused: 'hide' })}
              >
                제외
              </button>
              <button
                type="button"
                aria-pressed={view.unused === 'ghost'}
                onClick={() => setView({ ...view, unused: 'ghost' })}
              >
                흐리게 표시
              </button>
            </div>
          </div>
        ) : null}
        <div className="finish-opt">
          <div className="finish-flabel">출력</div>
          <div className="finish-bar">
            <button
              type="button"
              className="finish-primary"
              onClick={() => printNode(sheetRef.current)}
            >
              인쇄
            </button>
            <button type="button" onClick={csv}>
              CSV
            </button>
          </div>
        </div>
        <p className="finish-note finish-opt-wide">
          인쇄 창에서 A3 · 가로 · 배경 그래픽 켜기를 고르세요. 두께를 조절한 코드는 조절값으로
          나옵니다.
        </p>
      </div>
      <fieldset className="finish-titleform">
        <legend>표제와 일반사항</legend>
        {TITLE_FIELDS.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <input
              value={sheet.title[field.key]}
              maxLength={100}
              onChange={(event) => setTitle(field.key, event.target.value)}
            />
          </label>
        ))}
        <label className="finish-titleform-notes">
          <span>프로젝트 일반사항 (한 줄에 하나)</span>
          <textarea
            rows={3}
            value={notesText}
            onChange={(event) => {
              setNotesText(event.target.value);
              const notes = event.target.value
                .split('\n')
                .map((line) => line.trim().slice(0, 500))
                .filter(Boolean)
                .slice(0, 50);
              ctx.setSheet({ ...sheet, notes }, 600);
            }}
          />
        </label>
      </fieldset>
      <div className="finish-sheet-scroll">
        <div className="finish-sheet" ref={sheetRef} aria-label={title}>
          <div className="finish-sheet-main">
            <div className="finish-sheet-title">
              <b>{title}</b>
              <span>표준 마감코드 체계 v{lib.version}</span>
            </div>
            {view.sheet === 'rooms' ? (
              <RoomSheet ctx={ctx} />
            ) : (
              <CodeSheet ctx={ctx} unused={view.unused} />
            )}
          </div>
          <div className="finish-sheet-side">
            <div className="finish-sheet-note">
              <b>NOTE</b>
              <ol>
                {[...lib.notes.standard, ...sheet.notes].map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ol>
            </div>
            <table className="finish-sheet-tb" aria-label="표제">
              <tbody>
                <tr>
                  <th>PROJECT</th>
                  <td>{sheet.title.project}</td>
                </tr>
                <tr>
                  <th>DRAWING</th>
                  <td>{title}</td>
                </tr>
                <tr>
                  <th>DRAWN BY</th>
                  <td>{sheet.title.drawn}</td>
                </tr>
                <tr>
                  <th>CHECK BY</th>
                  <td>{sheet.title.check}</td>
                </tr>
                <tr>
                  <th>APPROVED</th>
                  <td>{sheet.title.approved}</td>
                </tr>
                <tr>
                  <th>DATE</th>
                  <td>{sheet.title.date}</td>
                </tr>
                <tr>
                  <th>DWG NO.</th>
                  <td>{sheet.title.drawingNo}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
function RoomSheet({ ctx }: { ctx: JigCtx }) {
  const { lib, rooms, sheet } = ctx;
  const rows = roomScheduleRows(lib, rooms, sheet.thk);
  return (
    <table className="finish-sheet-table" aria-label="실 마감표">
      <thead>
        <tr>
          <th rowSpan={2}>층별</th>
          <th rowSpan={2}>실번호</th>
          <th rowSpan={2}>실명</th>
          <th colSpan={4}>바 닥</th>
          <th colSpan={4}>벽</th>
          <th colSpan={4}>천 장</th>
        </tr>
        <tr>
          {ROOM_ELEMENTS.flatMap((element) =>
            ['바탕', '마감', 'THK', '코드'].map((label) => <th key={element + label}>{label}</th>),
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.roomId}-${row.line}`}>
            {row.line === 0 ? (
              <>
                <td rowSpan={row.lines} className="finish-c">
                  {row.floor}
                </td>
                <td rowSpan={row.lines} className="finish-c">
                  {row.no}
                </td>
                <td rowSpan={row.lines}>{row.name}</td>
              </>
            ) : null}
            {ROOM_ELEMENTS.flatMap((element) => {
              const cell = row.cells[element];
              return cell
                ? [
                    <td key={element + 'b'}>{cell.base}</td>,
                    <td key={element + 'f'}>{cell.finish}</td>,
                    <td key={element + 't'} className="finish-c finish-mono">
                      {cell.thk}
                    </td>,
                    <td key={element + 'c'} className="finish-c finish-mono">
                      {cell.code}
                    </td>,
                  ]
                : [0, 1, 2, 3].map((i) => <td key={element + i} />);
            })}
          </tr>
        ))}
        {!rows.length ? (
          <tr>
            <td colSpan={15} className="finish-c">
              실이 없습니다.
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
function CodeSheet({ ctx, unused }: { ctx: JigCtx; unused: 'hide' | 'ghost' }) {
  const { lib, rooms, sheet } = ctx;
  const rows = codeScheduleRows(lib, rooms, sheet, unused);
  let el = '';
  return (
    <table className="finish-sheet-table" aria-label="마감 일람표">
      <thead>
        <tr>
          <th>코드</th>
          <th>부위</th>
          <th>카테고리</th>
          <th>구성 (바탕 → 마감)</th>
          <th>마감</th>
          <th>THK</th>
          <th>속성</th>
          <th>적용 실</th>
        </tr>
      </thead>
      <tbody>
        {rows.flatMap((row) => {
          const out = [];
          if (row.el !== el) {
            el = row.el;
            out.push(
              <tr key={`g-${row.el}`} className="finish-sheet-group">
                <td colSpan={8}>
                  {row.element} {row.el}xxxx
                </td>
              </tr>,
            );
          }
          out.push(
            <tr key={row.code} data-unused={row.unused}>
              <td className="finish-c finish-mono">{row.code}</td>
              <td className="finish-c">{row.element}</td>
              <td>{row.category}</td>
              <td>{row.assembly}</td>
              <td>{row.finish}</td>
              <td className="finish-c finish-mono">{row.thk}</td>
              <td>{row.tags}</td>
              <td>{roomsText(row.rooms, row.unused)}</td>
            </tr>,
          );
          return out;
        })}
        {!rows.length ? (
          <tr>
            <td colSpan={8} className="finish-c">
              배정한 코드가 없습니다.
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

// ── 4. 체계 · 기준 ──────────────────────────────────────────────────────────────────────────
function SystemTab({ lib }: { lib: FinishLibrary }) {
  const codes = Object.values(lib.codes);
  return (
    <div className="finish-sys">
      <section>
        <h3>코드 구조</h3>
        <div className="finish-panelbox">
          <div className="finish-mono finish-scheme">W 3 1 01</div>
          <dl className="finish-kv">
            <dt className="finish-mono">W</dt>
            <dd>
              부위 —{' '}
              {lib.system.elements.map((element) => `${element.k} ${element.ko}`).join(' · ')}
            </dd>
            <dt className="finish-mono">3</dt>
            <dd>카테고리(바탕군) — 무엇에 대고 마감하는가</dd>
            <dt className="finish-mono">1</dt>
            <dd>
              마감재 — {lib.system.finishes.map((entry) => `${entry.k} ${entry.ko}`).join(' · ')}
            </dd>
            <dt className="finish-mono">01</dt>
            <dd>순번 — 해당 대역 안에서 01~99</dd>
          </dl>
        </div>
      </section>
      <section>
        <h3>카테고리 대역</h3>
        <div className="finish-sys-grid">
          {lib.system.elements.map((element) => (
            <div key={element.k} className="finish-panelbox">
              <div className="finish-sys-head">
                <b>
                  {element.ko} {element.k}
                </b>
                <span className="finish-faint finish-xs">
                  {element.scope === '내부' ? '내부' : '외부 (대역 예약)'}
                </span>
              </div>
              <dl className="finish-kv">
                {Object.entries(lib.system.families[element.k] ?? {}).map(([key, name]) => {
                  const n = codes.filter(
                    (code) => code.el === element.k && String(code.fam) === key,
                  ).length;
                  return [
                    <dt key={`t${key}`} className="finish-mono">
                      {element.k}
                      {key}xx
                    </dt>,
                    <dd key={`d${key}`}>
                      {name} <span className="finish-faint">{n || '—'}</span>
                    </dd>,
                  ];
                })}
              </dl>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3>재료 해치 범례</h3>
        <div className="finish-hatches">
          {lib.system.kinds.map((kind) => (
            <div key={kind.k} className="finish-panelbox">
              <div className="finish-xs">{kind.ko}</div>
              <Svg
                className="finish-secbox"
                markup={sectionSvg([{ nm: kind.ko, kind: kind.k, t: 100 }], {
                  w: 96,
                  band: 24,
                  axis: 'x',
                })}
              />
            </div>
          ))}
        </div>
      </section>
      {lib.ref.map((table) => (
        <section key={table.t}>
          <div className="finish-sys-head">
            <h3>{table.t}</h3>
            <span className="finish-faint finish-xs">{table.src}</span>
          </div>
          <div className="finish-tablewrap">
            <table className="finish-ref">
              <thead>
                <tr>
                  {table.cols.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((value, j) => (
                      <td key={j} className={j ? 'finish-mono' : undefined}>
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table.note ? <p className="finish-note">{table.note}</p> : null}
        </section>
      ))}
      <section>
        <h3>일반사항 NOTE — 표준 조항</h3>
        <ol className="finish-note finish-sys-notes">
          {lib.notes.standard.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ol>
        <p className="finish-note">프로젝트 조항은 납품 출력 탭에서 적습니다.</p>
      </section>
    </div>
  );
}
