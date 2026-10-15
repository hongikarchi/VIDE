/**
 * Imported lines and mails → candidate records (PLAN-53 T-329·T-330, ARCH-01 §5 「프로젝트 기록」
 * '가져오기'). Pure, no node imports: the server gives `h16` (the first 16 hex of the text's
 * SHA-256) and the raw copy's work-folder path. Every candidate is `type '?'`; the 1차 거르기
 * hints are not stored (src/core/record-triage.ts computes them on screen). No automatic O/X.
 */
import type { RecordAttachments, RecordInput } from '../../contracts/records.ts';
import type { KakaoMessage } from './kakao.ts';
import type { MailMessage } from './mail.ts';

export interface ImportCandidate {
  input: RecordInput;
  sourceKey: string;
}

/** A mail candidate's text: subject + first paragraph, at most 2,000 characters. */
const MAIL_TEXT_MAX = 2000;
const TEXT_MAX = 20_000;
const field = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 500);

export function kakaoCandidates(
  messages: readonly KakaoMessage[],
  h16: string,
  copyPath?: string | null,
): ImportCandidate[] {
  return messages.map((message) => {
    const attachments: RecordAttachments = copyPath
      ? { file: { path: copyPath, line: message.line } }
      : {};
    return {
      sourceKey: `kakao:${h16}:${message.line}`,
      input: {
        date: message.date,
        time: message.time,
        type: '?',
        text: `${message.who}: ${message.text}`.slice(0, TEXT_MAX),
        attachments,
      },
    };
  });
}

export function mailCandidates(
  mails: readonly MailMessage[],
  h16: string,
  copyPath?: string | null,
): ImportCandidate[] {
  return mails.map((mail, index) => {
    const subject = field(mail.subject);
    const from = field(mail.from);
    const mailField: NonNullable<RecordAttachments['mail']> = {
      from: from || '(보낸 사람 없음)',
      subject: subject || '(제목 없음)',
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo.slice(0, 500) } : {}),
    };
    const text = [subject || '(제목 없음)', mail.text].filter(Boolean).join('\n');
    return {
      sourceKey: mail.messageId ? `mail:${mail.messageId}` : `mail:${h16}:${index + 1}`,
      input: {
        date: mail.date,
        time: mail.time,
        type: '?',
        text: text.slice(0, MAIL_TEXT_MAX),
        attachments: {
          ...(copyPath ? { file: { path: copyPath, line: mail.line } } : {}),
          mail: mailField,
        },
      },
    };
  });
}
