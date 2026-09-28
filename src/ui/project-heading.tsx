import { createRoot } from 'react-dom/client';

interface Project {
  id: string;
  name: string;
}
interface Props {
  projects: Project[];
  selected: string;
  select: (id: string) => void;
  create: () => Promise<void>;
}
function ProjectHeading({ projects, selected, select, create }: Props) {
  return (
    <>
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
        id="new-project"
        title="새 프로젝트"
        aria-label="새 프로젝트"
        onClick={() => {
          void create();
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
