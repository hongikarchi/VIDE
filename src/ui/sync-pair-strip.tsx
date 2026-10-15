// 파일 지도의 동기화 쌍 띠 (PLAN-54 T-349, SPEC-01.13 11, Design SCR-47 '파일 지도의 쌍 지정'): pressing
// a Rhino↔CAD Sync line shows one recessed line by the map — the two files and [동기화 쌍으로 지정],
// or for a designated pair '동기화 쌍 · 지정한 사람 · 시각' and [쌍 해제] (one confirmation). A pair
// that cannot be watched shows a warning line and [Sync jig 열기]. Only a person's press designates.
import { useCallback, useEffect, useState } from 'react';
import { setWorkspace } from './workspaces.ts';
import {
  designatePair,
  listPairs,
  PAIR_STATUS_TEXT,
  pairOf,
  removePair,
  timeText,
  type SyncPairView,
} from './sync-pairs-api.ts';

/** The project's designated pairs, read again after a change. */
export function useSyncPairs(projectId: string | undefined) {
  const [pairs, setPairs] = useState<SyncPairView[]>([]);
  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setPairs(await listPairs(projectId));
    } catch {
      /* the map still shows without the pairs */
    }
  }, [projectId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { pairs, reload };
}

const WARN = new Set<SyncPairView['status']>([
  'no-relation',
  'both-changed',
  'error',
  'file-missing',
]);
const REFUSED: Record<string, string> = {
  PAIR_NOT_COMPARED: 'Sync jig로 두 파일을 비교하고 짝을 기록한 뒤 지정하세요',
  PAIR_EXISTS: '이미 동기화 쌍입니다',
  PAIR_NOT_FOUND: '이미 해제된 쌍입니다',
  FORBIDDEN: '작업 PC의 VIDE에서 지정하세요',
};

export function SyncPairStrip({
  projectId,
  model,
  drawing,
  pairs,
  remote,
  onChanged,
  onClose,
}: {
  projectId: string;
  model: { name: string; path: string | null };
  drawing: { name: string; path: string | null };
  pairs: readonly SyncPairView[];
  remote: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const pair = pairOf(pairs, model.path, drawing.path);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      await work();
      onChanged();
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      setNotice(REFUSED[code] ?? '바꾸지 못했습니다');
    } finally {
      setBusy(false);
    }
  };
  const warn = pair && WARN.has(pair.status) ? PAIR_STATUS_TEXT[pair.status] : undefined;
  return (
    <div className="sync-pair-strip" role="group" aria-label="동기화 쌍">
      <p className="sync-pair-line">
        {pair ? (
          <span>
            {model.name} ↔ {drawing.name} · 동기화 쌍 ·{' '}
            {pair.createdBy === 'user' ? '이 PC' : pair.createdBy} · {timeText(pair.createdAt)}
          </span>
        ) : (
          <span>
            {model.name} ↔ {drawing.name}
          </span>
        )}
        {remote ? (
          <span className="sync-pair-note">작업 PC의 VIDE에서 지정하세요</span>
        ) : pair ? (
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => {
              if (!confirm('동기화 쌍을 해제할까요? 이 쌍의 갱신 제안도 닫힙니다.')) return;
              void act(() => removePair(projectId, pair.id));
            }}
          >
            쌍 해제
          </button>
        ) : (
          <button
            type="button"
            className="link-button"
            disabled={busy || !model.path || !drawing.path}
            onClick={() =>
              void act(() =>
                designatePair(projectId, { model: model.path!, drawing: drawing.path! }),
              )
            }
          >
            동기화 쌍으로 지정
          </button>
        )}
        <button type="button" className="link-button sync-pair-close" onClick={onClose}>
          닫기
        </button>
      </p>
      {warn ? (
        <p className="sync-pair-warn">
          {warn}{' '}
          {pair?.status !== 'file-missing' ? (
            <button
              type="button"
              className="link-button"
              onClick={() => setWorkspace('jig', { instanceId: 'legacy:sync' })}
            >
              Sync jig 열기
            </button>
          ) : null}
        </p>
      ) : null}
      {notice ? (
        <p className="sync-pair-warn" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
