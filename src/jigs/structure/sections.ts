// Rolled H sections (KS D 3502 nominal dimensions, mm) used to name sections and to match
// member solids by their outer size. Root radius r follows the KS table where known; the
// section properties themselves are computed by the core from these dimensions.

export interface HSize {
  h: number;
  b: number;
  tw: number;
  tf: number;
  r: number;
}

// prettier-ignore
export const KS_H: HSize[] = [
  [100, 100, 6, 8, 10], [125, 125, 6.5, 9, 10], [150, 150, 7, 10, 11], [175, 175, 7.5, 11, 12],
  [200, 200, 8, 12, 13], [250, 250, 9, 14, 16], [300, 300, 10, 15, 18], [350, 350, 12, 19, 20],
  [400, 400, 13, 21, 22], [150, 75, 5, 7, 8], [200, 100, 5.5, 8, 11], [250, 125, 6, 9, 12],
  [300, 150, 6.5, 9, 13], [350, 175, 7, 11, 14], [400, 200, 8, 13, 16], [450, 200, 9, 14, 18],
  [500, 200, 10, 16, 20], [600, 200, 11, 17, 22], [194, 150, 6, 9, 13], [244, 175, 7, 11, 16],
  [294, 200, 8, 12, 18], [340, 250, 9, 14, 20], [390, 300, 10, 16, 22], [440, 300, 11, 18, 24],
  [488, 300, 11, 18, 26], [588, 300, 12, 20, 28], [700, 300, 13, 24, 28], [800, 300, 14, 26, 28],
  [900, 300, 16, 28, 28],
].map(([h, b, tw, tf, r]) => ({ h, b, tw, tf, r }));

export const hName = (s: Pick<HSize, 'h' | 'b' | 'tw' | 'tf'>) => `H-${s.h}x${s.b}x${s.tw}x${s.tf}`;
export const hId = (s: Pick<HSize, 'h' | 'b' | 'tw' | 'tf'>) => `H${s.h}x${s.b}x${s.tw}x${s.tf}`;

/** "H-400x200x8x13", "H 400×200×8×13", "BH-600*300*12*20" → dimensions; null if not a section name. */
export function parseSectionName(text: string): { shape: 'H' | 'BH'; dims: HSize } | null {
  const match =
    /\b(B?H)\s*-?\s*(\d+(?:\.\d+)?)\s*[x×*X]\s*(\d+(?:\.\d+)?)\s*[x×*X]\s*(\d+(?:\.\d+)?)\s*[x×*X]\s*(\d+(?:\.\d+)?)/.exec(
      text,
    );
  if (!match) return null;
  const [h, b, tw, tf] = match.slice(2, 6).map(Number);
  const table = KS_H.find((s) => s.h === h && s.b === b && s.tw === tw && s.tf === tf);
  return {
    shape: match[1].toUpperCase() === 'BH' ? 'BH' : 'H',
    dims: { h, b, tw, tf, r: match[1].toUpperCase() === 'BH' ? 0 : (table?.r ?? 0) },
  };
}

/** Nearest rolled H by outer size (depth h, width b), within `tolerance` relative error. */
export function matchOuterSize(h_mm: number, b_mm: number, tolerance = 0.08): HSize | null {
  let best: { size: HSize; error: number } | null = null;
  for (const size of KS_H) {
    const error = Math.abs(size.h - h_mm) / size.h + Math.abs(size.b - b_mm) / size.b;
    if (!best || error < best.error) best = { size, error };
  }
  return best && best.error <= tolerance ? best.size : null;
}
