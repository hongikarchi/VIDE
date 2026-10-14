import { useEffect, useRef, useState } from 'react';
import './kit.css';

// Card parts (Design §14 `role-card` · `bake-card` · `conflict-banner`, SCR-13·14): input roles
// to confirm, what a Rhino에 만들기 did, and what changed in Rhino since.

export interface RoleCardData {
  /** `<input>.<role>` */
  key: string;
  title: string;
  required: boolean;
  state: 'confirmed' | 'proposed' | 'missing';
  /** Where the role reads from (layers and counts). */
  source?: string;
  candidates?: { id: string; label: string; detail: string }[];
}
const ROLE_STATE: Record<RoleCardData['state'], string> = {
  confirmed: '✓ 확인',
  proposed: '? 확인 필요',
  missing: '자료에 없음',
};

/**
 * The opened [레이어 고르기] of one role (T-289, SPEC-07.14): the linked documents' layers to
 * pick from. It takes the focus and comes into view when it opens, so the rail's [입력 고르기]
 * lands on it.
 */
function LayerPicker({
  title,
  layers,
  busy,
  onPick,
  onClose,
}: {
  title: string;
  layers: readonly string[];
  busy?: boolean;
  onPick: (layer: string) => void;
  onClose: () => void;
}) {
  const [layer, setLayer] = useState('');
  const field = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    field.current?.scrollIntoView?.({ block: 'center' });
    field.current?.focus();
  }, []);
  return (
    <div className="kit-role-pick" role="group" aria-label={`${title} 레이어 고르기`}>
      {layers.length ? (
        <>
          <select
            ref={field}
            aria-label={`${title} 레이어`}
            value={layer}
            onChange={(event) => setLayer(event.target.value)}
          >
            <option value="">레이어를 고르세요</option>
            {layers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <div className="kit-actions">
            <button
              type="button"
              data-primary
              disabled={busy || !layer}
              onClick={() => onPick(layer)}
            >
              이 레이어로 확인
            </button>
            <button type="button" onClick={onClose}>
              닫기
            </button>
          </div>
        </>
      ) : (
        <span className="kit-muted">
          연결한 파일에서 가져온 레이어가 없습니다. 파일을 연결하고 가져온 뒤 고르세요.
        </span>
      )}
    </div>
  );
}

export function RoleCards({
  title = '입력 조립',
  roles,
  busy,
  onFind,
  onConfirm,
  layers,
  picking,
  onPicking,
  onPick,
}: {
  title?: string;
  roles: readonly RoleCardData[];
  busy?: boolean;
  onFind: (key: string) => void;
  /** Confirm the role as it is (no candidate) or with one found candidate. */
  onConfirm: (key: string, candidate?: string) => void;
  /** Layers a person may pick for a role ([레이어 고르기]); omitted, the control is not shown. */
  layers?: readonly string[];
  /** The role whose layer list is open. */
  picking?: string;
  onPicking?: (key: string | undefined) => void;
  onPick?: (key: string, layer: string) => void;
}) {
  const done = roles.filter((role) => role.state === 'confirmed').length;
  // Roles that need a person come first.
  const order = [...roles].sort(
    (a, b) => Number(a.state === 'confirmed') - Number(b.state === 'confirmed'),
  );
  return (
    <section className="kit-section">
      <h4>
        {title} {done}/{roles.length} 확인
      </h4>
      <div className="kit-roles">
        {order.map((role) => (
          <article key={role.key} className="kit-role" data-role={role.key} data-state={role.state}>
            <div className="kit-role-head">
              <strong>{role.title}</strong>
              <span className="kit-role-state" data-state={role.state}>
                {role.state === 'missing' && !role.required ? '없음(선택)' : ROLE_STATE[role.state]}
              </span>
            </div>
            {role.source ? <span className="kit-muted">{role.source}</span> : null}
            {role.candidates ? (
              role.candidates.length ? (
                <ul aria-label={`${role.title} 후보`}>
                  {role.candidates.map((candidate) => (
                    <li key={candidate.id}>
                      <span>
                        {candidate.label} <span className="kit-muted">{candidate.detail}</span>
                      </span>
                      <button
                        type="button"
                        className="kit-button"
                        disabled={busy}
                        onClick={() => onConfirm(role.key, candidate.id)}
                      >
                        확인
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="kit-muted">
                  읽은 레이어에서 맞는 것을 찾지 못했습니다. 연결 파일의 레이어를 먼저 읽으세요.
                </span>
              )
            ) : null}
            <div className="kit-actions">
              {role.state === 'proposed' ? (
                <button
                  type="button"
                  data-primary
                  disabled={busy}
                  onClick={() => onConfirm(role.key)}
                >
                  확인
                </button>
              ) : null}
              {layers && onPick ? (
                <button
                  type="button"
                  data-primary={role.state === 'missing' && role.required ? '' : undefined}
                  aria-expanded={picking === role.key}
                  disabled={busy}
                  onClick={() => onPicking?.(picking === role.key ? undefined : role.key)}
                >
                  레이어 고르기
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => onFind(role.key)}>
                {role.state === 'missing' ? '후보 찾기' : '바꾸기'}
              </button>
            </div>
            {layers && onPick && picking === role.key ? (
              <LayerPicker
                title={role.title}
                layers={layers}
                busy={busy}
                onPick={(layer) => onPick(role.key, layer)}
                onClose={() => onPicking?.(undefined)}
              />
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export interface BakePlan {
  added?: number;
  replaced?: number;
  kept?: number;
  copies?: number;
  deleted?: number;
  layer?: string;
  /** Results changed after the objects were made (만든 결과가 오래됨). */
  outdated?: boolean;
}
export function BakeCard({ title = 'Rhino에 만들기', plan }: { title?: string; plan?: BakePlan }) {
  const rows: [string, number | undefined][] = [
    ['추가', plan?.added],
    ['교체', plan?.replaced],
    ['사람이 고친 것 보존', plan?.kept],
    ['복사본 그대로', plan?.copies],
    ['사람이 지운 것', plan?.deleted],
  ];
  return (
    <div className="kit-card" data-part="bake-card">
      <strong>
        {title}
        {plan?.outdated ? <span className="kit-badge">만든 결과가 오래됨</span> : null}
      </strong>
      {plan ? (
        <>
          {rows
            .filter(([, count]) => count !== undefined)
            .map(([name, count]) => (
              <span key={name}>
                {name} {count}
              </span>
            ))}
          {plan.layer ? <span className="kit-muted">출력 레이어 {plan.layer}</span> : null}
        </>
      ) : (
        <span className="kit-muted">아직 Rhino에 만들지 않았습니다.</span>
      )}
    </div>
  );
}

export function ConflictBanner({ items }: { items: readonly { label: string; count: number }[] }) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  if (!total) return null;
  return (
    <p className="kit-banner" role="status">
      Rhino에서 {total}건이 바뀌었습니다:{' '}
      {items.map((item) => `${item.label} ${item.count}`).join(' · ')}
    </p>
  );
}
