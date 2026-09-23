import { readFile } from 'node:fs/promises';
import {packageRoot} from '../core/package-root.ts';

// Source, compiled server and packaged app share the nearest package root.
const root = new URL('dist/ui/', packageRoot);
const assetPath = /^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/;

export async function readWebAsset(pathname: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (pathname !== '/' && !assetPath.test(pathname)) return null;
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  try {
    const body = await readFile(new URL(filename, root));
    return { body, contentType: pathname === '/' ? 'text/html; charset=utf-8' : pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && pathname !== '/') return null;
    throw error;
  }
}
