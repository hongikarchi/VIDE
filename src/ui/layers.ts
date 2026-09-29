// Several files in one space (SPEC-01.9): every visible linked file (and a result opened on its own)
// is a layer. Layers are drawn together; no file is the main one. With more than one layer, object and
// scene ids are prefixed by the layer so equal ids of different files (e.g. CAD handles) stay apart,
// and each object keeps its own id (`sourceId`) and basis request (`revision`) for pins and inspection.

export interface LayerSource<O extends { id: string }, S extends { id: string }, D> {
  key: string;
  name: string;
  requestId: string;
  objects: readonly O[];
  scene: readonly S[];
  definitions?: Record<string, D>;
}
export interface LayerObject {
  id: string;
  sourceId: string;
  revision: string;
  documentKey: string;
  documentName: string;
}

export function composeLayers<O extends { id: string }, S extends { id: string }, D>(
  layers: readonly LayerSource<O, S, D>[],
) {
  const many = layers.length > 1;
  const objects: (O & LayerObject)[] = [];
  const scene: S[] = [];
  const definitions: Record<string, D> = {};
  for (const layer of layers) {
    const display = (id: string) => (many ? `${layer.key}::${id}` : id);
    for (const object of layer.objects)
      objects.push({
        ...object,
        id: display(object.id),
        sourceId: object.id,
        revision: layer.requestId,
        documentKey: layer.key,
        documentName: layer.name,
      });
    for (const item of layer.scene) scene.push({ ...item, id: display(item.id) });
    // Block definitions are keyed by content hash, so layers can share one table.
    Object.assign(definitions, layer.definitions ?? {});
  }
  return { objects, scene, definitions, many };
}

/** The file's own id of a shown object (pins and host calls use it). */
export const sourceIdOf = (object: { id: string; sourceId?: unknown }) =>
  typeof object.sourceId === 'string' ? object.sourceId : object.id;

/** The shown id of an object of a given basis request, if it is on screen. */
export function displayIdOf(
  objects: readonly { id: string; sourceId?: unknown; revision?: unknown }[],
  basis: string,
  id: string,
) {
  return objects.find((object) => object.revision === basis && sourceIdOf(object) === id)?.id;
}

/** Identity of the layer set on screen: a change means objects were added or removed. */
export const layerSignature = (layers: readonly { key: string; requestId: string }[]) =>
  layers.map((layer) => layer.key + '=' + layer.requestId).join('|');
