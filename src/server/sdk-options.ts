import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRoot } from '../core/package-root.ts';
/** The Rhino plugin shipped with this program, or the development build in a checkout. */
export function defaultRhinoPlugin() {
  const root = fileURLToPath(packageRoot),
    bundled = join(root, 'hosts/rhino/worker/runtime/VIDE.Worker.rhp');
  return existsSync(bundled)
    ? bundled
    : join(root, '.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp');
}
let version: string | undefined;
/** Program version: the PC program's, else package.json's. */
export function appVersion() {
  return (version ??=
    process.env.VIDE_DESKTOP_VERSION ||
    String(
      JSON.parse(readFileSync(join(fileURLToPath(packageRoot), 'package.json'), 'utf8')).version,
    ));
}
export function sdkOptions(directory: string) {
  const root = fileURLToPath(packageRoot);
  return {
    directory: join(directory, 'sdk-models'),
    executable:
      process.env.VIDE_RHINO_PATH ||
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Rhino 8/System/Rhino.exe'),
    plugin: defaultRhinoPlugin(),
    bootstrap: join(root, 'hosts/rhino/worker/bootstrap.py'),
  };
}
