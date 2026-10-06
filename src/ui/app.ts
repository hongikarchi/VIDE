// The work screen's imperative code, split by region under src/ui/app/ (PLAN-26 T-113, ARCH-01
// 「웹 화면 구조」). This entry first loads the modules the old single app.ts imported, in the same
// order, so module evaluation and the bundled CSS order stay as they were; then boot() runs each
// region's initialization in the old top-level order and connects to the engine.
import './viewport-empty.ts';
import './workspace-status.ts';
import './linked-draft.ts';
import './account-indicator.ts';
import '../contracts/execution-limits.ts';
import './execution-limits.tsx';
import '../contracts/request-scope.ts';
import './request-scope.ts';
import './draft-storage.ts';
import './reference-check.ts';
import './reference-check.css';
// Shared conversation records (PLAN-36): in the main stylesheet, not a chunk of its own.
import './conversation-mirror/mirror-thread.css';
import 'zod';
import '../contracts/workspace.ts';
import '../contracts/link-requests.ts';
import '../contracts/host-documents.ts';
import './elements.ts';
import './workspace-data.ts';
import './project-heading.tsx';
import './mobile-navigation.tsx';
import './quantities.tsx';
import './native-attributes.ts';
import './jigs.tsx';
import './skill-start.ts';
import './skill-catalog.ts';
import './jig-panel/instance.ts';
import './workspaces.ts';
import './reviews.tsx';
import './shared-feedback.tsx';
import './attachments.ts';
import './reference-bridge.ts';
import './work-view.tsx';
import './links.tsx';
import './host-panel.tsx';
import './usage-bars.ts';
import './layers.ts';
import './request-route.ts';
import './requests.tsx';
import './inspector.ts';
import './gateway.ts';
import './remote-panel.ts';
import './connection-recovery.ts';
import '../core/display-delta.ts';
import './model.ts';
import './object-list.ts';
import './pin-tokens.ts';
import './workspace-panels.ts';
import './viewport.ts';
import './display-settings.ts';
import './theme.ts';
import './feedback.ts';
import './dashboard.tsx';
import './agenda-text.ts';
import { boot } from './app/boot.ts';

await boot();
