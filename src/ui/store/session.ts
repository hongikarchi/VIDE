// The page session (PLAN-26 T-113, region E): the open project, the start state and the engine link.
import { createSlice } from './core.ts';
import type { Service } from '../request-route.ts';

export interface SessionFields {
  project: { id: string; name: string } | undefined;
  ready: boolean;
  busy: boolean;
  // Projects for the heading, and the account website when this PC is signed in.
  projects: { id: string; name: string }[];
  accountSite: string | undefined;
  /** Who is signed in (the providers' status), for the login card (SPEC-02.17 3). */
  providerSignedIn: Partial<Record<Service, boolean>>;
  catalogGeneration: number;
  hostLinkPolling: boolean;
  // Usage needs the session connect() opened; a retried start mounts it once.
  usageMounted: boolean;
  lostCode: string;
}
export const sessionState = createSlice<SessionFields>({
  project: undefined,
  ready: false,
  busy: false,
  projects: [],
  accountSite: undefined,
  providerSignedIn: {},
  catalogGeneration: 0,
  hostLinkPolling: false,
  usageMounted: false,
  lostCode: '',
});
