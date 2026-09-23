import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api, manifestSchema, sceneSchema, message, type Project, type Session } from './api';
import { uploadStorage } from './upload-storage';

const packageSchema = z
  .object({
    format: z.literal('vide-publication-v1'),
    requestId: z.string().uuid(),
    manifest: manifestSchema,
    scene: sceneSchema,
  })
  .strict();
type Package = z.infer<typeof packageSchema>;
async function prepare(text: string) {
  const file = packageSchema.parse(JSON.parse(text)),
    bytes = new TextEncoder().encode(JSON.stringify(file.scene)),
    chunks: Uint8Array<ArrayBuffer>[] = [];
  if (
    bytes.length > 64 * 1024 * 1024 ||
    file.manifest.assets.length !== 1 ||
    file.manifest.assets[0].id !== 'scene'
  )
    throw new Error('현재 뷰어에서 지원하지 않는 공유 파일입니다.');
  const ids = file.scene.objects.map((object) => object.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== file.manifest.objectIds.length ||
    ids.some((id) => !file.manifest.objectIds.includes(id))
  )
    throw new Error('공유 객체 목록이 일치하지 않습니다.');
  for (let offset = 0; offset < bytes.length; offset += 8 * 1024 * 1024)
    chunks.push(bytes.slice(offset, offset + 8 * 1024 * 1024));
  const parts = file.manifest.assets[0].parts;
  if (parts.length !== chunks.length) throw new Error('공유 파일의 청크 수가 다릅니다.');
  for (let i = 0; i < chunks.length; i++) {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', chunks[i])), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
    if (parts[i].size !== chunks[i].byteLength || parts[i].sha256 !== hash)
      throw new Error('공유 파일이 변경됐거나 손상되었습니다.');
  }
  return { file, chunks };
}
export function Publish({
  project,
  session,
  onPublished,
}: {
  project: Project;
  session: Session;
  onPublished: () => void;
}) {
  const [uploadsEnabled, setUploadsEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    void api('/config')
      .then((v) =>
        setUploadsEnabled(z.object({ uploadsEnabled: z.boolean() }).parse(v).uploadsEnabled),
      )
      .catch(() => setUploadsEnabled(false));
  }, []);
  const storageKey = `${session.user.id}:${project.id}`,
    [file, setFile] = useState<Package | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [status, setStatus] = useState('');
  const prepared = useRef<Awaited<ReturnType<typeof prepare>> | null>(null),
    locked = useRef(false);
  useEffect(() => {
    let alive = true;
    void uploadStorage(storageKey)
      .then(async (text) => {
        if (text) {
          const value = await prepare(text);
          if (alive) {
            prepared.current = value;
            setFile(value.file);
            setStatus('이전 게시의 접수 상태를 확인하고 이어갈 수 있습니다.');
          }
        }
      })
      .catch((error) => {
        if (alive) setStatus(message(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [storageKey]);
  async function choose(selected: File | undefined) {
    if (!selected || locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      if (selected.size > 80 * 1024 * 1024)
        throw new Error('공유 파일이 현재 표시 한도를 넘었습니다.');
      const value = await prepare(await selected.text());
      await uploadStorage(storageKey, JSON.stringify(value.file));
      prepared.current = value;
      setFile(value.file);
      setStatus('포함된 자료를 확인한 뒤 게시하세요.');
    } catch (error) {
      setStatus(message(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function publish() {
    if (locked.current || !prepared.current) return;
    locked.current = true;
    setBusy(true);
    const { file, chunks } = prepared.current;
    try {
      const base = `/projects/${project.id}/publications`,
        created = z
          .object({ id: z.string(), state: z.string() })
          .parse(await api(base, 'POST', { requestId: file.requestId, manifest: file.manifest }));
      if (created.state !== 'published')
        for (let i = 0; i < chunks.length; i++) {
          setStatus(`공개 모델 업로드 ${i + 1} / ${chunks.length}`);
          const response = await fetch('/api' + base + '/' + created.id + '/assets/scene/' + i, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunks[i],
            credentials: 'same-origin',
          });
          if (!response.ok)
            throw new Error('업로드를 완료하지 못했습니다. 같은 자료로 다시 확인하세요.');
        }
      await api(base + '/' + created.id + '/finalize', 'POST', {});
      const current = z.object({ id: z.string() }).parse(await api(base + '/current'));
      await uploadStorage(storageKey, null);
      prepared.current = null;
      setFile(null);
      setStatus(
        current.id === created.id
          ? '게시가 완료되었습니다.'
          : '이 자료는 이미 게시되었습니다. 더 최신인 현재 게시본을 유지합니다.',
      );
      onPublished();
    } catch (error) {
      setStatus(message(error) + ' · 같은 파일의 게시 확인으로 이어갈 수 있습니다.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  if (uploadsEnabled !== true)
    return (
      <details className="admin">
        <summary>모델 게시</summary>
        <p className="muted">
          {uploadsEnabled === null
            ? '설정 확인 중…'
            : '시험 서버의 모델 업로드는 비용 범위 확인 전까지 중지되어 있습니다.'}
        </p>
      </details>
    );
  return (
    <details className="admin">
      <summary>모델 게시</summary>
      <p className="muted">VIDE에서 선택해 만든 공유 자료 파일을 사용합니다.</p>
      {!file ? (
        <input
          type="file"
          accept=".json,application/json"
          aria-label="공유 자료 파일"
          disabled={loading || busy}
          onChange={(event) => {
            void choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      ) : (
        <>
          <h3>{file.manifest.title}</h3>
          <p>
            {file.scene.objects.length}개 객체 ·{' '}
            {file.scene.objects.some((object) => object.name) ? '이름 포함' : '이름 제외'} ·{' '}
            {file.scene.objects.some((object) => object.measurements)
              ? '측정값 포함'
              : '측정값 제외'}
          </p>
          <ul>
            {file.scene.objects.slice(0, 20).map((object) => (
              <li key={object.id}>{object.name || object.id}</li>
            ))}
          </ul>
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              void publish();
            }}
          >
            {busy ? '게시 확인 중…' : '이 자료 게시 / 재확인'}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              void uploadStorage(storageKey, null)
                .then(() => {
                  prepared.current = null;
                  setFile(null);
                  setStatus(
                    '브라우저의 재시도 자료를 지웠습니다. 이미 서버에 접수된 게시본은 유지됩니다.',
                  );
                })
                .catch((error) => setStatus(message(error)));
            }}
          >
            이 파일 닫기
          </button>
        </>
      )}
      <p role="status" className="status">
        {status}
      </p>
    </details>
  );
}
