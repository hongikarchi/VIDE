// 카카오톡 가져오기 파서 (PLAN-53 T-329, ARCH-01 §5 「프로젝트 기록」 '가져오기'): 합성 대화 300줄 이상
// (PC 형식·모바일 형식 두 가지), 이어지는 줄, 사진·파일·이모티콘 줄, 날짜 구분 줄, 시스템 줄 → 건수·줄
// 번호·sourceKey. 실제 대화는 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKakao } from '../../src/core/import/kakao.ts';
import { kakaoCandidates } from '../../src/core/import/candidates.ts';
import { triageHints, triageScore } from '../../src/core/record-triage.ts';
import { kakaoPc, kakaoPhone } from '../fixtures/records-import/index.mjs';

test('PC export: date lines, [이름] [오후 3:12] lines, continuations, media and system lines', () => {
  const pc = kakaoPc(12, 20);
  assert.ok(pc.lines >= 300);
  const messages = parseKakao(pc.text);
  assert.equal(messages.length, pc.messages);
  const lines = pc.text.split('\n');
  for (const message of messages) {
    // `line` is the message's first line in the file (1-based).
    assert.match(lines[message.line - 1], new RegExp(`^\\[${message.who}\\]`));
    assert.match(message.date, /^2026-10-\d{2}$/);
    assert.match(message.time, /^\d{2}:\d{2}$/);
    assert.ok(!message.text.includes('\r'));
  }
  assert.deepEqual(messages[0], {
    date: '2026-10-10',
    time: '09:00',
    who: '김설계',
    text: '외벽 마감 샘플 오늘 들어왔습니다\n이어지는 줄: 도면 번호 A-101 참고',
    line: 6,
  });
  assert.equal(messages[1].time, '10:02');
  // 오후: 13시 → 13:xx.
  assert.ok(messages.some((message) => message.time.startsWith('13:')));
  assert.ok(messages.some((message) => message.text === '(사진)'));
  assert.ok(messages.some((message) => message.text === '(파일) 평면도-v3.pdf'));
  assert.ok(messages.some((message) => message.text === '(이모티콘)'));
  assert.ok(
    !messages.some((message) => /초대했습니다|카카오톡 대화|저장한 날짜/.test(message.text)),
  );
  assert.equal(messages.at(-1).date, '2026-10-21');
  // A deleted message in the PC form is a system line as well.
  const deleted = parseKakao(
    '--------------- 2026년 10월 10일 토요일 ---------------\n' +
      '[박현장] [오후 2:06] 삭제된 메시지입니다.\n' +
      '[박현장] [오후 2:07] 지붕 샘플 확인했습니다\n',
  );
  assert.deepEqual(
    deleted.map((message) => message.text),
    ['지붕 샘플 확인했습니다'],
  );
});

test('phone export: 2026. 10. 15. and 2026년 10월 15일 lines, stamps, 나감 lines', () => {
  for (const form of ['dot', 'ko']) {
    const phone = kakaoPhone(12, 20, form);
    assert.ok(phone.lines >= 300, `${form} ${phone.lines}`);
    const messages = parseKakao(phone.text);
    assert.equal(messages.length, phone.messages, form);
    assert.deepEqual(messages[0], {
      date: '2026-10-10',
      time: '09:00',
      who: '김설계',
      text: '외벽 마감 샘플 오늘 들어왔습니다\n둘째 줄입니다',
      line: 5,
    });
    assert.ok(messages.some((message) => message.text === '(사진)'));
    assert.ok(!messages.some((message) => /나갔습니다/.test(message.text)));
  }
});

test('12시 오전/오후, a BOM, CRLF and a file with no messages', () => {
  const text =
    '\uFEFF--------------- 2026년 1월 2일 금요일 ---------------\r\n' +
    '[김설계] [오전 12:05] 자정 직후\r\n[박현장] [오후 12:30] 정오 뒤\r\n';
  assert.deepEqual(
    parseKakao(text).map((message) => [message.time, message.line]),
    [
      ['00:05', 2],
      ['12:30', 3],
    ],
  );
  assert.deepEqual(parseKakao('그냥 글입니다\n둘째 줄'), []);
  assert.deepEqual(parseKakao(''), []);
});

test('candidates: kakao:<h16>:<line> keys are unique, text "<이름>: <내용>", file line', () => {
  const pc = kakaoPc(12, 20);
  const messages = parseKakao(pc.text);
  const candidates = kakaoCandidates(messages, '0123456789abcdef', '01_운영/기록/원문/대화.txt');
  const keys = candidates.map((candidate) => candidate.sourceKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys[0], 'kakao:0123456789abcdef:6');
  assert.deepEqual(candidates[0].input, {
    date: '2026-10-10',
    time: '09:00',
    type: '?',
    text: '김설계: 외벽 마감 샘플 오늘 들어왔습니다\n이어지는 줄: 도면 번호 A-101 참고',
    attachments: { file: { path: '01_운영/기록/원문/대화.txt', line: 6 } },
  });
  // No copy: no file pointer.
  assert.deepEqual(kakaoCandidates(messages, 'x', null)[0].input.attachments, {});
});

test('1차 거르기 도우미: question, decision and part words; never a state', () => {
  const ask = triageHints('박현장: 2층 슬래브 두께는 200으로 갈까요?', ['슬래브', '외벽']);
  assert.deepEqual(ask, { question: true, decision: false, parts: ['슬래브'] });
  assert.equal(triageScore(ask), 2);
  const settle = triageHints('이구조: 계단 난간 높이는 1200으로 확정합니다', ['난간']);
  assert.deepEqual(settle, { question: false, decision: true, parts: ['난간'] });
  assert.equal(triageScore(triageHints('현장 사진 올립니다', ['외벽'])), 0);
  assert.equal(triageHints('창호를 바꿀지 정해야 합니다', []).question, false);
  assert.equal(triageHints('창호를 할지 말지', []).question, true);
  assert.equal(triageHints('확정은 아직입니다', []).decision, false);
});
