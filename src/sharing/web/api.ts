import { z } from 'zod';
const errors: Record<string, string> = {
  UPLOADS_DISABLED: '이 시험 서버의 모델 업로드는 비용 범위 확인 전까지 중지되어 있습니다.',
  AUTH_FEATURE_UNAVAILABLE: '현재 시험 서비스에서 제공하지 않는 계정 기능입니다.',
  JOIN_REQUEST_UNAVAILABLE: '이미 처리되었거나 취소·만료된 참여 신청입니다.',
  LOGIN_REQUIRED: '로그인이 필요합니다.',
  PROJECT_NOT_FOUND: '프로젝트 접근 권한이 없습니다.',
  PUBLICATION_NOT_FOUND: '이 게시본을 열 수 없습니다.',
  COMMENTER_REQUIRED: '의견 작성 권한이 없습니다.',
  OWNER_REQUIRED: '프로젝트 소유자만 할 수 있습니다.',
  INVITATION_UNAVAILABLE: '취소·만료되었거나 이 계정으로 수락할 수 없는 초대입니다.',
  PUBLICATION_BASE_CHANGED:
    '그동안 다른 게시본이 갱신되었습니다. 현재 게시본을 확인한 뒤 새 공유 자료를 만들어 주세요.',
  SUBMISSION_CONFLICT: '같은 제출 번호로 다른 내용이 이미 접수되었습니다.',
  INVALID_EMAIL_OR_PASSWORD: '이메일 또는 비밀번호를 확인해 주세요.',
  EMAIL_NOT_VERIFIED: '이메일 확인 링크를 먼저 열어 주세요.',
  HOST_OFFLINE: 'PC가 꺼져 있거나 원격 접속이 꺼져 있습니다.',
  HOST_NOT_FOUND: '등록된 PC를 찾을 수 없습니다.',
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    fallback?: string,
  ) {
    super(errors[code] || fallback || code);
  }
}
export async function api(path: string, method = 'GET', data?: unknown): Promise<unknown> {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const parsed = z
      .object({
        error: z.string().optional(),
        message: z.string().optional(),
        code: z.string().optional(),
      })
      .safeParse(value);
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('vide-sharing-login-required'));
    throw new ApiError(
      response.status,
      parsed.success ? parsed.data.error || parsed.data.code || '요청 실패' : '요청 실패',
      parsed.success ? parsed.data.message : undefined,
    );
  }
  return value;
}
export const sessionSchema = z
  .object({ user: z.object({ id: z.string(), name: z.string(), email: z.string() }) })
  .nullable();
export type Session = NonNullable<z.infer<typeof sessionSchema>>;
export const projectsSchema = z.object({
  projects: z.array(
    z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'viewer', 'commenter']) }),
  ),
});
export type Project = z.infer<typeof projectsSchema>['projects'][number];
const coordinate = z.number().finite();
const geometry = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('mesh'),
        positions: z.array(coordinate),
        indices: z.array(z.number().int().nonnegative()),
      })
      .strict(),
    z.object({ type: z.enum(['line', 'point']), positions: z.array(coordinate) }).strict(),
  ])
  .superRefine((value, ctx) => {
    if (
      !value.positions.length ||
      value.positions.length % 3 ||
      (value.type === 'mesh' &&
        (value.indices.length % 3 || value.indices.some((i) => i >= value.positions.length / 3)))
    )
      ctx.addIssue({ code: 'custom', message: '잘못된 형상' });
  });
export const sceneSchema = z
  .object({
    format: z.literal('vide-public-scene-v1'),
    unit: z.literal('m'),
    objects: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            geometry,
            measurements: z
              .object({
                length: coordinate.optional(),
                area: coordinate.optional(),
                volume: coordinate.optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();
export type Scene = z.infer<typeof sceneSchema>;
export const manifestSchema = z
  .object({
    title: z.string().min(1).max(200),
    objectIds: z.array(z.string()).max(5000),
    assets: z
      .array(
        z
          .object({
            id: z.string(),
            parts: z
              .array(
                z
                  .object({
                    sha256: z.string().regex(/^[0-9a-f]{64}$/),
                    size: z
                      .number()
                      .int()
                      .positive()
                      .max(8 * 1024 * 1024),
                  })
                  .strict(),
              )
              .max(128),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export const publicationSchema = z.object({
  id: z.string(),
  state: z.literal('published'),
  publishedAt: z.number(),
  manifest: manifestSchema,
});
export type Publication = z.infer<typeof publicationSchema>;
export async function loadScene(
  projectId: string,
  publication: Publication,
  signal: AbortSignal,
): Promise<Scene> {
  const asset = publication.manifest.assets.find((asset) => asset.id === 'scene');
  if (!asset) throw new Error('표시할 모델이 없습니다.');
  const size = asset.parts.reduce((sum, p) => sum + p.size, 0);
  if (size > 64 * 1024 * 1024) throw new Error('현재 웹 뷰어는 64 MiB 이하 모델을 표시합니다.');
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < asset.parts.length; i++) {
    const part = asset.parts[i],
      response = await fetch(
        `/api/projects/${projectId}/publications/${publication.id}/assets/scene/${i}`,
        { signal, credentials: 'same-origin' },
      );
    if (!response.ok) throw new Error('모델 접근 권한 또는 게시 상태를 확인해 주세요.');
    const bytes = await response.arrayBuffer(),
      hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
        n.toString(16).padStart(2, '0'),
      ).join('');
    if (bytes.byteLength !== part.size || hash !== part.sha256)
      throw new Error('게시 모델의 무결성을 확인하지 못했습니다.');
    buffer.set(new Uint8Array(bytes), offset);
    offset += bytes.byteLength;
  }
  const scene = sceneSchema.parse(JSON.parse(new TextDecoder().decode(buffer)));
  const ids = scene.objects.map((object) => object.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== publication.manifest.objectIds.length ||
    ids.some((id) => !publication.manifest.objectIds.includes(id))
  )
    throw new Error('모델과 게시 대상이 일치하지 않습니다.');
  return scene;
}
export const message = (error: unknown) =>
  error instanceof Error ? error.message : '처리하지 못했습니다.';
