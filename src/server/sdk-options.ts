import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageRoot} from '../core/package-root.ts';
export function sdkOptions(directory:string){
 const root=fileURLToPath(packageRoot),bundled=join(root,'hosts/rhino/worker/runtime/VIDE.Worker.rhp');
 return {directory:join(directory,'sdk-models'),executable:process.env.VIDE_RHINO_PATH||join(process.env.ProgramFiles||'C:\\Program Files','Rhino 8/System/Rhino.exe'),
  plugin:existsSync(bundled)?bundled:join(root,'.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),bootstrap:join(root,'hosts/rhino/worker/bootstrap.py')};
}
