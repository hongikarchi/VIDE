// ConnectionBanner (PLAN-26 T-113, region E): `#connection-banner`, the first child of
// `.composer-wrap`. A lost engine locks the composer only until it answers again; the banner says
// why and [다시 연결] checks at once. Drawn from store/session.ts (src/ui/app/boot.ts sets it through
// src/ui/app/status.ts); the button calls the reconnect action the start puts in store/status.ts.
import { memo } from 'react';
import { useStore } from '../store/core.ts';
import { sessionState } from '../store/session.ts';
import { statusState } from '../store/status.ts';

export const ConnectionBanner = memo(function ConnectionBanner() {
  const banner = useStore(sessionState, (s) => s.banner);
  return (
    <div id="connection-banner" role="alert" hidden={banner.hidden}>
      <span>
        {banner.text || null}
        {banner.link ? <a href="/">프로젝트 목록에서 다시 열기</a> : null}
      </span>
      <button
        type="button"
        disabled={banner.checking}
        onClick={() => statusState.actions.reconnect()}
      >
        다시 연결
      </button>
    </div>
  );
});
