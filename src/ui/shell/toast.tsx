// Toast (PLAN-26 T-113, region E): the single notice slot. Static markup moved from index.html; it
// has no state or props and never re-renders until its region makes it stateful.
import { memo } from 'react';

export const Toast = memo(function Toast() {
  return <div id="message" className="toast" role="status" hidden />;
});
