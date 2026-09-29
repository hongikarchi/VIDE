// Loads the Rust structure core (Node-API addon, ARCH-02 §1) and runs one analysis.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export function loadCore(): CoreBinding {
  if (binding) return binding;
  const path = coreCandidates.find((candidate) => existsSync(candidate));
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
