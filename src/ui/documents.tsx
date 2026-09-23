import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './gateway.ts';
import { hostDocumentsSchema, hostSelectionSchema } from '../contracts/host-documents.ts';
import type { HostDocuments, HostTarget, HostSelection } from '../contracts/host-documents.ts';
interface Props {
  notify: (message: string) => void;
  onCapture: (target: HostTarget) => Promise<void>;
  onSelection: (selection: HostSelection) => void;
}
function Documents({ notify, onCapture, onSelection }: Props) {
  const [catalog, setCatalog] = useState<HostDocuments | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState('조회한 문서를 표시합니다.');
  const key = (item: HostDocuments['documents'][number]) =>
    item.instance ? item.instance + '/' + item.id : String(item.id);
  const active = catalog?.documents.find((item) => key(item) === selected);
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const refresh = () =>
    run(async () => {
      setNotice('문서 조회 중');
      try {
        const next = hostDocumentsSchema.parse(await api('/host/documents'));
        setCatalog(next);
        setSelected(next.documents[0] ? key(next.documents[0]) : '');
        setNotice(next.documents.length ? '' : '연결된 열린 문서가 없습니다.');
      } catch (error) {
        setCatalog(null);
        setSelected('');
        setNotice(error instanceof Error ? error.message : '문서를 조회하지 못했습니다.');
      }
    });
  const capture = () =>
    run(async () => {
      if (!catalog || !active) return;
      try {
        await onCapture({ instance: active.instance ?? catalog.instance, documentId: active.id });
      } catch (error) {
        notify(error instanceof Error ? error.message : '작업 사본을 가져오지 못했습니다.');
      }
    });
  const selection = () =>
    run(async () => {
      if (!catalog || !active) return;
      const target = { instance: active.instance ?? catalog.instance, documentId: active.id };
      try {
        const result = hostSelectionSchema.parse(
          await api(
            `/host/selection?instance=${encodeURIComponent(target.instance)}&document=${target.documentId}`,
          ),
        );
        if (result.instance !== target.instance || result.documentId !== target.documentId)
          throw new Error('문서 연결이 바뀌었습니다. 다시 조회하세요.');
        onSelection(result);
      } catch (error) {
        notify(error instanceof Error ? error.message : '선택을 조회하지 못했습니다.');
      }
    });
  return (
    <>
      <button
        id="refresh-documents"
        disabled={busy}
        onClick={() => {
          void refresh();
        }}
      >
        문서 조회
      </button>
      <select
        id="host-documents"
        aria-label="열린 Rhino 문서"
        hidden={!catalog?.documents.length}
        disabled={busy}
        value={selected}
        onChange={(event) => {
          setSelected(event.target.value);
          setNotice('');
        }}
      >
        {catalog?.documents.map((item) => (
          <option key={key(item)} value={key(item)}>
            {item.name}
            {item.instance ? ` · Rhino ${item.instance.split(':')[0]}` : ''}
          </option>
        ))}
      </select>
      <small id="host-document-info">
        {notice ||
          (active
            ? `${active.objectCount}개 객체 · ${active.units}${active.modified ? ' · 저장되지 않은 변경' : ''}`
            : '연결된 열린 문서가 없습니다.')}
      </small>
      <button
        id="capture-document"
        disabled={busy || !active}
        onClick={() => {
          void capture();
        }}
      >
        작업 사본 가져오기
      </button>
      <button
        id="inspect-selection"
        disabled={busy || !active}
        onClick={() => {
          void selection();
        }}
      >
        선택을 요청에 첨부
      </button>
    </>
  );
}
export function initializeDocuments(
  notify: Props['notify'],
  onCapture: Props['onCapture'],
  onSelection: Props['onSelection'],
): void {
  const element = document.getElementById('host-document-controls');
  if (!element) throw new Error('Host document mount is missing');
  const root = createRoot(element);
  root.render(<Documents notify={notify} onCapture={onCapture} onSelection={onSelection} />);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) root.unmount();
  });
}
