import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './gateway.ts';
import { hostDocumentsSchema, hostSelectionSchema } from '../contracts/host-documents.ts';
import type { HostDocuments, HostTarget, HostSelection } from '../contracts/host-documents.ts';
interface Props {
  notify: (message: string) => void;
  onCapture: (target: HostTarget, automatic?: boolean) => Promise<boolean | void>;
  onSelection: (selection: HostSelection) => void;
}
function Documents({ notify, onCapture, onSelection }: Props) {
  const [catalog, setCatalog] = useState<HostDocuments | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const selectedRef = useRef('');
  const generations = useRef(new Map<string, number>());
  const autoFailed = useRef(false);
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
        const selection = next.documents.some((item) => key(item) === selectedRef.current)
          ? selectedRef.current
          : next.documents[0]
            ? key(next.documents[0])
            : '';
        selectedRef.current = selection;
        setSelected(selection);
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
        const captured = await onCapture({
          instance: active.instance ?? catalog.instance,
          documentId: active.id,
        });
        if (captured !== false) {
          generations.current.set(key(active), active.generation ?? 0);
          autoFailed.current = false;
          setNotice('Sync 완료');
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : '작업 사본을 가져오지 못했습니다.');
      }
    });
  useEffect(() => {
    let disposed = false,
      polling = false;
    const poll = async () => {
      if (disposed || polling || inFlight.current || document.hidden) return;
      polling = true;
      try {
        const next = hostDocumentsSchema.parse(await api('/host/attached-documents'));
        if (disposed) return;
        setCatalog((current) => ({
          ...next,
          documents: [
            ...(current?.documents.filter((d) => d.connection !== 'attached-editor') ?? []),
            ...next.documents,
          ],
        }));
        const item = next.documents.find((doc) => key(doc) === selectedRef.current);
        if (!item) {
          if (generations.current.has(selectedRef.current))
            setNotice('Rhino 연결 종료 · 기존 모델은 보존됩니다.');
          return;
        }
        if (item.connection !== 'attached-editor' || item.generation === undefined) return;
        const previous = generations.current.get(key(item)) ?? 0;
        if (item.generation <= previous || item.hostBusy || autoFailed.current) return;
        inFlight.current = true;
        setBusy(true);
        try {
          const captured = await onCapture(
            { instance: item.instance ?? next.instance, documentId: item.id },
            true,
          );
          if (captured === false)
            setNotice('자동 Sync 보류 · 초안 또는 진행 중 작업을 마친 뒤 갱신합니다.');
          else {
            generations.current.set(key(item), item.generation);
            setNotice('Sync 완료');
          }
        } catch (error) {
          autoFailed.current = true;
          setNotice(
            '자동 Sync 중단 · ' + (error instanceof Error ? error.message : '다시 Sync 하세요.'),
          );
        } finally {
          inFlight.current = false;
          if (!disposed) setBusy(false);
        }
      } catch {
        /* Transient discovery errors keep the last successful model. Manual refresh reports details. */
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [onCapture]);
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
      <small>
        기존 Rhino에서 VIDEConnect 실행 후 문서 조회 · VIDESync로 갱신 · VIDELiveSync로 자동 갱신
        켜기/끄기
      </small>
      {active?.connection === 'attached-editor' ? (
        <small>현재 Rhino 문서 연결 · Live Sync {active.live ? '켜짐' : '꺼짐'}</small>
      ) : null}
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
        aria-label="열린 호스트 문서"
        hidden={!catalog?.documents.length}
        disabled={busy}
        value={selected}
        onChange={(event) => {
          selectedRef.current = event.target.value;
          setSelected(event.target.value);
          autoFailed.current = false;
          setNotice('');
        }}
      >
        {catalog?.documents.map((item) => (
          <option key={key(item)} value={key(item)}>
            {item.name}
            {item.instance
              ? ` · ${item.host === 'zwcad' ? 'ZWCAD' : 'Rhino'} ${item.instance.split(':')[0]}`
              : ''}
          </option>
        ))}
      </select>
      <small id="host-document-info">
        {notice ||
          (active
            ? `${active.objectCount}개 객체 · ${active.units}${active.modified === null ? ' · 저장 상태 미확인' : active.modified ? ' · 저장되지 않은 변경' : ''}`
            : '연결된 열린 문서가 없습니다.')}
      </small>
      <button
        id="capture-document"
        disabled={busy || !active}
        onClick={() => {
          void capture();
        }}
      >
        Sync · 현재 모델 가져오기
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
