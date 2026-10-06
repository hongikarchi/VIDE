// Grasshopper in VIDE (ADR-033, user decision 2026-10-06 "무거운 검증 계층은 필요없고 … vide는 가능한
// llm native 기능을 방해하는게 아니라, 도움을 주는 쪽으로"): thin tools over the user's own Grasshopper
// in the Rhino a direct turn's document is open in. Reads (gh_state, gh_components, gh_outputs,
// gh_capture) in both modes; edits (gh_apply, gh_solve, gh_bake, gh_open, gh_save) in Auto. No
// broker, no fingerprint check, no lock: several conversations and the user edit the same canvas at
// once, each gh_apply is one Grasshopper undo record applied on Rhino's UI thread, and an op whose
// object is gone fails alone. gh_bake goes through the turn's execute path (one Rhino undo record).

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import type { RequestMode } from '../contracts/workspace.ts';
import { DomainError } from '../core/store.ts';
import { bounded, ToolImage, TOOL_IMAGE_BYTES } from './agent-tools.ts';
import type { ActivityEntry } from './activity.ts';
import type { DirectDriver, ExecutionRecord } from './direct-mode.ts';

const failure = (code: string) => Object.assign(new Error(code), { code });

/** A document of the turn as the Grasshopper tools see it (the Rhino it is open in). */
interface GhDocument {
  driver: DirectDriver;
  file: { linkId?: string; name: string };
}
export interface GrasshopperTurn {
  mode: RequestMode;
  /** The turn's document for a linkId (left out: the starting document). */
  resolve(linkId: unknown): Promise<GhDocument>;
  signal: AbortSignal;
  /** The conversation's title (or the request): it names each gh_apply's undo record. */
  title: string;
  workFolders?: () => readonly string[];
  /** Asks the user about a path outside the work folder (left out: refused). */
  filePermission?: (
    action: 'read' | 'write',
    path: string,
    signal: AbortSignal,
  ) => Promise<{ allow: true } | { allow: false; message: string }>;
  /** gh_bake through the turn's execute path (language `gh-bake`). */
  bake(linkId: unknown, spec: Record<string, unknown>): Promise<unknown>;
  onUse(doc: GhDocument, kind: ActivityEntry['kind'], text: string, detail?: string): void;
  /** An applied gh_apply (its undo record) for the request result and the ledger. */
  onRecord(doc: GhDocument, record: Omit<ExecutionRecord, 'host' | 'target' | 'file'>): void;
}
/** The Grasshopper tools a turn may get (ADR-033). */
export const GH_READ_TOOLS = ['gh_state', 'gh_components', 'gh_outputs', 'gh_capture'] as const;
export const GH_WRITE_TOOLS = ['gh_apply', 'gh_solve', 'gh_bake', 'gh_open', 'gh_save'] as const;

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
const rest = ({ targetRef: _target, linkId: _link, ...args }: Record<string, unknown>) => args;

/** The undo record's name in Grasshopper's Edit menu: the conversation and the op count. */
export function grasshopperLabel(title: string, ops: number) {
  const name = title.replace(/\s+/g, ' ').trim().slice(0, 60) || 'AI';
  return `VIDE: ${name} · ${ops} ops`;
}

/**
 * A path the AI names for gh_open / gh_save, when it lies inside a project work folder (ADR-031 8:
 * outside it the CLI's own file tools ask the user; VIDE's Grasshopper tools do not reach there).
 * The real path is compared, so a link out of the folder does not count as inside.
 */
export function insideWorkFolder(
  path: string,
  folders: readonly string[],
  mustExist: boolean,
): string | undefined {
  if (!isAbsolute(path)) return undefined;
  let real: string;
  try {
    real = mustExist
      ? realpathSync.native(path)
      : join(realpathSync.native(dirname(resolvePath(path))), basename(path));
  } catch {
    return undefined;
  }
  for (const folder of folders) {
    let base: string;
    try {
      base = realpathSync.native(folder);
    } catch {
      continue;
    }
    const inner = relative(base, real);
    if (inner && !inner.startsWith('..') && !isAbsolute(inner)) return real;
  }
  return undefined;
}

/** The ops' results the record keeps: added, changed and removed canvas object ids. */
function canvasChanges(answer: Record<string, unknown>) {
  const results = Array.isArray(answer.results)
    ? (answer.results as Record<string, unknown>[])
    : [];
  const added = results
    .filter((row) => row.ok === true && row.op === 'add' && typeof row.id === 'string')
    .map((row) => row.id as string);
  const ids = (key: string) =>
    Array.isArray(answer[key])
      ? (answer[key] as unknown[]).filter((v) => typeof v === 'string')
      : [];
  const row = (id: string) => ({ nativeId: id, layer: 'Grasshopper' });
  return {
    added: added.map(row),
    changed: (ids('changed') as string[]).filter((id) => !added.includes(id)).map(row),
    removed: (ids('removed') as string[]).map(row),
  };
}

export function grasshopperHandlers(turn: GrasshopperTurn): Record<string, Handler> {
  const call = async (
    doc: GhDocument,
    method: Parameters<NonNullable<DirectDriver['grasshopper']>>[0],
    args: Record<string, unknown>,
  ) => {
    if (!doc.driver.grasshopper) throw failure('GH_UNAVAILABLE');
    return doc.driver.grasshopper(method, args);
  };
  /**
   * A .gh path the turn may use: inside the work folder at once; elsewhere only after the user
   * allows it on the work folder card (ADR-031 8, SPEC-01.13), else GH_OUTSIDE_WORK_FOLDER.
   */
  const allowedPath = async (path: string, action: 'read' | 'write') => {
    if (!isAbsolute(path)) throw new DomainError('INVALID_INPUT');
    const inside = insideWorkFolder(path, turn.workFolders?.() ?? [], action === 'read');
    if (inside) return inside;
    if (!turn.filePermission) throw new DomainError('GH_OUTSIDE_WORK_FOLDER');
    const answer = await turn.filePermission(action, resolvePath(path), turn.signal);
    if (!answer.allow) throw new DomainError('GH_OUTSIDE_WORK_FOLDER');
    return resolvePath(path);
  };
  let edits = 0;
  const handlers: Record<string, Handler> = {
    gh_state: async (args) => {
      const doc = await turn.resolve(args.linkId);
      const answer = await call(doc, 'gh-state', rest(args));
      turn.onUse(doc, 'query', 'Grasshopper 캔버스 읽기');
      return bounded(answer);
    },
    gh_components: async (args) => {
      const doc = await turn.resolve(args.linkId);
      const answer = await call(doc, 'gh-components', rest(args));
      turn.onUse(doc, 'query', 'Grasshopper 컴포넌트 찾기');
      return bounded(answer);
    },
    gh_outputs: async (args) => {
      const doc = await turn.resolve(args.linkId);
      const answer = await call(doc, 'gh-outputs', rest(args));
      turn.onUse(doc, 'query', 'Grasshopper 출력 읽기');
      return bounded(answer);
    },
    gh_capture: async (args) => {
      const doc = await turn.resolve(args.linkId);
      let options = rest(args);
      // Too large an image is taken again at half the size (ADR-031 3), at most twice.
      for (let attempt = 0; ; attempt++) {
        const { data, mimeType: _type, ok: _ok, ...meta } = await call(doc, 'gh-capture', options);
        if (typeof data !== 'string') throw failure('CAPTURE_FAILED');
        if (Buffer.byteLength(data, 'base64') <= TOOL_IMAGE_BYTES || attempt >= 2) {
          turn.onUse(doc, 'query', 'Grasshopper 캔버스 보기');
          return new ToolImage(data, 'image/png', meta);
        }
        options = {
          ...options,
          width: Math.max(64, Math.floor(Number(meta.width ?? 1200) / 2)),
          height: Math.max(64, Math.floor(Number(meta.height ?? 800) / 2)),
        };
      }
    },
  };
  if (turn.mode !== 'auto') return handlers;
  return {
    ...handlers,
    gh_apply: async (args) => {
      if (turn.signal.aborted) throw failure('CANCELLED');
      const doc = await turn.resolve(args.linkId);
      const ops = Array.isArray(args.ops) ? args.ops : [];
      const label = grasshopperLabel(turn.title, ops.length);
      edits++;
      turn.onUse(
        doc,
        'execute',
        `Grasshopper 편집 ${edits}회차 · 작업 ${ops.length}개`,
        JSON.stringify(ops),
      );
      let answer: Record<string, unknown>;
      try {
        answer = await call(doc, 'gh-apply', { ...rest(args), label });
      } catch (error) {
        turn.onUse(
          doc,
          'error',
          'Grasshopper 편집 실패',
          String((error as { code?: unknown }).code ?? ''),
        );
        throw error;
      }
      const results = Array.isArray(answer.results) ? (answer.results as { ok?: unknown }[]) : [];
      const done = results.filter((row) => row.ok === true).length;
      const undoId = typeof answer.undoId === 'string' ? answer.undoId : null;
      if (undoId)
        turn.onRecord(doc, {
          executionId: randomUUID(),
          kind: 'grasshopper',
          label,
          at: new Date().toISOString(),
          state: 'applied',
          undoId,
          changes: canvasChanges(answer),
          body: JSON.stringify(ops),
        });
      turn.onUse(
        doc,
        done === results.length ? 'result' : 'error',
        `Grasshopper에 반영 · 작업 ${done}/${results.length}개${undoId ? ' · 되돌리기 1단계' : ''}`,
      );
      return bounded({
        ...answer,
        ...(undoId
          ? {}
          : { next: 'Nothing changed on the canvas, so there is no undo record for this call.' }),
      });
    },
    gh_solve: async (args) => {
      const doc = await turn.resolve(args.linkId);
      const answer = await call(doc, 'gh-solve', rest(args));
      turn.onUse(doc, 'host', 'Grasshopper 계산');
      return bounded(answer);
    },
    gh_bake: async (args) => {
      if (turn.signal.aborted) throw failure('CANCELLED');
      // Through the execute path: one Rhino undo record, the document's execute queue, its record.
      return turn.bake(args.linkId, rest(args));
    },
    gh_open: async (args) => {
      const doc = await turn.resolve(args.linkId);
      const options = rest(args);
      if (typeof options.path === 'string') {
        options.path = await allowedPath(options.path, 'read');
      }
      const answer = await call(doc, 'gh-open', options);
      turn.onUse(
        doc,
        'host',
        typeof options.path === 'string' ? 'Grasshopper 정의 열기' : 'Grasshopper 캔버스 열기',
      );
      return answer;
    },
    gh_save: async (args) => {
      const doc = await turn.resolve(args.linkId);
      const options = rest(args);
      if (typeof options.path !== 'string') throw new DomainError('INVALID_INPUT');
      const inside = await allowedPath(options.path, 'write');
      const answer = await call(doc, 'gh-save', { ...options, path: inside });
      turn.onUse(doc, 'result', `Grasshopper 정의 저장 · ${basename(inside)}`);
      return answer;
    },
  };
}
