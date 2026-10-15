// 기록 탭의 작업 폴더 사본 상태 (PLAN-53 T-331, Design SCR-44 '원격 세션'·SCR-45 「구현 기준」 '가져오기와
// 사본 줄'): a quiet grey line at the end of the head ('폴더에 씀 · 01_운영/기록/' or '폴더에 아직 안 씀'),
// nothing when the project has no work folder, and — when the person changed a copy in the folder —
// a small box under the head with [폴더 내용 들이기] · [VIDE 기록으로 다시 쓰기] (hidden remotely).
import { useCallback, useEffect, useState } from 'react';
import {
  importMirror,
  mirrorState,
  rewriteMirror,
  type RecordsMirrorState,
} from './records-api.ts';
import './records-mirror-line.css';

/** The records tab's own shown event (`records-tab.tsx`). */
const SHOWN = 'vide:records-shown';

/** The copy's state, read on open, when the tab is shown again and on `reload()`. */
export function useRecordsMirror(projectId: string) {
  const [state, setState] = useState<RecordsMirrorState | undefined>();
  const reload = useCallback(async () => {
    setState(await mirrorState(projectId));
  }, [projectId]);
  useEffect(() => {
    void reload();
    const again = () => void reload();
    addEventListener(SHOWN, again);
    return () => removeEventListener(SHOWN, again);
  }, [reload]);
  return { state, reload };
}
export type RecordsMirror = ReturnType<typeof useRecordsMirror>;

/** The grey line at the end of the records head (nothing without a work folder or while changed). */
export function MirrorLine({ mirror }: { mirror: RecordsMirror }) {
  const state = mirror.state;
  if (!state?.path || state.changed) return null;
  return (
    <span className="records-mirror-line">
      {state.written ? `폴더에 씀 · ${state.path}/` : '폴더에 아직 안 씀'}
    </span>
  );
}

/** The box under the head when a copy in the folder differs from the records. */
export function MirrorChanged({
  projectId,
  mirror,
  remote,
  onDone,
}: {
  projectId: string;
  mirror: RecordsMirror;
  remote: boolean;
  /** After 들이기 or 다시 쓰기: the notice to show (the lists are read again). */
  onDone: (notice: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!mirror.state?.path || !mirror.state.changed) return null;
  const run = async (what: 'import' | 'rewrite') => {
    setBusy(true);
    try {
      if (what === 'import') {
        const result = await importMirror(projectId);
        onDone(
          `사본에서 ${result.changed}건 반영 · ${result.added}건 추가 · ${result.skipped.length}줄 건너뜀`,
        );
      } else {
        await rewriteMirror(projectId);
        onDone('폴더의 기록 사본을 VIDE 기록으로 다시 썼습니다.');
      }
    } catch (error) {
      onDone(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      await mirror.reload();
    }
  };
  return (
    <div className="records-mirror-changed" role="group" aria-label="폴더의 기록 사본">
      <span>폴더의 기록 사본이 VIDE와 달라졌어요.</span>
      {remote ? null : (
        <>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => void run('import')}
          >
            폴더 내용 들이기
          </button>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => void run('rewrite')}
          >
            VIDE 기록으로 다시 쓰기
          </button>
        </>
      )}
    </div>
  );
}
