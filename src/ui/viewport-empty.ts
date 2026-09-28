/** An informational layer only: mouse/sketch input always reaches the canvas. */
export function initializeViewportEmpty(container: HTMLElement) {
  const panel = document.createElement('div');
  panel.id = 'viewport-empty';
  panel.className = 'viewport-empty';
  panel.setAttribute('role', 'status');
  const title = document.createElement('strong');
  const detail = document.createElement('span');
  panel.append(title, detail);
  container.append(panel);
  let connection: { key: string; name: string } | undefined;
  let sync: 'idle' | 'loading' | 'failed' = 'idle';
  let hidden = false;
  function update() {
    panel.hidden = hidden;
    panel.dataset.state = sync === 'idle' ? (connection ? 'connected' : 'idle') : sync;
    if (sync === 'loading') {
      title.textContent = 'Rhino 모델을 가져오는 중';
      detail.textContent = 'Sync가 끝나면 여기에 표시됩니다.';
    } else if (sync === 'failed') {
      title.textContent = '모델을 가져오지 못했습니다';
      detail.textContent = 'Sync 실패 · 하단 오류 기록에서 원인을 확인하세요.';
    } else if (connection) {
      title.textContent = 'Rhino 연결됨';
      detail.textContent = '왼쪽 문서에서 Sync를 실행하면 모델이 표시됩니다.';
    } else {
      title.textContent = '아직 가져온 모델이 없습니다';
      detail.textContent = 'Rhino 문서를 연결하거나 모델 파일을 불러오세요.';
    }
  }
  update();
  return {
    connection(value?: { key: string; name: string }) {
      if (connection && connection.key !== value?.key && sync !== 'loading') sync = 'idle';
      connection = value;
      update();
    },
    sync(value: typeof sync) {
      sync = value;
      update();
    },
    modelShown(value: boolean) {
      hidden = value;
      update();
    },
  };
}
