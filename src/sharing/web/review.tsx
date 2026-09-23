import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  api,
  ApiError,
  publicationSchema,
  loadScene,
  message,
  type Project,
  type Session,
  type Publication,
  type Scene,
} from './api';
const Model = lazy(() => import('./model').then((module) => ({ default: module.Model })));
import { Comments, type CommentInputHandle } from './comments';
import type { SpatialDraft } from './model';
import { Admin } from './admin';
import { Publish } from './publish';

export function Review({ project, session }: { project: Project; session: Session }) {
  const [publication, setPublication] = useState<Publication | null>(null),
    [scene, setScene] = useState<Scene | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [status, setStatus] = useState('불러오는 중…'),
    [requested, setRequested] = useState('current'),
    [versions, setVersions] = useState<
      { id: string; published_at: number | null; state: string }[]
    >([]);
  const base = `/projects/${project.id}/publications`;
  const [revision, setRevision] = useState(0);
  const input = useRef<CommentInputHandle | null>(null),
    [draft, setDraft] = useState<SpatialDraft>({}),
    [evidence, setEvidence] = useState<SpatialDraft | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setPublication(null);
    setScene(null);
    setSelected(null);
    setDraft({});
    setEvidence(null);
    setStatus('불러오는 중…');
    void api(base + '/' + requested)
      .then(async (value) => {
        const published = publicationSchema.parse(value),
          model = await loadScene(project.id, published, controller.signal);
        if (!controller.signal.aborted) {
          setPublication(published);
          setScene(model);
          setStatus('');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setStatus(
            error instanceof ApiError && error.code === 'PUBLICATION_NOT_FOUND'
              ? '아직 공유된 게시본이 없거나 열람 권한이 없습니다.'
              : message(error),
          );
      });
    void api(base)
      .then((value) => {
        const parsed = z
          .object({
            publications: z.array(
              z.object({ id: z.string(), published_at: z.number().nullable(), state: z.string() }),
            ),
          })
          .parse(value);
        if (!controller.signal.aborted)
          setVersions(parsed.publications.filter((p) => p.state === 'published'));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [base, project.id, requested, revision]);
  const object = scene?.objects.find((object) => object.id === selected);
  return (
    <main className="review">
      <section className="review-center">
        <header className="review-heading">
          <h1>{publication?.manifest.title || project.name}</h1>
          {publication ? (
            <small>{new Date(publication.publishedAt).toLocaleString('ko-KR')} 게시</small>
          ) : null}
          {versions.length > 1 ? (
            <select
              aria-label="게시본 선택"
              value={requested}
              onChange={(e) => setRequested(e.target.value)}
            >
              <option value="current">최신 게시본</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {new Date(version.published_at!).toLocaleString('ko-KR')}
                </option>
              ))}
            </select>
          ) : null}
        </header>
        {scene ? (
          <Suspense fallback={<p className="empty">3D 뷰어 준비 중…</p>}>
            <Model
              model={scene}
              selected={selected}
              onSelect={setSelected}
              editable={project.role !== 'viewer'}
              draft={{
                ...(evidence || draft),
                pending: draft.pending,
                interrupted: draft.interrupted,
              }}
              onPin={(pin, id) => {
                setEvidence(null);
                input.current?.pin(pin, id);
              }}
              onSketch={(sketch) => {
                setEvidence(null);
                input.current?.sketch(sketch);
              }}
              onInterrupted={(sketch) => {
                setEvidence(null);
                input.current?.interrupted(sketch);
              }}
            />
          </Suspense>
        ) : (
          <p className="empty" role="status">
            {status}
          </p>
        )}
        {evidence ? (
          <button onClick={() => setEvidence(null)}>저장된 공간 의견 표시 닫기</button>
        ) : null}
        {scene ? (
          <div className="selection">
            <select
              aria-label="객체 선택"
              value={selected || ''}
              onChange={(e) => setSelected(e.target.value || null)}
            >
              <option value="">객체 선택</option>
              {scene.objects.map((object) => (
                <option key={object.id} value={object.id}>
                  {object.name || object.id}
                </option>
              ))}
            </select>
            {object?.measurements?.area !== undefined ? (
              <small>{object.measurements.area.toLocaleString()} m²</small>
            ) : null}
            {object?.measurements?.volume !== undefined ? (
              <small>{object.measurements.volume.toLocaleString()} m³</small>
            ) : null}
          </div>
        ) : null}
      </section>
      <aside className="comments">
        {publication ? (
          <Comments
            key={publication.id}
            project={project}
            publicationId={publication.id}
            session={session}
            selected={selected}
            inputRef={input}
            onDraft={setDraft}
            onEvidence={setEvidence}
          />
        ) : null}
        {project.role === 'owner' ? (
          <>
            <Publish
              project={project}
              session={session}
              onPublished={() => {
                setRequested('current');
                setRevision((value) => value + 1);
              }}
            />
            <Admin project={project} />
          </>
        ) : null}
      </aside>
    </main>
  );
}
