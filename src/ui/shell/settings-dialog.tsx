// SettingsDialog (PLAN-26 T-113, region E): the settings dialog's place after the toast. Until region
// E moves the dialog here, src/ui/workspace-status.ts still builds it and appends it to <body>, so
// this renders nothing.
import { memo } from 'react';

export const SettingsDialog = memo(function SettingsDialog() {
  return null;
});
