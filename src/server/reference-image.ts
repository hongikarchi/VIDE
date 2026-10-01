// The image job of a reference board (SPEC-09.7, PLAN-26 T-090 (c), ARCH-01 §3 「참고 이미지 확인
// 보드」): one single-shot `codex exec` per image (no session), with the built-in image generation
// tool and the ChatGPT login (no API key). Inputs are files (`--image`): the 3D view capture and
// the reference with its regions drawn on it; the prompt carries the interpretation. Codex writes
// the picture under `<codex home>/generated_images/<thread>/*.png`; VIDE copies it into the
// project's outputs and never uses Codex's copy as the record. The whole job, start-up included,
// has one time limit (1 minute, 2026-10-01 user decision); on the limit or a cancel the process
// tree is killed, its end awaited, and whatever it wrote is ignored and removed.
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { killOwnedProcess } from '../ai/claude-cli.ts';
import { codexDisabledFeatures, codexEnvironment } from '../ai/codex-cli.ts';
import { installedCodex } from '../ai/paths.ts';

export const IMAGE_TIME_LIMIT_MS = 60_000;
/** How long a stopped job waits for its process to end before cleaning up anyway. */
const STOP_WAIT_MS = 5_000;
/** Whether `promise` settled within `ms` (the timer does not outlive it). */
async function within(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((done) => (timer = setTimeout(() => done(false), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Why a job left no image (the board shows each with [다시 생성]). */
export type ImageJobCode =
  | 'CODEX_UNAVAILABLE'
  | 'CODEX_LOGIN_REQUIRED'
  | 'CODEX_USAGE_LIMIT'
  | 'IMAGE_REFUSED'
  | 'IMAGE_NOT_CREATED'
  | 'IMAGE_FAILED'
  | 'IMAGE_TIMEOUT'
  | 'IMAGE_CANCELLED';
export type ImageJobResult =
  | { ok: true; elapsedMs: number; size: number }
  | { ok: false; code: ImageJobCode; elapsedMs: number };

export interface ImageJobOptions {
  /** codex.exe; default VIDE_CODEX_PATH or the installed CLI. */
  executable?: string;
  /** Arguments before Codex's own (test seam: a fake codex run by node). */
  prefixArgs?: string[];
  spawn?: typeof spawnChild;
  timeoutMs?: number;
  /** Where Codex keeps generated images (default `~/.codex/generated_images`). */
  generatedRoot?: string;
  /** Where the job's work folder is made (default the system temp folder). */
  workRoot?: string;
  /** The image model's reasoning effort (low keeps it quick). */
  effort?: string;
  model?: string;
}

/**
 * The arguments of the image job: the isolation of every Codex run of VIDE (no user config, rules,
 * MCP servers, web, shell or apps; read-only sandbox; ChatGPT login) with only image generation on.
 */
export function imageJobArguments(images: readonly string[], options: ImageJobOptions = {}) {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'model_provider="openai"',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'web_search="disabled"',
    '-c',
    'mcp_servers={}',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    `model_reasoning_effort="${options.effort ?? 'low'}"`,
  ];
  // The built-in image tool runs through the code-mode host (checked 2026-10-01, codex-cli
  // 0.157.1: with the host off the model reports the tool disabled); code mode itself stays off.
  for (const flag of codexDisabledFeatures)
    if (flag !== 'image_generation' && flag !== 'code_mode_host') args.push('--disable', flag);
  args.push('--enable', 'image_generation', '--enable', 'skip_host_skill_discovery');
  if (options.model) args.push('--model', options.model);
  for (const image of images) args.push('--image', image);
  args.push('-');
  return args;
}

/** The job's prompt: apply the interpreted element to our building in the captured view. */
export function imageJobPrompt(interpretation: {
  summary: string;
  imagePrompt: string;
  regions: readonly { letter: string; element: string; line: string }[];
}) {
  return [
    'Use the image generation tool exactly once to make ONE quick preview image. Fast, low quality, small size (at most 1024x1024). Do not do anything else and do not ask questions.',
    'Image 1 is the current 3D view of our building. Image 2 is a reference photo; the parts the user marked are drawn over it as translucent regions with letter badges.',
    "Redraw image 1 with the marked element(s) applied to our building: keep image 1's camera, framing and building massing; change only what the interpretation asks. No text, letters, labels or arrows anywhere in the image.",
    `Interpretation: ${interpretation.summary}`,
    ...interpretation.regions.map((region) => `Region ${region.letter}: ${region.line}`),
    interpretation.imagePrompt ? `Image instruction: ${interpretation.imagePrompt}` : '',
    'After the image is made, reply with one short sentence.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A failure's code from what the CLI printed (its error events and stderr). */
export function imageFailureCode(output: string): ImageJobCode {
  if (/not logged in|login|unauthori[sz]ed|\b401\b|authenticat/i.test(output))
    return 'CODEX_LOGIN_REQUIRED';
  if (/usage limit|rate limit|\b429\b|quota|too many requests/i.test(output))
    return 'CODEX_USAGE_LIMIT';
  if (/safety|refus|content policy|moderation|not allowed/i.test(output)) return 'IMAGE_REFUSED';
  return 'IMAGE_FAILED';
}

/**
 * Runs one image job. `images` are the input files; the picture is copied to `outFile`. The
 * signal cancels (IMAGE_CANCELLED); the time limit covers everything from the spawn on.
 */
export async function runImageJob(
  job: { prompt: string; images: readonly string[]; outFile: string; signal?: AbortSignal },
  options: ImageJobOptions = {},
): Promise<ImageJobResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const executable = options.executable ?? (process.env.VIDE_CODEX_PATH || installedCodex());
  if (!executable || (!options.prefixArgs && !existsSync(executable)))
    return { ok: false, code: 'CODEX_UNAVAILABLE', elapsedMs: elapsed() };
  if (job.signal?.aborted) return { ok: false, code: 'IMAGE_CANCELLED', elapsedMs: 0 };
  const cwd = await mkdtemp(join(options.workRoot ?? tmpdir(), 'vide-image-'));
  const generatedRoot = options.generatedRoot ?? join(homedir(), '.codex', 'generated_images');
  let thread = '';
  let output = '';
  let child: ChildProcess | undefined;
  // Settles when the process has ended and its output is read (`close`), or at once without one.
  let closed: Promise<void> = Promise.resolve();
  try {
    const outcome = await new Promise<'done' | 'timeout' | 'cancelled' | ImageJobCode>(
      (resolve) => {
        let settled = false;
        let stopping = false;
        const finish = (value: 'done' | 'timeout' | 'cancelled' | ImageJobCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          job.signal?.removeEventListener('abort', abort);
          resolve(value);
        };
        // The limit or a cancel: the process tree is ended and awaited before anything is cleaned
        // (Windows cannot remove a live process's folder; a picture written while it dies goes too).
        const stop = (value: 'timeout' | 'cancelled') => {
          if (stopping || settled) return;
          stopping = true;
          void (async () => {
            const running = child;
            if (running && running.exitCode === null && running.signalCode === null) {
              const killed = await killOwnedProcess(running).catch(() => false);
              if (!killed) running.kill();
              if (!(await within(closed, STOP_WAIT_MS))) running.kill('SIGKILL');
            }
            finish(value);
          })();
        };
        const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? IMAGE_TIME_LIMIT_MS);
        const abort = () => stop('cancelled');
        job.signal?.addEventListener('abort', abort, { once: true });
        try {
          child = (options.spawn ?? spawnChild)(
            executable,
            [...(options.prefixArgs ?? []), ...imageJobArguments(job.images, options)],
            {
              cwd,
              env: codexEnvironment(),
              shell: false,
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
        } catch {
          finish('CODEX_UNAVAILABLE');
          return;
        }
        const spawned = child;
        closed = new Promise<void>((done) => {
          spawned.once('close', () => done());
          spawned.once('error', () => done());
        });
        let pending = '';
        const readEvents = (all = false) => {
          let end;
          while ((end = pending.indexOf('\n')) >= 0 || (all && pending)) {
            if (end < 0) end = pending.length;
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try {
              const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
              if (
                event.type === 'thread.started' &&
                typeof event.thread_id === 'string' &&
                /^[0-9a-f-]{36}$/.test(event.thread_id)
              )
                thread = event.thread_id;
            } catch {
              /* Not an event line. */
            }
          }
        };
        child.stdout?.on('data', (chunk: Buffer) => {
          if (output.length < 200_000) output += chunk.toString('utf8');
          pending += chunk.toString('utf8');
          readEvents();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (output.length < 200_000) output += chunk.toString('utf8');
        });
        child.once('error', () => finish('CODEX_UNAVAILABLE'));
        child.once('close', (code) => {
          // The last line may come without its newline: the thread is known for the clean-up.
          readEvents(true);
          if (stopping) return;
          // `error` items are also warnings (unstable features): only the turn's end counts.
          finish(
            code === 0 &&
              output.includes('"type":"turn.completed"') &&
              !output.includes('"type":"turn.failed"')
              ? 'done'
              : imageFailureCode(output),
          );
        });
        child.stdin?.on('error', () => {});
        child.stdin?.end(job.prompt);
      },
    );
    if (outcome === 'timeout') return { ok: false, code: 'IMAGE_TIMEOUT', elapsedMs: elapsed() };
    if (outcome === 'cancelled')
      return { ok: false, code: 'IMAGE_CANCELLED', elapsedMs: elapsed() };
    if (outcome !== 'done') return { ok: false, code: outcome, elapsedMs: elapsed() };
    // The picture of this run only: its thread's folder, written after the start.
    const folder = thread ? join(generatedRoot, thread) : '';
    let newest: { path: string; at: number } | undefined;
    if (folder)
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        if (!/\.png$/i.test(name)) continue;
        const info = await stat(join(folder, name)).catch(() => undefined);
        if (
          info?.isFile() &&
          info.mtimeMs >= started - 1000 &&
          (!newest || info.mtimeMs > newest.at)
        )
          newest = { path: join(folder, name), at: info.mtimeMs };
      }
    if (!newest) return { ok: false, code: 'IMAGE_NOT_CREATED', elapsedMs: elapsed() };
    await copyFile(newest.path, job.outFile);
    const size = (await stat(job.outFile)).size;
    return { ok: true, elapsedMs: elapsed(), size };
  } finally {
    // Codex announces its thread before any tool runs, so once the process has ended (its output
    // read) a picture can only be in that thread's folder.
    await within(closed, STOP_WAIT_MS);
    await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
    // Codex's own copy is not the record (SPEC-09.9): this run's folder goes.
    if (thread)
      await rm(join(generatedRoot, thread), { recursive: true, force: true }).catch(() => {});
  }
}
