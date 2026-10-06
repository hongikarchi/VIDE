// 할 일 도우미 (Design §03 「대시보드의 AI 열」, PLAN-39 T-181; 2026-10-06 user choice '안 A: 할 일 |
// 큰 달력, AI 접기'): on the dashboard the AI column opens folded, and when it is opened this row
// sits on top with quick requests about the project's 할 일. A button sends its words to the 기본
// 대화 as a hostless Auto turn (src/ui/app/glue.ts listens for AGENDA_ASK), so the request and the
// answer show in the conversation below. Other screens do not show the row.
import { memo } from 'react';
import { useStore } from '../store/core.ts';
import { workspacesState } from '../workspaces.ts';

/** The event a quick request fires; its detail is the request's words. */
export const AGENDA_ASK = 'vide:agenda-ask';

const ASKS: { label: string; text: string }[] = [
  {
    label: '오늘 브리핑',
    text: '[할 일 도우미] 오늘 브리핑: agenda_list로 이 프로젝트의 할 일과 일정을 읽고 지난 것·오늘 할 일, 오늘의 협의·접수·마감, 내일 일정 순으로 짧게 정리해 주세요. 목록은 바꾸지 마세요.',
  },
  {
    label: '이번 주 마감·접수 정리',
    text: '[할 일 도우미] 이번 주(월~일) 마감과 접수를 agenda_list로 읽어 날짜 순으로 정리하고, 아직 끝내지 않은 것과 미리 준비할 것을 짚어 주세요. 목록은 바꾸지 마세요.',
  },
  {
    label: '노트에서 할 일 뽑기',
    text: '[할 일 도우미] 이 프로젝트의 최근 협의 내용·회의록(프로젝트 자료 검색과 프로젝트 폴더의 파일)에서 아직 목록에 없는 할 일·협의·접수·마감을 뽑아 agenda_add로 넣어 주세요. 먼저 agenda_list로 지금 목록을 읽어 같은 항목은 넣지 않고, 날짜·시각·위치·참석자가 적혀 있으면 함께 넣습니다. 넣은 항목을 짧게 알려 주세요.',
  },
];

export const AgendaHelper = memo(function AgendaHelper() {
  const active = useStore(workspacesState, (slice) => slice.active);
  if (active !== 'dashboard') return null;
  return (
    <section className="agenda-helper" aria-label="할 일 도우미">
      <h3>할 일 도우미</h3>
      <div className="agenda-helper-asks">
        {ASKS.map((ask) => (
          <button
            key={ask.label}
            type="button"
            className="link-button"
            onClick={() => dispatchEvent(new CustomEvent(AGENDA_ASK, { detail: ask.text }))}
          >
            {ask.label}
          </button>
        ))}
      </div>
    </section>
  );
});
