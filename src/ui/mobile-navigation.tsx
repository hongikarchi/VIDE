// The mobile tab bar's buttons (below 850 px): 모델 and 작업. The shown view is the layout slice's
// (src/ui/store/layout.ts), which also writes body[data-mobile] for the CSS.
import { layoutState, setMobileView, type MobileView } from './store/layout.ts';
import { useStore } from './store/core.ts';

export { setMobileView, type MobileView };

export function MobileNavigation() {
  const view = useStore(layoutState, (s) => s.mobileView);
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
