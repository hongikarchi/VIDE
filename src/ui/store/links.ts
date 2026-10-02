// Linked files and the layers drawn from them (PLAN-26 T-113; frozen after step F: regions read,
// src/ui/app/links-sync.ts and the host link poll write).
import { createSlice } from './core.ts';
import type { HostTarget } from '../../contracts/host-documents.ts';
import type { LinkRow, OfflineStatus } from '../links.tsx';

export interface Layer {
  key: string;
  requestId: string;
  name: string;
  link?: LinkRow;
}

export interface LinksFields {
  // Rhino's shared pinned set for the attached document, mirrored from the Rhino plugin.
  hostPinned: string[];
  hostPinBasis: string | undefined;
  connectedTarget: HostTarget | undefined;
  // Asked the plugin once to drop a link removed in VIDE; its reload gives the panel a fresh page.
  panelUnlinking: boolean;
  // Request whose display is refreshed in place (Live Sync): keep the camera, rebuild only changes.
  liveRefresh: string | undefined;
  // Linked files (SPEC-01.11): files linked from the host plugins, drawn together as layers. No file
  // is the main one; the composer targets the file of the last picked object (or the chosen row).
  links: LinkRow[];
  linksLoaded: boolean;
  linkSignature: string;
  linksPolling: boolean;
  linkSyncing: boolean;
  /** What the empty view last showed for the engine's Syncs. */
  engineView: 'loading' | 'idle' | 'failed' | undefined;
  /** A result shown that belongs to no linked file (file import, older work). */
  transientResult: string | undefined;
  activeLayer: string | undefined;
  shownSignature: string;
  fitNext: boolean;
  currentLayers: Layer[];
  // Offline view on the account site and requests left there (PLAN-20).
  offlineState: { projectId: string; status: OfflineStatus } | undefined;
  offlineAsked: string;
}
export const linksState = createSlice<LinksFields>({
  hostPinned: [],
  hostPinBasis: undefined,
  connectedTarget: undefined,
  panelUnlinking: false,
  liveRefresh: undefined,
  links: [],
  linksLoaded: false,
  linkSignature: '',
  linksPolling: false,
  linkSyncing: false,
  engineView: undefined,
  transientResult: undefined,
  activeLayer: undefined,
  shownSignature: '',
  fitNext: true,
  currentLayers: [],
  offlineState: undefined,
  offlineAsked: '',
});
