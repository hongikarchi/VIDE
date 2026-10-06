import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api, sessionSchema, projectsSchema, message, type Session, type Project } from './api';
import { Account } from './account';
import { Home } from './home';
import { useHosts } from './hosts';
import { Review } from './review';
import { OfflineProject } from './offline';
import { Reports } from './reports';
import { Privacy } from './privacy';
// The block editor loads only when notes are opened.
const ProjectNotes = lazy(() => import('./notes').then((m) => ({ default: m.ProjectNotes })));
import './style.css';

const displayName = (session: Session) =>
  session.user.email.endsWith('@users.vide.invalid')
    ? session.user.email.split('@')[0]
    : session.user.name || session.user.email;

function Signed({ session, signOut }: { session: Session; signOut: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null),
    [reviewing, setReviewing] = useState(
      () => new URL(location.href).searchParams.get('review') || '',
    ),
    [offlineId, setOfflineId] = useState(
      () => new URL(location.href).searchParams.get('offline') || '',
    ),
    [offlineNotice, setOfflineNotice] = useState(''),
    [reports, setReports] = useState(
      () => new URL(location.href).searchParams.get('admin') === 'reports',
    ),
    [admin, setAdmin] = useState(false),
    [notesId, setNotesId] = useState(() => new URL(location.href).searchParams.get('notes') || ''),
    [status, setStatus] = useState('');
  const { hosts, thisPc } = useHosts();
  const user = useRef(session.user.id);
  user.current = session.user.id;
  const [invitation, setInvitation] = useState(() => {
    if (location.pathname === '/invite' && location.hash) {
      const token = location.hash.slice(1);
      try {
        sessionStorage.setItem('vide-invitation', token);
      } catch {
        /* Keep token only in current memory when session storage is disabled. */
      }
      history.replaceState(null, '', '/');
      return token;
    }
    try {
      return sessionStorage.getItem('vide-invitation') || '';
    } catch {
      return '';
    }
  });
  const refresh = useCallback(async () => {
    const expected = user.current,
      value = projectsSchema.parse(await api('/projects')).projects;
    if (expected === user.current) setProjects(value);
  }, []);
  useEffect(() => {
    // Site admins see the reports page link (ADR-036).
    void api('/me')
      .then((value) =>
        setAdmin(z.object({ admin: z.boolean().optional() }).parse(value).admin === true),
      )
      .catch(() => {});
  }, []);
  useEffect(() => {
    void refresh().catch((error) => setStatus(message(error)));
    const timer = setInterval(() => void refresh().catch(() => {}), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const back = () => {
      const params = new URL(location.href).searchParams;
      setReviewing(params.get('review') || '');
      setOfflineId(params.get('offline') || '');
      setReports(params.get('admin') === 'reports');
      setNotesId(params.get('notes') || '');
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  async function accept() {
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
      await refresh();
      setStatus(
        response.status === 'pending'
          ? '참여를 신청했습니다. 소유자 승인 후 목록에 나타납니다.'
          : '공유 프로젝트에 참여했습니다.',
      );
    } catch (error) {
      setStatus(message(error));
    }
  }
  const review = projects?.find((project) => project.id === reviewing);
  const offline = review ? undefined : projects?.find((project) => project.id === offlineId);
  const notesProject =
    review || offline ? undefined : projects?.find((project) => project.id === notesId);
  return (
    <div className="site">
      <header className="topbar">
        <button
          className="wordmark"
          onClick={() => {
            setReviewing('');
            setOfflineId('');
            setReports(false);
            setNotesId('');
            history.pushState(null, '', '/');
          }}
        >
          VIDE
        </button>
        {review ? <span className="crumb">/ {review.name} · 공유 검토</span> : null}
        {offline ? <span className="crumb">/ {offline.name} · PC 없이 보기</span> : null}
        {reports ? <span className="crumb">/ 오류·성능 보고</span> : null}
        {notesProject ? <span className="crumb">/ {notesProject.name} · 노트·일지</span> : null}
        <span className="spacer" />
        {admin && !reports ? (
          <button
            className="ghost"
            onClick={() => {
              setReviewing('');
              setOfflineId('');
              setReports(true);
              history.pushState(null, '', '/?admin=reports');
            }}
          >
            오류·성능 보고
          </button>
        ) : null}
        <span className="user">{displayName(session)}</span>
        <button className="ghost" onClick={signOut}>
          로그아웃
        </button>
      </header>
      {invitation ? (
        <p className="banner">
          프로젝트 초대를 받았습니다.{' '}
          <button className="primary" onClick={() => void accept()}>
            초대 수락
          </button>
        </p>
      ) : null}
      {status ? (
        <p className="banner" role="status">
          {status}
        </p>
      ) : null}
      {reports && admin ? (
        <Reports />
      ) : review ? (
        <div className="review-page">
          <Review key={review.id} project={review} session={session} />
        </div>
      ) : offline ? (
        <OfflineProject
          key={offline.id}
          project={offline}
          pcOnline={!!hosts?.find((host) => host.id === offline.host_id)?.online}
          notice={offlineNotice}
          openNotes={(noteId) => {
            setOfflineId('');
            setNotesId(offline.id);
            history.pushState(
              null,
              '',
              '/?notes=' +
                encodeURIComponent(offline.id) +
                (noteId ? '&note=' + encodeURIComponent(noteId) : ''),
            );
          }}
        />
      ) : notesProject ? (
        <Suspense fallback={<p className="empty">불러오는 중…</p>}>
          <ProjectNotes key={notesProject.id} project={notesProject} user={displayName(session)} />
        </Suspense>
      ) : (
        <Home
          projects={projects}
          hosts={hosts}
          thisPc={thisPc}
          refresh={refresh}
          review={(project) => {
            setReviewing(project.id);
            history.pushState(null, '', '/?review=' + encodeURIComponent(project.id));
          }}
          offline={(project, notice) => {
            setOfflineNotice(notice ?? '');
            setOfflineId(project.id);
            history.pushState(null, '', '/?offline=' + encodeURIComponent(project.id));
          }}
          notes={(project) => {
            setNotesId(project.id);
            history.pushState(null, '', '/?notes=' + encodeURIComponent(project.id));
          }}
        />
      )}
    </div>
  );
}

function App() {
  // The notice page for opt-in reports is public (the PC's consent card links here).
  if (location.pathname === '/privacy') return <Privacy />;
  return <SignedApp />;
}

function SignedApp() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [status, setStatus] = useState('');
  async function refreshSession() {
    setSession(sessionSchema.parse(await api('/auth/get-session')));
  }
  useEffect(() => {
    void refreshSession()
      .catch((error) => setStatus(message(error)))
      .finally(() => setLoading(false));
    const expired = () => setSession(null);
    window.addEventListener('vide-sharing-login-required', expired);
    return () => window.removeEventListener('vide-sharing-login-required', expired);
  }, []);
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
  return (
    <Signed
      key={session.user.id}
      session={session}
      signOut={() => {
        void api('/auth/sign-out', 'POST', {})
          .then(() => setSession(null))
          .catch((error) => setStatus(message(error)));
      }}
    />
  );
}
createRoot(document.getElementById('root')!).render(<App />);
