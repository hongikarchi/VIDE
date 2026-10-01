import { THEME_CHANGED } from './theme.ts';
/** Viewport shading options (Blender-style header popover next to the view buttons). */
export interface DisplaySettings {
  mode: 'shaded' | 'wireframe' | 'ghosted';
  colorSource: 'default' | 'layer' | 'object' | 'material';
  edges: boolean;
  background: 'auto' | 'light' | 'dark';
  /** Print preview with the plot style table (CTB): white paper, pen colours and lineweights. */
  plot: boolean;
}
export const defaultDisplay: DisplaySettings = {
  mode: 'shaded',
  colorSource: 'object',
  edges: true,
  background: 'auto',
  plot: false,
};
const key = 'vide:viewport-display';
const choices = {
  mode: [
    ['shaded', '음영'],
    ['wireframe', '와이어'],
    ['ghosted', '반투명'],
  ],
  colorSource: [
    ['default', '기본 회색'],
    ['layer', '레이어 색'],
    ['object', '표시 색'],
    ['material', '재질 색'],
  ],
  background: [
    ['auto', '자동'],
    ['light', '밝게'],
    ['dark', '어둡게'],
  ],
} as const;

export function loadDisplay(): DisplaySettings {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!saved || typeof saved !== 'object') return { ...defaultDisplay };
    const pick = <K extends keyof typeof choices>(name: K) =>
      choices[name].some(([value]) => value === saved[name])
        ? (saved[name] as DisplaySettings[K])
        : defaultDisplay[name];
    return {
      mode: pick('mode'),
      colorSource: pick('colorSource'),
      background: pick('background'),
      edges: typeof saved.edges === 'boolean' ? saved.edges : defaultDisplay.edges,
      plot: typeof saved.plot === 'boolean' ? saved.plot : defaultDisplay.plot,
    };
  } catch {
    return { ...defaultDisplay };
  }
}

/** Build the popover under `button` and report every change (also once on start). */
export function initializeDisplaySettings(
  button: HTMLButtonElement,
  apply: (settings: DisplaySettings) => void,
) {
  let settings = loadDisplay();
  const panel = document.createElement('div');
  panel.className = 'display-popover';
  panel.id = 'display-popover';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '뷰포트 표시');
  button.setAttribute('aria-controls', panel.id);
  button.setAttribute('aria-expanded', 'false');
  button.after(panel);
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      /* Preference only. */
    }
  };
  function group<K extends keyof typeof choices>(name: K, label: string) {
    const section = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = label;
    section.append(legend);
    const row = document.createElement('div');
    row.className = 'display-segment';
    for (const [value, text] of choices[name]) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = text;
      option.dataset.display = name;
      option.dataset.value = value;
      option.onclick = () => {
        settings = { ...settings, [name]: value };
        update();
      };
      row.append(option);
    }
    section.append(row);
    return section;
  }
  const edges = document.createElement('label');
  edges.className = 'display-check';
  const edgesInput = document.createElement('input');
  edgesInput.type = 'checkbox';
  edgesInput.id = 'display-edges';
  edgesInput.onchange = () => {
    settings = { ...settings, edges: edgesInput.checked };
    update();
  };
  edges.append(edgesInput, document.createTextNode(' 모서리 선 표시'));
  const plot = document.createElement('label');
  plot.className = 'display-check display-plot';
  const plotInput = document.createElement('input');
  plotInput.type = 'checkbox';
  plotInput.id = 'display-plot';
  plotInput.onchange = () => {
    settings = { ...settings, plot: plotInput.checked };
    update();
  };
  const plotText = document.createElement('span');
  plotText.textContent = ' 플롯 미리보기 · monochrome.ctb';
  plotText.title = '출력 모양: 흰 종이, CTB 펜 색·선 굵기(lineweight)';
  plot.append(plotInput, plotText);
  panel.append(
    group('mode', '표시 방식'),
    group('colorSource', '색상'),
    edges,
    plot,
    group('background', '배경'),
  );
  function update() {
    for (const option of panel.querySelectorAll<HTMLButtonElement>('[data-display]'))
      option.setAttribute(
        'aria-pressed',
        String(settings[option.dataset.display as keyof DisplaySettings] === option.dataset.value),
      );
    edgesInput.checked = settings.edges;
    edgesInput.disabled = settings.mode !== 'shaded' || settings.plot;
    plotInput.checked = settings.plot;
    save();
    apply(settings);
  }
  const close = () => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.onclick = (event) => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
  };
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !panel.contains(event.target as Node) && event.target !== button) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) close();
  });
  // 'auto' follows the app's theme (the rail's toggle, or the host panel's theme).
  addEventListener(THEME_CHANGED, () => {
    if (settings.background === 'auto') apply(settings);
  });
  update();
  return { get: () => settings };
}
