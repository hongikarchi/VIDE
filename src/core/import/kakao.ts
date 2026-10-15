/**
 * 카카오톡 대화 내보내기 `.txt` (PLAN-53 T-329, ARCH-01 §5 「프로젝트 기록」 '가져오기'). Pure, no
 * node imports. Two shapes, told apart per line:
 *  - PC: a date line `--------------- 2026년 10월 15일 목요일 ---------------`, then
 *    `[이름] [오후 2:05] 내용`;
 *  - phone: `2026년 10월 15일 오후 2:05, 이름 : 내용` or `2026. 10. 15. 오후 2:05, 이름 : 내용`.
 * A line that fits neither is the next line of the message before it (`line` stays the first).
 * Date lines, the file's header and system lines (초대·나감·들어옴) make no message. Photo, file
 * and emoticon lines are kept, worded `(사진)`, `(파일) 이름`, `(이모티콘)`.
 * Line numbers count the text without its BOM split at `\n`, from 1 (`\r` dropped).
 */

export interface KakaoMessage {
  /** 'YYYY-MM-DD'. */
  date: string;
  /** 'HH:MM'. */
  time: string;
  who: string;
  text: string;
  /** The message's first line (1-based). */
  line: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (y: string, m: string, d: string) => `${y}-${pad(Number(m))}-${pad(Number(d))}`;
/** '오후 3:12' / '15:12' → '15:12'; null when not a time. */
function clock(meridiem: string | undefined, h: string, m: string): string | null {
  let hour = Number(h);
  const minute = Number(m);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === '오후' || /^pm$/i.test(meridiem)) hour = hour === 12 ? 12 : hour + 12;
    else hour = hour === 12 ? 0 : hour;
  }
  if (hour > 23) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

const TIME = String.raw`(?:(오전|오후|AM|PM|am|pm)\s*)?(\d{1,2}):(\d{2})`;
const DATE_KO = String.raw`(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일`;
const DATE_DOT = String.raw`(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?`;
/** PC date line, with or without the dashes; also `2026. 10. 15. 목요일`. */
const DAY_LINE = new RegExp(
  String.raw`^-*\s*(?:${DATE_KO}|${DATE_DOT})\s*(?:[월화수목금토일]요일)?\s*-*$`,
);
/** `[이름] [오후 2:05] 내용`. */
const PC_LINE = new RegExp(String.raw`^\[([^\]]+)\]\s*\[${TIME}\]\s?(.*)$`);
/** `2026년 10월 15일 오후 2:05, 이름 : 내용` / `2026. 10. 15. 오후 2:05, 이름 : 내용`. */
const PHONE_LINE = new RegExp(String.raw`^(?:${DATE_KO}|${DATE_DOT})\s*${TIME}\s*,\s*(.*)$`);
/** A dated line with no ', 이름 : 내용' (a phone date header). */
const PHONE_STAMP = new RegExp(String.raw`^(?:${DATE_KO}|${DATE_DOT})\s*${TIME}\s*$`);
/** 초대·나감·들어옴·내보냄·방장 같은 시스템 줄. */
const SYSTEM =
  /님이\s.*(?:초대했습니다|초대하였습니다)|님이\s*(?:나갔습니다|들어왔습니다|입장했습니다|퇴장했습니다)|님을\s*내보냈습니다|(?:방장|부방장)(?:이|으로)\s|채팅방 관리자가|메시지가 삭제되었습니다|삭제된 메시지입니다/;

const DELETED = /^(?:삭제된 메시지입니다|메시지가 삭제되었습니다)\.?$/;

/** A photo, file or emoticon line in plain words. */
function media(content: string): string {
  const text = content.trim();
  if (/^사진(?:\s*\d+장)?$/.test(text)) return '(사진)';
  if (/^동영상$/.test(text)) return '(동영상)';
  if (/^(?:\(?이모티콘\)?|스티커)$/.test(text)) return '(이모티콘)';
  if (/^음성메시지$/.test(text)) return '(음성메시지)';
  const file = /^파일\s*:\s*(.+)$/.exec(text);
  if (file) return `(파일) ${file[1]!.trim()}`;
  return content;
}

export function parseKakao(input: string): KakaoMessage[] {
  const text = input.replace(/^\uFEFF/, '');
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const messages: KakaoMessage[] = [];
  let day: string | null = null;
  let current: { date: string; time: string; who: string; parts: string[]; line: number } | null =
    null;
  const flush = () => {
    if (!current) return;
    const body = current.parts.join('\n').replace(/\s+$/, '');
    if (body.trim())
      messages.push({
        date: current.date,
        time: current.time,
        who: current.who,
        text: body,
        line: current.line,
      });
    current = null;
  };
  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    const dayLine = DAY_LINE.exec(trimmed);
    if (dayLine) {
      flush();
      day = dayLine[1]
        ? dayOf(dayLine[1], dayLine[2]!, dayLine[3]!)
        : dayOf(dayLine[4]!, dayLine[5]!, dayLine[6]!);
      return;
    }
    const pc = PC_LINE.exec(raw);
    if (pc && day) {
      const time = clock(pc[2], pc[3]!, pc[4]!);
      if (time) {
        flush();
        // '삭제된 메시지입니다.' in a [이름] [시각] line is a system line too, never a message.
        if (!DELETED.test((pc[5] ?? '').trim()))
          current = { date: day, time, who: pc[1]!.trim(), parts: [media(pc[5] ?? '')], line };
        return;
      }
    }
    const phone = PHONE_LINE.exec(trimmed);
    if (phone) {
      const date = phone[1]
        ? dayOf(phone[1], phone[2]!, phone[3]!)
        : dayOf(phone[4]!, phone[5]!, phone[6]!);
      const time = clock(phone[7], phone[8]!, phone[9]!);
      if (time) {
        flush();
        day = date;
        const rest = phone[10] ?? '';
        const said = /^(.+?)\s:\s?(.*)$/.exec(rest);
        // No 'name : text': a system line (초대·나감 …), never a message.
        if (said && !SYSTEM.test(rest))
          current = { date, time, who: said[1]!.trim(), parts: [media(said[2] ?? '')], line };
        return;
      }
    }
    const stamp = PHONE_STAMP.exec(trimmed);
    if (stamp) {
      flush();
      day = stamp[1]
        ? dayOf(stamp[1], stamp[2]!, stamp[3]!)
        : dayOf(stamp[4]!, stamp[5]!, stamp[6]!);
      return;
    }
    if (SYSTEM.test(trimmed) && !/^\[/.test(trimmed)) {
      flush();
      return;
    }
    // Before the first message: the export's header ("… 님과 카카오톡 대화", "저장한 날짜 : …").
    if (!current) return;
    (current as { parts: string[] }).parts.push(raw);
  });
  flush();
  return messages;
}
