import { existsSync } from 'node:fs';
let root = new URL('./', import.meta.url);
while (!existsSync(new URL('package.json', root))) {
  const parent = new URL('../', root);
  if (parent.href === root.href) throw new Error('VIDE_PACKAGE_ROOT_NOT_FOUND');
  root = parent;
}
export const packageRoot = root;
