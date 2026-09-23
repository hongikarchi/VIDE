import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { hostDocumentsSchema } from '../contracts/host-documents.ts';
import type { HostDocuments, HostTarget } from '../contracts/host-documents.ts';
import { api, errors } from './gateway.ts';

const previewSchema = z.object({
  id: z.string().min(1),
  documentId: z.number().int().positive(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  mode: z.string().optional(),
});
const resultSchema = z
  .object({
    id: z.string().min(1),
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown']),
    result: z.object({ code: z.string().optional() }).passthrough().nullish(),
  })
  .passthrough();
type Preview = z.infer<typeof previewSchema>;
type ApplicationResult = z.infer<typeof resultSchema>;
interface Props {
  projectId: string;
  requestId: string;
  catalog: HostDocuments;
  sourceDocument?: HostTarget;
  onResult: (result: ApplicationResult) => void;
}
const dialog = document.createElement('dialog');
dialog.className = 'quantity-dialog application-dialog';
dialog.setAttribute('aria-label', '호스트 원본 적용');
document.body.append(dialog);
const root = createRoot(dialog);
let opening = 0,
  busy = false;
const message = (error: unknown) =>
  error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
function Application({ projectId, requestId, catalog, sourceDocument, onResult }: Props) {
  const key = (doc: HostDocuments['documents'][number]) =>
    doc.instance ? doc.instance + '/' + doc.id : String(doc.id);
  const documents = catalog.documents.filter(
    (doc) =>
      !sourceDocument ||
      ((doc.instance ?? catalog.instance) === sourceDocument.instance &&
        doc.id === sourceDocument.documentId),
  );
  const [target, setTarget] = useState(documents[0] ? key(documents[0]) : ''),
    [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState(false),
    [sent, setSent] = useState(false);
  const [info, setInfo] = useState(
    documents.length
      ? '적용할 문서를 고르고 영향 범위를 확인하세요.'
      : '열린 호스트 문서가 없습니다.',
  );
  const locked = useRef(false),
    submitted = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const lock = () => {
    locked.current = true;
    busy = true;
    setPending(true);
  };
  const unlock = () => {
    locked.current = false;
    busy = false;
    if (alive.current) setPending(false);
  };
  async function inspect() {
    const selected = documents.find((doc) => key(doc) === target);
    if (locked.current || submitted.current || !selected) return;
    lock();
    setPreview(null);
    try {
      const next = previewSchema.parse(
        await api(`/projects/${projectId}/applications`, 'POST', {
          requestId,
          instance: selected.instance ?? catalog.instance,
          documentId: selected.id,
        }),
      );
      if (next.documentId !== selected.id)
        throw new Error('문서 연결이 바뀌었습니다. 다시 확인하세요.');
      if (!alive.current) return;
      setPreview(next);
      setInfo(
        `추가 ${next.added} · 수정 ${next.updated} · 삭제 ${next.removed}개. ${next.mode === 'sdk-native' ? '취득한 문서의 검토한 형상·속성을 반영합니다.' : next.mode === 'native-move' ? '취득한 원본의 이동 대상만 변경합니다.' : '이 프로젝트가 소유한 객체만 수정·삭제합니다.'}`,
      );
    } catch (error) {
      if (alive.current) setInfo('영향 검토 실패: ' + message(error));
    } finally {
      unlock();
    }
  }
  async function apply() {
    if (locked.current || submitted.current || !preview) return;
    submitted.current = true;
    setSent(true);
    lock();
    setInfo('선택한 문서에 반영 중…');
    try {
      const result = resultSchema.parse(
        await api(`/projects/${projectId}/applications/${preview.id}`, 'POST', {}),
      );
      if (result.id !== preview.id) throw new Error('적용 결과의 요청이 일치하지 않습니다.');
      if (!alive.current) return;
      const labels: Record<string, string> = errors;
      setInfo(
        result.state === 'succeeded'
          ? '문서 반영 완료 · 파일은 아직 저장하지 않았습니다.'
          : result.state === 'failed'
            ? '적용하지 못했습니다: ' +
              (labels[result.result?.code ?? ''] || result.result?.code || result.state)
            : '결과 미확인 · 이 문서의 추가 적용을 보류합니다.',
      );
      onResult(result);
    } catch (error) {
      if (alive.current) setInfo('적용 상태 확인 필요: ' + message(error));
    } finally {
      unlock();
    }
  }
  return (
    <>
      <div className="quantity-head">
        <h2>
          {documents.find((doc) => key(doc) === target)?.host === 'zwcad' ? 'ZWCAD' : 'Rhino'}{' '}
          문서에 적용
        </h2>
        <button
          disabled={pending}
          onClick={() => {
            if (!locked.current) dialog.close();
          }}
        >
          닫기
        </button>
      </div>
      <p>선택한 열린 문서에 이 후보를 반영합니다. 파일 저장은 해당 호스트에서 별도로 수행합니다.</p>
      <select
        aria-label="적용할 호스트 문서"
        value={target}
        disabled={pending || sent || !!sourceDocument || !documents.length}
        onChange={(event) => {
          setTarget(event.target.value);
          setPreview(null);
          setInfo('새 대상의 영향 범위를 다시 확인하세요.');
        }}
      >
        {documents.map((doc) => (
          <option key={key(doc)} value={key(doc)}>
            {doc.name} · {doc.objectCount}개 객체 · {doc.units}
          </option>
        ))}
      </select>
      <button disabled={pending || sent || !documents.length} onClick={inspect}>
        영향 검토
      </button>
      <p role="status">{info}</p>
      <button disabled={pending || sent || !preview} onClick={apply}>
        검토한 변경 적용
      </button>
    </>
  );
}
dialog.addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
dialog.addEventListener('close', () => {
  opening++;
  root.render(null);
});
export async function showApplication(
  projectId: string,
  requestId: string,
  onResult: Props['onResult'],
  sourceDocument?: HostTarget,
): Promise<void> {
  if (busy) return;
  const generation = ++opening,
    catalog = hostDocumentsSchema.parse(await api('/host/documents'));
  if (generation !== opening || busy) return;
  root.render(
    <Application
      key={generation}
      {...{ projectId, requestId, onResult, sourceDocument, catalog }}
    />,
  );
  if (!dialog.open) dialog.showModal();
}
