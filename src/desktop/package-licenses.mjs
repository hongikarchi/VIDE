import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Collect notices for the exact NuGet runtime assemblies copied into the package. */
export async function copyZwcadNotices(root, destination, assemblies) {
  const assets = JSON.parse(
    await readFile(join(root, 'hosts/zwcad/worker/obj/project.assets.json'), 'utf8'),
  );
  const target = Object.values(assets.targets)[0];
  const packages = [];
  const found = new Set();
  await mkdir(destination, { recursive: true });
  for (const [name, metadata] of Object.entries(target)) {
    const runtime = Object.keys(metadata.runtime || {}).filter((path) =>
      assemblies.includes(path.split('/').at(-1)),
    );
    if (!runtime.length) continue;
    const library = assets.libraries[name];
    if (library.type !== 'package' || library.path.includes('..'))
      throw Error('Invalid NuGet runtime source');
    let folder;
    for (const base of Object.keys(assets.packageFolders)) {
      const candidate = join(base, library.path);
      try {
        await readdir(candidate);
        folder = candidate;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!folder) throw Error('Missing restored runtime package: ' + name);
    const out = join(destination, name.replace('/', '-'));
    await mkdir(out);
    const notices = (await readdir(folder)).filter((file) =>
      /^(LICENSE|THIRD-PARTY-NOTICES)\.TXT$/i.test(file),
    );
    if (name.startsWith('Microsoft.CodeAnalysis.')) {
      if (!name.endsWith('/4.11.0')) throw Error('Update Roslyn notices for the new version');
      await copyFile(
        join(root, 'src/desktop/licenses/roslyn-4.11.0.txt'),
        join(out, 'LICENSE.TXT'),
      );
    } else if (!notices.some((file) => /^LICENSE/i.test(file)))
      throw Error('Missing runtime license: ' + name);
    for (const file of notices) await copyFile(join(folder, file), join(out, file));
    for (const file of runtime) found.add(file.split('/').at(-1));
    packages.push({
      package: name,
      sha512: library.sha512,
      assemblies: runtime.map((file) => file.split('/').at(-1)),
    });
  }
  for (const file of assemblies)
    if (!found.has(file)) throw Error('Runtime dependency has no notice: ' + file);
  await writeFile(join(destination, 'packages.json'), JSON.stringify(packages, null, 2) + '\n');
}
