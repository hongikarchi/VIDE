// 설정 → 외부 자료 (PLAN-45 T-205): the public site-data keys of this PC. The screen only learns
// whether each key is there (and whether an environment variable sets it); a typed value goes to
// the engine once and is never read back. This PC only (the AI tab is hidden on other devices).
import { memo, useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from '../gateway.ts';
import { useStore } from '../store/core.ts';
import { sessionState } from '../store/session.ts';
import { statusState } from '../store/status.ts';

const KEYS = [
  ['VWORLD_KEY', '브이월드 키', '필지·용도지역·건물'],
  ['VWORLD_DOMAIN', '브이월드 등록 도메인', '예: http://localhost'],
  ['JUSO_KEY', '주소 검색 키', '주소 → 후보 필지'],
  ['DATA_GO_KR_KEY', '공공데이터포털 키', '건축물대장'],
] as const;
type KeyName = (typeof KEYS)[number][0];

const viewSchema = z.object({
  keys: z.array(
    z.object({
      name: z.string(),
      present: z.boolean(),
      from: z.enum(['env', 'file']).nullable(),
    }),
  ),
});
type View = z.infer<typeof viewSchema>;

export const PublicDataSection = memo(function PublicDataSection() {
  const shown = useStore(statusState, (s) => s.tab === 'ai');
  const [view, setView] = useState<View | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<KeyName, string>>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    if (!shown || !sessionState.ready) return;
    api('/settings/public-data', 'GET', undefined, { quiet: ['FORBIDDEN'] })
      .then((value) => setView(viewSchema.parse(value)))
      .catch(() => setView(null));
  }, [shown]);
  const save = async (name: KeyName, value: string) => {
    setError('');
    try {
      setView(viewSchema.parse(await api('/settings/public-data', 'PUT', { name, value })));
      setDrafts((current) => ({ ...current, [name]: '' }));
    } catch {
      setError('키를 저장하지 못했습니다. 잠시 뒤 다시 누르세요.');
    }
  };
  if (!view) return null;
  return (
    <section className="settings-public-data">
      <h3>외부 자료</h3>
      <small>
        규모검토의 대지 자료(필지·용도지역·건물·건축물대장)를 공공 자료원에서 가져올 때 쓰는
        키입니다. 키는 이 PC에만 두고 화면에는 있는지만 보입니다.
      </small>
      <ul className="settings-rows">
        {KEYS.map(([name, label, hint]) => {
          const state = view.keys.find((key) => key.name === name);
          const draft = drafts[name] ?? '';
          return (
            <li key={name} data-key={name}>
              <strong title={hint}>{label}</strong>
              <span className="pill" data-ok={String(!!state?.present)}>
                {state?.from === 'env' ? '환경 변수' : state?.present ? '있음' : '없음'}
              </span>
              {state?.from === 'env' ? null : (
                <span className="settings-key-edit">
                  <input
                    type={name === 'VWORLD_DOMAIN' ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`${label} 입력`}
                    placeholder={state?.present ? '바꿀 값' : hint}
                    value={draft}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [name]: event.target.value }))
                    }
                  />
                  <button type="button" disabled={!draft.trim()} onClick={() => save(name, draft)}>
                    저장
                  </button>
                  {state?.present ? (
                    <button type="button" onClick={() => save(name, '')}>
                      지우기
                    </button>
                  ) : null}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="usage-note" role="status">
          {error}
        </p>
      ) : null}
    </section>
  );
});
