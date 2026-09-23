import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const excluded = /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.git|\.vide|\.wrangler|node_modules|bin|obj|build|dist)(?:\/|$)|\.(?:db|sqlite)(?:-.*)?$|\.(?:log|dmp|pem|key|pfx|p12|3dm|3dmbak|dwg|dwl2?)$/i;

// Release source comes only from the Git index, never a recursive working-tree copy.
// This also excludes local credentials accidentally added under a source directory.
export async function copyPackageSources(root, destination, trackedFiles, prefixes) {
  let count = 0;
  for (const name of trackedFiles) {
    if (!prefixes.some(prefix => name.startsWith(prefix + '/'))) continue;
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.' || !part)) {
      throw new Error('INVALID_PACKAGE_SOURCE_PATH');
    }
    if (excluded.test(name)) throw new Error('FORBIDDEN_PACKAGE_SOURCE: ' + name);
    const filename = join(root, name);
    // Check every component: a tracked path inside a replaced directory must not
    // follow a symlink into private data outside the repository.
    let current = root;
    for (const part of name.split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('PACKAGE_SOURCE_SYMLINK: ' + name);
    }
    if (!(await lstat(filename)).isFile()) throw new Error('PACKAGE_SOURCE_NOT_FILE: ' + name);
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(filename, target);
    count++;
  }
  return count;
}
