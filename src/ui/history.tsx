import { useRef, useState } from 'react';
import { sceneRepresentation } from '../core/scene-representation.ts';
import { api, labels, errors } from './gateway.ts';
import { showApplication } from './application.tsx';
import { showQuantities } from './quantities.tsx';
import { applicationResultSchema } from '../contracts/workspace-result.ts';
import { uiRequestSchema as workspaceRequestSchema } from './workspace-data.ts';
import type { UiRequest as Request, UiMessage as Message } from './workspace-data.ts';
import type { z } from 'zod';
// Result actions shared by the work view: candidate display, application, downloads.
// Requests made before explicit models were listed ran each CLI's own default model.
export const legacyModels: Record<string, string> = {
  'claude-cli': 'Claude (CLI 기본)',
  'codex-cli': 'ChatGPT (CLI 기본)',
};
type Application = z.infer<typeof applicationResultSchema>;
export interface Actions {
  candidate: (id: string) => void;
  selection: (requestId: string | undefined, id: string) => void;
  saveReview: (id: string) => Promise<void>;
  report: (id: string) => void;
  changed: () => void;
  restore: (request: Request) => void;
  error: (message: string) => void;
  /** Open another work in the work view. */
  focus: (id: string) => void;
  /** Add the composer's input to running work (SPEC-02.8); a reason means it is not possible now. */
  intervene: (id: string) => void;
  interventionReason: (id: string) => string | undefined;
}
export const errorLabels: Record<string, string> = errors,
  stateLabels: Record<string, string> = labels;
export function Action({
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
/** Area and volume per object, drawn only while open: a large model has tens of thousands. */
function Measurements({
  scene,
  objects,
}: {
  scene: { id: string; area?: number | null; volume?: number | null }[];
  objects: { id: string; name?: string }[];
}) {
  const [open, setOpen] = useState(false);
  let rows = null;
  if (open) {
    const names = new Map(objects.map((item) => [item.id, item.name]));
    rows = scene.map((object) => (
      <p key={object.id}>
        {names.get(object.id) || object.id} · 기하 면적 {object.area?.toFixed(2) ?? '—'} m² · 체적{' '}
        {object.volume?.toFixed(2) ?? '—'} m³
      </p>
    ));
  }
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>측정값</summary>
      {rows}
    </details>
  );
}
export function Candidate({
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
  const omitted = result.displayCoverage?.omitted ?? missing.length;
  const displayOnly = result.displayOnly === true;
  const apply =
    !result.applicationId &&
    (host === 'Rhino' || result.executionMode === 'sdk') &&
    (result.executionMode === 'sdk'
      ? (result.sourceDocument?.connection === 'owned-editor' ||
          result.sourceDocument?.connection === 'attached-editor') &&
        message.source !== 'document'
      : (!result.sourceDocument &&
          objects.every((object) => ['box', 'polyline', 'extrude'].includes(object.kind))) ||
        (result.sourceDocument &&
          objects.every((object) => object.kind === 'native') &&
          message.source !== 'document'));
  return (
    <>
      <button onClick={() => actions.candidate(message.id)}>
        {displayOnly ? '이 모델 보기' : '이 후보 보기'}
      </button>
      {result.syncState === 'failed' ? (
        <small>Rhino 반영 완료 · Sync를 다시 실행하세요. 파일 저장은 별도입니다.</small>
      ) : null}
      <small>
        {displayOnly
          ? `${host} 화면 동기화 · 원본 변경 없음`
          : `${host} ${['file', 'document'].includes(message.source ?? '') ? '작업 사본' : '후보'} · 저장·재열기 검증됨`}
      </small>
      {result.sourceDocument ? (
        <small>
          {result.sourceDocument.name} ·{' '}
          {new Date(result.sourceDocument.capturedAt).toLocaleString()} 취득 · 현재 상태 미확인
        </small>
      ) : null}
      {omitted > 0 ? (
        <small>
          {omitted.toLocaleString()}개는{' '}
          {displayOnly ? `원본 ${host}에 유지` : '목록·네이티브 파일에 보존'} ·{' '}
          {host === 'ZWCAD' && displayOnly ? '표시 제외 (숨김·미지원 포함)' : '화면 표현 미지원'}
        </small>
      ) : null}
      {host === 'ZWCAD' && displayOnly && result.displayCoverage?.omittedTypes.OversizedDisplay ? (
        <small>
          대형 블록 {result.displayCoverage.omittedTypes.OversizedDisplay}개는 아직 표시하지
          못했습니다.
        </small>
      ) : null}
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
                Object.assign(
                  request,
                  workspaceRequestSchema.parse(
                    await api(`/projects/${projectId}/requests/${message.id}`),
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
      <details className="more-actions">
        <summary>더보기</summary>
        {!displayOnly ? (
          <>
            <a
              href={`api/v1/projects/${projectId}/requests/${message.id}/model`}
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
          </>
        ) : null}
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
        <Measurements scene={scene} objects={objects} />
      </details>
    </>
  );
}
