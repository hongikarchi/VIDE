import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DomainError } from '../core/store.ts';

// The remote access tool (ADR-039 2, ARCH-01 §6 「원격 접속 도구」): the official cloudflared of a
// fixed release, fetched by this PC from Cloudflare's GitHub releases (VIDE does not ship it) and
// used only when its SHA-256 is the release's published value.
export const CLOUDFLARED_VERSION = '2026.9.3';
/** From the 2026.9.3 release notes; equal to the file checked on this PC on 2026-09-28. */
export const CLOUDFLARED_SHA256 =
  'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2';
export const CLOUDFLARED_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`;

/**
 * Download cloudflared to `target`: written next to it as `.download`, renamed only when its hash
 * matches. CLOUDFLARED_DOWNLOAD_FAILED (network, HTTP) or CLOUDFLARED_VERIFY_FAILED (hash).
 */
export async function downloadCloudflared(
  target: string,
  {
    fetcher = fetch,
    url = CLOUDFLARED_URL,
    sha256 = CLOUDFLARED_SHA256,
  }: { fetcher?: typeof fetch; url?: string; sha256?: string } = {},
) {
  await mkdir(dirname(target), { recursive: true });
  const partial = target + '.download';
  const hash = createHash('sha256');
  try {
    const response = await fetcher(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const out = createWriteStream(partial, { mode: 0o755 });
    const done = new Promise<void>((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
    });
    done.catch(() => {});
    const reader = response.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      hash.update(value);
      if (!out.write(value))
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
    out.end();
    await done;
  } catch {
    await unlink(partial).catch(() => {});
    throw new DomainError('CLOUDFLARED_DOWNLOAD_FAILED');
  }
  if (hash.digest('hex') !== sha256.toLowerCase()) {
    await unlink(partial).catch(() => {});
    throw new DomainError('CLOUDFLARED_VERIFY_FAILED');
  }
  await rename(partial, target);
  return target;
}
