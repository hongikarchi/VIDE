import { z } from 'zod';

/**
 * 마감 일람표 jig (SPEC-11, PLAN-43 T-198): the finish-code library as the screen reads it, and a
 * project's saved state — its rooms (층별·실번호·실명 and the F·W·C code lists) and its sheet
 * (채택 codes, per-layer 두께 조절, 표제 fields, 프로젝트 일반사항). Shared by the engine
 * (src/jigs/finish.ts, src/core/finish-store.ts) and the screen (src/ui/finish-jig.tsx).
 */

// ── Library (vide/finish-codes) ──────────────────────────────────────────────────────────────
export interface FinishLayer {
  /** Material key (mats). */
  k: string;
  nm: string;
  /** Hatch kind (system.kinds). */
  kind: string;
  /** Default thickness, mm. */
  t: number;
  lo: number;
  hi: number;
  /** 실무 상한 (mm), null when none. */
  hard: number | null;
  /** What to do above the 상한. */
  alt: string;
  src: string;
  note: string;
}
export interface FinishCode {
  code: string;
  el: string;
  fam: number;
  fin_d: number;
  seq: number;
  nm: string;
  struct: string;
  layers: FinishLayer[];
  fin: string;
  finKey: string;
  tags: string[];
  note: string;
  group: number;
  siblings: string[];
}
export interface FinishRefTable {
  t: string;
  src: string;
  cols: string[];
  rows: string[][];
  note: string;
}
export interface FinishSystem {
  elements: { k: string; ko: string; en: string; scope: string }[];
  families: Record<string, Record<string, string>>;
  finishes: { k: string; ko: string }[];
  tags: { k: string; d: string }[];
  kinds: { k: string; ko: string }[];
}
export interface FinishLibrary {
  version: string;
  generated: string;
  system: FinishSystem;
  mats: Record<string, FinishLayer>;
  codes: Record<string, FinishCode>;
  ref: FinishRefTable[];
  notes: { standard: string[] };
}

// ── A project's state ────────────────────────────────────────────────────────────────────────
/** The interior elements a room row holds (SPEC-11.4). */
export const ROOM_ELEMENTS = ['F', 'W', 'C'] as const;
export type RoomElement = (typeof ROOM_ELEMENTS)[number];
export const FINISH_ROOMS_MAX = 2000;
export const FINISH_CODES_PER_CELL = 20;
export const FINISH_TEXT_MAX = 100;
export const FINISH_NOTES_MAX = 50;
export const FINISH_NOTE_MAX = 500;
/** Codes the sheet may adopt or adjust (more than the library has). */
const FINISH_ADOPTED_MAX = 1000;

const code = z.string().regex(/^[A-Z]\d{4}$/);
const text = z.string().max(FINISH_TEXT_MAX);
const cell = z.array(code).max(FINISH_CODES_PER_CELL);

export const finishRoomSchema = z.object({
  id: z.string().min(1).max(64),
  floor: text,
  no: text,
  name: text,
  F: cell,
  W: cell,
  C: cell,
});
export type FinishRoom = z.infer<typeof finishRoomSchema>;
export const finishRoomsSchema = z.object({
  rooms: z.array(finishRoomSchema).max(FINISH_ROOMS_MAX),
});

export const finishTitleSchema = z.object({
  project: text,
  drawingNo: text,
  date: text,
  drawn: text,
  check: text,
  approved: text,
});
export type FinishTitle = z.infer<typeof finishTitleSchema>;
export const EMPTY_TITLE: FinishTitle = {
  project: '',
  drawingNo: '',
  date: '',
  drawn: '',
  check: '',
  approved: '',
};

export const finishSheetSchema = z.object({
  adopted: z.array(code).max(FINISH_ADOPTED_MAX),
  /** Per code, per layer index: the project's thickness (mm) where it differs from the library. */
  thk: z
    .record(code, z.record(z.string().regex(/^\d{1,2}$/), z.number().min(0).max(10000)))
    .refine((value) => Object.keys(value).length <= FINISH_ADOPTED_MAX),
  notes: z.array(z.string().max(FINISH_NOTE_MAX)).max(FINISH_NOTES_MAX),
  title: finishTitleSchema,
});
export type FinishSheet = z.infer<typeof finishSheetSchema>;
export const EMPTY_SHEET: FinishSheet = { adopted: [], thk: {}, notes: [], title: EMPTY_TITLE };

export const finishStateSchema = z.object({
  rooms: z.array(finishRoomSchema),
  sheet: finishSheetSchema,
});
export type FinishState = z.infer<typeof finishStateSchema>;
