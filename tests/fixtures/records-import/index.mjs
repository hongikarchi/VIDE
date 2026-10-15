// 합성 가져오기 fixture (PLAN-53 T-329·T-330): made-up 카카오톡 conversations and mails only —
// names 김설계·박현장·이구조, addresses at example.com, no real conversation or phone number.
const WHO = ['김설계', '박현장', '이구조'];
const SAYS = [
  '외벽 마감 샘플 오늘 들어왔습니다',
  '2층 슬래브 두께는 200으로 갈까요?',
  '계단 난간 높이는 1200으로 확정합니다',
  '현장 사진 올립니다',
  '창호 업체 견적 다시 받아볼게요',
  '지붕 방수는 우레탄으로 하자',
];

/**
 * PC export: header, date lines, `[이름] [오후 3:12] 내용`, every 7th message two lines long,
 * photo·file·emoticon lines and a system line per day. Returns {text, messages, lines}.
 */
export function kakaoPc(days = 6, perDay = 20) {
  const lines = ['김설계 님과 카카오톡 대화', '저장한 날짜 : 2026-10-20 09:00:00', ''];
  let messages = 0;
  for (let d = 0; d < days; d++) {
    const day = 10 + d;
    lines.push(`--------------- 2026년 10월 ${day}일 목요일 ---------------`);
    lines.push('박현장님이 이구조님을 초대했습니다.');
    for (let i = 0; i < perDay; i++) {
      const hour = 9 + (i % 10);
      const meridiem = hour < 12 ? '오전' : '오후';
      const h12 = hour > 12 ? hour - 12 : hour;
      const said =
        i % 10 === 3
          ? '사진'
          : i % 10 === 8
            ? '파일: 평면도-v3.pdf'
            : i % 10 === 9
              ? '이모티콘'
              : SAYS[i % SAYS.length];
      lines.push(`[${WHO[i % 3]}] [${meridiem} ${h12}:${String(i * 2).padStart(2, '0')}] ${said}`);
      if (i % 7 === 0) lines.push('이어지는 줄: 도면 번호 A-101 참고');
      messages++;
    }
  }
  return { text: lines.join('\r\n') + '\r\n', messages, lines: lines.length };
}

/** Phone export: `2026. 10. 15. 오후 3:12, 이름 : 내용` (or the 년월일 form), stamp lines between days. */
export function kakaoPhone(days = 6, perDay = 20, form = 'dot') {
  const lines = ['카카오톡 대화', ''];
  let messages = 0;
  for (let d = 0; d < days; d++) {
    const day = 10 + d;
    const date = form === 'dot' ? `2026. 10. ${day}.` : `2026년 10월 ${day}일`;
    lines.push(`${date} 오전 8:00`);
    lines.push(`${date} 오전 8:01, 박현장님이 나갔습니다.`);
    for (let i = 0; i < perDay; i++) {
      const hour = 9 + (i % 10);
      const meridiem = hour < 12 ? '오전' : '오후';
      const h12 = hour > 12 ? hour - 12 : hour;
      const said = i % 10 === 3 ? '사진 3장' : SAYS[i % SAYS.length];
      lines.push(
        `${date} ${meridiem} ${h12}:${String(i * 2).padStart(2, '0')}, ${WHO[i % 3]} : ${said}`,
      );
      if (i % 5 === 0) lines.push('둘째 줄입니다', '');
      messages++;
    }
    lines.push('');
  }
  return { text: lines.join('\n'), messages, lines: lines.length };
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const word = (text) => `=?UTF-8?B?${b64(text)}?=`;
const qp = (text) =>
  [...Buffer.from(text, 'utf8')]
    .map((byte) =>
      byte > 126 || byte === 61
        ? '=' + byte.toString(16).toUpperCase().padStart(2, '0')
        : String.fromCharCode(byte),
    )
    .join('');

/**
 * Twenty made-up mails, one `.eml` text each: plain, base64 Korean, quoted-printable, multipart
 * alternative (plain+html), html only, a reply with In-Reply-To and quoted text, an attachment, a
 * signature, one with no Message-ID.
 */
export function mails() {
  const out = [];
  for (let n = 1; n <= 20; n++) {
    const id = n === 20 ? null : `m${n}@example.com`;
    const head = [
      `From: ${word(WHO[n % 3])} <user${n % 3}@example.com>`,
      `To: team@example.com`,
      `Subject: ${word(`외벽 검토 ${n}차`)}`,
      `Date: Thu, ${String(10 + (n % 5)).padStart(2, '0')} Oct 2026 0${n % 9}:15:00 +0900`,
      ...(id ? [`Message-ID: <${id}>`] : []),
      ...(n > 1 && n % 2 === 0 ? [`In-Reply-To: <m${n - 1}@example.com>`] : []),
      'MIME-Version: 1.0',
    ];
    const body = `${n}차 검토 의견입니다. 외벽 줄눈은 600 간격으로 할지 정해야 합니다.`;
    const kind = n % 5;
    let rest;
    if (kind === 0)
      rest = [
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64(body + '\n\n둘째 문단.\n'),
      ];
    else if (kind === 1)
      rest = [
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        qp(body),
        '',
        '> 이전 메일 인용 줄',
        '',
        '2026년 10월 9일 (목) 오후 3:12, 김설계 <user0@example.com>님이 작성:',
        '> 원래 질문',
      ];
    else if (kind === 2)
      rest = [
        'Content-Type: multipart/alternative; boundary="ALT-1"',
        '',
        '--ALT-1',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64(body),
        '--ALT-1',
        'Content-Type: text/html; charset=utf-8',
        '',
        `<p>${body}</p>`,
        '--ALT-1--',
      ];
    else if (kind === 3)
      rest = [
        'Content-Type: multipart/mixed; boundary="MIX-1"',
        '',
        '--MIX-1',
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64(
          `<html><head><style>p{}</style></head><body><p>${body}</p><p>둘째 &amp; 문단</p></body></html>`,
        ),
        '--MIX-1',
        `Content-Type: application/pdf; name="${word('입면도.pdf')}"`,
        'Content-Disposition: attachment; filename="elevation.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQK',
        '--MIX-1--',
      ];
    else
      rest = [
        'Content-Type: text/plain; charset=utf-8',
        '',
        body,
        '',
        '-----Original Message-----',
        'From: someone@example.com',
        '원래 메일',
        '',
        '-- ',
        '김설계 드림',
      ];
    out.push({ id, text: [...head, ...rest].join('\r\n') + '\r\n' });
  }
  return out;
}

/** The twenty mails as one mbox (`From ` lines between them). */
export function mbox(list = mails()) {
  return list
    .map(
      (mail, i) =>
        `From user${i}@example.com Thu Oct 15 09:00:00 2026\n${mail.text.replace(/\r\n/g, '\n')}`,
    )
    .join('\n');
}
