/** SDK and fixed candidate application capabilities; legacy templates keep their own contract. */
export function isDwgSdkEditMode(value: unknown): boolean {
  return value === 'polyline-vertices-v1' || value === 'linear-entities-v1';
}
