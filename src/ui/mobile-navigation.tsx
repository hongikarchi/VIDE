import { useSyncExternalStore } from 'react';

export type MobileView = 'model' | 'input' | 'documents';
const eventName = 'vide:mobile-view';

export function setMobileView(view: MobileView): void {
  document.body.dataset.mobile = view;
  document.dispatchEvent(new Event(eventName));
}

function subscribe(listener: () => void): () => void {
  document.addEventListener(eventName, listener);
  return () => document.removeEventListener(eventName, listener);
}

function currentView(): MobileView {
  const view = document.body.dataset.mobile;
  return view === 'input' || view === 'documents' ? view : 'model';
}

export function MobileNavigation() {
  const view = useSyncExternalStore(subscribe, currentView);
  return (
    <>
      <button
        data-mobile="model"
        aria-pressed={view === 'model'}
        onClick={() => setMobileView('model')}
      >
        모델
      </button>
      <button
        data-mobile="input"
        aria-pressed={view === 'input'}
        onClick={() => setMobileView('input')}
      >
        작업
      </button>
    </>
  );
}
