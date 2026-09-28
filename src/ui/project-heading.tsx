import { useState } from 'react';
import { createRoot } from 'react-dom/client';

// Project switcher. New and rename use an inline field: browser prompt() dialogs are blocked in
// embedded browsers, which silently dropped new projects and names.
interface Project {
  id: string;
  name: string;
}
interface Props {
  projects: Project[];
  selected: string;
  select: (id: string) => void;
  create: (name: string) => Promise<void>;
  rename: (name: string) => Promise<void>;
  /** Account website of this PC, when signed in: link back to all projects. */
  site?: string;
}
function ProjectHeading({ projects, selected, select, create, rename, site }: Props) {
  const [editing, setEditing] = useState<'new' | 'rename' | null>(null),
    [value, setValue] = useState(''),
    [busy, setBusy] = useState(false);
  const current = projects.find((project) => project.id === selected);
  if (editing)
    return (
      <form
        className="project-edit"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !value.trim()) return;
          setBusy(true);
          void (editing === 'new' ? create(value.trim()) : rename(value.trim())).finally(() => {
            setBusy(false);
            setEditing(null);
          });
        }}
      >
        <input
          id="project-name"
          autoFocus
          aria-label={editing === 'new' ? '새 프로젝트 이름' : '프로젝트 이름'}
          placeholder={editing === 'new' ? '새 프로젝트 이름' : '프로젝트 이름'}
          maxLength={200}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(null);
          }}
        />
        <button type="submit" disabled={busy || !value.trim()} title="저장 · Enter">
          ✓
        </button>
        <button type="button" onClick={() => setEditing(null)} title="취소 · Esc">
          ✕
        </button>
      </form>
    );
  return (
    <>
      {site ? (
        <a
          className="project-home"
          href={site}
          title="모든 프로젝트 (웹사이트)"
          aria-label="모든 프로젝트"
        >
          ⌂
        </a>
      ) : null}
      <select
        id="project-picker"
        aria-label="프로젝트"
        value={selected}
        onChange={(event) => select(event.target.value)}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <button
        id="rename-project"
        title="프로젝트 이름 바꾸기"
        aria-label="프로젝트 이름 바꾸기"
        onClick={() => {
          setValue(current?.name ?? '');
          setEditing('rename');
        }}
      >
        ✎
      </button>
      <button
        id="new-project"
        title="새 프로젝트"
        aria-label="새 프로젝트"
        onClick={() => {
          setValue('');
          setEditing('new');
        }}
      >
        ＋
      </button>
    </>
  );
}
const element = document.getElementById('project-heading');
if (!element) throw new Error('Project heading mount is missing');
const root = createRoot(element);
export function renderProjectHeading(props: Props): void {
  root.render(<ProjectHeading {...props} />);
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) root.unmount();
});
