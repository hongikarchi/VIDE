// The jig steps of `vide/paneling` that run this library (ARCH-03 §2.3 `library` step: inputs as the
// step reads them, the flat setting values). Stage 1 writes the `PanelLayout` itself, so the later
// stages and the screen read `step.preview` as the contract shape.

import {
  surfaceSampleSchema,
  type PanelLayout,
  type SurfaceSample,
} from '../../../contracts/paneling.ts';
import { layoutPanels } from './layout.ts';
import { previewSettingsFromParams } from './settings.ts';

/** The 기준 면 input: the sample itself, or a pinned value `{ value }` around it. */
function sampleOf(input: unknown): SurfaceSample {
  const raw =
    input && typeof input === 'object' && 'value' in input && !('schema' in input)
      ? (input as { value: unknown }).value
      : input;
  if (!raw || typeof raw !== 'object')
    throw new Error('기준 면이 없습니다 · Rhino에서 면을 고르고 [고른 면 쓰기]를 누르세요');
  // Cheap structural check (the arrays can hold 65,536 points; the reader validated them).
  const s = raw as Partial<SurfaceSample>;
  if (s.schema !== 'vide.paneling.surface@1' || !Array.isArray(s.faces) || !s.faces.length) {
    const parsed = surfaceSampleSchema.safeParse(raw);
    if (!parsed.success) throw new Error('기준 면 표본의 형식이 맞지 않습니다 · 다시 읽기');
    return parsed.data;
  }
  for (const f of s.faces) {
    const n = f.nu * f.nv;
    if (f.points?.length !== 3 * n || f.normals?.length !== 3 * n || f.curvatures?.length !== 2 * n)
      throw new Error('기준 면 표본의 배열 길이가 맞지 않습니다 · 다시 읽기');
  }
  return raw as SurfaceSample;
}

/** Stage 1 '미리보기': lay the pattern on the picked face (SPEC-16.5). */
export function previewStep(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
): PanelLayout {
  const sample = sampleOf(inputs.surface);
  const result = layoutPanels(sample, previewSettingsFromParams(params));
  if (!result.ok) throw new Error(result.message);
  return result.layout;
}
