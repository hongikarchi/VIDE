// A small JSON Schema (draft 2020-12 subset) checker for step outputs (ARCH-03 §6.2): `type`,
// `properties`, `required`, `additionalProperties: false`, `items`, `enum`, `minItems`, `const`.
// Enough to guard the shape of a step's result without a validator dependency; anything the
// subset does not know is ignored, never rejected.

export interface SchemaProblem {
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

const typeOf = (value: unknown) =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'number'
        ? Number.isInteger(value)
          ? 'integer'
          : 'number'
        : typeof value;

export function checkSchema(
  schema: unknown,
  value: unknown,
  path = '$',
  out: SchemaProblem[] = [],
) {
  if (!schema || typeof schema !== 'object' || out.length > 20) return out;
  const s = schema as Schema;
  if (s.type !== undefined) {
    const allowed = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    const actual = typeOf(value);
    const ok = allowed.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      out.push({ path, message: `${allowed.join('|')} 이어야 하는데 ${actual}` });
      return out;
    }
  }
  if (s.enum !== undefined && Array.isArray(s.enum) && !s.enum.some((e) => e === value))
    out.push({ path, message: `허용 값 밖: ${JSON.stringify(value)}` });
  if (s.const !== undefined && s.const !== value) out.push({ path, message: '고정 값이 아닙니다' });
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    for (const key of (s.required ?? []) as string[])
      if (record[key] === undefined)
        out.push({ path: `${path}.${key}`, message: '필수 항목이 없습니다' });
    for (const [key, sub] of Object.entries(properties))
      if (record[key] !== undefined) checkSchema(sub, record[key], `${path}.${key}`, out);
    if (s.additionalProperties === false)
      for (const key of Object.keys(record))
        if (!(key in properties)) out.push({ path: `${path}.${key}`, message: '선언에 없는 항목' });
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems)
      out.push({ path, message: `항목이 ${s.minItems}개 이상이어야 합니다` });
    if (s.items)
      for (let i = 0; i < value.length && out.length <= 20; i++)
        checkSchema(s.items, value[i], `${path}[${i}]`, out);
  }
  return out;
}
