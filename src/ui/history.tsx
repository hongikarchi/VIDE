import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { sceneRepresentation } from '../core/scene-representation.ts';
import { api, labels, errors } from './gateway.ts';
import { showApplication } from './application.tsx';
import { showQuantities } from './quantities.tsx';
import { applicationResultSchema } from '../contracts/workspace-result.ts';
import { uiRequestSchema as workspaceRequestSchema } from './workspace-data.ts';
import type { UiRequest as Request, UiMessage as Message } from './workspace-data.ts';
import type { z } from 'zod';
type Application = z.infer<typeof applicationResultSchema>;
interface Actions {
  candidate: (id: string) => void;
  selection: (requestId: string | undefined, id: string) => void;
  saveReview: (id: string) => Promise<void>;
  report: (id: string) => void;
  changed: () => void;
  restore: (request: Request) => void;
  error: (message: string) => void;
}
const errorLabels: Record<string, string> = errors,
  stateLabels: Record<string, string> = labels;
function Action({
  children,
  run,
  error,
  latch = false,
}: {
  children: string;
  run: () => void | Promise<void>;
  error: Actions['error'];
  latch?: boolean;
}) {
  const [pending, setPending] = useState(false),
    locked = useRef(false);
  return (
    <button
      disabled={pending}
      onClick={async () => {
        if (locked.current) return;
        locked.current = true;
        setPending(true);
        let succeeded = false;
        try {
          await run();
          succeeded = true;
        } catch (reason) {
          error(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다.');
        } finally {
          if (!latch || !succeeded) {
            locked.current = false;
            setPending(false);
          }
        }
      }}
    >
      {children}
    </button>
  );
}
function Candidate({
  message,
  projectId,
  actions,
}: {
  message: Message;
  projectId: string;
  actions: Actions;
}) {
  const request = message.request!,
    result = request.result!,
    objects = result.objects ?? [],
    scene = result.scene ?? [];
  const host = result.host === 'zwcad' ? 'ZWCAD' : 'Rhino',
    extension = result.host === 'zwcad' ? 'dwg' : '3dm';
  const missing = scene.filter((object) => !sceneRepresentation(object));
  const apply =
    host === 'Rhino' &&
    (result.executionMode === 'sdk'
      ? result.sourceDocument?.connection === 'owned-editor' && message.source !== 'document'
      : (!result.sourceDocument &&
          objects.every((object) => ['box', 'polyline', 'extrude'].includes(object.kind))) ||
        (result.sourceDocument &&
          objects.every((object) => object.kind === 'native') &&
          message.source !== 'document'));
  return (
    <>
      <button onClick={() => actions.candidate(message.id)}>이 후보 보기</button>
      <small>
        {host} {['file', 'document'].includes(message.source ?? '') ? '작업 사본' : '후보'} ·
        저장·재열기 검증됨
      </small>
      {result.sourceDocument ? (
        <small>
          {result.sourceDocument.name} ·{' '}
          {new Date(result.sourceDocument.capturedAt).toLocaleString()} 취득 · 현재 상태 미확인
        </small>
      ) : null}
      {missing.length ? (
        <small>
          3D 표시 미지원 {missing.length}개 (
          {[...new Set(missing.map((object) => object.nativeType))].join(', ')}) · 파일과 객체
          목록에는 보존됨
        </small>
      ) : null}
      <a
        href={`/api/v1/projects/${projectId}/requests/${message.id}/model`}
        download={`VIDE-candidate.${extension}`}
      >
        {extension === 'dwg' ? 'DWG 내려받기' : '3dm 내려받기'}
      </a>
      <Action
        error={actions.error}
        run={async () => {
          await api(`/projects/${projectId}/requests/${message.id}/open`, 'POST', {});
        }}
      >
        {host + '에서 열기'}
      </Action>
      <Action error={actions.error} run={() => actions.saveReview(message.id)}>
        검토본 저장
      </Action>
      <button onClick={() => actions.report(message.id)}>검토본 내려받기</button>
      <Action
        error={actions.error}
        run={async () => {
          const { showPublicationExport } = await import('./publication-export.tsx');
          showPublicationExport(projectId, message.id, objects);
        }}
      >
        공유 자료
      </Action>
      {apply ? (
        <Action
          error={actions.error}
          run={async () => {
            await showApplication(
              projectId,
              message.id,
              (application: Application) => {
                request.applications = [...(request.applications ?? []), application];
                actions.changed();
              },
              result.sourceDocument,
            );
          }}
        >
          문서에 적용
        </Action>
      ) : null}
      {request.applications?.map((application) => (
        <div key={application.id}>
          <small>
            {application.state === 'succeeded'
              ? '원본 반영됨 · 파일 저장 별도'
              : application.state === 'unknown'
                ? '원본 적용 결과 미확인'
                : application.state === 'failed'
                  ? '원본 적용 실패'
                  : '원본 적용 중'}
          </small>
          {application.result?.code ? (
            <small>{errorLabels[application.result.code] || application.result.code}</small>
          ) : null}
          {application.state === 'unknown' ? (
            <Action
              error={actions.error}
              run={async () => {
                Object.assign(
                  application,
                  applicationResultSchema.parse(
                    await api(
                      `/projects/${projectId}/applications/${application.id}/reconcile`,
                      'POST',
                      {},
                    ),
                  ),
                );
                actions.changed();
              }}
            >
              결과 다시 확인
            </Action>
          ) : null}
        </div>
      ))}
      <Action
        error={actions.error}
        run={async () => {
          await showQuantities(projectId, message.id, (id: string) =>
            actions.selection(message.id, id),
          );
        }}
      >
        수량표
      </Action>
      <details>
        <summary>측정값</summary>
        {scene.map((object) => (
          <p key={object.id}>
            {objects.find((item) => item.id === object.id)?.name || object.id} · 기하 면적{' '}
            {object.area?.toFixed(2) ?? '—'} m² · 체적 {object.volume?.toFixed(2) ?? '—'} m³
          </p>
        ))}
      </details>
    </>
  );
}
function Card({
  message,
  models,
  projectId,
  actions,
}: {
  message: Message;
  models: { id: string; name: string }[];
  projectId: string;
  actions: Actions;
}) {
  const request = message.request,
    result = request?.result;
  const references = [...message.pins, ...message.sketches, ...message.files].map(
    (item) => item.name,
  );
  const imported = ['file', 'document'].includes(message.source ?? '');
  const subtitle =
    message.provider === 'extension'
      ? '확장 · ' + message.extensionVersion
      : imported
        ? message.host === 'zwcad'
          ? result?.dwgEditMode === 'polyline-vertices-v1'
            ? 'ZWCAD 작업 사본'
            : 'ZWCAD 참고 도면'
          : 'Rhino 작업 사본'
        : `${models.find((model) => model.id === message.model)?.name || message.model} · ${message.effort} · ${message.permission === 'review' ? '검토만' : '후보 작업 허용'}`;
  return (
    <article className="chat-message" data-request-id={message.id}>
      <p>{message.body || '첨부한 문맥 검토'}</p>
      {references.length ? <small>{references.join(' · ')}</small> : null}
      <small>{subtitle}</small>
      <details>
        <summary>요청 문맥</summary>
        <pre>{JSON.stringify(request?.input || message, null, 2)}</pre>
      </details>
      {request ? (
        <>
          <small>
            {message.provider === 'extension' && request.state === 'succeeded'
              ? '확장 완료'
              : request.state === 'running' && result?.phase === 'host'
                ? '호스트 생성·저장 검증 중'
                : result?.phase === 'stopping'
                  ? '중단 확인 중'
                  : stateLabels[request.state] || request.state}
          </small>
          {result?.text ? <p>{result.text}</p> : null}
          {result?.extensionResult?.rows.map((row, index) => (
            <details key={index}>
              <summary>
                {row.type} · {row.layer || '레이어 미상'} · {row.count}개
              </summary>
              {row.objectIds.map((id) => (
                <button
                  key={id}
                  onClick={() => actions.selection(message.baseRequestId ?? undefined, id)}
                >
                  {message.pins.find((pin) => pin.id === id)?.name || id}
                </button>
              ))}
            </details>
          ))}
          {result?.hostExecuted ? (
            <Candidate message={message} projectId={projectId} actions={actions} />
          ) : null}
          {result?.code ? <p>{errorLabels[result.code] || result.code}</p> : null}
          {request.state === 'unknown' && result?.executionMode === 'sdk' ? (
            <Action
              error={actions.error}
              run={async () => {
                message.request = workspaceRequestSchema.parse(
                  await api(`/projects/${projectId}/requests/${message.id}/reconcile`, 'POST', {}),
                );
                actions.changed();
              }}
            >
              저장된 후보 다시 확인
            </Action>
          ) : null}
          {request.state === 'unknown' &&
          message.source === 'file' &&
          message.host === 'zwcad' &&
          result?.sourceHash ? (
            <Action
              error={actions.error}
              run={async () => {
                message.request = workspaceRequestSchema.parse(
                  await api(`/projects/${projectId}/imports/${message.id}/reconcile`, 'POST', {}),
                );
                actions.changed();
              }}
            >
              불러오기 결과 확인
            </Action>
          ) : null}
          {['failed', 'cancelled', 'interrupted'].includes(request.state) &&
          message.provider !== 'extension' &&
          !imported ? (
            <Action error={actions.error} run={() => actions.restore(request)}>
              입력을 초안으로 복원
            </Action>
          ) : null}
          {message.provider !== 'extension' &&
          ['queued', 'running'].includes(request.state) &&
          !imported &&
          result?.phase !== 'host' ? (
            <Action
              latch
              error={actions.error}
              run={async () => {
                await api(`/projects/${projectId}/requests/${message.id}/cancel`, 'POST', {});
              }}
            >
              중단
            </Action>
          ) : null}
        </>
      ) : null}
    </article>
  );
}
function History({
  element,
  messages,
  models,
  projectId,
  actions,
  follow,
  scroll,
}: {
  element: HTMLElement;
  messages: Message[];
  models: { id: string; name: string }[];
  projectId: string;
  actions: Actions;
  follow: boolean;
  scroll: number;
}) {
  useLayoutEffect(() => {
    element.scrollTop = follow ? element.scrollHeight : scroll;
  });
  return messages.length ? (
    <>
      {messages.map((message) => (
        <Card
          key={message.id}
          message={message}
          models={models}
          projectId={projectId}
          actions={actions}
        />
      ))}
    </>
  ) : (
    <div className="chat-empty">V.</div>
  );
}
const roots = new Map<HTMLElement, Root>();
export function renderHistory(
  element: HTMLElement,
  messages: Message[],
  models: { id: string; name: string }[],
  projectId: string | undefined,
  actions: Actions,
): void {
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  root.render(
    <History
      element={element}
      messages={messages}
      models={models}
      projectId={projectId ?? ''}
      actions={actions}
      follow={element.scrollHeight - element.scrollTop - element.clientHeight < 60}
      scroll={element.scrollTop}
    />,
  );
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    for (const root of roots.values()) root.unmount();
    roots.clear();
  }
});
