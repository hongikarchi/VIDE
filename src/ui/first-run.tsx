// The installed program's first run (SPEC-05.6 「첫 실행」, Design SCR-26, ADR-039): the VIDE
// account sign-in before the work screen, then a project chosen or made by name. The engine does
// the sign-in (POST /remote/link, password used once); choosing reopens the page on that project.
import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api, projectSchema, sharedProjectList, type SharedProjectEntry } from './gateway.ts';
import { SITE_ORIGIN, accountStatusSchema, loginError } from './remote-panel.ts';
import { accountSwitchSchema, ACCOUNT_SWITCH_DOWNLOAD } from './account-switch-link.ts';
import './first-run.css';

type Step = 'sign-in' | 'project';
type Project = z.infer<typeof projectSchema>;
const usageSchema = z
  .object({
    accounts: z.array(
      z
        .object({ provider: z.string(), signedIn: z.boolean(), email: z.string().optional() })
        .passthrough(),
    ),
    accountSwitch: accountSwitchSchema,
  })
  .passthrough();
const settingsSchema = z
  .object({ found: z.record(z.string(), z.boolean()).optional() })
  .passthrough();
const providerName: Record<string, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
};

/** Reopens the work screen on a project (this PC's or a shared one, SPEC-04.11 3). */
const open = (id: string) =>
  location.assign(`${location.pathname}?project=${encodeURIComponent(id)}`);

/** "AI 연결 · Claude Code: a@b.com · Codex: 로그인 필요" and the AccountSwitch action. */
function AiLine() {
  const [line, setLine] = useState('AI 연결 확인 중…');
  const [accountSwitch, setAccountSwitch] = useState<z.infer<typeof accountSwitchSchema>>();
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api('/accounts/usage', 'GET', undefined, { quiet: ['NOT_FOUND'] }).then((value) =>
        usageSchema.parse(value),
      ),
      api('/settings/ai', 'GET', undefined, { quiet: ['NOT_FOUND'] })
        .then((value) => settingsSchema.parse(value))
        .catch(() => ({ found: undefined })),
    ])
      .then(([usage, settings]) => {
        if (!alive) return;
        setAccountSwitch(usage.accountSwitch);
        setLine(
          'AI 연결 · ' +
            usage.accounts
              .map(
                (row) =>
                  `${providerName[row.provider] ?? row.provider}: ${
                    settings.found?.[row.provider] === false
                      ? '설치 안 됨'
                      : row.signedIn
                        ? (row.email ?? '로그인됨')
                        : '로그인 필요'
                  }`,
              )
              .join(' · '),
        );
      })
      .catch(() => alive && setLine('AI 연결 상태를 읽지 못했습니다.'));
    return () => {
      alive = false;
    };
  }, []);
  const [opening, setOpening] = useState(false);
  return (
    <p className="first-run-ai">
      <span>{line}</span>
      {accountSwitch?.installed ? (
        <button
          type="button"
          className="first-run-secondary"
          disabled={opening}
          onClick={() => {
            setOpening(true);
            void api('/accountswitch/open', 'POST', {})
              .catch(() => {})
              .finally(() => setOpening(false));
          }}
        >
          AccountSwitch 열기
        </button>
      ) : accountSwitch ? (
        <a href={accountSwitch.download ?? ACCOUNT_SWITCH_DOWNLOAD} target="_blank" rel="noopener">
          AccountSwitch 설치
        </a>
      ) : null}
    </p>
  );
}

function SignIn({ onDone }: { onDone: (who: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('VIDE PC');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailure('');
    try {
      const status = accountStatusSchema.parse(
        await api(
          '/remote/link',
          'POST',
          { username: username.trim(), password, name: name.trim() || 'VIDE PC' },
          { quiet: Object.keys(loginError) },
        ),
      );
      setPassword('');
      onDone(`${status.username ?? username.trim()} · ${status.name ?? name.trim()}`);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      setFailure(
        loginError[code] ||
          (error instanceof Error ? error.message : '로그인하지 못했습니다. 다시 시도하세요.'),
      );
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="first-run-form" onSubmit={(event) => void submit(event)}>
      {failure ? (
        <p className="first-run-error" role="alert">
          {failure}
        </p>
      ) : null}
      <input
        aria-label="아이디"
        placeholder="아이디"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <div className="first-run-password">
        <input
          aria-label="비밀번호"
          placeholder="비밀번호"
          type={show ? 'text' : 'password'}
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          type="button"
          className="first-run-secondary"
          aria-pressed={show}
          aria-label={show ? '비밀번호 숨기기' : '비밀번호 보기'}
          onClick={() => setShow(!show)}
        >
          {show ? '숨기기' : '보기'}
        </button>
      </div>
      <label className="first-run-label">
        <input
          aria-label="PC 이름"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <small>웹사이트의 작업 PC 목록에 보일 이름</small>
      </label>
      <button type="submit" className="first-run-primary" disabled={busy}>
        {busy ? '로그인 중…' : '로그인'}
      </button>
      <small className="first-run-note">
        계정이 없으면{' '}
        <a href={SITE_ORIGIN} target="_blank" rel="noopener">
          웹사이트
        </a>
        에서 가입 코드로 만드세요.
      </small>
    </form>
  );
}

function Projects({ who }: { who: string }) {
  const [local, setLocal] = useState<Project[]>();
  const [shared, setShared] = useState<SharedProjectEntry[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let alive = true;
    void api('/projects')
      .then((value) => alive && setLocal(z.array(projectSchema).parse(value)))
      .catch(() => alive && setLocal([]));
    void sharedProjectList().then((list) => alive && setShared(list));
    return () => {
      alive = false;
    };
  }, []);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFailure('');
    try {
      open(projectSchema.parse(await api('/projects', 'POST', { name: trimmed })).id);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '프로젝트를 만들지 못했습니다.');
      setBusy(false);
    }
  };
  const empty = local !== undefined && !local.length && !shared.length;
  return (
    <>
      {who ? <p className="first-run-who">{who}</p> : null}
      {failure ? (
        <p className="first-run-error" role="alert">
          {failure}
        </p>
      ) : null}
      {local === undefined ? <p className="first-run-note">프로젝트 확인 중…</p> : null}
      {local?.length ? (
        <section aria-label="이 PC의 프로젝트">
          <h3>이 PC의 프로젝트</h3>
          <ul className="first-run-list">
            {local.map((project) => (
              <li key={project.id}>
                <button type="button" onClick={() => open(project.id)}>
                  {project.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {shared.length ? (
        <section aria-label="공유받은 프로젝트">
          <h3>공유받은 프로젝트</h3>
          <ul className="first-run-list">
            {shared.map((project) => (
              <li key={project.id}>
                <button type="button" onClick={() => open(project.id)}>
                  {project.name}
                  {project.ownerName ? ` · ${project.ownerName}` : ''}
                  {project.hostOnline === false ? ' (PC 꺼짐)' : ''}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {empty ? (
        <p className="first-run-note">아직 프로젝트가 없습니다. 이름을 넣어 만드세요.</p>
      ) : null}
      <form className="first-run-create" onSubmit={(event) => void create(event)}>
        <h3>새 프로젝트</h3>
        <div>
          <input
            aria-label="프로젝트 이름"
            placeholder="프로젝트 이름"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="first-run-primary" disabled={!name.trim() || busy}>
            만들기
          </button>
        </div>
      </form>
    </>
  );
}

function FirstRun({ start }: { start: Step }) {
  const [step, setStep] = useState<Step>(start);
  const [who, setWho] = useState('');
  useEffect(() => {
    if (start !== 'project') return;
    void api('/remote')
      .then((value) => {
        const status = accountStatusSchema.parse(value);
        if (status.linked) setWho(`${status.username ?? ''} · ${status.name ?? ''}`);
      })
      .catch(() => {});
  }, [start]);
  return (
    <main className="first-run-card" aria-label="VIDE 시작">
      <p className="first-run-mark">VIDE</p>
      {step === 'sign-in' ? (
        <>
          <h1>VIDE 계정으로 로그인</h1>
          <p className="first-run-note">
            로그인하면 이 PC의 프로젝트와 팀이 공유한 프로젝트를 열 수 있습니다. 작업 자료는 이 PC에
            남습니다.
          </p>
          <SignIn
            onDone={(next) => {
              setWho(next);
              setStep('project');
            }}
          />
        </>
      ) : (
        <>
          <h1>프로젝트 열기</h1>
          <Projects who={who} />
        </>
      )}
      <AiLine />
    </main>
  );
}

/** Replaces the work screen with the first-run screen (no work screen region loads). */
export function mountFirstRun(start: Step) {
  const element = document.createElement('div');
  element.id = 'first-run';
  document.body.appendChild(element);
  document.body.classList.add('first-run-open');
  createRoot(element).render(<FirstRun start={start} />);
}
