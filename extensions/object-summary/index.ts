export function run({
  objects,
}: {
  objects: { id: string; type: string; layer: string | null }[];
}) {
  const groups = new Map<string, { type: string; layer: string | null; objectIds: string[] }>();
  for (const object of objects) {
    const key = JSON.stringify([object.type, object.layer]);
    if (!groups.has(key))
      groups.set(key, { type: object.type, layer: object.layer, objectIds: [] });
    groups.get(key)!.objectIds.push(object.id);
  }
  return {
    type: 'object-summary',
    rows: [...groups.values()].map((row) => ({ ...row, count: row.objectIds.length })),
  };
}
