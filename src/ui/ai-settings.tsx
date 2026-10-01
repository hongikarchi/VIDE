import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api, errors, projectSchema } from './gateway.ts';
import {
  aiSettingsSchema,
  aiSettingsResponseSchema,
  providerStatusSchema,
  providers,
} from '../contracts/ai-settings.ts';
import type { AiSettingsResponse, ProviderStatus, Provider } from '../contracts/ai-settings.ts';

const errorLabels: Record<string, string> = errors;
/**
 * FR-18 notice and switch for sending route questions to Jev (SPEC-02.17 4, PLAN-24 T-049): what
 * leaves this PC before a request is sent, and the switch that leaves only the rules. The engine
 * enforces the list (src/ai/request-router.ts); this text must say the same.
 */
function RoutingSection() {
  const [state, setState] = useState<{ jev: boolean; key: boolean }>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const read = (value: unknown) => {
    const row = (value ?? {}) as { jev?: unknown; key?: unknown };
    return { jev: row.jev === true, key: row.key === true };
  };
  useEffect(() => {
    let live = true;
    api('/settings/routing')
      .then((value) => live && setState(read(value)))
      .catch(() => live && setMessage('경로 판정 설정을 읽지 못했습니다.'));
    return () => {
      live = false;
    };
  }, []);
  const toggle = async (jev: boolean) => {
    setSaving(true);
    try {
      setState(read(await api('/settings/routing', 'PUT', { jev })));
      setMessage(
        jev ? '다음 요청부터 Jev에 경로 판정을 보냅니다.' : '다음 요청부터 규칙으로만 판정합니다.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설정을 바꾸지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };
  const status = !state
    ? '확인 중'
    : !state.jev
      ? '꺼짐 · 규칙만'
      : state.key
        ? '켜짐'
        : '이 PC에 키 없음 · 규칙만';
  return (
    <section className="ai-provider ai-routing" aria-label="요청 경로 판정">
      <div className="ai-provider-head">
        <h3>요청 경로 판정 · Jev</h3>
        <span className="pill" data-ok={String(Boolean(state?.jev && state.key))} role="status">
          {status}
        </span>
      </div>
      <p className="ai-intro">
        요청을 보낼 때 화면 표시·설정값·앱 동작·jig 열기로 AI 없이 처리할지 TypeSafe의 Jev가
        판정합니다. 이 PC에 Jev 키가 있을 때만 보냅니다.
      </p>
      <p className="ai-intro">
        보내는 것: 요청 글(2,000자까지, 글 속 경로·파일 이름은 지움), 화면의 객체 묶음
        이름(종류·레이어), 열린 jig의 설정값 이름·설명, jig 설명, 연결 파일의 역할 이름(Rhino 모델
        1·CAD 1), 앱 동작 이름.
      </p>
      <p className="ai-intro">
        보내지 않는 것: 파일 이름·경로·폴더 이름, 프로젝트 자료 본문, 형상, 계정 주소, 로그인 코드.
        판정 기록에는 결과·방법·시간만 남고 글은 남지 않습니다.
      </p>
      <label>
        <input
          type="checkbox"
          aria-label="Jev에 경로 판정 보내기"
          checked={state?.jev ?? false}
          disabled={!state || saving}
          onChange={(event) => {
            void toggle(event.target.checked);
          }}
        />{' '}
        Jev에 경로 판정 보내기
      </label>
      <small>
        끄면 Jev를 부르지 않고 규칙으로만 판정합니다. 잘못 판정된 요청은 알림의 'AI 작업으로
        보내기'로 보냅니다.
      </small>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
/**
 * 작업 중 질문 받기 (PLAN-24 T-075, ADR-026 4): the AI asks with its provider's own question tool
 * inside the running turn and goes on with the answer. One switch for Claude and Codex, default on;
 * an environment variable on this PC can still force a provider off (src/ai/question-settings.ts).
 */
function QuestionsSection() {
  const [state, setState] = useState<{ native: boolean; claude: boolean; codex: boolean }>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const read = (value: unknown) => {
    const row = (value ?? {}) as { native?: unknown; forcedOff?: Record<string, unknown> };
    return {
      native: row.native === true,
      claude: row.forcedOff?.['claude-cli'] === true,
      codex: row.forcedOff?.['codex-cli'] === true,
    };
  };
  useEffect(() => {
    let live = true;
    api('/settings/questions')
      .then((value) => live && setState(read(value)))
      .catch(() => live && setMessage('질문 설정을 읽지 못했습니다.'));
    return () => {
      live = false;
    };
  }, []);
  const toggle = async (native: boolean) => {
    setSaving(true);
    try {
      setState(read(await api('/settings/questions', 'PUT', { native })));
      setMessage(
        native
          ? '다음 요청부터 AI가 작업 중에 묻고 답을 받아 이어 갑니다.'
          : '다음 요청부터 AI는 작업을 마친 뒤 질문 카드로 묻습니다.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설정을 바꾸지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };
  const forced = state
    ? [state.claude ? 'Claude Code' : '', state.codex ? 'Codex' : ''].filter(Boolean)
    : [];
  const status = !state ? '확인 중' : !state.native ? '꺼짐' : forced.length ? '일부 꺼짐' : '켜짐';
  return (
    <section className="ai-provider ai-questions" aria-label="작업 중 질문 받기">
      <div className="ai-provider-head">
        <h3>작업 중 질문 받기</h3>
        <span className="pill" data-ok={String(Boolean(state?.native))} role="status">
          {status}
        </span>
      </div>
      <p className="ai-intro">
        AI가 결과가 크게 달라지는 결정을 만나면 작업을 멈추지 않고 질문 카드로 묻고, 답을 받아 같은
        작업을 이어 갑니다. Claude Code와 Codex 모두에 적용됩니다.
      </p>
      <label>
        <input
          type="checkbox"
          aria-label="작업 중 질문 받기"
          checked={state?.native ?? false}
          disabled={!state || saving}
          onChange={(event) => {
            void toggle(event.target.checked);
          }}
        />{' '}
        작업 중 질문 받기
      </label>
      <small>
        끄면 AI는 작업을 마친 뒤 질문 카드로 묻고, 답은 다음 요청으로 이어집니다. Codex는 요청마다
        새로 실행됩니다.
      </small>
      {state?.native && forced.length > 0 && (
        <small>이 PC의 환경 변수로 꺼져 있습니다: {forced.join(', ')}</small>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
/** The addendum limit the engine enforces (src/ai/instructions/project-store.ts). */
const ADDENDUM_MAX_BYTES = 8 * 1024;
const addendumSchema = z.object({ text: z.string(), updatedAt: z.string().nullable() });
/**
 * The project's addendum to the AI instruction bundle (PLAN-24 지침 묶음): notes the AI reads as
 * data with every request of this project (terms, layer rules, preferences). The project is the
 * one the workspace opened (`?project=`, else the first).
 */
function ProjectInstructionsSection() {
  const [project, setProject] = useState<{ id: string; name: string }>();
  const [text, setText] = useState('');
  const [saved, setSaved] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    (async () => {
      const projects = z.array(projectSchema).parse(await api('/projects'));
      const wanted = new URLSearchParams(location.search).get('project');
      const current = projects.find((p) => p.id === wanted) ?? projects[0];
      if (!current) return;
      const row = addendumSchema.parse(
        await api(`/projects/${encodeURIComponent(current.id)}/ai-instructions`),
      );
      if (!live) return;
      setProject({ id: current.id, name: current.name });
      setText(row.text);
      setSaved(row.text);
    })().catch(() => live && setMessage('프로젝트 AI 지침을 읽지 못했습니다.'));
    return () => {
      live = false;
    };
  }, []);
  const size = new TextEncoder().encode(text).length;
  const save = async () => {
    if (!project || saving) return;
    setSaving(true);
    try {
      const row = addendumSchema.parse(
        await api(`/projects/${encodeURIComponent(project.id)}/ai-instructions`, 'PUT', { text }),
      );
      setText(row.text);
      setSaved(row.text);
      setMessage('저장했습니다. 다음 요청부터 적용됩니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '지침을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="ai-provider ai-instructions" aria-label="프로젝트 AI 지침">
      <div className="ai-provider-head">
        <h3>프로젝트 AI 지침{project ? ` · ${project.name}` : ''}</h3>
      </div>
      <p className="ai-intro">
        이 프로젝트의 AI 요청마다 함께 보내는 참고 사항입니다. 용어, 레이어·이름 규칙, 단위, 선호를
        적어 두세요. AI는 참고 자료로만 읽고, VIDE의 권한·대상·반영 규칙은 바뀌지 않습니다.
      </p>
      <textarea
        aria-label="프로젝트 AI 지침"
        rows={6}
        style={{ width: '100%', boxSizing: 'border-box' }}
        disabled={!project || saving}
        value={text}
        placeholder="예: 구조 레이어는 STR:: 아래에 둔다. 치수는 mm로 답한다."
        onChange={(event) => setText(event.target.value)}
      />
      <div className="table-controls">
        <small>
          {size.toLocaleString()} / {ADDENDUM_MAX_BYTES.toLocaleString()} 바이트
        </small>
        <button
          disabled={!project || saving || size > ADDENDUM_MAX_BYTES || text === saved}
          onClick={() => {
            void save();
          }}
        >
          지침 저장
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
/**
 * Reference image check (SPEC-09.7 6, 09.10 1): images go to OpenAI too (the image job is always
 * Codex), and the project's switch for the image job. The board's own switch is the same setting.
 */
function ReferenceImagesSection() {
  const [project, setProject] = useState<{ id: string; name: string }>();
  const [images, setImages] = useState<boolean>();
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    (async () => {
      const projects = z.array(projectSchema).parse(await api('/projects'));
      const wanted = new URLSearchParams(location.search).get('project');
      const current = projects.find((p) => p.id === wanted) ?? projects[0];
      if (!current) return;
      const row = z
        .object({ images: z.boolean() })
        .parse(await api(`/projects/${encodeURIComponent(current.id)}/reference-settings`));
      if (!live) return;
      setProject({ id: current.id, name: current.name });
      setImages(row.images);
    })().catch(() => live && setUnavailable(true));
    return () => {
      live = false;
    };
  }, []);
  const toggle = async (on: boolean) => {
    if (!project) return;
    setSaving(true);
    try {
      const row = z.object({ images: z.boolean() }).parse(
        await api(`/projects/${encodeURIComponent(project.id)}/reference-settings`, 'PUT', {
          images: on,
        }),
      );
      setImages(row.images);
      setMessage(
        row.images
          ? '다음 판부터 우리 건물에 입혀 본 이미지를 만듭니다.'
          : '이미지를 만들지 않습니다. 진행 중인 생성도 멈춥니다.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '설정을 바꾸지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };
  // An engine without project data (no boards) has no such setting.
  if (unavailable) return null;
  return (
    <section className="ai-provider ai-reference-images" aria-label="참고 이미지 확인">
      <div className="ai-provider-head">
        <h3>참고 이미지 확인 · 이미지 생성{project ? ` · ${project.name}` : ''}</h3>
      </div>
      <p className="ai-intro">
        참고 이미지와 영역은 해석을 맡은 대화의 AI로 갑니다. 확인 보드의 &apos;우리 건물에 입혀 본
        이미지&apos;는 대화의 AI와 상관없이 항상 Codex(ChatGPT 로그인)로 만들므로, 3D 뷰 캡처와
        영역을 그린 참고 이미지가 OpenAI로도 갑니다. 생성은 ChatGPT 요금제 사용량을 쓰고, 원격
        세션에서는 만들지 않습니다.
      </p>
      <label>
        <input
          type="checkbox"
          aria-label="참고 이미지 확인에서 이미지 생성"
          checked={images ?? false}
          disabled={images === undefined || saving}
          onChange={(event) => {
            void toggle(event.target.checked);
          }}
        />{' '}
        이 프로젝트에서 이미지 생성
      </label>
      <small>
        끄면 확인 보드의 오른쪽은 &apos;이미지 생성 꺼짐&apos;이고 말풍선 판만 만듭니다.
      </small>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
const dialog = document.createElement('dialog');
dialog.className = 'quantity-dialog ai-settings';
dialog.setAttribute('aria-label', 'AI 연결 설정');
document.body.append(dialog);
const root = createRoot(dialog);
let generation = 0;
interface Props {
  config: AiSettingsResponse;
  current: number;
  onStatus?: (rows: ProviderStatus) => void;
}
function Settings({ config, current, onStatus }: Props) {
  const [revision, setRevision] = useState(config.revision);
  const [paths, setPaths] = useState(config.paths);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  const [states, setStates] = useState<Partial<Record<Provider, string>>>({});
  const isCurrent = () => current === generation;
  const close = () => {
    generation++;
    dialog.close();
    root.render(null);
  };
  const verify = async () => {
    setChecking(true);
    try {
      const rows = providerStatusSchema.parse(await api('/providers'));
      if (!isCurrent()) return;
      setStates(
        Object.fromEntries(
          rows.map((row) => [
            row.id,
            row.available
              ? '구독 로그인 확인됨'
              : errorLabels[row.reason ?? ''] || '로그인 또는 실행 상태를 확인하세요.',
          ]),
        ),
      );
      onStatus?.(rows);
    } catch (error) {
      if (isCurrent())
        setStatus(error instanceof Error ? error.message : '연결을 확인하지 못했습니다.');
    } finally {
      if (isCurrent()) setChecking(false);
    }
  };
  useEffect(() => {
    void verify();
  }, []);
  useEffect(() => {
    const cancel = (event: Event) => {
      event.preventDefault();
      if (!saving) close();
    };
    dialog.addEventListener('cancel', cancel);
    return () => dialog.removeEventListener('cancel', cancel);
  }, [saving]);
  const save = async () => {
    if (saving || checking) return;
    setSaving(true);
    try {
      const saved = aiSettingsSchema.parse(
        await api('/settings/ai', 'PUT', {
          revision,
          paths: Object.fromEntries(
            providers.map((provider) => [provider, paths[provider]?.trim() || null]),
          ),
        }),
      );
      if (!isCurrent()) return;
      setRevision(saved.revision);
      setStatus('설정을 저장했습니다. 다음 요청부터 적용됩니다.');
      await verify();
    } catch (error) {
      if (isCurrent())
        setStatus(error instanceof Error ? error.message : '설정을 저장하지 못했습니다.');
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };
  return (
    <>
      <div className="quantity-head">
        <h2>AI 연결</h2>
        <button disabled={saving} onClick={close}>
          닫기
        </button>
      </div>
      <p className="ai-intro">
        요청은 이 PC에서 공식 Claude Code·Codex CLI가 지금 로그인된 구독 계정으로 실행합니다. 계정
        추가·로그인·전환은 AccountSwitch에서 하고, 현재 계정과 사용량은 설정 → AI에서 봅니다.
      </p>
      {providers.map((provider) => {
        const label = provider === 'claude-cli' ? 'Claude Code' : 'Codex · ChatGPT';
        const connected = states[provider] === '구독 로그인 확인됨';
        return (
          <section key={provider} className="ai-provider">
            <div className="ai-provider-head">
              <h3>{label}</h3>
              <span className="pill" data-ok={String(connected)} role="status">
                {states[provider] || '연결 확인 전'}
              </span>
            </div>
            <details className="ai-advanced">
              <summary>고급 · 실행 파일 경로</summary>
              <input
                aria-label={`${label} 실행 경로`}
                disabled={saving}
                value={paths[provider] ?? ''}
                placeholder={config.resolved[provider] || '실행 파일 전체 경로'}
                onChange={(event) =>
                  setPaths((previous) => ({ ...previous, [provider]: event.target.value }))
                }
              />
              <small>비워 두면 설치된 CLI를 자동으로 찾습니다.</small>
            </details>
          </section>
        );
      })}
      <RoutingSection />
      <QuestionsSection />
      <ProjectInstructionsSection />
      <ReferenceImagesSection />
      <div className="table-controls">
        <button
          disabled={saving || checking}
          onClick={() => {
            void save();
          }}
        >
          설정 저장
        </button>
        <button
          disabled={saving || checking}
          onClick={() => {
            void verify();
          }}
        >
          연결 확인
        </button>
      </div>
      <p role="status">{status}</p>
      <small>
        로그인은 터미널이나 AccountSwitch에서 합니다. 경로 변경은 다음 요청부터 적용됩니다.
      </small>
    </>
  );
}
export async function showAiSettings(onStatus?: (rows: ProviderStatus) => void): Promise<void> {
  const current = ++generation;
  const config = aiSettingsResponseSchema.parse(await api('/settings/ai'));
  if (current !== generation) return;
  root.render(<Settings key={current} config={config} current={current} onStatus={onStatus} />);
  if (!dialog.open) dialog.showModal();
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    generation++;
    root.unmount();
  }
});
