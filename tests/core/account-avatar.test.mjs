// The account circle's letter and colour (SPEC-05.10 1, Design SCR-34): the same username always
// gets the same colour (FNV-1a 32-bit mod 8), on every PC and on the site.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { AVATAR_COLORS, avatarIndex, avatarInitial } from '../../src/contracts/account-avatar.ts';

test('the colour follows the username and stays stable', () => {
  // FNV-1a 32-bit of "a" is 0xe40c292c (3826002220); mod 8 = 4.
  assert.equal(avatarIndex('a'), 3826002220 % 8);
  assert.equal(avatarIndex('kim'), avatarIndex('kim'));
  for (const name of ['kim', 'lee', 'studio', '김건축', 'x'.repeat(200)]) {
    const index = avatarIndex(name);
    assert.ok(Number.isInteger(index) && index >= 0 && index < AVATAR_COLORS.length, name);
  }
  // One definition for the PC and the site: FNV-1a over the UTF-8 bytes ('김' = EA B9 80 ->
  // 2008694116), not UTF-16 code units (which would give 7).
  assert.equal(avatarIndex('김'), 2008694116 % 8);
  // The eight colours spread over usernames.
  const seen = new Set(Array.from({ length: 64 }, (_, i) => avatarIndex(`user${i}`)));
  assert.equal(seen.size, 8);
});

test('the letter is the first character, upper-case', () => {
  assert.equal(avatarInitial('kim'), 'K');
  assert.equal(avatarInitial(' lee '), 'L');
  assert.equal(avatarInitial('김건축'), '김');
  assert.equal(avatarInitial(''), '');
});

test('the VIDE account and remote access are pointed to the account button, not settings', async () => {
  // SPEC-05.10 4: settings has no account tab any more.
  for (const file of [
    'src/ui/jig-submit.tsx',
    'src/ui/shell/services-settings.tsx',
    'src/sharing/web/hosts.tsx',
    'src/sharing/web/home.tsx',
  ]) {
    const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /설정에서 로그인|⚙ 설정 → VIDE 계정|VIDE 설정에서 원격 접속/, file);
  }
});
