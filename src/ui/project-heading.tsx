import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { iconSvg } from './inspector.ts';

// Project switcher. New and rename use an inline field: browser prompt() dialogs are blocked in
// embedded browsers, which silently dropped new projects and names.
interface Project {
  id: string;
  name: string;
}
/** A project shared with this PC's account (ADR-037 1): opens as a remote project. */
interface SharedProject extends Project {
  ownerName?: string | null;
  hostOnline?: boolean;
}
interface Props {
  projects: Project[];
  shared?: SharedProject[];
  selected: string;
  select: (id: string) => void;
  create: (name: string) => Promise<void>;
  rename: (name: string) => Promise<void>;
  /** Deletes the selected project and its data; called only after the inline confirmation. */
  remove: () => Promise<void>;
}
function ProjectHeading({
  projects,
  shared = [],
  selected,
  select,
  create,
  rename,
  remove,
}: Props) {
  const [editing, setEditing] = useState<'new' | 'rename' | 'delete' | null>(null),
    [value, setValue] = useState(''),
    [busy, setBusy] = useState(false);
  const current = projects.find((project) => project.id === selected);
  if (editing === 'delete')
    return (
      <div
        className="project-edit project-delete"
        role="alertdialog"
        aria-label="프로젝트 삭제 확인"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(null);
        }}
      >
        <span
          className="project-delete-text"
          title="요청·연결 파일 기록·지그·대화가 함께 삭제되며 되돌릴 수 없습니다. 사용자의 원본 파일은 그대로 둡니다."
        >
          ‘{current?.name}’ 삭제할까요?
        </span>
        <button
          id="confirm-delete-project"
          className="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void remove().finally(() => {
              setBusy(false);
              setEditing(null);
            });
          }}
        >
          삭제
        </button>
        <button type="button" autoFocus onClick={() => setEditing(null)} title="취소 · Esc">
          취소
        </button>
      </div>
    );
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
      <select
        id="project-picker"
        aria-label="프로젝트"
        value={selected}
        onChange={(event) => select(event.target.value)}
      >
        {shared.length ? (
          <optgroup label="이 PC의 프로젝트">
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </optgroup>
        ) : (
          projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))
        )}
        {shared.length ? (
          <optgroup label="공유받은 프로젝트">
            {shared.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
                {project.ownerName ? ` · ${project.ownerName}` : ''}
                {project.hostOnline === false ? ' (PC 꺼짐)' : ''}
              </option>
            ))}
          </optgroup>
        ) : null}
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
      <button
        id="delete-project"
        title="프로젝트 삭제"
        aria-label="프로젝트 삭제"
        onClick={() => setEditing('delete')}
        dangerouslySetInnerHTML={{ __html: iconSvg('trash') }}
      />
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
