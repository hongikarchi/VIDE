import { z } from 'zod';
import { append as el } from './elements.ts';
import { api } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';

// Settings section "연결 프로그램": install or update the VIDE plugin of each design program on
// this PC. Only on the PC itself (not on pages opened from other devices).
const connectorsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    available: z.boolean(),
    running: z.boolean(),
    plugin: z.enum(['none', 'other', 'outdated', 'current']),
    version: z.string().optional(),
  }),
);
type Connector = z.infer<typeof connectorsSchema>[number];
const pluginText: Record<Connector['plugin'], string> = {
  none: '플러그인 미설치',
  other: '다른 위치의 플러그인 사용 중(개발 빌드 등)',
  outdated: '새 플러그인 버전이 있습니다',
  current: '최신 플러그인 설치됨',
};
const actionText: Record<Connector['plugin'], string> = {
  none: '설치',
  other: '이 버전으로 설치',
  outdated: '업데이트',
  current: '다시 설치',
};
const errorText: Record<string, string> = {
  HOST_RUNNING: '프로그램을 종료한 뒤 설치하세요. 실행 중에는 플러그인 등록을 바꿀 수 없습니다.',
  HOST_NOT_INSTALLED: '이 PC에 프로그램이 설치돼 있지 않습니다.',
  PLUGIN_MISSING: '이 VIDE에 포함된 플러그인 파일을 찾지 못했습니다.',
};

export function attachConnectorsPanel(section: HTMLElement, dialog: HTMLDialogElement) {
  if (remoteSession()) {
    section.hidden = true;
    return;
  }
  let rows: Connector[] | undefined,
    busy = '',
    failure = '',
    done = '';
  const load = async () => {
    try {
      rows = connectorsSchema.parse(await api('/connectors'));
    } catch (error) {
      failure = error instanceof Error ? error.message : '확인하지 못했습니다.';
    }
    draw();
  };
  const install = async (row: Connector) => {
    busy = row.id;
    failure = done = '';
    draw();
    try {
      rows = connectorsSchema.parse(await api(`/connectors/${row.id}/install`, 'POST', {}));
      done = `${row.name}을 다시 시작하면 새 플러그인이 적용됩니다.`;
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      failure =
        errorText[code] || (error instanceof Error ? error.message : '설치하지 못했습니다.');
    } finally {
      busy = '';
      draw();
    }
  };
  function draw() {
    section.replaceChildren();
    el('h3', '연결 프로그램', section);
    el(
      'small',
      'Rhino·CAD 등에서 VIDE와 연결하는 플러그인입니다. 프로그램별로 설치합니다.',
      section,
    );
    if (failure) el('p', failure, section, { class: 'remote-error', role: 'alert' });
    if (done) el('p', done, section, { role: 'status' });
    if (!rows) {
      el('p', '확인 중…', section);
      return;
    }
    const list = el('ul', '', section, { class: 'connector-list' });
    for (const row of rows) {
      const item = el('li', '', list);
      const label = el('div', '', item);
      el('strong', row.name, label);
      el(
        'small',
        !row.available
          ? '이 PC에 설치되지 않음'
          : pluginText[row.plugin] +
              (row.running ? ' · 실행 중 (종료 후 설치)' : '') +
              (row.version ? ` · ${row.version}` : ''),
        label,
      );
      if (row.available)
        el('button', busy === row.id ? '설치 중…' : actionText[row.plugin], item, {
          type: 'button',
          ...(busy || row.running ? { disabled: '' } : {}),
        }).onclick = () => void install(row);
    }
    el('small', 'ZWCAD·SketchUp·Revit은 순서대로 추가됩니다.', section);
  }
  new MutationObserver(() => {
    if (dialog.open) {
      done = failure = '';
      void load();
    }
  }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  draw();
}
