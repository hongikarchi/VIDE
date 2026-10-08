// The account circle's letter and colour (SPEC-05.10 1, Design SCR-34): the same username always
// gets the same colour (FNV-1a 32-bit mod 8), on every PC and on the site.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AVATAR_COLORS, avatarIndex, avatarInitial } from '../../src/contracts/account-avatar.ts';

test('the colour follows the username and stays stable', () => {
  // FNV-1a 32-bit of "a" is 0xe40c292c (3826002220); mod 8 = 4.
  assert.equal(avatarIndex('a'), 3826002220 % 8);
  assert.equal(avatarIndex('kim'), avatarIndex('kim'));
  for (const name of ['kim', 'lee', 'studio', '김건축', 'x'.repeat(200)]) {
    const index = avatarIndex(name);
    assert.ok(Number.isInteger(index) && index >= 0 && index < AVATAR_COLORS.length, name);
  }
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
