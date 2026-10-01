// The 만들기 workspace tab (PLAN-22 T-063, SPEC-07.16, Design SCR-16): making a jig by conversation.
// Left: the draft outline read from its manifest (단계 · 설정값 · 화면 · 시험) and its file names.
// Centre: 화면 미리보기 (the draft's panel.json drawn with the official parts on the outputs the
// engine computed in the compute box on a fixture), 흐름 (the steps with their states) and 설명서
// (skill.md, read-only). Bottom: the 점검·시험 console. Right: the authoring conversation is the
// app's conversation column (chips, work view, question cards); this screen adds the plan card,
// the progress line and the two decisions, [버리기] and [이 프로젝트의 jig로 고정] (확인 필요).
// Nothing here writes to a host: a preview draws lines on this screen only. The JIG list's
// '말로 만들기' card, the draft list and [가져오기] (.vjig) are exported from here too.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import {
  BAND_ORDER,
  BAND_SYMBOL,
  BAND_TEXT,
  bandCounts,
  bandsOf,
  cellText,
  columnsOf,
  fieldOf,
  formatNumber,
  layerItems,
  resolve,
  rowsOf,
  toDisplay,
  type Band,
  type PanelData,
  type PanelSetting,
} from './jig-panel/bindings.ts';
import { scopeOf, validatePanel, type PanelIssue } from './jig-panel/spec.ts';
import { BakeCard, type BakePlan } from './kit/cards.tsx';
import type { PartOf, PartUse } from './kit/registry.ts';
import { FactBadge, SettingGroup, SettingRow, SliderBoard } from './kit/settings.tsx';
import { KpiStrip, StepRail, VerdictLegend, type RailState, type RailStep } from './kit/status.tsx';
import { DataTable, ResultTabs } from './kit/tables.tsx';
import { PlanMap } from './kit/views.tsx';
import {
  createDraft,
  deleteDraft,
  getDraft,
  importJig,
  listDrafts,
  makeConversation,
  pinDraft,
  previewDraft,
  setDraftIcon,
  testDraft,
  validateDraft,
  type DraftDetail,
  type DraftManifest,
  type DraftStart,
  type DraftStepReport,
  type DraftSummary,
  type PreviewResult,
} from './make-api.ts';
import { JIG_ICONS, JIG_ICON_LABELS, JigIconMark, jigIcon, noteJigIcon } from './jig-icons.ts';
import { openDrafts } from './jig-list.ts';
import { openContextTab, setWorkspace } from './workspaces.ts';
import './make.css';

type Value = number | string | boolean;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
const clock = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';
const seconds = (ms?: number | null) =>
  ms === undefined || ms === null
    ? ''
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(1)} s`;

// --- The draft shown in the tab, per project (a viewer convenience in this browser). ---

const draftKey = (projectId: string) => `vide:make-draft:${projectId}`;
function rememberedDraft(projectId: string) {
  try {
    return localStorage.getItem(draftKey(projectId)) ?? undefined;
  } catch {
    return undefined;
  }
}
function rememberDraft(projectId: string, draftId: string | undefined) {
  try {
    if (draftId) localStorage.setItem(draftKey(projectId), draftId);
    else localStorage.removeItem(draftKey(projectId));
  } catch {
    /* The tab still opens; it just starts from the draft list. */
  }
}

// --- Outline helpers (pure) ---

const BY_KIND: Record<string, string> = {
  code: '계산',
  library: '라이브러리',
  host: '호스트',
  ai: 'AI',
  human: '사람',
};
const RAIL_OF: Record<string, RailState> = {
  done: 'done',
  failed: 'failed',
  'gate-failed': 'failed',
  waiting: 'waiting',
  confirmed: 'confirmed',
  reconfirm: 'reconfirm',
  blocked: 'blocked',
  running: 'running',
  pending: 'pending',
};
/** The steps of the manifest with the states of the latest run (a test case or the preview). */
export function railOf(
  manifest: DraftManifest,
  reports: readonly DraftStepReport[] = [],
): RailStep[] {
  return manifest.steps.map((step) => {
    const report = reports.find((r) => r.id === step.id);
    const failedGates = (report?.gates ?? []).filter((g) => !g.ok && !g.verdict);
    return {
      id: step.id,
      title: step.title || step.id,
      by: BY_KIND[step.kind] ?? step.kind,
      state: report ? (RAIL_OF[report.status] ?? 'pending') : 'pending',
      ms: report?.ms ?? null,
      problems: failedGates.length || undefined,
      reason:
        report?.error?.message ?? (failedGates.map((g) => g.message).join(' · ') || undefined),
    };
  });
}
/** Settings as the kit draws them, from `jig.json` params and the values a preview ran with. */
export function settingsOf(
  manifest: DraftManifest,
  values: Readonly<Record<string, Value>> = {},
): PanelSetting[] {
  return manifest.params.map((param) => {
    const setting: PanelSetting = {
      key: param.key,
      title: param.title || param.key,
      group: param.group,
      type: param.type,
      unit: param.unit ?? '',
      displayUnit: param.display?.unit ?? param.unit ?? '',
      ...(param.display ? { decimals: param.display.decimals } : {}),
      value: values[param.key] ?? param.default ?? 0,
      displayValue: 0,
      by: 'default',
      at: '',
      ...(param.range ? { range: param.range } : {}),
      ...(param.choices ? { choices: param.choices } : {}),
      ...(param.board ? { board: true } : {}),
      ...(param.fixedAtPin ? { fixedAtPin: true } : {}),
      ...(param.basis ? { basis: param.basis } : {}),
      ...(param.help ? { help: param.help } : {}),
    };
    setting.displayValue =
      typeof setting.value === 'number' ? toDisplay(setting, setting.value) : setting.value;
    return setting;
  });
}
const PHASES = ['계획', '질문', '작성', '시험', '미리보기', '고정'] as const;
type Phase = (typeof PHASES)[number];
/** Where the authoring stands, from what the engine reports about the draft. */
export function phaseOf(detail: DraftDetail): Phase {
  if (detail.preview) return '미리보기';
  if (detail.test || detail.validate) return '시험';
  if (detail.files.some((file) => file.path.startsWith('steps/'))) return '작성';
  return '계획';
}
/** Why [이 프로젝트의 jig로 고정] cannot be pressed yet (undefined: it can). */
export function pinBlocked(detail: DraftDetail): string | undefined {
  if (!detail.validate) return '점검을 먼저 해야 합니다';
  if (!detail.validate.ok)
    return `점검 오류 ${detail.validate.issues.filter((i) => i.level === 'error').length}건이 남았습니다`;
  if (!detail.test) return '시험을 먼저 해야 합니다';
  const failed = detail.test.cases.filter((c) => !c.ok).length;
  if (!detail.test.ok)
    return failed ? `시험 ${failed}건이 통과하지 않았습니다` : '시험이 통과하지 않았습니다';
  if (detail.files.some((file) => file.changed))
    return '점검 뒤 파일이 바뀌었습니다. 점검·시험을 다시 하세요';
  return undefined;
}
/** The plan card: the engine's plan when it keeps one, otherwise what the draft already has. */
export function planOf(detail: DraftDetail) {
  if (detail.plan?.length) return detail.plan;
  const m = detail.manifest;
  const has = (path: string) => detail.files.some((file) => file.path === path);
  const items = [
    { title: `입력 ${m.inputs.length}개`, done: m.inputs.length > 0 },
    { title: `설정값 ${m.params.length}개`, done: m.params.length > 0 },
    { title: `단계 ${m.steps.length}개`, done: m.steps.length > 0 },
    { title: '화면 (panel.json)', done: has('panel.json') },
    {
      title: '시험 자료',
      done: detail.files.some((file) => file.path.startsWith('fixtures/')),
    },
    { title: '결과 확인 (시험 통과)', done: !!detail.test?.ok },
  ];
  const current = items.findIndex((item) => !item.done);
  return items.map((item, i) => ({ ...item, current: i === current }));
}

// --- Mounting ---

let root: Root | undefined;
let shownFor: string | undefined;
let wanted: string | undefined;
const listeners = new Set<(draftId: string | undefined) => void>();

/** Show the 만들기 tab of a project (mounts once, like the report tab). */
export function showMake(projectId: string) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root) {
    const host = document.createElement('section');
    host.className = 'make-workspace';
    host.setAttribute('aria-label', '만들기');
    workspace.append(host);
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<MakeTab key={projectId} projectId={projectId} />);
  }
  window.dispatchEvent(new Event('vide:make-shown'));
}
/** Open a draft in the 만들기 tab (from the JIG list or after creating one). */
export function openDraft(projectId: string, draftId: string) {
  wanted = draftId;
  rememberDraft(projectId, draftId);
  for (const listener of listeners) listener(draftId);
  setWorkspace('make');
  showMake(projectId);
}

/**
 * Choose the authoring conversation in the right column. The app's chips own the choice; this asks
 * through an event (the app may listen) and, while the chip is listed, presses it.
 */
function chooseConversation(id: string) {
  window.dispatchEvent(new CustomEvent('vide:select-conversation', { detail: { id } }));
  let tries = 0;
  const press = () => {
    const chips = document.getElementById('conversation-chips');
    const chip = chips?.querySelector<HTMLButtonElement>(`[data-conversation="${CSS.escape(id)}"]`);
    if (chip) {
      if (chip.getAttribute('aria-selected') !== 'true') chip.click();
      return;
    }
    const more = chips?.querySelector<HTMLSelectElement>('select.conv-more');
    if (more && [...more.options].some((option) => option.value === id)) {
      more.value = id;
      more.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (++tries < 6) setTimeout(press, 500);
  };
  press();
}

// --- The tab ---

function MakeTab({ projectId }: { projectId: string }) {
  const [drafts, setDrafts] = useState<DraftSummary[]>();
  const [draftId, setDraftId] = useState<string | undefined>(
    () => wanted ?? rememberedDraft(projectId),
  );
  const [detail, setDetail] = useState<DraftDetail>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'validate' | 'test' | 'preview' | 'pin' | 'delete' | 'icon'>();
  const [picking, setPicking] = useState(false);
  const [asking, setAsking] = useState<'pin' | 'delete'>();
  const [center, setCenter] = useState<'screen' | 'flow' | 'skill'>('screen');
  const [fixture, setFixture] = useState<string>();
  const [side, setSide] = useState<HTMLElement>();
  const conversationFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    const listener = (id: string | undefined) => setDraftId(id);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  const readList = useCallback(() => {
    listDrafts(projectId)
      .then(setDrafts)
      .catch((error) => {
        setDrafts([]);
        setNotice(messageOf(error));
      });
  }, [projectId]);
  useEffect(readList, [readList]);

  const read = useCallback(
    (id: string) =>
      getDraft(projectId, id)
        .then((value) => {
          setDetail(value);
          return value;
        })
        .catch((error) => {
          setNotice(messageOf(error));
          return undefined;
        }),
    [projectId],
  );
  // The AI writes the draft's files during its turns: read again while the tab shows.
  useEffect(() => {
    setDetail(undefined);
    setNotice('');
    if (!draftId) return;
    let live = true;
    void read(draftId).then((value) => {
      if (!live) return;
      if (!value) {
        rememberDraft(projectId, undefined);
        setDraftId(undefined);
      }
    });
    const timer = setInterval(() => {
      if (document.body.dataset.workspace === 'make' && !document.hidden) void read(draftId);
    }, 5000);
    const again = () => void read(draftId);
    window.addEventListener('vide:make-shown', again);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('vide:make-shown', again);
    };
  }, [draftId, projectId, read]);
  // The make conversation's chip draws the draft's icon (T-100).
  useEffect(() => {
    if (detail) noteJigIcon(`draft:${detail.draft.id}`, detail.manifest.icon);
  }, [detail]);
  // The authoring conversation goes to the right column when a draft opens.
  useEffect(() => {
    if (!detail || conversationFor.current === detail.draft.id) return;
    conversationFor.current = detail.draft.id;
    const known = detail.conversationId;
    (known ? Promise.resolve(known) : makeConversation(projectId, detail.draft))
      .then(chooseConversation)
      .catch((error) => setNotice(`제작 대화를 열지 못했습니다: ${messageOf(error)}`));
  }, [detail, projectId]);
  // The plan card and the decisions sit in the right column, under the conversation chips.
  useEffect(() => {
    const chips = document.getElementById('conversation-chips');
    if (!chips) return;
    const element = document.createElement('section');
    element.className = 'make-side';
    element.setAttribute('aria-label', '제작 진행');
    chips.after(element);
    setSide(element);
    return () => element.remove();
  }, []);

  const act = async <T,>(kind: NonNullable<typeof busy>, work: () => Promise<T>) => {
    setBusy(kind);
    setNotice('');
    try {
      return await work();
    } catch (error) {
      setNotice(messageOf(error));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };
  const id = detail?.draft.id;
  const runValidate = () =>
    id &&
    void act('validate', async () => {
      const validate = await validateDraft(projectId, id);
      setDetail((d) => (d ? { ...d, validate } : d));
      void read(id);
    });
  const runTest = () =>
    id &&
    void act('test', async () => {
      const test = await testDraft(projectId, id);
      setDetail((d) => (d ? { ...d, test } : d));
      void read(id);
    });
  const runPreview = (params?: Record<string, Value>, chosen = fixture) =>
    id &&
    void act('preview', async () => {
      const preview = await previewDraft(projectId, id, {
        ...(chosen ? { fixture: chosen } : {}),
        ...(params ? { params } : {}),
      });
      setDetail((d) => (d ? { ...d, preview } : d));
    });
  const pin = () =>
    id &&
    void act('pin', async () => {
      const result = await pinDraft(projectId, id);
      setAsking(undefined);
      readList();
      if (result.instanceId)
        openContextTab({
          instanceId: result.instanceId,
          label: detail?.manifest.name ?? detail?.draft.name ?? 'jig',
        });
      else setWorkspace('jig');
    });
  const discard = () =>
    id &&
    void act('delete', async () => {
      await deleteDraft(projectId, id);
      setAsking(undefined);
      rememberDraft(projectId, undefined);
      conversationFor.current = undefined;
      setDraftId(undefined);
      readList();
    });
  // The draft's icon goes into its jig.json; the list shows it once the draft is pinned (T-100).
  const chooseIcon = (icon: string) =>
    id &&
    void act('icon', async () => {
      await setDraftIcon(projectId, id, icon);
      setPicking(false);
      await read(id);
    });
  const choose = (next: string | undefined) => {
    rememberDraft(projectId, next);
    setDraftId(next);
  };

  if (!draftId || (!detail && !notice))
    return (
      <div className="make-start">
        <button type="button" className="link-button make-back" onClick={() => setWorkspace('jig')}>
          JIG 목록
        </button>
        {draftId ? (
          <p className="kit-muted" role="status">
            초안을 여는 중…
          </p>
        ) : (
          <>
            <MakeCard
              projectId={projectId}
              onCreated={(draft) => {
                readList();
                choose(draft.id);
              }}
            />
            <DraftList projectId={projectId} drafts={drafts} onOpen={choose} />
            {notice ? <p role="alert">{notice}</p> : null}
          </>
        )}
      </div>
    );
  if (!detail)
    return (
      <div className="make-start">
        <p role="alert">{notice}</p>
        <button type="button" onClick={() => choose(undefined)}>
          초안 목록으로
        </button>
      </div>
    );

  const m = detail.manifest;
  const name = m.name || detail.draft.name;
  const block = pinBlocked(detail);
  const phase = phaseOf(detail);
  const plan = planOf(detail);
  const lastSteps = detail.preview?.steps.length
    ? detail.preview.steps
    : (detail.test?.cases[0]?.steps ?? []);
  const validateErrors = detail.validate?.issues.filter((i) => i.level === 'error') ?? [];
  const passed = detail.test?.cases.filter((c) => c.ok).length ?? 0;
  const cases = detail.test?.cases.length ?? 0;
  const panelIssues = detail.preview ? validatePanel(detail.preview.panel, scopeOf(m)).issues : [];
  const parts = detail.preview ? partNames(detail.preview.panel) : [];

  const sidePanel = side
    ? createPortal(
        <div className="make-side-body">
          <div className="make-head">
            <strong>제작 대화 · {name}</strong>
            {detail.turns !== undefined ? (
              <small data-over={String(detail.turns >= 20)}>턴 {detail.turns}/20</small>
            ) : null}
          </div>
          <ol className="make-phases" aria-label="진행">
            {PHASES.map((p) => (
              <li key={p} aria-current={p === phase ? 'step' : undefined}>
                {p}
              </li>
            ))}
          </ol>
          <section className="make-plan" aria-label="계획">
            <div className="make-head">
              <strong>계획</strong>
              <small>
                {plan.filter((item) => item.done).length}/{plan.length} 완료
              </small>
            </div>
            <ul>
              {plan.map((item, i) => (
                <li key={i} data-done={String(item.done)} aria-current={item.current || undefined}>
                  <span aria-hidden="true">{item.done ? '✓' : '○'}</span> {item.title}
                </li>
              ))}
            </ul>
            <small className="kit-muted">
              계획과 질문은 아래 대화에서 주고받습니다. 질문 카드에 답하면 AI가 이어서 씁니다.
            </small>
          </section>
          <div className="make-decide">
            <small className="kit-muted">
              파일 {detail.files.length}개 · 시험 {cases ? `${passed}/${cases}` : '전'}
            </small>
            <div className="kit-actions">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => setAsking('delete')}
                data-action="discard"
              >
                버리기
              </button>
              <button
                type="button"
                className="primary"
                disabled={!!busy || !!block}
                onClick={() => setAsking('pin')}
                data-action="pin"
              >
                이 프로젝트의 jig로 고정
              </button>
            </div>
            {block ? <small className="kit-reason">{block}</small> : null}
            {asking === 'pin' ? (
              <div className="kit-confirm" role="group" aria-label="고정 확인">
                <strong>
                  {name} {m.version ? `v${m.version}` : ''}을 이 프로젝트의 jig로 고정합니다
                </strong>
                <span>어디에: 이 프로젝트의 JIG 목록 · AI가 쓴 초안(계산 상자에서 실행)</span>
                <span>영향: 점검을 다시 확인한 뒤 고정합니다. 고정한 버전은 바뀌지 않습니다.</span>
                <div className="kit-actions">
                  <button type="button" className="primary" disabled={!!busy} onClick={pin}>
                    고정
                  </button>
                  <button type="button" onClick={() => setAsking(undefined)}>
                    취소
                  </button>
                </div>
              </div>
            ) : null}
            {asking === 'delete' ? (
              <div className="kit-confirm" role="group" aria-label="버리기 확인">
                <strong>초안 ‘{name}’을 버립니다</strong>
                <span>초안 폴더의 파일과 이 초안의 제작 대화 기록을 함께 지웁니다.</span>
                <span>되돌릴 수 없습니다.</span>
                <div className="kit-actions">
                  <button type="button" className="danger" disabled={!!busy} onClick={discard}>
                    버리기
                  </button>
                  <button type="button" onClick={() => setAsking(undefined)}>
                    취소
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>,
        side,
      )
    : null;

  return (
    <>
      <aside className="make-outline" aria-label="도구 설명 개요">
        {/* 만들기 belongs to JIG (T-099): the way back to the list where it started. */}
        <button type="button" className="link-button make-back" onClick={() => setWorkspace('jig')}>
          JIG 목록
        </button>
        <div className="make-head">
          <small className="make-tag">
            새 도구 · 초안{m.version ? ` v${m.version}` : ''} · 내 것
          </small>
          <select
            aria-label="초안"
            value={detail.draft.id}
            onChange={(event) => choose(event.target.value || undefined)}
          >
            {(drafts ?? [detail.draft]).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            <option value="">새 초안…</option>
          </select>
        </div>
        <h3 className="make-title">
          <JigIconMark icon={m.icon} />
          {name}
        </h3>
        <button
          type="button"
          className="link-button make-icon-toggle"
          aria-expanded={picking}
          onClick={() => setPicking((open) => !open)}
        >
          아이콘 바꾸기
        </button>
        {picking ? (
          <div className="make-icons" role="group" aria-label="아이콘">
            {JIG_ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                title={JIG_ICON_LABELS[icon]}
                aria-label={`${JIG_ICON_LABELS[icon]} 아이콘`}
                aria-pressed={jigIcon(m.icon) === icon}
                disabled={!!busy}
                onClick={() => chooseIcon(icon)}
              >
                <JigIconMark icon={icon} />
              </button>
            ))}
            <small className="kit-muted">아이콘은 고정할 때 jig에 함께 들어갑니다.</small>
          </div>
        ) : null}
        {m.summary ? <p className="make-summary">{m.summary}</p> : null}
        {m.inputs.length ? (
          <p className="kit-muted">입력: {m.inputs.map((i) => i.title || i.key).join(', ')}</p>
        ) : null}
        <Outline title="단계" count={m.steps.length}>
          {railOf(m, lastSteps).map((step, i) => (
            <li key={step.id} data-state={step.state}>
              <span>
                {i + 1}. {step.title}
              </span>
              <small>
                {step.by} · {STATE_TEXT[step.state]}
              </small>
            </li>
          ))}
        </Outline>
        <Outline title="설정값" count={m.params.length}>
          {settingsOf(m, detail.preview?.params).map((s) => (
            <li key={s.key}>
              <span>{s.title}</span>
              <small>
                {typeof s.displayValue === 'number'
                  ? formatNumber(s.displayValue, s.decimals)
                  : String(s.displayValue)}{' '}
                {s.displayUnit} <FactBadge setting={s} />
              </small>
            </li>
          ))}
        </Outline>
        <Outline title="화면" count={parts.length}>
          {parts.length ? (
            <li>
              <span className="make-chips">
                {[...new Set(parts)].map((p) => (
                  <code key={p}>{p}</code>
                ))}
              </span>
              <small>
                부품 {parts.length} · 목록 밖{' '}
                {panelIssues.filter((i) => i.code === 'PANEL_PART_UNKNOWN').length}
              </small>
            </li>
          ) : (
            <li className="kit-muted">미리보기 뒤에 보입니다</li>
          )}
        </Outline>
        <Outline title="시험" count={cases}>
          {(detail.test?.cases ?? []).map((c) => (
            <li key={c.name} data-ok={String(c.ok)}>
              <span>
                {c.ok ? '✓' : '✕'} {c.name}
              </span>
              <small>
                {seconds(c.ms)}
                {c.attempts ? ` · 시도 ${c.attempts}/3` : ''}
              </small>
            </li>
          ))}
        </Outline>
        <div className="make-files" aria-label="초안 파일">
          <small className="kit-muted">
            초안 파일{detail.savedAt ? ` · 저장 ${clock(detail.savedAt)}` : ''}
          </small>
          <ul>
            {detail.files.map((file) => (
              <li key={file.path} data-changed={file.changed ? '' : undefined}>
                <code>{file.path}</code>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <section className="make-center" aria-label="미리보기">
        <div className="make-center-head">
          <div className="kit-view-tabs" role="tablist" aria-label="보기">
            {(
              [
                ['screen', '화면 미리보기'],
                ['flow', '흐름'],
                ['skill', '설명서'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={center === key}
                onClick={() => setCenter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {center === 'screen' ? (
            <div className="make-run">
              <span className="make-tag">미리보기 선만 · Rhino에 쓰지 않음</span>
              {detail.preview?.fixtures?.length ? (
                <select
                  aria-label="시험 자료"
                  value={fixture ?? detail.preview.fixture ?? ''}
                  onChange={(event) => {
                    setFixture(event.target.value);
                    runPreview(undefined, event.target.value);
                  }}
                >
                  {detail.preview.fixtures.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                disabled={!!busy}
                onClick={() => runPreview()}
                data-action="preview"
              >
                {busy === 'preview' ? '계산 중…' : '미리보기'}
              </button>
            </div>
          ) : null}
        </div>
        {notice ? (
          <p className="kit-notice" role="alert">
            {notice}
          </p>
        ) : null}
        <div className="make-center-body">
          {center === 'screen' ? (
            detail.preview ? (
              <PreviewPanel
                manifest={m}
                preview={detail.preview}
                busy={busy === 'preview'}
                onParams={(params) => runPreview(params)}
              />
            ) : (
              <p className="kit-muted">
                [미리보기]를 누르면 시험 자료로 계산한 실제 화면이 여기에 그려집니다.
              </p>
            )
          ) : center === 'flow' ? (
            m.steps.length ? (
              <StepRail steps={railOf(m, lastSteps)} />
            ) : (
              <p className="kit-muted">아직 단계가 없습니다.</p>
            )
          ) : detail.skill ? (
            <pre className="make-skill" aria-label="설명서">
              {detail.skill}
            </pre>
          ) : (
            <p className="kit-muted">설명서(skill.md)가 아직 없습니다.</p>
          )}
        </div>
      </section>

      <Console
        detail={detail}
        busy={busy}
        validateErrors={validateErrors.length}
        onValidate={runValidate}
        onTest={runTest}
      />
      {sidePanel}
    </>
  );
}

const STATE_TEXT: Record<RailState, string> = {
  pending: '계산 전',
  running: '계산 중',
  done: '통과',
  stale: '다시 계산 필요',
  blocked: '앞 단계 대기',
  failed: '막힘',
  waiting: '확정 전',
  confirmed: '확정됨',
  reconfirm: '다시 확인 필요',
};

function Outline({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <details className="make-group" open>
      <summary>
        {title} <small>{count}</small>
      </summary>
      <ul>{children}</ul>
    </details>
  );
}

/** Every part name used in a panel (for the outline's 화면 chips). */
function partNames(panel: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.part === 'string') out.push(record.part);
      Object.values(record).forEach(walk);
    }
  };
  walk(panel);
  return out;
}

function Console({
  detail,
  busy,
  validateErrors,
  onValidate,
  onTest,
}: {
  detail: DraftDetail;
  busy?: string;
  validateErrors: number;
  onValidate: () => void;
  onTest: () => void;
}) {
  const [tab, setTab] = useState<'all' | 'validate' | 'test'>('all');
  const [open, setOpen] = useState<string>();
  const v = detail.validate;
  const t = detail.test;
  const passed = t?.cases.filter((c) => c.ok).length ?? 0;
  const issues = [...(v?.issues ?? []), ...(t?.issues ?? [])];
  const showValidate = tab !== 'test';
  const showTest = tab !== 'validate';
  return (
    <section className="make-console" aria-label="점검·시험 결과">
      <div className="make-console-head">
        <div className="kit-tabs" role="tablist" aria-label="결과">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            onClick={() => setTab('all')}
          >
            모두
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'validate'}
            onClick={() => setTab('validate')}
          >
            점검 <b>{v ? (v.ok ? '✓' : validateErrors) : '–'}</b>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'test'}
            onClick={() => setTab('test')}
          >
            시험 <b>{t ? `${passed}/${t.cases.length}` : '–'}</b>
          </button>
        </div>
        <small className="kit-muted">
          {[v?.at ? `점검 ${clock(v.at)}` : '', t?.at ? `시험 ${clock(t.at)}` : '', seconds(t?.ms)]
            .filter(Boolean)
            .join(' · ')}
        </small>
        <div className="kit-actions">
          <button type="button" disabled={!!busy} onClick={onValidate} data-action="validate">
            {busy === 'validate' ? '점검 중…' : '점검'}
          </button>
          <button type="button" disabled={!!busy} onClick={onTest} data-action="test">
            {busy === 'test' ? '시험 중…' : '시험'}
          </button>
        </div>
      </div>
      <ul className="make-log">
        {showValidate && !v ? <li className="kit-muted">아직 점검하지 않았습니다.</li> : null}
        {showValidate && v?.ok && !issues.length ? (
          <li data-ok="true">
            <span>✓ 형식 점검을 통과했습니다</span>
          </li>
        ) : null}
        {showValidate
          ? issues.map((issue, i) => (
              <li key={`i${i}`} data-level={issue.level}>
                <span>
                  {issue.level === 'error' ? '✕' : '!'} {issue.message}
                </span>
                <small>
                  {issue.code}
                  {issue.path ? ` · ${issue.path}` : ''}
                </small>
              </li>
            ))
          : null}
        {showTest && !t ? <li className="kit-muted">아직 시험하지 않았습니다.</li> : null}
        {showTest
          ? (t?.cases ?? []).map((c) => (
              <li key={`t${c.name}`} data-ok={String(c.ok)}>
                <button
                  type="button"
                  className="make-case"
                  aria-expanded={!c.ok ? open === c.name : undefined}
                  onClick={() => setOpen(open === c.name ? undefined : c.name)}
                  disabled={c.ok}
                >
                  {c.ok ? '✓' : '✕'} 시험 자료 {c.name}
                  {c.error ? ` — ${c.error}` : ''}
                </button>
                <small>
                  {seconds(c.ms)}
                  {c.attempts ? ` · 시도 ${c.attempts}/3` : ''}
                </small>
                {!c.ok && open === c.name ? (
                  <div className="make-diff">
                    {c.mismatches.length ? (
                      c.mismatches.map((d, k) => (
                        <div key={k}>
                          <code>{d.path}</code>
                          <div className="make-minus">− {JSON.stringify(d.expected)}</div>
                          <div className="make-plus">+ {JSON.stringify(d.actual)}</div>
                        </div>
                      ))
                    ) : (
                      <small>
                        {c.steps
                          .filter((s) => s.error)
                          .map((s) => `${s.id}: ${s.error?.message}`)
                          .join(' · ') || '기대 결과와 다릅니다'}
                      </small>
                    )}
                  </div>
                ) : null}
              </li>
            ))
          : null}
      </ul>
    </section>
  );
}

/**
 * The draft's panel drawn on the preview outputs: the same parts as the run screen (SCR-13),
 * with no instance behind it. Moving a setting runs the preview again with that value; the 3D
 * overlay is drawn on the plan here (nothing reaches the model or a host).
 */
function PreviewPanel({
  manifest,
  preview,
  busy,
  onParams,
}: {
  manifest: DraftManifest;
  preview: PreviewResult;
  busy: boolean;
  onParams: (params: Record<string, Value>) => void;
}) {
  const checked = useMemo(
    () => validatePanel(preview.panel, scopeOf(manifest)),
    [preview.panel, manifest],
  );
  const [values, setValues] = useState<Record<string, Value>>({});
  const [selection, setSelection] = useState<{ key: string; id: string }>();
  const [drawer, setDrawer] = useState('0');
  const [viewTab, setViewTab] = useState(0);
  const [colored, setColored] = useState(true);
  const [only, setOnly] = useState<Record<string, Band | undefined>>({});
  const settings = useMemo(() => settingsOf(manifest, preview.params), [manifest, preview.params]);
  const shown = { ...Object.fromEntries(settings.map((s) => [s.key, s.value])), ...values };
  const data: PanelData = useMemo(
    () => ({ outputs: preview.outputs, params: settings }),
    [preview.outputs, settings],
  );
  const change = (key: string, value: Value, phase: 'drag' | 'release') => {
    const next = { ...values, [key]: value };
    setValues(next);
    if (phase === 'release') onParams({ ...(preview.params ?? {}), ...next });
  };
  const spec = checked.spec;
  if (!spec) return <PanelIssues issues={checked.issues} />;

  const settingsFor = (refs?: readonly string[], group?: string) =>
    refs
      ? refs.flatMap((ref) => settings.find((s) => s.key === ref.slice(1)) ?? [])
      : group
        ? settings.filter((s) => s.group === group)
        : settings;
  const rowId = (keyField: string) => (row: Record<string, unknown>, index: number) => {
    const value = fieldOf(row, keyField);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : String(index);
  };
  const table = (part: PartOf<'table' | 'issue-table' | 'schedule'>, label: string) => {
    const rows = rowsOf(resolve(part.from, data));
    const key = part.overlay ?? `table:${part.from}`;
    return (
      <DataTable
        variant={part.part}
        label={label}
        rows={rows}
        columns={columnsOf(rows, part.columns)}
        rowId={rowId(part.key ?? 'key')}
        selected={selection?.key === key ? selection.id : undefined}
        onRow={(id) => setSelection({ key, id })}
        csvName={part.csv}
      />
    );
  };
  const legend = (part: Omit<PartOf<'verdict-legend'>, 'part'>) => {
    const rows = rowsOf(resolve(part.from, data));
    const bands = bandsOf(part.bands, data);
    const counts = bandCounts(rows, part.field, bands);
    return (
      <VerdictLegend
        title={part.title ?? '판정'}
        total={rows.length}
        bands={BAND_ORDER.filter((band) => band !== 'na' || counts.na).map((band) => ({
          band,
          symbol: BAND_SYMBOL[band],
          text: BAND_TEXT[band],
          range: '',
          count: counts[band],
        }))}
        only={part.overlay ? only[part.overlay] : undefined}
        colored={colored}
        onOnly={(band) => {
          if (part.overlay) setOnly((current) => ({ ...current, [part.overlay!]: band }));
        }}
        onColored={setColored}
      />
    );
  };
  const plan = (layers: PartOf<'plan-map'>['layers'], title?: string, rotate?: number) => (
    <PlanMap
      title={title}
      layers={layers.map((layer) => ({
        key: layer.key,
        items: layerItems(layer, data, { verdict: colored, only: only[layer.key] }),
      }))}
      rotate={rotate ?? 0}
      selected={selection}
      onPick={(key, id) => setSelection({ key, id })}
    />
  );
  const render = (part: PartUse, key: string): ReactNode => {
    switch (part.part) {
      case 'step-rail':
        return (
          <section key={key} className="kit-section">
            <h4>{part.title ?? '단계'}</h4>
            <StepRail steps={railOf(manifest, preview.steps)} busy={busy} />
          </section>
        );
      case 'param-group':
        return (
          <SettingGroup
            key={key}
            title={part.title}
            settings={settingsFor(part.params, part.group)}
            values={shown}
            disabled={busy}
            onChange={change}
          />
        );
      case 'slider':
      case 'stepper':
      case 'toggle':
      case 'choice': {
        const setting = settingsFor([part.param])[0];
        return setting ? (
          <SettingRow
            key={key}
            setting={setting}
            value={shown[setting.key]}
            control={part.part}
            disabled={busy}
            onChange={(value, phase) => change(setting.key, value, phase)}
          />
        ) : null;
      }
      case 'slider-board':
        return (
          <SliderBoard
            key={key}
            title={part.title}
            settings={part.params ? settingsFor(part.params) : settings.filter((s) => s.board)}
            values={shown}
            disabled={busy}
            onChange={change}
          />
        );
      case 'fact-badge': {
        const setting = settingsFor([part.param])[0];
        return setting ? <FactBadge key={key} setting={setting} /> : null;
      }
      case 'role-card':
        return (
          <div key={key} className="kit-card">
            <strong>입력 {part.input.replace(/^inputs\./, '')}</strong>
            <span className="kit-muted">미리보기는 시험 자료의 입력을 씁니다</span>
          </div>
        );
      case 'kpi-strip':
        return (
          <KpiStrip
            key={key}
            items={part.items.map((item) => {
              const value = resolve(item.from, data);
              const limit =
                typeof item.warnAbove === 'string' ? resolve(item.warnAbove, data) : item.warnAbove;
              return {
                label: item.label,
                value:
                  value === undefined || value === null
                    ? undefined
                    : cellText(value, item.decimals),
                unit: item.unit,
                note: item.note,
                over: typeof value === 'number' && typeof limit === 'number' && value > limit,
                empty: item.empty,
              };
            })}
          />
        );
      case 'verdict-legend':
        return (
          <section key={key} className="kit-section">
            {legend(part)}
          </section>
        );
      case 'viewport-overlay':
        return (
          <div key={key}>
            {plan(part.layers, '3D 겹침 (미리보기는 평면으로)')}
            {part.legend ? legend(part.legend) : null}
          </div>
        );
      case 'plan-map': {
        const turn = part.rotate ? resolve(part.rotate, data) : undefined;
        return (
          <div key={key}>{plan(part.layers, part.title, typeof turn === 'number' ? turn : 0)}</div>
        );
      }
      case 'issue-table':
      case 'table':
      case 'schedule':
        return (
          <section key={key} className="kit-section">
            {part.title ? <h4>{part.title}</h4> : null}
            {table(part, part.title ?? '결과')}
          </section>
        );
      case 'result-tabs':
        return (
          <ResultTabs
            key={key}
            active={drawer}
            onActive={setDrawer}
            tabs={part.tabs.map((tab, i) => {
              const isTable =
                tab.part === 'table' || tab.part === 'issue-table' || tab.part === 'schedule';
              return {
                id: String(i),
                title: tab.title,
                count: isTable ? rowsOf(resolve(tab.from, data)).length : undefined,
                content: isTable ? table(tab, tab.title) : render(tab, `${key}.${i}`),
              };
            })}
          />
        );
      case 'bake-card': {
        const planned = part.from ? resolve(part.from, data) : undefined;
        return (
          <div key={key}>
            <BakeCard
              title={`${part.title ?? 'Rhino에 만들기'} · 미리보기`}
              plan={planned && typeof planned === 'object' ? (planned as BakePlan) : undefined}
            />
            <small className="kit-muted">
              미리보기에서는 선으로만 보이고 Rhino에 쓰지 않습니다.
            </small>
          </div>
        );
      }
      default:
        return (
          <div key={key} className="kit-card kit-muted">
            {part.part}
          </div>
        );
    }
  };
  const views = spec.center.views;
  const view = views[Math.min(viewTab, Math.max(views.length - 1, 0))];
  const failed = preview.steps.filter((s) => s.status === 'failed' || s.status === 'gate-failed');
  return (
    <div className="kit-panel make-preview" data-preview="">
      {failed.length ? (
        <p className="kit-notice" data-level="error" role="alert">
          {failed.map((s) => `${s.id}: ${s.error?.message ?? '막힘'}`).join(' · ')}
        </p>
      ) : null}
      <div className="kit-columns">
        <div className="kit-side">{spec.left.map((part, i) => render(part, `left.${i}`))}</div>
        <div className="kit-main">
          {spec.center.kpis ? render(spec.center.kpis, 'kpis') : null}
          {views.length > 1 ? (
            <div className="kit-view-tabs" role="tablist" aria-label="보기">
              {views.map((part, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={part === view}
                  onClick={() => setViewTab(i)}
                >
                  {'title' in part && typeof part.title === 'string' && part.title
                    ? part.title
                    : part.part === 'plan-map'
                      ? '평면'
                      : '3D'}
                </button>
              ))}
            </div>
          ) : null}
          {view ? <div className="kit-view">{render(view, 'view')}</div> : null}
          {spec.center.board ? render(spec.center.board, 'board') : null}
        </div>
      </div>
      {spec.drawer ? render(spec.drawer, 'drawer') : null}
      <small className="kit-muted">
        {preview.fixture ? `시험 자료 ${preview.fixture} · ` : ''}
        {preview.at ? `계산 ${clock(preview.at)}` : ''}
        {preview.ms !== undefined ? ` · ${seconds(preview.ms)}` : ''} · 호스트 쓰기 없음
      </small>
    </div>
  );
}

function PanelIssues({ issues }: { issues: readonly PanelIssue[] }) {
  return (
    <div className="kit-panel">
      <p className="kit-notice" data-level="error" role="alert">
        화면 구성(panel.json)에 목록에 없는 부품이나 값이 있어 그리지 않았습니다.
      </p>
      <ul className="kit-issues">
        {issues.map((issue, i) => (
          <li key={i}>
            {issue.message} <small>{issue.path}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Entry points in the JIG list (SCR-18) ---

/**
 * '새로 만들기', the JIG list's last card (SCR-18, PLAN-26 T-099): one sentence of what the tool
 * does and [만들기 시작]. The draft starts from the general grid example; [빈 초안에서] starts from a
 * blank one. The sentence is the draft's first name; the make conversation names the tool.
 */
export function MakeCard({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated?: (draft: DraftSummary) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = (from: DraftStart) => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    createDraft(projectId, { name: name.trim(), from })
      .then((draft) => {
        setName('');
        if (onCreated) onCreated(draft);
        else openDraft(projectId, draft.id);
      })
      .catch((reason) => setError(messageOf(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="jig-card make-card"
      data-source="new"
      aria-label="새로 만들기"
      onSubmit={(event) => {
        event.preventDefault();
        start('example-grid');
      }}
    >
      <div className="jig-card-head">
        <strong>새로 만들기</strong>
      </div>
      <p>무엇을 하는 도구인지 한 문장으로 적으면 AI가 계획을 보이고 초안을 만듭니다.</p>
      <input
        value={name}
        maxLength={100}
        aria-label="무엇을 하는 도구인가요?"
        placeholder="예: 신설 이음 선마다 양쪽 기둥이 있는지 확인"
        onChange={(event) => setName(event.target.value)}
      />
      {error ? <small role="alert">{error}</small> : null}
      <div className="make-card-actions">
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          {busy ? '만드는 중…' : '만들기 시작'}
        </button>
        <button
          type="button"
          className="link-button"
          disabled={busy || !name.trim()}
          title="격자 예제 대신 설명서와 빈 단계 하나에서 시작합니다"
          onClick={() => start('blank')}
        >
          빈 초안에서
        </button>
      </div>
    </form>
  );
}

const savedAt = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

/** A draft being written, as a JIG list card (SCR-18, T-099): '작성 중' and [이어서 만들기]. */
export function DraftCard({ projectId, draft }: { projectId: string; draft: DraftSummary }) {
  const name = draft.name || draft.manifest?.name || '새 도구';
  return (
    <article className="jig-card" data-source="draft" data-status="available">
      <div className="jig-card-head">
        <span className="jig-card-title">
          <JigIconMark icon={draft.manifest?.icon} />
          <strong>{name}</strong>
        </span>
        <span className="pill">작성 중</span>
      </div>
      <p>{draft.manifest?.summary || '만들기 대화에서 쓰고 있는 초안입니다.'}</p>
      <small>
        내 초안{draft.version ? ` · v${draft.version}` : ''}
        {draft.updatedAt ? ` · ${savedAt(draft.updatedAt)}` : ''}
      </small>
      <button type="button" onClick={() => openDraft(projectId, draft.id)}>
        이어서 만들기
      </button>
    </article>
  );
}

/** The drafts of this PC (내 초안): read here when not given. */
export function DraftList({
  projectId,
  drafts: given,
  onOpen,
}: {
  projectId: string;
  drafts?: DraftSummary[];
  onOpen?: (draftId: string) => void;
}) {
  const [read, setRead] = useState<DraftSummary[]>();
  useEffect(() => {
    if (given) return;
    let live = true;
    listDrafts(projectId)
      .then((value) => live && setRead(value))
      .catch(() => live && setRead([]));
    return () => {
      live = false;
    };
  }, [given, projectId]);
  const all = given ?? read;
  if (!all) return null;
  const drafts = openDrafts(all);
  if (!drafts.length) return <p className="jig-intro">아직 만들고 있는 초안이 없습니다.</p>;
  return (
    <ul className="make-drafts" aria-label="내 초안">
      {drafts.map((draft) => (
        <li key={draft.id}>
          <span>{draft.name}</span>
          <small>
            {draft.version ? `v${draft.version} · ` : ''}
            {savedAt(draft.updatedAt)}
          </small>
          <button
            type="button"
            onClick={() => (onOpen ? onOpen(draft.id) : openDraft(projectId, draft.id))}
          >
            열기
          </button>
        </li>
      ))}
    </ul>
  );
}

/** [가져오기]: a `.vjig` packed on this PC, after a confirmation (확인 필요 동작). */
export function ImportJig({
  projectId,
  onImported,
}: {
  projectId: string;
  onImported?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <div className="make-import">
      <input
        ref={input}
        type="file"
        accept=".vjig"
        hidden
        aria-label=".vjig 파일"
        onChange={(event) => {
          setFile(event.target.files?.[0]);
          setMessage('');
          event.target.value = '';
        }}
      />
      <button type="button" onClick={() => input.current?.click()} data-action="import">
        가져오기
      </button>
      {file ? (
        <div className="kit-confirm" role="group" aria-label="가져오기 확인">
          <strong>{file.name}을 이 프로젝트의 jig로 가져옵니다</strong>
          <span>이 PC에서 묶고 서명한 jig만 설치합니다. 다른 PC의 묶음은 거절합니다.</span>
          <span>같은 이름·버전이 다른 내용으로 있으면 설치하지 않습니다.</span>
          <div className="kit-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                importJig(projectId, file)
                  .then((result) => {
                    setFile(undefined);
                    setMessage(`가져왔습니다${result.version ? ` · 버전 ${result.version}` : ''}.`);
                    onImported?.();
                  })
                  .catch((error) => setMessage(messageOf(error)))
                  .finally(() => setBusy(false));
              }}
            >
              가져오기
            </button>
            <button type="button" onClick={() => setFile(undefined)}>
              취소
            </button>
          </div>
        </div>
      ) : null}
      {message ? <small role="status">{message}</small> : null}
    </div>
  );
}
