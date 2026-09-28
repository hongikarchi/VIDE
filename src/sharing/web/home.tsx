import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api, message, type Project } from './api';
import { HostStrip, type Host } from './hosts';

// Account home: every project of the account, recent work first. Opening one goes to the work PC
// that holds it: locally when this browser runs on that PC, otherwise through its tunnel.
const openSchema = z.object({
  hostId: z.string(),
  remote: z.string().url().nullable(),
  local: z.string().url().nullable(),
});

function ago(time: number) {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}일 전`;
  return new Date(time).toLocaleDateString();
}

interface Props {
  projects: Project[] | null;
  hosts: Host[] | null;
  thisPc: string;
  refresh: () => Promise<void>;
  review: (project: Project) => void;
}
export function Home({ projects, hosts, thisPc, refresh, review }: Props) {
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [renaming, setRenaming] = useState(''),
    [menu, setMenu] = useState(''),
    [confirmDelete, setConfirmDelete] = useState(''),
    [opening, setOpening] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.('.card-menu, .card-more')) {
        setMenu('');
        setConfirmDelete('');
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const hostOf = (project: Project) => hosts?.find((host) => host.id === project.host_id);
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const online = hosts?.filter((host) => host.online) ?? [];
      const hostId = thisPc || (online.length === 1 ? online[0].id : undefined);
      await api('/projects', 'POST', { name: name.trim(), ...(hostId ? { hostId } : {}) });
      setName('');
      setCreating(false);
      await refresh();
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function rename(project: Project, value: string) {
    setRenaming('');
    if (!value.trim() || value.trim() === project.name) return;
    try {
      await api('/projects/' + project.id, 'PATCH', { name: value.trim() });
      await refresh();
    } catch (error) {
      setStatus(message(error));
    }
  }
  async function remove(project: Project) {
    try {
      await api('/projects/' + project.id, 'DELETE');
      setMenu('');
      await refresh();
    } catch (error) {
      setStatus(message(error));
    }
  }
  async function open(project: Project) {
    if (opening) return;
    if (project.role !== 'owner') {
      review(project);
      return;
    }
    setOpening(project.id);
    setStatus('');
    try {
      const online = hosts?.filter((host) => host.online) ?? [];
      const hostId = project.host_id ?? (thisPc || online[0]?.id);
      const links = openSchema.parse(
        await api(`/projects/${project.id}/open`, 'POST', hostId ? { hostId } : {}),
      );
      const target = links.hostId === thisPc && links.local ? links.local : links.remote;
      if (!target) {
        setStatus(
          '이 기기에서 열려면 작업 PC의 VIDE 설정에서 원격 접속을 켜세요. (같은 PC에서는 바로 열립니다)',
        );
        setOpening('');
        return;
      }
      location.href = target;
    } catch (error) {
      setStatus(message(error));
      setOpening('');
    }
  }
  return (
    <main className="home">
      <section className="home-pcs">
        <HostStrip hosts={hosts} thisPc={thisPc} />
      </section>
      <div className="home-head">
        <h1>프로젝트</h1>
        {creating ? (
          <form
            className="new-project"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <input
              autoFocus
              aria-label="새 프로젝트 이름"
              placeholder="프로젝트 이름"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setCreating(false);
              }}
            />
            <button className="primary" disabled={busy || !name.trim()}>
              만들기
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              취소
            </button>
          </form>
        ) : (
          <button className="primary" onClick={() => setCreating(true)}>
            ＋ 새 프로젝트
          </button>
        )}
      </div>
      {status ? (
        <p role="alert" className="status banner">
          {status}
        </p>
      ) : null}
      {projects === null ? <p className="muted">불러오는 중…</p> : null}
      {projects?.length === 0 ? (
        <p className="muted empty-projects">
          프로젝트가 없습니다. 새 프로젝트를 만들거나, 작업 PC에서 로그인하면 그 PC의 프로젝트가
          여기에 나타납니다.
        </p>
      ) : null}
      <div className="project-grid">
        {projects?.map((project) => {
          const host = hostOf(project);
          const shared = project.role !== 'owner';
          return (
            <article
              key={project.id}
              className="project-card"
              data-opening={String(opening === project.id)}
            >
              <button
                className="card-open"
                aria-label={`${project.name} 열기`}
                disabled={!!opening}
                onClick={() => void open(project)}
              >
                <span className="thumb">
                  {project.has_thumbnail ? (
                    <img
                      alt=""
                      loading="lazy"
                      src={`/api/projects/${project.id}/thumbnail?v=${project.updated_at ?? 0}`}
                    />
                  ) : (
                    <span className="thumb-empty" aria-hidden="true">
                      {project.name.slice(0, 1)}
                    </span>
                  )}
                  {opening === project.id ? <span className="thumb-state">여는 중…</span> : null}
                </span>
              </button>
              <div className="card-meta">
                {renaming === project.id ? (
                  <input
                    autoFocus
                    aria-label="프로젝트 이름"
                    defaultValue={project.name}
                    maxLength={200}
                    onBlur={(e) => void rename(project, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenaming('');
                    }}
                  />
                ) : (
                  <strong title={project.name}>{project.name}</strong>
                )}
                <small>
                  {shared
                    ? '공유받은 프로젝트'
                    : `${ago(project.updated_at ?? project.created_at)} · ${
                        host ? `${host.name}${host.online ? '' : ' (꺼짐)'}` : 'PC 미지정'
                      }`}
                </small>
              </div>
              <button
                className="card-more"
                aria-label={`${project.name} 메뉴`}
                aria-expanded={menu === project.id}
                onClick={() => {
                  setMenu(menu === project.id ? '' : project.id);
                  setConfirmDelete('');
                }}
              >
                ⋯
              </button>
              {menu === project.id ? (
                <div className="card-menu" role="menu">
                  {!shared ? (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenu('');
                        setRenaming(project.id);
                      }}
                    >
                      이름 바꾸기
                    </button>
                  ) : null}
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenu('');
                      review(project);
                    }}
                  >
                    공유 검토
                  </button>
                  {!shared ? (
                    confirmDelete === project.id ? (
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() => void remove(project)}
                      >
                        목록에서 삭제 확인
                      </button>
                    ) : (
                      <button role="menuitem" onClick={() => setConfirmDelete(project.id)}>
                        목록에서 삭제…
                      </button>
                    )
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </main>
  );
}
