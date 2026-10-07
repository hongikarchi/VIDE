// Opt-in error/performance reports (ADR-036, SPEC-05.9, PLAN-34 T-155·T-156). Nothing leaves this
// PC until the user agrees on the first-run card or in Settings › 상태 · 오류. Once agreed, an
// anonymous summary of the diagnostic logs (telemetry-summary.ts: allowlisted fields, scrubbed text,
// numbers) is built at start and once a day, kept in <data>/telemetry-outbox until the account site
// takes it, and retried hourly while offline. The choice and a random install id live in
// <data>/telemetry.json; the id is not tied to the VIDE account. Large items (the diagnostic bundle,
// crash dumps) are never sent automatically: after an engine crash the user is asked, and the site
// takes bundles only while its switch is on (off until R2 is available).
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, totalmem, userInfo } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { listDumps, writeDiagnosticBundle } from './diagnostic-bundle.ts';
import { BENIGN_EXITS, summarizeLogs, type Summary } from './telemetry-summary.ts';

export type Consent = 'granted' | 'denied';

const settingsSchema = z
  .object({
    consent: z.enum(['granted', 'denied']).optional(),
    decidedAt: z.string().optional(),
    installId: z.string().uuid().optional(),
    /** Lines up to this time (ISO) are summarized already. */
    cursor: z.string().optional(),
    lastBatchAt: z.string().optional(),
    lastSentAt: z.string().optional(),
    lastError: z.string().optional(),
    /** The last engine crash the user answered (its `at` in engine-exits.jsonl). */
    crashSeenAt: z.string().optional(),
  })
  .passthrough();
type Settings = z.infer<typeof settingsSchema>;

export interface TelemetryOptions {
  /** The VIDE data folder; undefined (in-memory stores) keeps everything in memory, never sends. */
  directory?: string;
  /** Show the first-run card (the installed PC program; tests turn it on). */
  prompt?: boolean;
  /** The account site that takes reports (the signed-in site, else the default one). */
  site: () => string;
  /** Program version on every report. */
  version: () => string;
  /** Written to the engine log before summarizing, so the latest lines are on disk. */
  flush?: () => void;
  /** Words taken out of free text besides the Windows user and PC names (project names). */
  sensitive?: () => string[];
  fetcher?: typeof fetch;
  now?: () => Date;
  /** First batch this long after start (default 60 s). */
  startDelayMs?: number;
  /** Checks for a due batch and retries this often (default 1 hour). */
  everyMs?: number;
  /** A new batch at most this often (default 24 h); at start one is made when an hour has passed. */
  batchMs?: number;
}

/** Reports kept while the site cannot be reached (oldest dropped). */
const OUTBOX_KEEP = 14;
/** Answers that mean the site will never take this report. */
const DROPPED_STATUS = new Set([400, 413, 415, 422]);
/** A diagnostic bundle sent after a crash: without a dump, and with one. */
export const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
export const BUNDLE_WITH_DUMP_MAX_BYTES = 95 * 1024 * 1024;
/**
 * A dump goes to the site only when it fits the site's limit with the logs beside it (T-191; the
 * site's own limit is in src/sharing/telemetry.ts). Full dumps are usually larger: they stay on
 * this PC, in a bundle made with [진단 묶음 내보내기].
 */
export const dumpSendable = (bytes: number) =>
  bytes + BUNDLE_MAX_BYTES <= BUNDLE_WITH_DUMP_MAX_BYTES;

export interface TelemetryView {
  consent: Consent | null;
  /** Show the first-run card now. */
  prompt: boolean;
  installId?: string;
  decidedAt?: string;
  lastSentAt?: string;
  lastError?: string;
  pending: number;
  site: string;
  /** An engine crash the user has not answered (the [진단 묶음을 보낼까요?] card). */
  crash?: { at: string; code: number; hex?: string };
}

export class Telemetry {
  private readonly options: TelemetryOptions;
  private memory: Settings = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  constructor(options: TelemetryOptions) {
    this.options = options;
  }
  private get file() {
    return this.options.directory ? join(this.options.directory, 'telemetry.json') : undefined;
  }
  private get outbox() {
    return this.options.directory ? join(this.options.directory, 'telemetry-outbox') : undefined;
  }
  private now() {
    return (this.options.now ?? (() => new Date()))();
  }
  private read(): Settings {
    const file = this.file;
    if (!file) return { ...this.memory };
    try {
      return settingsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // Missing or damaged: not answered, so nothing is sent.
      return {};
    }
  }
  private write(next: Settings) {
    const file = this.file;
    if (!file) {
      this.memory = { ...next };
      return;
    }
    mkdirSync(this.options.directory!, { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(file + '.tmp', file);
  }
  private update(change: Partial<Settings>) {
    const next = { ...this.read(), ...change };
    this.write(next);
    return next;
  }
  /** The settings with a random install id (made once, kept in the file). */
  private settings() {
    const current = this.read();
    if (current.installId) return current;
    return this.update({ installId: randomUUID() });
  }
  get consent(): Consent | null {
    return this.read().consent ?? null;
  }
  private pendingFiles() {
    const outbox = this.outbox;
    if (!outbox || !existsSync(outbox)) return [];
    return readdirSync(outbox)
      .filter((name) => /^report-.*\.json$/.test(name))
      .sort();
  }
  async view(local = true): Promise<TelemetryView> {
    const settings = this.read();
    const crash = local && settings.consent !== undefined ? await this.crash() : undefined;
    return {
      consent: settings.consent ?? null,
      prompt: local && !!this.options.prompt && !!this.file && settings.consent === undefined,
      ...(settings.installId ? { installId: settings.installId } : {}),
      ...(settings.decidedAt ? { decidedAt: settings.decidedAt } : {}),
      ...(settings.lastSentAt ? { lastSentAt: settings.lastSentAt } : {}),
      ...(settings.lastError ? { lastError: settings.lastError } : {}),
      pending: this.pendingFiles().length,
      site: safeOrigin(this.options.site()),
      ...(crash ? { crash } : {}),
    };
  }
  /**
   * The user's answer. Agreeing starts the reports from now on (lines written before are never
   * sent); declining stops them and removes reports waiting to be sent.
   */
  async set(consent: Consent) {
    const now = this.now().toISOString();
    const before = this.read();
    this.settings();
    this.update({
      consent,
      decidedAt: now,
      ...(consent === 'granted' && before.consent !== 'granted'
        ? { cursor: now, lastBatchAt: now }
        : {}),
      lastError: undefined,
    });
    if (consent === 'denied') {
      this.stopTimers();
      const outbox = this.outbox;
      if (outbox) rmSync(outbox, { recursive: true, force: true });
    } else this.start();
    return this.view();
  }
  /** Starts the timers (only while agreed). Called at engine start and after agreeing. */
  start() {
    if (this.closed || !this.file || this.consent !== 'granted' || this.interval) return;
    this.timer = setTimeout(() => void this.tick(true), this.options.startDelayMs ?? 60_000);
    this.timer.unref?.();
    this.interval = setInterval(() => void this.tick(false), this.options.everyMs ?? 3_600_000);
    this.interval.unref?.();
  }
  private stopTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = this.interval = undefined;
  }
  async close() {
    this.closed = true;
    this.stopTimers();
    await this.running?.catch(() => {});
  }
  /** One round: a new batch when due, then the outbox. Rounds never overlap. */
  tick(atStart = false): Promise<void> {
    if (this.running) return this.running;
    this.running = this.round(atStart).finally(() => (this.running = undefined));
    return this.running;
  }
  private async round(atStart: boolean) {
    if (this.consent !== 'granted') return;
    const settings = this.settings();
    const now = this.now();
    const last = Date.parse(settings.lastBatchAt ?? settings.cursor ?? '') || 0;
    const due =
      now.getTime() - last >= (atStart ? 3_600_000 : (this.options.batchMs ?? 86_400_000));
    if (due) await this.batch();
    await this.flushOutbox();
  }
  /** The summary the next batch would carry (Settings › [보낼 내용 보기]). Never sent from here. */
  async preview() {
    const settings = this.settings();
    const until = this.now().toISOString();
    const since =
      settings.consent === 'granted' && settings.cursor
        ? settings.cursor
        : new Date(this.now().getTime() - 86_400_000).toISOString();
    return this.report(settings.installId!, await this.summary(since, until));
  }
  private async summary(since: string, until: string): Promise<Summary> {
    try {
      this.options.flush?.();
    } catch {
      /* The log flush is best effort. */
    }
    return summarizeLogs({
      directory: this.options.directory!,
      since,
      until,
      sensitive: this.sensitiveWords(),
    });
  }
  private sensitiveWords() {
    const words: string[] = [];
    try {
      words.push(userInfo().username);
    } catch {
      /* No user name. */
    }
    try {
      words.push(hostname());
    } catch {
      /* No host name. */
    }
    try {
      words.push(...(this.options.sensitive?.() ?? []));
    } catch {
      /* Project names are a help, not a must. */
    }
    return words;
  }
  /** One report: who (a random install id), which versions and system, and the summary. */
  private report(installId: string, summary: Summary) {
    return {
      installId,
      version: this.options.version(),
      kind: 'summary' as const,
      payload: {
        os: `${platform()} ${release()}`,
        arch: arch(),
        node: process.version,
        cpus: cpus().length,
        memoryGB: Math.round(totalmem() / 1_073_741_824),
        ...summary,
      },
    };
  }
  /** Summarizes the lines since the cursor into the outbox and moves the cursor. */
  async batch() {
    if (this.consent !== 'granted' || !this.outbox) return undefined;
    const settings = this.settings();
    const until = this.now().toISOString();
    const since = settings.cursor ?? settings.decidedAt ?? until;
    if (since >= until) return undefined;
    const report = this.report(settings.installId!, await this.summary(since, until));
    // Declined while the summary was being made: nothing is kept.
    if (this.consent !== 'granted') return undefined;
    mkdirSync(this.outbox, { recursive: true });
    const name = `report-${until.replace(/[:.]/g, '-')}.json`;
    writeFileSync(join(this.outbox, name), JSON.stringify(report), 'utf8');
    for (const old of this.pendingFiles().slice(0, -OUTBOX_KEEP))
      rmSync(join(this.outbox, old), { force: true });
    this.update({ cursor: until, lastBatchAt: until });
    return report;
  }
  /** Sends what waits in the outbox, oldest first; stops at the first failure to retry later. */
  async flushOutbox() {
    const outbox = this.outbox;
    if (!outbox) return { sent: 0 };
    let sent = 0;
    for (const name of this.pendingFiles()) {
      if (this.consent !== 'granted') break;
      const file = join(outbox, name);
      let body: string;
      try {
        body = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      let status: number;
      try {
        const response = await (this.options.fetcher ?? fetch)(
          `${safeOrigin(this.options.site())}/api/telemetry/reports`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(20_000),
          },
        );
        status = response.status;
      } catch (error) {
        this.update({ lastError: `NETWORK ${(error as Error)?.name ?? 'Error'}` });
        break;
      }
      if (status >= 200 && status < 300) {
        rmSync(file, { force: true });
        sent++;
        this.update({ lastSentAt: this.now().toISOString(), lastError: undefined });
        continue;
      }
      this.update({ lastError: `HTTP ${status}` });
      // The site will never take this one (malformed, too large, refused for its content): it is
      // dropped. Anything else (limited, busy, a site without the endpoint yet) is kept.
      if (DROPPED_STATUS.has(status)) rmSync(file, { force: true });
      break;
    }
    return { sent };
  }
  /** The newest engine exit the PC program recorded that VIDE did not ask for, if unanswered. */
  async crash(): Promise<TelemetryView['crash']> {
    const directory = this.options.directory;
    if (!directory) return undefined;
    const seen = this.read().crashSeenAt ?? '';
    const oldest = new Date(this.now().getTime() - 7 * 86_400_000).toISOString();
    let text = '';
    try {
      text = await readFile(join(directory, 'logs', 'engine-exits.jsonl'), 'utf8');
    } catch {
      return undefined;
    }
    for (const raw of text.trim().split(/\r?\n/).reverse().slice(0, 200)) {
      try {
        const line = JSON.parse(raw) as {
          at?: unknown;
          code?: unknown;
          hex?: unknown;
          asked?: unknown;
        };
        if (typeof line.at !== 'string' || line.at <= seen || line.at < oldest) return undefined;
        if (line.asked !== false || typeof line.code !== 'number' || BENIGN_EXITS.has(line.code))
          continue;
        return {
          at: line.at,
          code: line.code,
          ...(typeof line.hex === 'string' ? { hex: line.hex } : {}),
        };
      } catch {
        continue;
      }
    }
    return undefined;
  }
  /**
   * The answer to [진단 묶음을 보낼까요?]: the crash counts as answered either way. Sending makes the
   * diagnostic bundle (dumps only when asked) and posts it; the site may refuse (switched off).
   */
  async answerCrash(send: boolean, dumps = false) {
    const crash = await this.crash();
    this.update({ crashSeenAt: crash?.at ?? this.now().toISOString() });
    if (!send || !this.options.directory) return { sent: false as const, reason: 'DECLINED' };
    const settings = this.settings();
    try {
      this.options.flush?.();
    } catch {
      /* Best effort. */
    }
    // A dump over the site's limit is left out (the logs still go) instead of failing the send.
    const newest = dumps ? (await listDumps(this.options.directory))[0] : undefined;
    const dumpSkipped = !!newest && !dumpSendable(newest.bytes);
    if (dumpSkipped || !newest) dumps = false;
    const skipped = dumpSkipped ? { dumpSkipped: true as const } : {};
    const bundle = await writeDiagnosticBundle({
      directory: this.options.directory,
      days: 3,
      dumps,
    });
    const limit = dumps ? BUNDLE_WITH_DUMP_MAX_BYTES : BUNDLE_MAX_BYTES;
    if (bundle.bytes > limit)
      return {
        sent: false as const,
        reason: 'BUNDLE_TOO_LARGE',
        file: bundle.file,
        bytes: bundle.bytes,
        ...skipped,
      };
    let status: number;
    let code: string | undefined;
    try {
      const response = await (this.options.fetcher ?? fetch)(
        `${safeOrigin(this.options.site())}/api/telemetry/bundles`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/zip',
            'X-Vide-Install': settings.installId!,
            'X-Vide-Version': this.options.version(),
            'X-Vide-Dumps': dumps ? '1' : '0',
          },
          body: await readFile(bundle.file),
          signal: AbortSignal.timeout(120_000),
        },
      );
      status = response.status;
      code = z.object({ error: z.string() }).safeParse(await response.json().catch(() => ({})))
        .data?.error;
    } catch {
      return {
        sent: false as const,
        reason: 'NETWORK_UNAVAILABLE',
        file: bundle.file,
        bytes: bundle.bytes,
        ...skipped,
      };
    }
    if (status >= 200 && status < 300)
      return { sent: true as const, file: bundle.file, bytes: bundle.bytes, ...skipped };
    return {
      sent: false as const,
      reason: code ?? `HTTP_${status}`,
      file: bundle.file,
      bytes: bundle.bytes,
      ...skipped,
    };
  }
}

function safeOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, '');
  }
}
