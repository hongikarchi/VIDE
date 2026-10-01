// Settings → AI 「작업 중 질문 받기」 (PLAN-24 T-075, ADR-026 4; 2026-10-01 user decision "codex도
// 기본으로 켜야"): the AI asks with its provider's own question tool inside the running turn —
// Claude's AskUserQuestion, Codex through `codex app-server` — and the turn goes on with the answer.
// One switch for both providers, on by default. The environment still forces each one off:
// VIDE_NATIVE_QUESTIONS=0 (Claude) and VIDE_CODEX_APP_SERVER=0 (Codex, back to `codex exec`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { codexAppServerEnabled } from './codex-app-server.ts';

export interface QuestionSettingsValue {
  /** Ask with the provider's own question tool during a turn. */
  native: boolean;
}
/** The setting as the screen reads it: the switch and what the environment forces off. */
export interface QuestionSettingsView extends QuestionSettingsValue {
  forcedOff: { 'claude-cli': boolean; 'codex-cli': boolean };
}
/** Claude's own questions are not forced off by the environment. */
export const claudeQuestionsAllowed = (env: NodeJS.ProcessEnv = process.env) =>
  env.VIDE_NATIVE_QUESTIONS !== '0';

/**
 * Stored in <data>/question-settings.json; in memory for in-memory stores. A missing file means on
 * (the default); an unreadable one means off, so a switch the user turned off is never read as on.
 */
export class QuestionSettings {
  private readonly file?: string;
  private memory: QuestionSettingsValue = { native: true };
  constructor(file?: string) {
    this.file = file;
  }
  get(): QuestionSettingsValue {
    if (!this.file) return { ...this.memory };
    if (!existsSync(this.file)) return { native: true };
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as { native?: unknown };
      return { native: stored.native === true };
    } catch {
      return { native: false };
    }
  }
  set(value: QuestionSettingsValue): QuestionSettingsValue {
    if (!this.file) {
      this.memory = { native: value.native };
      return this.get();
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ native: value.native }) + '\n', 'utf8');
    return this.get();
  }
  view(env: NodeJS.ProcessEnv = process.env): QuestionSettingsView {
    return {
      ...this.get(),
      forcedOff: {
        'claude-cli': !claudeQuestionsAllowed(env),
        'codex-cli': !codexAppServerEnabled(env),
      },
    };
  }
}
