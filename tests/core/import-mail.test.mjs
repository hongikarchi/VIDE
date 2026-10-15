// 메일 가져오기 파서 (PLAN-53 T-330, ARCH-01 §5 「프로젝트 기록」 '가져오기'): 합성 eml 20통 —
// 멀티파트(plain+html, html+첨부), base64 한글, quoted-printable, 인용·서명, In-Reply-To, Message-ID 없음 —
// 과 mbox 분리, 머리 인코딩, euc-kr. 가짜 이름과 example.com 주소만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWords, htmlText, ownText, parseMail } from '../../src/core/import/mail.ts';
import { mailCandidates } from '../../src/core/import/candidates.ts';
import { mails, mbox } from '../fixtures/records-import/index.mjs';

const NOW = new Date(2026, 9, 20, 9, 0);
const BODY = (n) => `${n}차 검토 의견입니다. 외벽 줄눈은 600 간격으로 할지 정해야 합니다.`;

test('20 eml: subject, from, Message-ID, In-Reply-To, first paragraph, attachments', () => {
  const list = mails();
  assert.equal(list.length, 20);
  list.forEach((mail, index) => {
    const n = index + 1;
    const parsed = parseMail(mail.text, `메일${n}.eml`, NOW);
    assert.equal(parsed.length, 1, `mail ${n}`);
    const [one] = parsed;
    assert.equal(one.subject, `외벽 검토 ${n}차`);
    assert.match(one.from, /^(김설계|박현장|이구조) <user\d@example\.com>$/);
    assert.equal(one.messageId, mail.id);
    assert.equal(one.inReplyTo, n > 1 && n % 2 === 0 ? `m${n - 1}@example.com` : null);
    assert.equal(one.text, BODY(n), `mail ${n} first paragraph`);
    assert.equal(one.line, 1);
    // Quotes, "…님이 작성:", "Original Message" and the signature are folded away.
    assert.ok(!/인용|원래|드림|Original/.test(one.full), `mail ${n}: ${one.full}`);
    assert.match(one.date, /^2026-10-1\d$/);
    assert.match(one.time, /^\d{2}:\d{2}$/);
  });
  const withFile = parseMail(list[2].text, 'a.eml', NOW)[0];
  assert.deepEqual(withFile.attachmentsNames, ['elevation.pdf']);
  assert.match(withFile.full, /둘째 & 문단/);
  assert.ok(!/<p>|style/.test(withFile.full));
});

test('Date: local time of the header; missing or unreadable → the import day, no time', () => {
  const sent = parseMail(
    'Subject: a\r\nDate: Thu, 15 Oct 2026 05:15:00 +0000\r\n\r\n본문',
    'a.eml',
    NOW,
  )[0];
  const at = new Date(Date.UTC(2026, 9, 15, 5, 15));
  assert.equal(sent.time, `${String(at.getHours()).padStart(2, '0')}:15`);
  const none = parseMail('Subject: b\r\nDate: 언젠가\r\n\r\n본문', 'b.eml', NOW)[0];
  assert.equal(none.date, '2026-10-20');
  assert.equal(none.time, null);
});

test('mbox: split at From lines, each mail keeps its first line', () => {
  const text = mbox();
  const parsed = parseMail(text, '보관함.mbox', NOW);
  assert.equal(parsed.length, 20);
  const lines = text.split('\n');
  for (const mail of parsed) assert.match(lines[mail.line - 1], /^From user\d+@example\.com /);
  assert.deepEqual(
    parsed.map((mail) => mail.subject),
    mails().map((_mail, i) => `외벽 검토 ${i + 1}차`),
  );
});

test('encoded words, euc-kr, an unknown charset, html text, quoted lines', () => {
  assert.equal(decodeWords('=?UTF-8?B?7ZWc6riA?= =?UTF-8?Q?=EC=8B=9C=ED=97=98?='), '한글시험');
  // '한글' in EUC-KR (C7 D1 B1 DB), base64.
  const euc = [
    'Subject: =?euc-kr?B?x9Gx2w==?=',
    'Content-Type: text/plain; charset=ks_c_5601-1987',
    'Content-Transfer-Encoding: base64',
    '',
    'x9Gx2w==',
  ].join('\r\n');
  const parsed = parseMail(euc, 'e.eml', NOW)[0];
  assert.equal(parsed.subject, '한글');
  assert.equal(parsed.text, '한글');
  const odd = parseMail(
    'Subject: x\r\nContent-Type: text/plain; charset=x-unknown-9\r\nContent-Transfer-Encoding: base64\r\n\r\nx9Gx2w==',
    'o.eml',
    NOW,
  )[0];
  assert.equal(odd.text, '(글자 깨짐)');
  assert.equal(htmlText('<div>가<br>나</div><script>x</script>&lt;다&gt;'), '가\n나\n\n<다>');
  assert.equal(
    ownText('위 글\n> 인용\n아래 글\n\nOn Thu, Oct 15 kim wrote:\n> 옛 글'),
    '위 글\n아래 글',
  );
});

test('candidates: mail:<Message-ID>, mail:<h16>:<n> without one, subject + first paragraph', () => {
  const parsed = parseMail(mbox(), 'm.mbox', NOW);
  const candidates = mailCandidates(parsed, 'feedfacecafebeef', '01_운영/기록/원문/m.mbox');
  assert.equal(candidates[0].sourceKey, 'mail:m1@example.com');
  assert.equal(candidates[19].sourceKey, 'mail:feedfacecafebeef:20');
  assert.equal(candidates[1].input.text, `외벽 검토 2차\n${BODY(2)}`);
  assert.deepEqual(candidates[1].input.attachments, {
    file: { path: '01_운영/기록/원문/m.mbox', line: parsed[1].line },
    mail: {
      from: '이구조 <user2@example.com>',
      subject: '외벽 검토 2차',
      inReplyTo: 'm1@example.com',
    },
  });
  assert.equal(candidates[1].input.type, '?');
  const long = mailCandidates([{ ...parsed[0], text: '가'.repeat(5000) }], 'x');
  assert.equal(long[0].input.text.length, 2000);
  assert.deepEqual(Object.keys(long[0].input.attachments), ['mail']);
});
