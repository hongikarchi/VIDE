// Loads the Rust structure core (Node-API addon, ARCH-02 §1) and runs one analysis.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import {
  structureModelSchema,
  structureResultSchema,
  type StructureModel,
  type StructureModelInput,
  type StructureResult,
} from '../../contracts/structure-model.ts';

interface CoreBinding {
  analyze(modelJson: string, modelHash: string): string;
  coreVersion(): string;
}

const crateDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native', 'structure');
/** Packaged build first, then the local cargo release build. */
export const coreCandidates = [
  process.env.VIDE_STRUCTURE_CORE,
  join(crateDir, 'vide_structure.node'),
  join(crateDir, 'target', 'release', 'vide_structure.dll'),
].filter((path): path is string => !!path);

let binding: CoreBinding | undefined;

/** The first built core on disk, or undefined when none is built. */
export function corePath(): string | undefined {
  return coreCandidates.find((candidate) => existsSync(candidate));
}

/**
 * Keep the core loaded until the process ends; call on the main thread before a worker loads it.
 * Node unloads an addon when the worker thread that loaded it exits (never on the main thread),
 * but the core's sparse solver (faer) runs on rayon's global pool, whose threads outlive the
 * worker: unloading the library under them crashes the whole process (0xC0000005 on Windows),
 * most often under CPU load while the pool is still spinning after a job. The main thread's load
 * holds a reference no worker exit releases. A no-op on other threads.
 */
export function pinCore(): void {
  if (isMainThread) loadCore();
}

export function loadCore(): CoreBinding {
  if (binding) return binding;
  const path = corePath();
  if (!path)
    throw Object.assign(new Error('Structure core is not built (npm run build:structure)'), {
      code: 'STRUCTURE_CORE_MISSING',
    });
  const module = { exports: {} as CoreBinding };
  process.dlopen(module, path);
  binding = module.exports;
  return binding;
}

export function modelHash(model: StructureModel): string {
  return createHash('sha256').update(JSON.stringify(model)).digest('hex');
}

/** Validate, hash and analyse a model. Throws on an invalid model; core failures come back as status 'error'. */
export function analyzeStructure(input: StructureModelInput): StructureResult {
  const model = structureModelSchema.parse(input);
  const hash = modelHash(model);
  const raw = JSON.parse(loadCore().analyze(JSON.stringify(model), hash));
  return structureResultSchema.parse(raw);
}
