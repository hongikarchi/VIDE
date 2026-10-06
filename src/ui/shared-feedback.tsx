import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from './gateway.ts';
import { receivedFeedbackSchema, type ReceivedFeedback } from '../contracts/shared-feedback.ts';
import type { DraftState } from './model.ts';
import { requestBody } from './model.ts';

export function attachSharedFeedback(state: DraftState, note: ReceivedFeedback) {
  if (state.baseRequestId !== note.requestId)
    throw Error(
      '기준 후보를 먼저 열어 대상을 확인하세요. 현재 초안의 기준을 자동 변경하지 않습니다.',
    );
  const input = note.original.comment.input,
    source = state.messages.find((message) => message.id === note.requestId)?.request;
  const object = input.objectId
    ? source?.result?.objects?.find((object) => object.id === input.objectId)
    : null;
  if (!source?.result?.hostExecuted || (input.objectId && !object))
    throw Error('의견의 원래 후보와 객체를 확인할 수 없습니다.');
  if ((source.result.host || 'rhino') !== state.host)
    throw Error('의견의 기준 호스트와 현재 작업 호스트가 다릅니다.');
  const name = 'Shared-feedback-' + note.id + '.json',
    text = JSON.stringify(note, null, 2),
    sketches = input.sketches ?? [];
  if (state.files.some((file) => file.name === name)) throw Error('이미 첨부한 의견입니다.');
  if (
    text.length > 50000 ||
    state.files.length >= 100 ||
    state.sketches.length + sketches.length > 100
  )
    throw Error('초안 첨부 한도를 넘었습니다. 기존 초안을 정리한 뒤 시도하세요.');
  if (requestBody({ ...state, instructions: [...state.instructions, input.body] }).length > 20000)
    throw Error('요청 문장이 20,000자를 넘습니다.');
  if (input.body.trim() && state.instructions.length >= 100)
    throw Error('요청 목록은 100개까지입니다.');
  const pin = object && state.pins.find((pin) => pin.id === object.id);
  if (pin && (pin.basis !== note.requestId || pin.role !== 'target'))
    throw Error('기존 객체 첨부의 기준과 역할을 먼저 확인하세요.');
  if (object && !pin && state.pins.length >= 100) throw Error('요청 객체는 100개까지입니다.');
  state.files.push({
    name,
    text,
    displayName: '외부 의견 · ' + note.original.manifest.title,
    type: 'application/json',
    contentStatus: 'included',
  });
  if (object && !pin)
    state.pins.push({ id: object.id, basis: note.requestId, role: 'target', name: object.name });
  state.sketches.push(
    ...sketches.map((sketch, index) => ({
      ...structuredClone(sketch),
      id: note.id + '-' + index,
      name: '외부 의견 선 ' + (index + 1),
    })),
  );
  if (input.body.trim()) state.instructions.push(input.body);
}

export function SharedFeedback({
  projectId,
  onAdopt,
  onBasis,
  onCount,
}: {
  projectId: string;
  onAdopt: (note: ReceivedFeedback) => void | Promise<void>;
  onBasis: (id: string) => void;
  /** The received count changed (the 산출물 badge follows it). */
  onCount?: (count: number) => void;
}) {
  const [notes, setNotes] = useState<ReceivedFeedback[] | undefined>(),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const base = `/projects/${projectId}/shared-feedback`;
  useEffect(() => {
    if (notes) onCount?.(notes.length);
  }, [notes, onCount]);
  useEffect(() => {
    let active = true;
    void api(base)
      .then((value) => {
        if (active) setNotes(z.array(receivedFeedbackSchema).parse(value));
      })
      .catch((error) => {
        if (active) setStatus(String(error));
      });
    return () => {
      active = false;
    };
  }, [base]);
  async function receive(file: File) {
    setBusy(true);
    try {
      if (file.size > 1024 * 1024) throw Error('의견 파일은 1 MiB 이하만 가져올 수 있습니다.');
      const value = receivedFeedbackSchema.parse(
        await api(base, 'POST', JSON.parse(await file.text())),
      );
      setNotes((previous = []) => [value, ...previous.filter((note) => note.id !== value.id)]);
      setStatus('의견을 로컬에 보관했습니다. 아직 작업 입력으로 채택하거나 실행하지 않았습니다.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '의견을 가져오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }
  const perform = (action: () => void | Promise<void>) => {
    const failed = (error: unknown) =>
      setStatus(error instanceof Error ? error.message : '처리하지 못했습니다.');
    try {
      void action()?.catch(failed);
    } catch (error) {
      failed(error);
    }
  };
  return (
    <>
      <h2>외부 의견</h2>
      <p>
        웹 프로젝트 소유자가 내려받은 의견 파일을 가져오세요. 공개했던 로컬 후보와 대조합니다.
        파일의 작성자·서버 접수 정보는 서버에 재인증한 정보가 아닙니다.
      </p>
      <label>
        외부 의견 파일{' '}
        <input
          type="file"
          accept=".json"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void receive(file);
            event.target.value = '';
          }}
        />
      </label>
      <p role="status">{status}</p>
      {(notes ?? []).map((note) => (
        <article key={note.id} className="review-notes">
          <h3>{note.original.manifest.title}</h3>
          <small>
            파일 수신 · 게시본 {note.original.publicationId} ·{' '}
            {new Date(note.original.comment.receivedAt).toLocaleString('ko-KR')}
          </small>
          <p>{note.original.comment.input.body}</p>
          <p>
            {note.original.comment.input.pin ? '월드 핀 · ' : ''}선{' '}
            {note.original.comment.input.sketches?.length ?? 0}개
          </p>
          <button onClick={() => perform(() => onBasis(note.requestId))}>기준 후보 열기</button>{' '}
          <button onClick={() => perform(() => onAdopt(note))}>외부 의견을 요청 초안에 첨부</button>
        </article>
      ))}
    </>
  );
}
