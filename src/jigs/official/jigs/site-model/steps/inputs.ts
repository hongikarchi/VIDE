// What the `site-data` input gives the steps (ARCH-03 §8.3): the engine's read-copies of one
// instance. `lookup` and `collection` are `vide/site-data` results kept as they came; `shp` is the
// SHP import (EPSG:5186, local to its own frame origin) with feature attributes left out.

import type { LookupResult } from '../../../site-data/lookup.ts';
import type { SiteCollection } from '../../../site-data/collect.ts';
import type { LocalGeometry, SiteFrame } from '../../../site-data/shp/import.ts';
import type { LayerRole } from '../../../site-data/shp/ngii.ts';

export interface ShpFeature {
  index: number;
  geometry: LocalGeometry;
  building?: {
    floors: number | null;
    kind: string | null;
    kindName: string | null;
    use: string | null;
    name: string | null;
    wallless: boolean;
  };
  elevation?: number | null;
  parcel?: { pnu: string | null; jibun: string | null; ledger: string | null };
}
export interface ShpLayer {
  file: string;
  name: string;
  role: LayerRole;
  sourceCrs: { epsg: string | null; label: string };
  warnings: string[];
  features: ShpFeature[];
}
export interface ShpCopy {
  frame: SiteFrame | null;
  layers: ShpLayer[];
  ignored: { file: string; name: string }[];
  rejected: { file: string; code: string; reason: string }[];
  files: string[];
  importedAt: string;
}

export interface SiteInput {
  query: string | null;
  lookup: LookupResult | null;
  targets: { pnus: string[]; by: 'proposal' | 'user' | null };
  collection: (SiteCollection & { radius: number }) | null;
  shp: ShpCopy | null;
}
