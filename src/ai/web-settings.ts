// Settings → AI 「AI 웹 검색」 (ADR-028, T-105; 2026-10-02 user decision "Claude는 WebSearch·WebFetch,
// Codex는 web_search를 켜자"): conversation, host (modeling) and make turns may read the public web
// with the provider's own tools. One switch for both providers, on by default.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WebSettingsValue {
  /** The provider's own web tools in conversation, host and make turns. */
  web: boolean;
}

/**
 * Stored in <data>/web-settings.json; in memory for in-memory stores. A missing file means on (the
 * default); an unreadable one means off, so a switch the user turned off is never read as on.
 */
export class WebSettings {
  private readonly file?: string;
  private memory: WebSettingsValue = { web: true };
  constructor(file?: string) {
    this.file = file;
  }
  get(): WebSettingsValue {
    if (!this.file) return { ...this.memory };
    if (!existsSync(this.file)) return { web: true };
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as { web?: unknown };
      return { web: stored.web === true };
    } catch {
      return { web: false };
    }
  }
  set(value: WebSettingsValue): WebSettingsValue {
    if (!this.file) {
      this.memory = { web: value.web };
      return this.get();
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ web: value.web }) + '\n', 'utf8');
    return this.get();
  }
}
