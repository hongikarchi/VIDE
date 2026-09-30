import { useEffect, useRef, useState } from 'react';
import {
  formatNumber,
  fromDisplay,
  toDisplay,
  unitText,
  type PanelSetting,
} from '../jig-panel/bindings.ts';
import { basisAttributes } from '../jig-panel/registry.ts';
import './kit.css';

// Setting parts (Design §14 `slider` · `choice` · `stepper` · `toggle` · `param-group` ·
// `slider-board` · `fact-badge`, SCR-13 설정값 슬라이더 판). A row always shows the name, the basis
// chip and the unit. Values travel in storage units; the screen shows the display unit. A slider
// reports `drag` while it is held and `release` when let go, so the jig can compute only the
// geometry steps while dragging and everything once released.

export type SettingPhase = 'drag' | 'release';
export type SettingControl = 'slider' | 'stepper' | 'toggle' | 'choice';
type Value = number | string | boolean;

const BY: Record<string, string> = {
  default: '기본값',
  user: '사용자',
  decision: '사용자 결정',
  fact: '프로젝트 자료',
  ai: 'AI 제안',
  rhino: '모델',
  sketch: '스케치',
};
const BASIS: Record<string, string> = {
  confirmed: '',
  assumed: '가정',
  chosen: '선택',
  'to-ask': '물어볼 것',
};
const FACT: Record<string, string> = {
  confirmed: '',
  ai: '미확정',
  contaminated: '근거 무효',
  superseded: '대체됨',
};
/**
 * The basis chip of a setting (SPEC-07.6): where the value came from, then its standing — the
 * declared basis for a default, the statement's state for a project fact. A chip whose value rests
 * on a statement carries `data-fact-statement`, so a click opens the fact window (registry.ts).
 */
export function FactBadge({ setting }: { setting: PanelSetting }) {
  const standing =
    setting.by === 'default'
      ? setting.basis
        ? BASIS[setting.basis.status]
        : ''
      : setting.by === 'fact'
        ? (FACT[setting.status ?? 'ai'] ?? '')
        : '';
  return (
    <span
      className="kit-fact"
      data-by={setting.by}
      data-standing={standing || undefined}
      title={[setting.basis?.note, setting.basis?.question, setting.ref]
        .filter(Boolean)
        .join(' · ')}
      {...basisAttributes(setting)}
    >
      {BY[setting.by] ?? setting.by}
      {standing ? ` · ${standing}` : ''}
    </span>
  );
}

/** The control a setting gets when the panel does not name one. */
export const controlOf = (setting: PanelSetting): SettingControl =>
  setting.type === 'choice'
    ? 'choice'
    : setting.type === 'toggle'
      ? 'toggle'
      : setting.range
        ? 'slider'
        : 'stepper';

export function SettingRow({
  setting,
  value,
  control = controlOf(setting),
  stale,
  disabled,
  onChange,
}: {
  setting: PanelSetting;
  /** Current value in the storage unit (a value being dragged included). */
  value: Value;
  control?: SettingControl;
  stale?: boolean;
  disabled?: boolean;
  onChange: (value: Value, phase: SettingPhase) => void;
}) {
  const unit = unitText(setting.displayUnit);
  const shown =
    typeof value === 'number'
      ? `${formatNumber(toDisplay(setting, value), setting.decimals)}${unit && unit !== '°' ? ' ' : ''}${unit}`
      : typeof value === 'boolean'
        ? value
          ? '켜짐'
          : '꺼짐'
        : (setting.choices?.find((c) => c.value === value)?.label ?? String(value));
  const name = (
    <span className="kit-setting-name">
      <span className={stale ? 'kit-stale' : undefined}>{setting.title}</span>
      <FactBadge setting={setting} />
    </span>
  );
  if (setting.fixedAtPin)
    return (
      <div className="kit-setting" data-setting={setting.key} data-fixed="">
        {name}
        <span className="kit-setting-value kit-locked" title="이 프로젝트의 jig를 만들 때 정한 값">
          🔒 {shown}
        </span>
      </div>
    );
  return (
    <div className="kit-setting" data-setting={setting.key}>
      {name}
      <span className="kit-setting-value" aria-live="polite">
        {shown}
      </span>
      <div className="kit-setting-control">
        {control === 'choice' ? (
          <div className="kit-chips" role="group" aria-label={setting.title}>
            {(setting.choices ?? []).map((choice) => (
              <button
                key={choice.value}
                type="button"
                aria-pressed={choice.value === value}
                disabled={disabled}
                onClick={() => onChange(choice.value, 'release')}
              >
                {choice.label}
              </button>
            ))}
          </div>
        ) : control === 'toggle' ? (
          <label>
            <input
              type="checkbox"
              checked={value === true}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked, 'release')}
            />{' '}
            {setting.title}
          </label>
        ) : typeof value === 'number' ? (
          <NumberControl
            setting={setting}
            value={value}
            slider={control === 'slider' && !!setting.range}
            disabled={disabled}
            onChange={onChange}
          />
        ) : null}
      </div>
    </div>
  );
}

function NumberControl({
  setting,
  value,
  slider,
  disabled,
  onChange,
}: {
  setting: PanelSetting;
  value: number;
  slider: boolean;
  disabled?: boolean;
  onChange: (value: number, phase: SettingPhase) => void;
}) {
  const range = setting.range;
  const step = range?.step ?? (range ? (range.max - range.min) / 100 : 1);
  const clamp = (v: number) =>
    range ? Math.min(range.max, Math.max(range.min, Number(v.toPrecision(12)))) : v;
  const held = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  const [typed, setTyped] = useState<string>();
  useEffect(() => setTyped(undefined), [value]);
  const nudge = (sign: number) => onChange(clamp(value + sign * step), 'release');
  const commit = () => {
    if (typed === undefined) return;
    const shown = Number(typed);
    setTyped(undefined);
    if (Number.isFinite(shown)) onChange(clamp(fromDisplay(setting, shown)), 'release');
  };
  return (
    <>
      <button
        type="button"
        aria-label={`${setting.title} 줄이기`}
        disabled={disabled}
        onClick={() => nudge(-1)}
      >
        −
      </button>
      {slider && range ? (
        <span className="kit-zone">
          <input
            type="range"
            aria-label={setting.title}
            min={range.min}
            max={range.max}
            step={step}
            value={value}
            disabled={disabled}
            onPointerDown={() => {
              held.current = true;
              // Released anywhere (the pointer may leave the slider while dragging).
              addEventListener(
                'pointerup',
                () => {
                  if (!held.current) return;
                  held.current = false;
                  onChange(latest.current, 'release');
                },
                { once: true },
              );
            }}
            onChange={(event) => {
              latest.current = Number(event.target.value);
              onChange(latest.current, held.current ? 'drag' : 'release');
            }}
          />
        </span>
      ) : (
        <input
          type="number"
          aria-label={setting.title}
          value={typed ?? String(toDisplay(setting, value))}
          step={range ? toDisplay(setting, step) || 'any' : 'any'}
          disabled={disabled}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
        />
      )}
      <button
        type="button"
        aria-label={`${setting.title} 늘리기`}
        disabled={disabled}
        onClick={() => nudge(1)}
      >
        +
      </button>
    </>
  );
}

export interface SettingsProps {
  settings: readonly PanelSetting[];
  values: Readonly<Record<string, Value>>;
  stale?: ReadonlySet<string>;
  disabled?: boolean;
  onChange: (key: string, value: Value, phase: SettingPhase) => void;
}
/** One group of settings (펼침); without a group name, one section per group. */
export function SettingGroup({
  title,
  settings,
  values,
  stale,
  disabled,
  onChange,
}: SettingsProps & { title?: string }) {
  const groups = new Map<string, PanelSetting[]>();
  for (const setting of settings)
    groups.set(setting.group, [...(groups.get(setting.group) ?? []), setting]);
  return (
    <div className="kit-settings">
      {[...groups].map(([group, list]) => (
        <details key={group} className="kit-section" open>
          <summary>{groups.size === 1 && title ? title : group || title || '설정값'}</summary>
          <div className="kit-settings">
            {list.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                value={values[setting.key] ?? setting.value}
                stale={stale?.has(setting.key)}
                disabled={disabled}
                onChange={(value, phase) => onChange(setting.key, value, phase)}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

/** The floating board of up to six settings (SCR-13): drag for geometry, release to compute. */
export function SliderBoard({
  title = '설정값 판',
  settings,
  values,
  stale,
  disabled,
  onChange,
}: SettingsProps & { title?: string }) {
  return (
    <details className="kit-board" open>
      <summary>
        {title} <small>끌면 기하만 · 놓으면 다시 계산</small>
      </summary>
      <div className="kit-settings">
        {settings.slice(0, 6).map((setting) => (
          <SettingRow
            key={setting.key}
            setting={setting}
            value={values[setting.key] ?? setting.value}
            stale={stale?.has(setting.key)}
            disabled={disabled}
            onChange={(value, phase) => onChange(setting.key, value, phase)}
          />
        ))}
      </div>
    </details>
  );
}
