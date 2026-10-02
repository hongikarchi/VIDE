// The empty-view notice over the 3D view (PLAN-26 T-113, region B): its state lives in the viewer
// slice and shell/viewport-area.tsx draws it as #viewport-empty. An informational layer only:
// mouse/sketch input always reaches the canvas.
import { viewerState } from './store/viewer.ts';

export interface ViewportEmptyFields {
  connection: { key: string; name: string; host?: 'rhino' | 'zwcad' } | undefined;
  sync: 'idle' | 'loading' | 'failed';
  hidden: boolean;
}
/** What the notice shows for a state. */
export function viewportEmptyView({ connection, sync, hidden }: ViewportEmptyFields) {
  const host = connection?.host === 'zwcad' ? 'ZWCAD' : 'Rhino';
  const state = sync === 'idle' ? (connection ? 'connected' : 'idle') : sync;
  const [title, detail] =
    sync === 'loading'
      ? [host + ' 모델을 가져오는 중', 'Sync가 끝나면 여기에 표시됩니다.']
      : sync === 'failed'
        ? ['모델을 가져오지 못했습니다', 'Sync 실패 · 하단 오류 기록에서 원인을 확인하세요.']
        : connection
          ? [
              host + ' 연결됨',
              '첫 Sync를 기다리는 중입니다. 연결 파일 목록의 ⟳로 바로 가져올 수 있습니다.',
            ]
          : [
              '아직 가져온 모델이 없습니다',
              'Rhino·ZWCAD 플러그인 패널에서 Link를 누르거나 모델 파일을 불러오세요.',
            ];
  return { hidden, state, title, detail };
}
/** The notice's controls: the linked document, the Sync state and whether a model is shown. */
export function initializeViewportEmpty() {
  const set = (next: ViewportEmptyFields) => {
    const current = viewerState.empty;
    if (
      next.connection === current.connection &&
      next.sync === current.sync &&
      next.hidden === current.hidden
    )
      return;
    viewerState.empty = next;
    viewerState.bump();
  };
  return {
    connection(value?: { key: string; name: string; host?: 'rhino' | 'zwcad' }) {
      const { connection, sync } = viewerState.empty;
      set({
        ...viewerState.empty,
        connection: value,
        sync: connection && connection.key !== value?.key && sync !== 'loading' ? 'idle' : sync,
      });
    },
    sync(value: ViewportEmptyFields['sync']) {
      set({ ...viewerState.empty, sync: value });
    },
    modelShown(value: boolean) {
      set({ ...viewerState.empty, hidden: value });
    },
  };
}
