// The legal citation gate on a turn's answer (SPEC-13.5, PLAN-46 T-223, after SPEC-08.7): [L<n>]
// and article numbers pass only when a legal tool returned them in this turn; a legal answer
// written without any legal tool result is 'AI 추정 · 서비스 근거 없음'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalCitations, legalTurn } from '../../src/server/legal-tools.ts';

function returned() {
  const turn = legalTurn();
  turn.used = true;
  turn.answers.set(1, 'applies');
  turn.articles.set('law:건축법/제61조/①', { lawName: '건축법', article: '제61조 제1항' });
  turn.articles.set('law:건축법 시행령/제86조/①', {
    lawName: '건축법 시행령',
    article: '제86조 제1항',
  });
  return turn;
}

test('a reply that is not about law and used no legal tool is left alone', () => {
  assert.deepEqual(legalCitations('보 간격을 2.4 m로 바꿨습니다.', legalTurn()), {});
  assert.deepEqual(legalCitations('제3조 회의록을 보세요', undefined), {});
});

test('only answers and articles the tools returned this turn pass', () => {
  const ok = legalCitations(
    '정북 일조 사선을 받습니다 [L1]. 건축법 제61조, 건축법 시행령 제86조, 시행령 제86조를 보세요.',
    returned(),
  );
  assert.equal(ok.text, undefined);
  assert.deepEqual(ok.legalCheck, { cited: ['L1'], unknown: [], estimate: false, answers: [1] });

  const bad = legalCitations(
    '[L1] [L4] 그리고 건축법 제99조와 주차장법 제19조, 건축법 제86조.',
    returned(),
  );
  assert.deepEqual(bad.legalCheck.unknown, [
    'L4',
    '건축법 제99조',
    '주차장법 제19조',
    '건축법 제86조',
  ]);
  assert.match(bad.text, /\n\n⚠ 확인되지 않은 인용: L4, 건축법 제99조/);
  assert.match(bad.text, /법규 도구가 돌려주지 않은/);
});

test('a legal answer without any legal tool result is an AI estimate', () => {
  const cited = legalCitations('건축법 제61조에 따라 띄워야 합니다.', legalTurn());
  assert.equal(cited.legalCheck.estimate, true);
  assert.match(cited.text, /⚠ AI 추정 · 서비스 근거 없음/);
  assert.deepEqual(cited.legalCheck.unknown, ['건축법 제61조']);
  // [L<n>] from memory, no tool this turn.
  assert.equal(legalCitations('앞 답 [L2] 그대로입니다.', undefined).legalCheck.estimate, true);
  // In the legal conversation, legal words alone make it a legal answer.
  assert.equal(
    legalCitations('용적률 한도는 250%입니다.', legalTurn(), { legalConversation: true }).legalCheck
      .estimate,
    true,
  );
  assert.deepEqual(legalCitations('용적률 한도는 250%입니다.', legalTurn()), {});
});

test('a turn that used the tools without citing gets its answers listed and no warning', () => {
  const result = legalCitations('서비스 답 카드를 보세요.', returned());
  assert.equal(result.text, undefined);
  assert.deepEqual(result.legalCheck.answers, [1]);
});
