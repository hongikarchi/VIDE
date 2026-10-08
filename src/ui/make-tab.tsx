// The 만들기 workspace tab (PLAN-22 T-063, SPEC-07.16, Design SCR-16): making a jig by conversation.
// Left: the draft outline read from its manifest (단계 · 설정값 · 화면 · 시험) and its file names.
// Centre: 화면 미리보기 (the draft's panel.json drawn with the official parts on the outputs the
// engine computed in the compute box on a fixture), 흐름 (the steps with their states) and 설명서
// (skill.md, read-only). Bottom: the 점검·시험 console. Right: the authoring conversation is the
// app's conversation column (chips, work view, question cards); this screen adds the plan card,
// the progress line and the two decisions, [버리기] and [이 프로젝트의 jig로 고정] (확인 필요).
// Nothing here writes to a host: a preview draws lines on this screen only. The JIG list's
// '새로 만들기' card, the draft list and [가져오기] (.vjig) are exported from here too. With no draft
// open, the tab shows the 시작 양식 (PLAN-40 T-185): [계획 받기] makes the draft and sends the form
// as the make conversation's first turn.
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
import { offerMakeSide, workState } from './store/work.ts';
import {
  INPUTS,
  LAYER_SHAPES,
  NOT_WHEN_EXAMPLES,
  OUTPUTS,
  PARAM_TYPES,
  STEP_BY,
  WHEN_EXAMPLES,
  ZONE_SHAPES,
  PHASES,
  briefPrompt,
  briefReady,
  emptyBrief,
  emptyCheck,
  emptyParam,
  emptyStep,
  keepBrief,
  keptBrief,
  phaseOf,
  planOf,
  untouched,
  type Brief,
  type BriefCheck,
  type BriefInput,
  type BriefOutput,
  type BriefParam,
  type BriefStep,
} from './make-brief.ts';
import { MySubmissions, SubmitJig } from './jig-submit.tsx';
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
/**
 * Open the 만들기 tab on the 시작 양식 (the JIG list's [새로 만들기], PLAN-40 T-185): no draft is made
 * yet, and the last draft shown does not open again.
 */
export function openBrief(projectId: string) {
  wanted = undefined;
  rememberDraft(projectId, undefined);
  for (const listener of listeners) listener(undefined);
  setWorkspace('make');
  showMake(projectId);
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

/** The first turn of a draft just made from the 시작 양식, waiting for its make conversation. */
const firstTurns = new Map<string, string>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Send words as a turn of the make conversation (PLAN-40 T-185): the 시작 양식's first turn and
 * [만들기 시작]. Only into that conversation, once it is the chosen one; words already typed in the
 * composer stay and nothing is sent ('kept'). When sending cannot start (no model, the app busy),
 * the words wait in the composer ('typed'). The turn skips request routing: it is the make
 * conversation's turn by construction.
 */
export async function sendMakeTurn(
  conversationId: string,
  text: string,
): Promise<'sent' | 'typed' | 'kept' | 'missed'> {
  const chosen = () => workState.conversationChips?.active() === conversationId;
  for (let i = 0; i < 40 && !chosen(); i++) {
    if (i % 10 === 5) {
      await workState.conversationChips?.refresh().catch(() => undefined);
      workState.conversationChips?.select(conversationId);
    }
    await pause(200);
  }
  if (!chosen()) return 'missed';
  // The chosen conversation's own draft lands in the composer first.
  await pause(100);
  const composer = document.getElementById('body');
  if (!(composer instanceof HTMLTextAreaElement)) return 'missed';
  if (composer.value.trim() && composer.value !== text) return 'kept';
  composer.value = text;
  // The app keeps the composer's text through its input handler.
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  for (let i = 0; i < 40; i++) {
    if (!chosen() || composer.value !== text) return 'typed';
    const send = document.getElementById('request');
    if (send instanceof HTMLButtonElement && !send.disabled && !composer.disabled) {
      const { submitRequest } = await import('./app/composer.ts');
      await submitRequest();
      return composer.value === text ? 'typed' : 'sent';
    }
    await pause(250);
  }
  composer.focus();
  return 'typed';
}
const TURN_NOTICE: Record<'typed' | 'kept' | 'missed', string> = {
  typed: '보낼 말을 오른쪽 입력 칸에 넣어 두었습니다. 보내기를 누르면 이어집니다.',
  kept: '입력 칸에 적어 둔 말이 있어 보내지 않았습니다. 그 말을 보내거나 지운 뒤 다시 누르세요.',
  missed:
    '제작 대화를 고르지 못해 보내지 않았습니다. 오른쪽 대화 칩에서 이 초안의 대화를 고르세요.',
};

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
  /** The draft's make conversation once it is known (it may be made after the draft is read). */
  const [conversation, setConversation] = useState<string>();
  /** [만들기 시작] is being sent; bumped after it is kept so the plan card reads it again. */
  const [starting, setStarting] = useState(false);
  const [, setKeptVersion] = useState(0);

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
    const draftId = detail.draft.id;
    setConversation(known);
    (known ? Promise.resolve(known) : makeConversation(projectId, detail.draft))
      .then((id) => {
        setConversation(id);
        chooseConversation(id);
        // The 시작 양식 goes as the first turn by itself (SPEC-07.16 step 0, 2026-10-06).
        const turn = firstTurns.get(draftId);
        firstTurns.delete(draftId);
        if (turn)
          void sendMakeTurn(id, turn).then((result) => {
            if (result !== 'sent') setNotice(TURN_NOTICE[result]);
          });
      })
      .catch((error) => setNotice(`제작 대화를 열지 못했습니다: ${messageOf(error)}`));
  }, [detail, projectId]);
  // The plan card and the decisions sit in the right column, under the conversation chips.
  // The AI column renders the section (src/ui/shell/right-column.tsx) and hands it over.
  useEffect(
    () =>
      offerMakeSide((element) => {
        if (element) setSide(element);
      }),
    [],
  );

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
            <MakeBrief
              projectId={projectId}
              onCreated={(draft) => {
                readList();
                choose(draft.id);
              }}
            />
            <h3 className="make-drafts-title">내 초안</h3>
            <DraftList projectId={projectId} drafts={drafts} onOpen={choose} />
            <h3 className="make-drafts-title">내 제출</h3>
            <MySubmissions />
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
  const kept = keptBrief(detail.draft.id);
  // Writing starts with [만들기 시작] or with files written after the starting point (SPEC-07.16).
  const writing = !!kept?.started || !untouched(detail);
  const phase = phaseOf(detail, writing);
  const plan = planOf(detail, { writing, ...(kept?.brief ? { brief: kept.brief } : {}) });
  const startWriting = () => {
    if (!conversation || starting) return;
    const draftId = detail.draft.id;
    setStarting(true);
    setNotice('');
    void sendMakeTurn(conversation, '만들기 시작')
      .then((result) => {
        if (result === 'sent') {
          keepBrief(draftId, { ...(keptBrief(draftId) ?? {}), started: true });
          setKeptVersion((n) => n + 1);
        } else setNotice(TURN_NOTICE[result]);
      })
      .finally(() => setStarting(false));
  };
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
                {!writing && kept?.brief
                  ? `양식 ${plan.filter((item) => item.done).length}칸`
                  : `${plan.filter((item) => item.done).length}/${plan.length} 완료`}
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
              계획과 질문은 아래 대화에서 주고받습니다. 계획이 맞으면 [만들기 시작]을 누르세요.
            </small>
            {!writing ? (
              <button
                type="button"
                className="primary make-go"
                disabled={!conversation || starting || !!busy}
                onClick={startWriting}
                data-action="start-writing"
              >
                {starting ? '보내는 중…' : '만들기 시작'}
              </button>
            ) : null}
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
              <SubmitJig
                target={{ projectId, draftId: detail.draft.id }}
                name={name}
                version={m.version}
                disabled={!!busy}
              />
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
                {detail.origin ? (
                  <span>
                    이 프로젝트의 목록에서 v{detail.origin.version} 대신 이 버전이 보입니다. 열어 둔
                    작업본은 JIG 목록의 [올리기]로 옮깁니다.
                  </span>
                ) : null}
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
            {detail.origin
              ? `수정 · ${detail.origin.name || detail.origin.jigId} v${detail.origin.version}의 사본${m.version ? ` → v${m.version}` : ''}`
              : `새 도구 · 초안${m.version ? ` v${m.version}` : ''} · 내 것`}
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
        {/* 입력 → 단계 → 결과 (T-101): what the jig takes, how it works and what it makes. */}
        <Outline title="입력" count={m.inputs.length}>
          {/* A note may list ten roles: it wraps under the name (make-io), never squeezes it. */}
          {inputsOf(m).map((input) => (
            <li key={input.key} className="make-io">
              <span>{input.title}</span>
              <small>{input.note}</small>
            </li>
          ))}
        </Outline>
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
        <Outline title="결과" count={resultsOf(m).length}>
          {resultsOf(m).map((result) => (
            <li key={result.key} className="make-io">
              <span>{result.title}</span>
              <small>{result.note}</small>
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
            <div className="make-flow">
              <section aria-label="입력">
                <h4>입력</h4>
                <ul>
                  {inputsOf(m).map((input) => (
                    <li key={input.key}>
                      {input.title} <small>{input.note}</small>
                    </li>
                  ))}
                </ul>
                {m.inputs.length ? null : <p className="kit-muted">입력이 없습니다.</p>}
              </section>
              <section aria-label="단계">
                <h4>단계</h4>
                {m.steps.length ? (
                  <StepRail steps={railOf(m, lastSteps)} />
                ) : (
                  <p className="kit-muted">아직 단계가 없습니다.</p>
                )}
              </section>
              <section aria-label="결과">
                <h4>결과</h4>
                <ul>
                  {resultsOf(m).map((result) => (
                    <li key={result.key}>
                      {result.title} <small>{result.note}</small>
                    </li>
                  ))}
                </ul>
                {resultsOf(m).length ? null : (
                  <p className="kit-muted">화면에 보이는 결과만 있습니다.</p>
                )}
              </section>
            </div>
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

const INPUT_KINDS: Record<string, string> = {
  assembly: '입력 조립',
  'sync-layers': '연결 파일 레이어',
  zone: '그린 구역',
  facts: '프로젝트 자료',
  'table-file': '표 파일',
  'jig-output': '다른 jig의 결과',
  'host-document': '연결 문서 전체',
  'host-surface': 'Rhino에서 고른 면',
};
/** The outline's 입력: each declared input, an assembly's roles named under it (T-101). */
export function inputsOf(m: DraftManifest): { key: string; title: string; note: string }[] {
  return m.inputs.map((input) => {
    const roles = (input.roles ?? []).map(
      (role) => `${role.title || role.role}${role.required === false ? '(선택)' : ''}`,
    );
    const kind = INPUT_KINDS[input.kind] ?? input.kind;
    return {
      key: input.key,
      title: input.title || input.key,
      note: roles.length ? `${kind} · ${roles.join(', ')}` : kind,
    };
  });
}
const BAKE_TEMPLATES: Record<string, string> = {
  'vide.bake.curves@1': '선',
  'vide.bake.sweep-h@1': 'H형 부재',
  'vide.bake.extrude-column@1': '기둥',
  'vide.bake.textdot@1': '부호 문자',
  'vide.bake.extrude-polygon@1': '돌출 매스',
  'vide.bake.brep-faces@1': '닫힌 다면체',
  'vide.bake.mesh@1': '메쉬',
};
/** The outline's 결과: what Rhino에 만들기 makes, the reports and the outputs other jigs read. */
export function resultsOf(m: DraftManifest): { key: string; title: string; note: string }[] {
  return [
    ...m.bake.map((bake) => ({
      key: `bake:${bake.id}`,
      title: `Rhino에 만들기 · ${BAKE_TEMPLATES[bake.template] ?? bake.template}`,
      note: bake.layer ? `레이어 ${bake.layer}` : '',
    })),
    ...m.reports.map((report) => ({
      key: `report:${report.id}`,
      title: `보고서 · ${report.title || report.id}`,
      note: '',
    })),
    ...m.outputs.map((output) => ({
      key: `output:${output.key}`,
      title: `다른 jig로 · ${output.key}`,
      note: output.from,
    })),
  ];
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
 * '새로 만들기', the JIG list's last card (SCR-18, PLAN-40 T-185): the whole dashed card is one
 * button that opens the 만들기 tab on the 시작 양식. No draft is made until [계획 받기].
 */
export function MakeCard({ projectId }: { projectId: string }) {
  return (
    <button
      type="button"
      className="jig-card make-card"
      data-source="new"
      aria-label="새로 만들기"
      onClick={() => openBrief(projectId)}
    >
      <span className="make-card-plus" aria-hidden="true">
        +
      </span>
      <strong>새로 만들기</strong>
    </button>
  );
}

const toggled = <T,>(list: readonly T[], item: T) =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

/**
 * The 시작 양식 (SPEC-07.16 step 0, Design SCR-16, PLAN-40 T-185): what the tool is for (required)
 * and, if the person wants, what it reads, what it lets them adjust, how it decides, what it gives
 * and when it passes. [계획 받기] makes the draft (blank unless the example is chosen) and its first
 * turn is this form in sentences, sent by itself once the make conversation is open.
 */
export function MakeBrief({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated?: (draft: DraftSummary) => void;
}) {
  const [brief, setBrief] = useState<Brief>(emptyBrief);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<Brief>) => setBrief((b) => ({ ...b, ...patch }));
  const setParam = (i: number, patch: Partial<BriefParam>) =>
    setBrief((b) => ({ ...b, params: b.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const setStep = (i: number, patch: Partial<BriefStep>) =>
    setBrief((b) => ({ ...b, steps: b.steps.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const setCheck = (i: number, patch: Partial<BriefCheck>) =>
    setBrief((b) => ({ ...b, checks: b.checks.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const drop = (key: 'params' | 'steps' | 'checks', i: number) =>
    setBrief((b) => ({ ...b, [key]: b[key].filter((_, j) => j !== i) }));
  const addTo = (base: string, example: string) =>
    base.trim() ? (base.includes(example) ? base : `${base.trim()}\n${example}`) : example;
  const ready = briefReady(brief);
  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    createDraft(projectId, { name: brief.purpose.trim(), from: brief.start })
      .then((draft) => {
        keepBrief(draft.id, { brief, started: false });
        firstTurns.set(draft.id, briefPrompt(brief));
        setBrief(emptyBrief());
        if (onCreated) onCreated(draft);
        else openDraft(projectId, draft.id);
      })
      .catch((reason) => setError(messageOf(reason)))
      .finally(() => setBusy(false));
  };
  const chip = (on: boolean, label: string, toggle: () => void) => (
    <button key={label} type="button" className="make-chip" aria-pressed={on} onClick={toggle}>
      {label}
    </button>
  );
  const check = (key: BriefOutput, label: string) => (
    <label key={key} className="make-check">
      <input
        type="checkbox"
        checked={brief.outputs.includes(key)}
        onChange={() => set({ outputs: toggled(brief.outputs, key) })}
      />
      {label}
    </label>
  );
  return (
    <form
      className="make-brief"
      aria-label="시작 양식"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="make-head">
        <h2>새 도구 만들기</h2>
        <small className="kit-muted">목적만 적어도 됩니다</small>
      </div>
      <label className="make-field">
        <strong>무엇을 하는 도구인가요?</strong>
        <input
          value={brief.purpose}
          maxLength={100}
          placeholder="예: 신설 이음 선마다 양쪽 기둥이 있는지 확인"
          onChange={(event) => set({ purpose: event.target.value })}
        />
      </label>
      <div className="make-when">
        <div className="make-field">
          <label className="make-field">
            <span>언제 쓰나</span>
            <textarea
              rows={2}
              value={brief.when}
              onChange={(event) => set({ when: event.target.value })}
            />
          </label>
          <div className="make-chips" role="group" aria-label="언제 쓰나 예문">
            {WHEN_EXAMPLES.map((text) =>
              chip(false, text, () => set({ when: addTo(brief.when, text) })),
            )}
          </div>
        </div>
        <div className="make-field">
          <label className="make-field">
            <span>쓰지 않을 때</span>
            <textarea
              rows={2}
              value={brief.notWhen}
              onChange={(event) => set({ notWhen: event.target.value })}
            />
          </label>
          <div className="make-chips" role="group" aria-label="쓰지 않을 때 예문">
            {NOT_WHEN_EXAMPLES.map((text) =>
              chip(false, text, () => set({ notWhen: addTo(brief.notWhen, text) })),
            )}
          </div>
        </div>
      </div>

      <fieldset>
        <legend>무엇을 읽나</legend>
        <div className="make-chips" role="group" aria-label="입력">
          {INPUTS.map((input) =>
            chip(brief.inputs.includes(input.key), input.label, () =>
              set({ inputs: toggled<BriefInput>(brief.inputs, input.key) }),
            ),
          )}
        </div>
        {brief.inputs.includes('layers') ? (
          <div className="make-chips make-sub" role="group" aria-label="레이어에서 읽는 형상">
            <small>형상</small>
            {LAYER_SHAPES.map((shape) =>
              chip(brief.layerShapes.includes(shape), shape, () =>
                set({ layerShapes: toggled<string>(brief.layerShapes, shape) }),
              ),
            )}
          </div>
        ) : null}
        {brief.inputs.includes('zone') ? (
          <div className="make-chips make-sub" role="group" aria-label="그리는 모양">
            <small>모양</small>
            {ZONE_SHAPES.map((shape) =>
              chip(brief.zoneShapes.includes(shape), shape, () =>
                set({ zoneShapes: toggled<string>(brief.zoneShapes, shape) }),
              ),
            )}
          </div>
        ) : null}
      </fieldset>

      <fieldset>
        <legend>무엇을 조절하나</legend>
        {brief.params.length ? (
          <div className="make-table-wrap">
            <table className="make-rows" aria-label="설정값">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>종류</th>
                  <th>단위</th>
                  <th>기본값</th>
                  <th>범위</th>
                  <th>근거</th>
                  <th aria-label="지우기" />
                </tr>
              </thead>
              <tbody>
                {brief.params.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        aria-label="설정값 이름"
                        value={p.name}
                        placeholder="예: 기둥 간격"
                        onChange={(event) => setParam(i, { name: event.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        aria-label="종류"
                        value={p.type}
                        onChange={(event) => {
                          const type = PARAM_TYPES.find((t) => t.key === event.target.value);
                          if (type) setParam(i, { type: type.key, unit: type.unit });
                        }}
                      >
                        {PARAM_TYPES.map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label="단위"
                        className="make-short"
                        value={p.unit}
                        onChange={(event) => setParam(i, { unit: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label="기본값"
                        className="make-short"
                        value={p.value}
                        onChange={(event) => setParam(i, { value: event.target.value })}
                      />
                    </td>
                    <td className="make-range">
                      <input
                        aria-label="최소"
                        className="make-short"
                        value={p.min}
                        onChange={(event) => setParam(i, { min: event.target.value })}
                      />
                      ~
                      <input
                        aria-label="최대"
                        className="make-short"
                        value={p.max}
                        onChange={(event) => setParam(i, { max: event.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        aria-label="근거"
                        value={p.basis}
                        onChange={(event) =>
                          setParam(i, {
                            basis: event.target.value === 'confirmed' ? 'confirmed' : 'assumed',
                          })
                        }
                      >
                        <option value="assumed">가정</option>
                        <option value="confirmed">확정</option>
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        aria-label="설정값 지우기"
                        onClick={() => drop('params', i)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <button
          type="button"
          className="link-button"
          onClick={() => set({ params: [...brief.params, emptyParam()] })}
        >
          설정값 추가
        </button>
      </fieldset>

      <fieldset>
        <legend>어떻게 판단하나</legend>
        {brief.steps.length ? (
          <ol className="make-steps" aria-label="계산 단계">
            {brief.steps.map((step, i) => (
              <li key={i}>
                <input
                  aria-label="단계 이름"
                  value={step.name}
                  placeholder="예: 이음 선 찾기"
                  onChange={(event) => setStep(i, { name: event.target.value })}
                />
                <select
                  aria-label="맡는 쪽"
                  value={step.by}
                  onChange={(event) =>
                    setStep(i, {
                      by: STEP_BY.find((b) => b.key === event.target.value)?.key ?? 'code',
                    })
                  }
                >
                  {STEP_BY.map((b) => (
                    <option key={b.key} value={b.key}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="한 줄 설명"
                  value={step.note}
                  placeholder="무엇을 하는지 한 줄"
                  onChange={(event) => setStep(i, { note: event.target.value })}
                />
                <button
                  type="button"
                  className="link-button"
                  aria-label="단계 지우기"
                  onClick={() => drop('steps', i)}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        <button
          type="button"
          className="link-button"
          onClick={() => set({ steps: [...brief.steps, emptyStep()] })}
        >
          단계 추가
        </button>
      </fieldset>

      <fieldset>
        <legend>무엇을 내놓나</legend>
        <div className="make-chips">
          {check('preview', '3D 미리보기선')}
          {check('table', '표')}
          {check('report', '보고서')}
          {check('handoff', '다른 jig로 넘김')}
        </div>
        <div className="make-chips make-sub" role="group" aria-label="Rhino에 만들기">
          <small>Rhino에 만들기</small>
          {OUTPUTS.filter((o) => o.group).map((o) => check(o.key, o.label))}
        </div>
      </fieldset>

      <fieldset>
        <legend>무엇이면 통과인가</legend>
        {brief.checks.map((row, i) => (
          <div key={i} className="make-check-row">
            <input
              aria-label="통과 조건"
              value={row.text}
              placeholder="예: 기둥 간격 ≤ 12 m"
              onChange={(event) => setCheck(i, { text: event.target.value })}
            />
            <select
              aria-label="어기면"
              value={row.level}
              onChange={(event) =>
                setCheck(i, { level: event.target.value === 'warn' ? 'warn' : 'block' })
              }
            >
              <option value="block">막음</option>
              <option value="warn">주의</option>
            </select>
            <button
              type="button"
              className="link-button"
              aria-label="통과 조건 지우기"
              onClick={() => drop('checks', i)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="link-button"
          onClick={() => set({ checks: [...brief.checks, emptyCheck()] })}
        >
          통과 조건 추가
        </button>
      </fieldset>

      <fieldset>
        <legend>시작점</legend>
        <div className="make-chips" role="radiogroup" aria-label="시작점">
          <label className="make-check">
            <input
              type="radio"
              name="make-start"
              checked={brief.start === 'blank'}
              onChange={() => set({ start: 'blank' })}
            />
            빈 초안
          </label>
          <label className="make-check">
            <input
              type="radio"
              name="make-start"
              checked={brief.start === 'example-grid'}
              onChange={() => set({ start: 'example-grid' })}
            />
            본보기: 격자 예제
          </label>
        </div>
      </fieldset>

      <div className="make-brief-foot">
        <small className="kit-muted">
          목적 말고는 비워도 됩니다. 비운 칸은 AI가 가정으로 채워 계획에 적습니다.
        </small>
        {error ? <small role="alert">{error}</small> : null}
        <button type="submit" className="primary" disabled={busy || !ready}>
          {busy ? '만드는 중…' : '계획 받기'}
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
