// The proposal slot over the composer (`#route-card`, PLAN-26 T-113, region C): '계획부터 할까요?',
// a proposal card (jig to open, T2 app action), a jig start row (SPEC-07.18 3·7) or the reference
// check before sending (SPEC-09.11). src/ui/app/thread.ts sets `workState.routeCard`.
import { useStore } from '../store/core.ts';
import { workState, type RouteCardContent } from '../store/work.ts';
import type { ReferenceCardOptions } from '../reference-check.ts';

function ReferenceCheckCard({ options }: { options: ReferenceCardOptions }) {
  const { found } = options;
  return (
    <>
      <p>참고 이미지로 먼저 확인할까요?</p>
      {found?.images.length ? (
        <div className="reference-check-list" role="list" aria-label="경로의 이미지">
          {found.images.map((image, index) => (
            <button
              key={index}
              type="button"
              role="listitem"
              title={`${image.path} · 첨부하고 영역 표시`}
              onClick={() => options.pick?.(image)}
            >
              {image.name}
            </button>
          ))}
        </div>
      ) : null}
      {found?.images.length && found.kind === 'folder' ? (
        <small className="reference-check-note" title={found.path ?? ''}>
          {found.total > found.images.length
            ? `앞 ${found.images.length}개 · 전체 ${found.total}개`
            : `${found.total}개`}
        </small>
      ) : null}
      <div className="route-card-actions">
        {options.mark ? (
          <button type="button" className="primary-button" onClick={options.mark}>
            영역 표시
          </button>
        ) : null}
        <button type="button" onClick={options.send}>
          그냥 보내기
        </button>
        <button type="button" onClick={options.close}>
          닫기
        </button>
      </div>
    </>
  );
}

function Content({ content }: { content: RouteCardContent }) {
  switch (content.kind) {
    case 'plan-first':
      return (
        <>
          <p>Jev · 여러 단계나 여러 파일이 걸린 요청입니다. 계획부터 할까요?</p>
          <div className="route-card-actions">
            <button type="button" className="primary-button" onClick={content.plan}>
              계획부터
            </button>
            <button type="button" onClick={content.auto}>
              바로 진행
            </button>
            <button type="button" onClick={content.close}>
              닫기
            </button>
          </div>
        </>
      );
    case 'proposal':
      return (
        <>
          <p>{content.text}</p>
          <div className="route-card-actions">
            {content.run ? (
              <button type="button" className="primary-button" onClick={content.run.action}>
                {content.run.label}
              </button>
            ) : null}
            <button type="button" onClick={content.toAi}>
              AI 작업으로 보내기
            </button>
            <button type="button" onClick={content.close}>
              닫기
            </button>
          </div>
        </>
      );
    case 'skill':
      return (
        <>
          <p className="route-row-head">{content.head}</p>
          {content.steps ? (
            <ul className="route-row-steps">
              {content.steps.map((item, index) => (
                <li key={index} data-done={String(item.done)}>
                  {`${item.done ? '✓' : '□'} ${item.text}`}
                </li>
              ))}
            </ul>
          ) : null}
          {content.note ? <p className="route-row-note">{content.note}</p> : null}
          <div className="route-card-actions">
            {content.progress ? (
              <button type="button" className="primary-button" onClick={content.progress}>
                진행
              </button>
            ) : null}
            <button type="button" onClick={content.toChat}>
              일반 대화로
            </button>
          </div>
        </>
      );
    case 'reference':
      return <ReferenceCheckCard options={content.options} />;
  }
}

export function RouteCard() {
  const card = useStore(workState, (slice) => slice.routeCard);
  const className = [
    'route-card',
    card.routeRow ? 'route-row' : '',
    card.referenceCheck ? 'reference-check' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={className}
      id="route-card"
      role="group"
      aria-label="요청 제안"
      hidden={card.hidden}
    >
      {card.content ? <Content content={card.content} /> : null}
    </div>
  );
}
