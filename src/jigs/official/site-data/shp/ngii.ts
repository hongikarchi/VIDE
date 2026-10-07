// 국토지리정보원 연속수치지형도 code dictionary (SPEC-12.4, PLAN-45 T-206). The data in
// `../assets/ngii-codes.json` (레이어 107 · 속성항목 66 · 코드값 503 · 통합코드 423) was extracted by
// S-02 Site Maker from the public manual "연속수치지형도 데이터 설명서 Ver 5.1.1"; the source is
// recorded in `../assets/NOTICE.json`. Only four topographic layers are used by site modeling:
// 건물, 도로경계, 등고선, 표고점. 연속지적도 is a different product and is recognised by its fields.
import data from '../assets/ngii-codes.json' with { type: 'json' };

interface NgiiLayer {
  cat: string;
  name: string;
  geom: string;
  scales: string;
}
interface NgiiDictionary {
  layers: Record<string, NgiiLayer>;
  fields: Record<string, string>;
  codes: Record<string, string>;
  scls: Record<string, string>;
}
const DICT = data as unknown as NgiiDictionary;

/** 연속지적도 fields (not in the topographic manual). */
const CADASTRAL_FIELDS: Record<string, string> = {
  PNU: '필지고유번호',
  JIBUN: '지번',
  BCHK: '대장구분',
  SGG_OID: '시군구 객체ID',
  COL_ADM_SE: '제공기관 코드',
};
/** Field-specific code tables (a value like "1" means different things in different fields). */
const FIELD_CODES: Record<string, Record<string, string>> = {
  BCHK: { '1': '토지대장', '2': '임야대장' },
};

export type LayerRole =
  | 'building'
  | 'road-boundary'
  | 'contour'
  | 'spot-height'
  | 'parcel'
  | 'unused';
const ROLE_BY_CODE: Record<string, LayerRole> = {
  B0010000: 'building',
  A0010000: 'road-boundary',
  F0010000: 'contour',
  F0020000: 'spot-height',
};
const GEOM_KR: Record<string, string> = { A: '면', L: '선', P: '점' };
const SCALE_KR: Record<string, string> = { '1': '1:1,000', '3': '1:5,000', '4': '1:25,000' };

export interface LayerInfo {
  /** File base name without folder or extension. */
  file: string;
  product: 'ngii-topo' | 'cadastral' | 'other';
  /** NGII feature code (A0010000 …) when the file name carries one. */
  code: string | null;
  category: string;
  name: string;
  geometry: string;
  scale: string;
  role: LayerRole;
}

/**
 * Describe a layer by its file name (N3A_B0010000 → 건물 · 면) and, for 연속지적도, by its fields.
 * The role decides what site modeling uses; a closed road-boundary polygon is never a building
 * (S-02 TRAPS B2).
 */
export function describeLayer(fileBase: string, fieldNames: readonly string[] = []): LayerInfo {
  const file = fileBase.replace(/^.*[\\/]/, '');
  const m = /^N([134])([PLA])_([A-H]\d{7})$/i.exec(file);
  if (m) {
    const code = m[3].toUpperCase();
    const spec = DICT.layers[code];
    return {
      file,
      product: 'ngii-topo',
      code,
      category: spec?.cat ?? '',
      name: spec?.name ?? `설명서 미등재(${code})`,
      geometry: GEOM_KR[m[2].toUpperCase()] ?? '',
      scale: SCALE_KR[m[1]] ?? '',
      role: ROLE_BY_CODE[code] ?? 'unused',
    };
  }
  const upper = new Set(fieldNames.map((f) => f.toUpperCase()));
  if (upper.has('PNU') && (upper.has('JIBUN') || upper.has('BCHK')))
    return {
      file,
      product: 'cadastral',
      code: null,
      category: '지적',
      name: '연속지적도',
      geometry: '면',
      scale: '',
      role: 'parcel',
    };
  return {
    file,
    product: 'other',
    code: null,
    category: '',
    name: file,
    geometry: '',
    scale: '',
    role: 'unused',
  };
}

/** Korean name of an attribute field id (NMLY → 층수), or the id itself. */
export function fieldName(id: string): string {
  const key = id.toUpperCase();
  return CADASTRAL_FIELDS[key] ?? DICT.fields[key] ?? id;
}

/** Korean meaning of a code value in a field (KIND BDK005 → 무벽건물), or null. */
export function codeName(fieldId: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const key = fieldId.toUpperCase();
  if (FIELD_CODES[key]) return FIELD_CODES[key][value] ?? null;
  if (key === 'SCLS') return DICT.scls[value] ?? null;
  return DICT.codes[value] ?? DICT.scls[value] ?? null;
}

/** Counts of the dictionary, for the notice and tests. */
export function dictionarySize() {
  return {
    layers: Object.keys(DICT.layers).length,
    fields: Object.keys(DICT.fields).length,
    codes: Object.keys(DICT.codes).length,
    scls: Object.keys(DICT.scls).length,
  };
}
