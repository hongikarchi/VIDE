import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api, sessionSchema, projectsSchema, message, type Session, type Project } from './api';
import { Account } from './account';
import { Review } from './review';
import './style.css';

function App() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [projects, setProjects] = useState<Project[]>([]),
    [selected, setSelected] = useState(new URL(location.href).searchParams.get('project') || ''),
    [name, setName] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const currentUser = useRef(session?.user.id);
  currentUser.current = session?.user.id;
  const [invitation, setInvitation] = useState(() => {
    if (location.pathname === '/invite' && location.hash) {
      const token = location.hash.slice(1);
      try {
        sessionStorage.setItem('vide-invitation', token);
      } catch {
        /* Keep token only in current memory when session storage is disabled. */
      }
      history.replaceState(null, '', '/invite');
      return token;
    }
    try {
      return sessionStorage.getItem('vide-invitation') || '';
    } catch {
      return '';
    }
  });
  async function refreshSession() {
    setSession(sessionSchema.parse(await api('/auth/get-session')));
  }
  async function refreshProjects() {
    const expected = currentUser.current,
      value = projectsSchema.parse(await api('/projects')).projects;
    if (expected === currentUser.current) setProjects(value);
  }
  useEffect(() => {
    void refreshSession()
      .catch((error) => setStatus(message(error)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    let active = true;
    if (session)
      void api('/projects')
        .then((value) => {
          if (active) setProjects(projectsSchema.parse(value).projects);
        })
        .catch((error) => {
          if (active) setStatus(message(error));
        });
    else setProjects([]);
    return () => {
      active = false;
    };
  }, [session]);
  useEffect(() => {
    const expired = () => setSession(null);
    window.addEventListener('vide-sharing-login-required', expired);
    return () => window.removeEventListener('vide-sharing-login-required', expired);
  }, []);
  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const project = z.object({ id: z.string() }).parse(await api('/projects', 'POST', { name }));
      await refreshProjects();
      setSelected(project.id);
      setName('');
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    if (busy) return;
    setBusy(true);
    try {
      const response = z
        .object({ project_id: z.string().optional(), status: z.string().optional() })
        .parse(await api('/invitations/accept', 'POST', { token: invitation }));
      setInvitation('');
      try {
        sessionStorage.removeItem('vide-invitation');
      } catch {
        /* Acceptance is authoritative; repeated acceptance is idempotent. */
      }
      await refreshProjects();
      if (response.project_id) setSelected(response.project_id);
      setStatus(
        response.status === 'pending'
          ? '참여를 신청했습니다. 소유자 승인 후 새로고침해 주세요.'
          : '프로젝트에 참여했습니다.',
      );
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <p className="empty" role="status">
        불러오는 중…
      </p>
    );
  if (!session)
    return (
      <>
        <Account onLogin={refreshSession} />
        {status ? (
          <p role="alert" className="empty">
            {status}
          </p>
        ) : null}
      </>
    );
  const project = projects.find((project) => project.id === selected);
  return (
    <div className="shell">
      <aside className="project-panel">
        <div className="brand">V.</div>
        <nav aria-label="프로젝트">
          {projects.map((project) => (
            <button
              key={project.id}
              aria-pressed={selected === project.id}
              onClick={() => {
                setSelected(project.id);
                history.replaceState(null, '', '/?project=' + encodeURIComponent(project.id));
              }}
            >
              {project.name}
            </button>
          ))}
        </nav>
        {invitation ? (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              void accept();
            }}
          >
            프로젝트 초대 수락
          </button>
        ) : null}
        <details>
          <summary>새 공유 프로젝트</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <input
              aria-label="새 프로젝트 이름"
              placeholder="프로젝트 이름"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button disabled={busy}>만들기</button>
          </form>
        </details>
        <p role="status" className="status">
          {status}
        </p>
        <div className="account-menu">
          <p className="muted">{session.user.name}</p>
          <button
            onClick={() => {
              void api('/auth/sign-out', 'POST', {})
                .then(() => {
                  setSession(null);
                  setSelected('');
                })
                .catch((error) => setStatus(message(error)));
            }}
          >
            로그아웃
          </button>
        </div>
      </aside>
      {project ? (
        <Review key={project.id} project={project} session={session} />
      ) : (
        <p className="empty">프로젝트를 선택해 주세요.</p>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
