import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNIVERSARY_INTRO,
  LETTER,
  MENU_STEP_ONE,
  UNAUTHORIZED_TEMPLATE,
  WELCOME_MESSAGE,
} from '../tgcloud/lib/content.js';
import {
  SPEC_INTRO,
  SPEC_LETTER_PARAGRAPHS,
  SPEC_SIGNATURE,
  SPEC_UNAUTHORIZED,
  SPEC_WELCOME,
} from './fixtures/spec_text.js';

test('the unauthorized message matches the specification character for character', () => {
  assert.equal(UNAUTHORIZED_TEMPLATE, SPEC_UNAUTHORIZED);
  assert.equal(UNAUTHORIZED_TEMPLATE.split('{mention}').length, 2);
  assert.equal(UNAUTHORIZED_TEMPLATE.includes('{%'), false);
});

test('the girlfriend welcome matches the specification character for character', () => {
  assert.equal(WELCOME_MESSAGE, SPEC_WELCOME);
});

test('the anniversary introduction matches the specification character for character', () => {
  assert.equal(ANNIVERSARY_INTRO, SPEC_INTRO);
});

test('the menu step body is exactly "choose"', () => {
  assert.equal(MENU_STEP_ONE, 'choose');
});

test('the letter is complete, in order, and not shortened or rewritten', () => {
  assert.equal(LETTER.paragraphs.length, SPEC_LETTER_PARAGRAPHS.length);
  assert.equal(LETTER.paragraphs.length, 12);
  assert.ok(LETTER.signature.includes('With love'));
  assert.deepEqual([...LETTER.paragraphs], SPEC_LETTER_PARAGRAPHS);
  assert.equal(LETTER.signature, SPEC_SIGNATURE);
  assert.equal(LETTER.id, 'anniversary-7-months');
  assert.equal(LETTER.title, 'For Sheesh’s Mommy');
});

test('the supplied Unicode styling is preserved, not re-transformed', () => {
  assert.match(WELCOME_MESSAGE, /𝑯𝒆𝒉𝒆/);
  assert.match(LETTER.paragraphs[0], /𝑴𝒐𝒎𝒎𝒚/);
  assert.match(ANNIVERSARY_INTRO, /𝑯𝒐𝒊𝒊/);
  // A second transform would break these mathematical alphanumeric codepoints.
  assert.equal([...WELCOME_MESSAGE].includes('𝐻'), false);
  assert.equal([...LETTER.paragraphs[0]].includes('M'), true); // "My Dearest" stays plain
});
