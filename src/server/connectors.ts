import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '../core/store.ts';

// "연결 프로그램": installs the bundled host plugins for the user. Rhino 8 first: the plugin is
// copied to <data>/plugins/rhino/<version>/ (outside the program folder, so a running Rhino never
// blocks a program update) and Rhino's own plugin registration points there. An existing
// registration of the same plugin (for example a development build) is replaced, not duplicated.
const exec = promisify(execFile);
export const RHINO_PLUGIN_ID = '6bde756c-cb1f-45bc-90fa-784c098c2c38';
const RHINO_INSTALL = 'HKLM\\SOFTWARE\\McNeel\\Rhinoceros\\8.0\\Install';
const RHINO_PLUGIN_KEY = `HKCU\\Software\\McNeel\\Rhinoceros\\8.0\\Plug-ins\\${RHINO_PLUGIN_ID}`;
// ZWCAD 2023 loads a managed DLL at startup from its per-user "Applications" registration.
const ZWCAD_INSTALL = 'HKLM\\SOFTWARE\\ZWSOFT\\ZWCAD\\2023';
const zwcadAppKey = (locale: string) =>
  `HKCU\\Software\\ZWSOFT\\ZWCAD\\2023\\${locale}\\Applications\\VIDE`;

export interface Registry {
  get(key: string, name: string): Promise<string | undefined>;
  set(key: string, name: string, value: string | number): Promise<void>;
  /** Value names of a key (empty when it does not exist). */
  names?(key: string): Promise<string[]>;
}
export interface ConnectorOptions {
  /** User data folder (plugins are installed under it). */
  directory: string;
  /** The plugin shipped with this program (VIDE.Worker.rhp next to its deps.json). */
  bundledRhino: string;
  /** The ZWCAD connection plugin (VIDE.Zwcad.Connection.dll with its compiler assemblies). */
  bundledZwcad?: string;
  version: string;
  registry?: Registry;
  /** Whether a process image (e.g. Rhino.exe) is running. */
  running?: (image: string) => Promise<boolean>;
}
export interface ConnectorStatus {
  id: 'rhino8' | 'zwcad2023';
  name: string;
  /** The host program is installed on this PC. */
  available: boolean;
  running: boolean;
  /** none: not registered · other: registered elsewhere (e.g. a development build) · outdated · current */
  plugin: 'none' | 'other' | 'outdated' | 'current';
  version?: string;
  path?: string;
}

const text = (value: string) => value.split(/\r?\n/);
export const windowsRegistry: Registry = {
  async get(key, name) {
    try {
      const { stdout } = await exec('reg', ['query', key, '/v', name], { windowsHide: true });
      for (const line of text(stdout)) {
        const match = new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`).exec(line);
        if (match) return match[1].trim();
      }
    } catch {
      /* Missing key or value. */
    }
    return undefined;
  },
  async names(key) {
    try {
      const { stdout } = await exec('reg', ['query', key], { windowsHide: true });
      return text(stdout)
        .map((line) => /^\s+(\S+)\s+REG_\w+/.exec(line)?.[1])
        .filter((name): name is string => !!name);
    } catch {
      return [];
    }
  },
  async set(key, name, value) {
    await exec(
      'reg',
      [
        'add',
        key,
        '/v',
        name,
        '/t',
        typeof value === 'number' ? 'REG_DWORD' : 'REG_SZ',
        '/d',
        String(value),
        '/f',
      ],
      { windowsHide: true },
    );
  },
};
async function processRunning(image: string) {
  try {
    const { stdout } = await exec(
      'tasklist',
      ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'],
      {
        windowsHide: true,
      },
    );
    return stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
  } catch {
    return false;
  }
}
const digest = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

export class Connectors {
  private options: Required<ConnectorOptions>;
  constructor(options: ConnectorOptions) {
    this.options = {
      registry: windowsRegistry,
      running: processRunning,
      bundledZwcad: '',
      ...options,
    };
  }
  /** ZWCAD 2023's installed UI languages (its Applications registrations are per language). */
  private async zwcadLocales() {
    const names = (await this.options.registry.names?.(ZWCAD_INSTALL)) ?? [];
    return names
      .map((name) => /^ZWCAD\.([a-z]{2}-[A-Z]{2})\.Version$/.exec(name)?.[1])
      .filter((locale): locale is string => !!locale);
  }
  private async zwcadBundle() {
    const file = this.options.bundledZwcad;
    if (!file || !existsSync(file)) return undefined;
    const hash = await digest(file);
    return { file, hash, folder: `${this.options.version}-${hash.slice(0, 8)}` };
  }
  private async zwcadStatus(): Promise<ConnectorStatus> {
    const { registry, running } = this.options;
    const locales = await this.zwcadLocales();
    const available = locales.length > 0;
    const path = available ? await registry.get(zwcadAppKey(locales[0]), 'LOADER') : undefined;
    const bundled = await this.zwcadBundle();
    const root = join(this.options.directory, 'plugins', 'zwcad');
    let plugin: ConnectorStatus['plugin'] = 'none';
    let version: string | undefined;
    if (path) {
      const inside = relative(root, resolve(path));
      if (inside.startsWith('..') || inside.includes(':') || inside.split(sep).length !== 2)
        plugin = 'other';
      else {
        version = inside.split(sep)[0];
        plugin =
          existsSync(path) && bundled && (await digest(path)) === bundled.hash
            ? 'current'
            : 'outdated';
      }
    }
    return {
      id: 'zwcad2023',
      name: 'ZWCAD 2023',
      available,
      running: available && (await running('ZWCAD.exe')),
      plugin,
      version,
      path,
    };
  }
  /**
   * Install or update the ZWCAD connection plugin (loads when ZWCAD starts; its "VIDE CAD" panel
   * opens once). The DLL goes to a new versioned folder, so a running ZWCAD never blocks it.
   */
  async installZwcad() {
    const { registry } = this.options;
    const locales = await this.zwcadLocales();
    if (!locales.length) throw new DomainError('HOST_NOT_INSTALLED');
    const bundled = await this.zwcadBundle();
    if (!bundled) throw new DomainError('PLUGIN_MISSING');
    const root = join(this.options.directory, 'plugins', 'zwcad');
    const target = join(root, bundled.folder);
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(dirname(bundled.file), { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith('.dll'))
        await copyFile(join(dirname(bundled.file), entry.name), join(target, entry.name));
    const plugin = join(target, basename(bundled.file));
    if ((await digest(plugin)) !== bundled.hash) throw new DomainError('PLUGIN_COPY_FAILED');
    for (const locale of locales) {
      const key = zwcadAppKey(locale);
      await registry.set(key, 'DESCRIPTION', 'VIDE 연결');
      await registry.set(key, 'LOADER', plugin);
      await registry.set(key, 'LOADCTRLS', 2);
      await registry.set(key, 'MANAGED', 1);
    }
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => []))
      if (entry.isDirectory() && entry.name !== bundled.folder)
        await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => {});
    return this.list();
  }
  private get pluginRoot() {
    return join(this.options.directory, 'plugins', 'rhino');
  }
  private async bundled() {
    const file = this.options.bundledRhino;
    if (!existsSync(file)) return undefined;
    const hash = await digest(file);
    return { file, hash, folder: `${this.options.version}-${hash.slice(0, 8)}` };
  }
  async list(): Promise<ConnectorStatus[]> {
    const { registry, running } = this.options;
    const available = !!(await registry.get(RHINO_INSTALL, 'ExePath'));
    const path = await registry.get(`${RHINO_PLUGIN_KEY}\\PlugIn`, 'FileName');
    const bundled = await this.bundled();
    let plugin: ConnectorStatus['plugin'] = 'none';
    let version: string | undefined;
    if (path) {
      const inside = relative(this.pluginRoot, resolve(path));
      const managed =
        !inside.startsWith('..') && !inside.includes(':') && inside.split(sep).length === 2;
      if (!managed) plugin = 'other';
      else {
        version = inside.split(sep)[0];
        plugin =
          existsSync(path) && bundled && (await digest(path)) === bundled.hash
            ? 'current'
            : 'outdated';
      }
    }
    return [
      {
        id: 'rhino8',
        name: 'Rhino 8',
        available,
        running: available && (await running('Rhino.exe')),
        plugin,
        version,
        path,
      },
      await this.zwcadStatus(),
    ];
  }
  /** Install or update the Rhino plugin; takes effect when Rhino starts next. */
  async installRhino() {
    const { registry, running } = this.options;
    if (!(await registry.get(RHINO_INSTALL, 'ExePath')))
      throw new DomainError('HOST_NOT_INSTALLED');
    // Rhino rewrites its plugin registration when it exits; change it only while Rhino is closed.
    if (await running('Rhino.exe')) throw new DomainError('HOST_RUNNING');
    const bundled = await this.bundled();
    if (!bundled) throw new DomainError('PLUGIN_MISSING');
    const target = join(this.pluginRoot, bundled.folder);
    await mkdir(target, { recursive: true });
    const plugin = join(target, basename(bundled.file));
    await copyFile(bundled.file, plugin);
    const deps = join(dirname(bundled.file), 'VIDE.Worker.deps.json');
    if (existsSync(deps)) await copyFile(deps, join(target, 'VIDE.Worker.deps.json'));
    if ((await digest(plugin)) !== bundled.hash) throw new DomainError('PLUGIN_COPY_FAILED');
    // The same values Rhino writes when a plugin is dragged in; FileName points to our copy.
    const key = RHINO_PLUGIN_KEY;
    if (!(await registry.get(key, 'Name'))) {
      await registry.set(key, 'Name', 'VIDE.Worker');
      await registry.set(key, 'EnglishName', 'VIDE.Worker');
      await registry.set(key, 'Type', 16);
      await registry.set(key, 'IsDotNETPlugIn', 1);
      await registry.set(key, 'DirectoryInstall', 0);
    }
    await registry.set(key, 'LoadMode', 2);
    await registry.set(`${key}\\PlugIn`, 'FileName', plugin);
    // Earlier copies are removed when nothing uses them (a running Rhino may still hold one).
    for (const entry of await readdir(this.pluginRoot, { withFileTypes: true }).catch(() => []))
      if (entry.isDirectory() && entry.name !== bundled.folder)
        await rm(join(this.pluginRoot, entry.name), { recursive: true, force: true }).catch(
          () => {},
        );
    return this.list();
  }
}
