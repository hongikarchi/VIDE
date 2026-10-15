// 모델 위 타임라인 (PLAN-53 T-334, Design SCR-46, SPEC-17.5, ARCH-01 §5 「타임라인 띠」): a band under
// the 3D view of the model tab, one row per 부위, the 남김 records as glyphs (SCR-45), follows lines,
// milestones and the 검토본 · 동기화 days on the axis. Moving the time cursor lights the parts with a
// record up to that day, dims the others and dims the objects of no part further (뷰포트 `fade`);
// an episode (장 or joined records) lights only its parts; [분리] moves the part groups apart
// (display only); a glyph highlights its part's objects and opens a card. The band reads only
// what the screen already has (records, parts, milestones, 검토본 list, the requests of the work
// history) and the objects the viewport draws (src/core/records-scene.ts). It changes nothing in
// the documents or in the host's selection and display. The 시점 형상 (T-335) is records-moment.ts:
// a settled cursor picks the model of that day, folding or leaving the model tab lets it go.
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildRecordsChart,
  dayNumber,
  layoutRecordsChart,
  type RecordsChartModel,
  type RecordsPlacedItem,
} from '../core/records-chart.ts';
import {
  bundleParts,
  layerIndexOf,
  objectLevels,
  partLevels,
  sceneEpisodes,
  sceneGroups,
  sceneRecords,
  separationVectors,
  type PartLevel,
  type RecordsScene,
  type SceneEpisode,
  type SceneObject,
} from '../core/records-scene.ts';
import { ChartDefs, ChartLinks, stepCursor, timeTicks, type LinkStyle } from './chart/index.ts';
import { objects } from './model.ts';
import { RecordGlyph } from './records-chart.tsx';
import {
  TYPE_NAME,
  listMilestones,
  listParts,
  listRecords,
  type MilestoneRow,
  type PartRow,
  type RecordRow,
  type RecordType,
} from './records-api.ts';
import {
  momentState,
  momentTicks,
  onMomentsChange,
  pickMoment,
  setMomentToday,
} from './records-moment.ts';
import { showRecords } from './records-tab.tsx';
import { openReview, reviewRows } from './reviews.tsx';
import { linkClosed } from './jig-panel/role-sources.ts';
import { linksState } from './store/links.ts';
import { selectionState } from './store/selection.ts';
import { viewerState } from './store/viewer.ts';
import { activeWorkspace, onWorkspaceChange, setWorkspace } from './workspaces.ts';
import './records-timeline.css';

const NAME = 160;
const GROUP_HEAD = 20;
const DAY = 86_400_000;
const LABEL_DAYS = 60;
const NO_GROUP = '';

const CURRENT_BASIS = '현재 모델 · 부위만 표시';

const two = (n: number) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' of a local time. */
const localDate = (t: number) => {
  const at = new Date(t);
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
};
const midnight = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
};

interface Saved {
  folded: boolean;
  cursor?: string;
}
const savedKey = (projectId: string) => `vide:records-timeline:${projectId}`;
function readSaved(projectId: string): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(savedKey(projectId)) ?? '{}') as Partial<Saved>;
    return {
      folded: value.folded === true,
      ...(typeof value.cursor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.cursor)
        ? { cursor: value.cursor }
        : {}),
    };
  } catch {
    return { folded: false };
  }
}
function writeSaved(projectId: string, saved: Saved) {
  try {
    localStorage.setItem(savedKey(projectId), JSON.stringify(saved));
  } catch {
    /* a viewer convenience only */
  }
}

const LINK_STYLES: Record<string, LinkStyle> = {
  follows: { width: 1, arrow: true, label: '이어짐' },
};

/** The objects on screen as the scene reads them, and a key that changes when they change. */
function shownSignature() {
  return `${linksState.shownSignature}#${objects.length}#${objects[0]?.id ?? ''}#${objects.at(-1)?.id ?? ''}`;
}
/** A redraw of the shown layers (Live Sync, a file shown or hidden) or a new selection. */
function subscribeShown(listener: () => void) {
  const stopLinks = linksState.subscribe(listener);
  const stopSelection = selectionState.subscribe(listener);
  return () => {
    stopLinks();
    stopSelection();
  };
}

export interface TimelineOptions {
  /** Shows a request's work card ([출처로 가기] of a record that points at a request). */
  openRequest?: (requestId: string) => void;
}

function RecordsTimeline({
  projectId,
  host,
  options,
}: {
  projectId: string;
  host: HTMLElement;
  options: TimelineOptions;
}) {
  const [workspace, setWorkspaceShown] = useState(activeWorkspace);
  useEffect(() => {
    const stop = onWorkspaceChange((change) => setWorkspaceShown(change.active));
    return () => void stop();
  }, []);
  const onModel = workspace === 'model';
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  // The 검토본 · 동기화 ticks and the basis line change with records-moment.ts.
  const [momentVersion, setMomentVersion] = useState(0);
  useEffect(() => onMomentsChange(() => setMomentVersion((n) => n + 1)), []);
  const [saved] = useState(() => readSaved(projectId));
  const [folded, setFolded] = useState(saved.folded);
  const [cursor, setCursor] = useState<number | undefined>(() =>
    saved.cursor ? midnight(saved.cursor) : undefined,
  );
  const [playing, setPlaying] = useState(false);
  const [all, setAll] = useState(false);
  const [separate, setSeparate] = useState(false);
  const [episodeId, setEpisodeId] = useState<string | undefined>();
  const [episodeStep, setEpisodeStep] = useState(-1);
  const [listOpen, setListOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [card, setCard] = useState<{ record: string; part: string; x: number } | undefined>();
  const [tip, setTip] = useState<{ x: number; lines: string[] } | undefined>();
  const [width, setWidth] = useState(640);
  const plot = useRef<HTMLDivElement>(null);

  // Data: read when the model tab shows (the 기록 tab may have changed it meanwhile).
  useEffect(() => {
    if (!onModel) return;
    let live = true;
    void Promise.all([
      listRecords(projectId, { state: ['kept'] }).then((answer) => answer.records),
      listParts(projectId).catch(() => [] as PartRow[]),
      listMilestones(projectId).catch(() => [] as MilestoneRow[]),
    ])
      .then(([list, partList, milestoneList]) => {
        if (!live) return;
        setRecords(list);
        setParts(partList);
        setMilestones(milestoneList);
      })
      .catch(() => {
        /* No records route (an older engine): the band stays away. */
      });
    return () => {
      live = false;
    };
  }, [projectId, onModel]);
  // The shown objects (they change with the Syncs drawn) and the selection.
  const signature = useSyncExternalStore(subscribeShown, shownSignature);
  const selected = useSyncExternalStore(selectionState.subscribe, () => selectionState.selectedIds);
  const scene: RecordsScene = useMemo(() => {
    void signature;
    const shown = objects as unknown as SceneObject[];
    return bundleParts({ parts, objects: shown, layerIndex: layerIndexOf(shown) });
  }, [parts, signature]);
  const shownRecords = useMemo(() => sceneRecords(records), [records]);
  const episodes = useMemo(() => sceneEpisodes(records), [records]);
  const episode: SceneEpisode | undefined = episodes.find((each) => each.id === episodeId);
  const episodeParts = useMemo(() => (episode ? new Set(episode.partIds) : undefined), [episode]);
  const episodeRecords = useMemo(
    () => (episode ? new Set(episode.recordIds) : undefined),
    [episode],
  );

  // The chart: rows = parts (grouped), 남김 only.
  const model: RecordsChartModel = useMemo(() => {
    const built = buildRecordsChart({
      records: shownRecords,
      parts,
      milestones,
      rowMode: 'part',
      states: ['kept'],
      groupByGrp: true,
    });
    const rows = built.rows.filter((row) => row.part !== null);
    const known = new Set(rows.map((row) => row.id));
    const items = built.items.filter((item) => known.has(item.row));
    const kept = new Set(items.map((item) => item.id));
    return {
      ...built,
      rows,
      items,
      links: built.links.filter((link) => kept.has(link.from) && kept.has(link.to)),
    };
  }, [shownRecords, parts, milestones]);
  const domain = model.domain;
  const at =
    cursor === undefined ? domain.end : Math.min(domain.end, Math.max(domain.start, cursor));
  const shownCursor = useDeferredValue(at);

  const visible = onModel && parts.length > 0;
  const active = visible && !folded;
  useEffect(() => {
    host.hidden = !visible;
  }, [host, visible]);

  // The viewport follows the cursor at once (the band's own drawing may come a frame later).
  const latest = useRef({ scene, records: shownRecords, episodeParts, all, active });
  latest.current = { scene, records: shownRecords, episodeParts, all, active };
  const fadeAt = useCallback((t: number): Map<string, PartLevel> | undefined => {
    const now = latest.current;
    const viewport = viewerState.viewport;
    if (!now.active) return undefined;
    const levels = partLevels(now.scene, now.records, dayNumber(localDate(t)), {
      ...(now.episodeParts ? { episode: now.episodeParts } : {}),
      all: now.all,
    });
    viewport?.fade(objectLevels(now.scene, levels));
    return levels;
  }, []);
  const moveCursor = useCallback(
    (t: number) => {
      fadeAt(t);
      setCursor(t);
    },
    [fadeAt],
  );
  // The cursor at rest (let go, stepped, playing stopped): the model of that day (T-335).
  const settle = useCallback((t: number) => {
    if (latest.current.active) pickMoment(localDate(t));
  }, []);
  useEffect(() => {
    if (active) fadeAt(at);
    else viewerState.viewport?.fade(null);
  }, [active, scene, shownRecords, episodeParts, all, fadeAt, domain.start, domain.end]);
  useEffect(
    () => () => {
      viewerState.viewport?.fade(null);
      viewerState.viewport?.highlight(null);
      viewerState.viewport?.offset(null);
    },
    [],
  );

  // 시점 형상 (T-335): shown → the model at the cursor's day; folded, off the model tab or gone →
  // the current model again (Design SCR-46). Playing changes it only when it stops (`settle`).
  const atNow = useRef(at);
  atNow.current = at;
  const following = cursor === undefined ? localDate(domain.end) : '';
  const momentPicked = useRef(false);
  useEffect(() => {
    if (!active) {
      if (momentPicked.current) pickMoment(null);
      momentPicked.current = false;
      return;
    }
    // Once shown, only a cursor that follows the end (no day chosen yet) is picked again here.
    if (momentPicked.current && !following) return;
    momentPicked.current = true;
    pickMoment(localDate(atNow.current));
  }, [active, following]);
  useEffect(
    () => () => {
      if (momentPicked.current) pickMoment(null);
    },
    [],
  );
  // [현재로] of the basis line brings the cursor to today (only while the band is shown).
  useEffect(() => {
    if (!active) return;
    setMomentToday(() => {
      setPlaying(false);
      moveCursor(Math.min(domain.end, Math.max(domain.start, Date.now())));
    });
    return () => setMomentToday(undefined);
  }, [active, domain.start, domain.end, moveCursor]);

  // [분리]: groups moved apart along x (display only).
  const groups = useMemo(() => sceneGroups(scene), [scene]);
  useEffect(() => {
    const viewport = viewerState.viewport;
    if (!viewport) return;
    viewport.offset(null);
    if (!active || !separate || groups.length < 2) return;
    const bounds = viewport.modelBounds();
    if (bounds) viewport.offset(separationVectors(scene, bounds));
  }, [active, separate, scene, groups.length]);

  // A glyph's part: its objects in the accent colour, the camera on them.
  const bundleOf = useMemo(
    () => new Map(scene.bundles.map((bundle) => [bundle.partId, bundle])),
    [scene],
  );
  useEffect(() => {
    const viewport = viewerState.viewport;
    if (!viewport) return;
    const ids = active && card ? (bundleOf.get(card.part)?.objectIds ?? []) : [];
    viewport.highlight(ids.length ? ids : null);
  }, [active, card, bundleOf]);

  // Remembered per project: folded, cursor day (not every step of [재생]).
  useEffect(() => {
    if (playing) return;
    writeSaved(projectId, {
      folded,
      ...(cursor === undefined ? {} : { cursor: localDate(cursor) }),
    });
  }, [projectId, folded, cursor, playing]);

  // [재생]: the time cursor's steps (120 ms), stopping at the end.
  const playAt = useRef(at);
  playAt.current = at;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = stepCursor(playAt.current, domain);
      moveCursor(next);
      if (next >= domain.end) {
        setPlaying(false);
        settle(next);
      }
    }, 120);
    return () => clearInterval(timer);
  }, [playing, domain, moveCursor, settle]);

  // Width of the time area.
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const fit = () => setWidth(Math.max(240, element.clientWidth - NAME - 14));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  // Esc: the card first, then the episode.
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.body.dataset.workspace !== 'model') return;
      if (card) setCard(undefined);
      else if (listOpen) setListOpen(false);
      else if (episodeId) {
        setEpisodeId(undefined);
        setEpisodeStep(-1);
      }
    };
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [active, card, listOpen, episodeId]);

  // Print (Design SCR-46 「인쇄」): the 3D view as drawn now, and one summary line.
  const levelsNow = useMemo(
    () =>
      partLevels(scene, shownRecords, dayNumber(localDate(shownCursor)), {
        ...(episodeParts ? { episode: episodeParts } : {}),
        all,
      }),
    [scene, shownRecords, shownCursor, episodeParts, all],
  );
  const lit = [...levelsNow.values()].filter((level) => level === 'on').length;
  const summary = `${localDate(shownCursor)} · 켜진 부위 ${lit} · ${momentState().text || CURRENT_BASIS}`;
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  useEffect(() => {
    if (!active) return;
    let root: HTMLElement | undefined;
    const before = () => {
      const image = viewerState.viewport?.capture();
      if (!image) return;
      root = document.createElement('div');
      root.className = 'records-timeline-print';
      const picture = document.createElement('img');
      picture.src = image;
      picture.alt = '';
      const line = document.createElement('p');
      line.textContent = summaryRef.current;
      root.append(picture, line);
      document.body.append(root);
      document.body.dataset.timelinePrint = '';
    };
    const after = () => {
      root?.remove();
      root = undefined;
      delete document.body.dataset.timelinePrint;
    };
    addEventListener('beforeprint', before);
    addEventListener('afterprint', after);
    return () => {
      removeEventListener('beforeprint', before);
      removeEventListener('afterprint', after);
      after();
    };
  }, [active]);

  // Labels only within 60 days of the cursor; collapsed groups drop their rows.
  const labelDay = dayNumber(localDate(shownCursor));
  const layout = useMemo(() => {
    const rows = model.rows.filter((row) => !collapsed.has(row.group ?? NO_GROUP));
    const keep = new Set(rows.map((row) => row.id));
    return layoutRecordsChart(
      {
        ...model,
        rows,
        items: model.items
          .filter((item) => keep.has(item.row))
          .map((item) =>
            Math.abs(item.day - labelDay) <= LABEL_DAYS ? item : { ...item, text: '' },
          ),
      },
      { width },
    );
  }, [model, collapsed, labelDay, width]);

  // Name column entries (group heads 20px) and each row's shift below the heads.
  const { entries, shift, rowsHeight } = useMemo(() => {
    const placedRows = new Map(layout.rows.map((row) => [row.id, row]));
    const entries: (
      | { kind: 'group'; group: string; y: number }
      | { kind: 'row'; id: string; label: string; y: number; height: number }
    )[] = [];
    const shift = new Map<string, number>();
    let y = 0;
    let last: string | undefined;
    for (const row of model.rows) {
      const group = row.group ?? NO_GROUP;
      if (group !== last) {
        entries.push({ kind: 'group', group, y });
        y += GROUP_HEAD;
        last = group;
      }
      const placed = placedRows.get(row.id);
      if (!placed) continue;
      shift.set(row.id, y - placed.y);
      entries.push({ kind: 'row', id: row.id, label: row.label, y, height: placed.height });
      y += placed.height;
    }
    return { entries, shift, rowsHeight: Math.max(y, 24) };
  }, [model.rows, layout]);
  const itemById = useMemo(() => new Map(model.items.map((item) => [item.id, item])), [model]);
  const placed = useMemo(() => {
    const out = new Map<string, RecordsPlacedItem>();
    for (const [id, item] of layout.items) {
      const dy = shift.get(itemById.get(id)?.row ?? '') ?? 0;
      out.set(id, {
        ...item,
        y: item.y + dy,
        label: item.label ? { ...item.label, y: item.label.y + dy } : null,
      });
    }
    return out;
  }, [layout, shift, itemById]);

  const picked = useMemo(() => {
    const out = new Set<string>();
    for (const id of selected.slice(0, 2000))
      for (const part of scene.partsOf.get(id) ?? []) out.add(part);
    return out;
  }, [selected, scene]);
  const byRecord = useMemo(() => new Map(records.map((row) => [row.id, row])), [records]);
  const partNames = useMemo(() => new Map(parts.map((part) => [part.id, part.name])), [parts]);
  const ticks = useMemo(() => {
    void signature;
    void momentVersion;
    return momentTicks();
  }, [signature, momentVersion]);
  const found = scene.bundles.some((bundle) => bundle.objectIds.length);

  if (!visible) return null;
  const x = layout.x;
  const openCard = (record: string, part: string) => {
    const t = byRecord.get(record);
    const placedX = t ? x(midnight(t.date)) : 0;
    setCard({ record, part, x: placedX });
    const ids = bundleOf.get(part)?.objectIds ?? [];
    if (ids.length) viewerState.viewport?.fit(ids);
  };
  const step = (by: number) => {
    if (!episode) return;
    const next = Math.min(episode.recordIds.length - 1, Math.max(0, episodeStep + by));
    const id = episode.recordIds[next];
    const row = id ? byRecord.get(id) : undefined;
    if (!row) return;
    setEpisodeStep(next);
    const t = midnight(row.date);
    moveCursor(t);
    settle(t);
    openCard(row.id, row.parts.find((part) => bundleOf.has(part)) ?? row.parts[0] ?? '');
  };
  const chooseEpisode = (id: string | undefined) => {
    setEpisodeId(id);
    setEpisodeStep(-1);
    setListOpen(false);
  };
  const toggleGroup = (group: string) =>
    setCollapsed((before) => {
      const next = new Set(before);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const linkState = (link: { from: string; to: string }) => {
    const from = itemById.get(link.from);
    const to = itemById.get(link.to);
    if (episodeRecords)
      return from && to && episodeRecords.has(from.record) && episodeRecords.has(to.record)
        ? ('on' as const)
        : ('dim' as const);
    return to && to.t !== null && to.t > shownCursor ? ('later' as const) : ('base' as const);
  };
  const cardRecord = card ? byRecord.get(card.record) : undefined;
  const cardBundle = card ? bundleOf.get(card.part) : undefined;
  const cardPart = card ? parts.find((part) => part.id === card.part) : undefined;
  const cardNote = (() => {
    if (!cardBundle || cardBundle.objectIds.length) return undefined;
    const mapping = cardPart?.mapping ?? [];
    if (mapping.length && mapping.every((each) => each.kind === 'jig-output'))
      return '모델에서 찾을 수 없는 부위';
    return '연결이 닫혀 있어 표시 못 함';
  })();
  const closedLink = cardPart?.mapping.some((each) => {
    if (each.kind === 'jig-output') return false;
    const link = linksState.links.find((entry) => entry.id === each.linkId);
    return !link || linkClosed(link);
  });
  const destination = cardRecord ? destinationOf(cardRecord, projectId, options) : undefined;

  return (
    <div
      className={`records-timeline-band${folded ? ' records-timeline-folded' : ''}`}
      data-cursor={localDate(at)}
      data-lit={lit}
      data-parts={scene.bundles.length}
      data-found={scene.bundles.filter((bundle) => bundle.objectIds.length).length}
      data-episode={episode ? episode.recordIds.length : 0}
      data-separate={separate ? '1' : '0'}
      data-all={all ? '1' : '0'}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (folded || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        if ((event.target as HTMLElement).tagName === 'INPUT') return;
        event.preventDefault();
        const days = (event.shiftKey ? 30 : 1) * (event.key === 'ArrowLeft' ? -1 : 1);
        const next = Math.min(domain.end, Math.max(domain.start, at + days * DAY));
        moveCursor(next);
        settle(next);
      }}
    >
      <div className="records-timeline-head">
        <button
          type="button"
          className="link-button records-timeline-play"
          aria-pressed={playing}
          disabled={folded || !model.items.length}
          onClick={() => {
            if (playing) {
              setPlaying(false);
              settle(at);
              return;
            }
            if (at >= domain.end) moveCursor(domain.start);
            setPlaying(true);
          }}
        >
          {playing ? '멈춤' : '재생'}
        </button>
        <span className="records-timeline-date" aria-live="polite">
          {localDate(at)}
        </span>
        <div className="records-timeline-episodes">
          <button
            type="button"
            className="link-button"
            aria-label="앞 기록"
            disabled={!episode || folded}
            onClick={() => step(-1)}
          >
            ◀
          </button>
          <span className="records-timeline-chip-wrap">
            <button
              type="button"
              className="records-timeline-chip"
              aria-pressed={!!episode}
              aria-expanded={listOpen}
              disabled={!episodes.length || folded}
              onClick={() => setListOpen(!listOpen)}
            >
              {episode ? episode.name : '에피소드'}
            </button>
            {episode ? (
              <button
                type="button"
                className="records-timeline-chip-clear"
                aria-label="에피소드 풀기"
                onClick={() => chooseEpisode(undefined)}
              >
                ×
              </button>
            ) : null}
            {listOpen ? (
              <ul className="records-timeline-episode-list" role="listbox" aria-label="에피소드">
                {episodes.map((each) => (
                  <li key={each.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={each.id === episodeId}
                      onClick={() => chooseEpisode(each.id)}
                    >
                      <span>{each.name}</span>
                      <span className="records-timeline-count">{each.recordIds.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </span>
          <button
            type="button"
            className="link-button"
            aria-label="다음 기록"
            disabled={!episode || folded}
            onClick={() => step(1)}
          >
            ▶
          </button>
        </div>
        <span className="records-spacer" />
        {!found && !folded ? (
          <span className="records-timeline-note">
            모델에서 찾은 부위가 없습니다 · 부위 사전의 레이어를 확인하세요
          </span>
        ) : null}
        <button
          type="button"
          className="link-button records-timeline-toggle"
          aria-pressed={separate}
          aria-disabled={groups.length < 2}
          title={groups.length < 2 ? '나눌 그룹이 없습니다' : undefined}
          disabled={folded}
          onClick={() => {
            if (groups.length >= 2) setSeparate(!separate);
          }}
        >
          분리
        </button>
        <button
          type="button"
          className="link-button records-timeline-toggle"
          aria-pressed={all}
          disabled={folded}
          onClick={() => setAll(!all)}
        >
          전부 보기
        </button>
        <button
          type="button"
          className="link-button"
          aria-expanded={!folded}
          onClick={() => {
            setPlaying(false);
            setCard(undefined);
            setFolded(!folded);
          }}
        >
          {folded ? '펼치기' : '접기'}
        </button>
      </div>
      {folded ? null : !model.items.length ? (
        <div className="records-timeline-empty">
          <p>
            남긴 기록이 있는 부위가 아직 없습니다. 기록 탭에서 후보를 거르고 부위에 묶으면 여기에
            놓입니다.
          </p>
          <button type="button" className="link-button" onClick={() => setWorkspace('records')}>
            기록 탭으로
          </button>
        </div>
      ) : (
        <div className="records-timeline-plot" ref={plot}>
          <div className="records-timeline-rows">
            <div className="records-timeline-names" style={{ width: NAME, height: rowsHeight }}>
              {entries.map((entry) =>
                entry.kind === 'group' ? (
                  <button
                    key={`g:${entry.group}`}
                    type="button"
                    className="records-timeline-group"
                    style={{ top: entry.y, height: GROUP_HEAD }}
                    aria-expanded={!collapsed.has(entry.group)}
                    onClick={() => toggleGroup(entry.group)}
                  >
                    {collapsed.has(entry.group) ? '▸' : '▾'} {entry.group || '그룹 없음'}
                  </button>
                ) : (
                  <div
                    key={entry.id}
                    className={`records-timeline-name${picked.has(entry.id) ? ' records-timeline-name-picked' : ''}`}
                    data-picked={picked.has(entry.id) ? '1' : undefined}
                    data-level={levelsNow.get(entry.id) ?? 'dim'}
                    style={{ top: entry.y, height: entry.height }}
                    title={entry.label}
                  >
                    {entry.label}
                  </div>
                ),
              )}
            </div>
            <svg
              className="records-timeline-svg"
              width={width}
              height={rowsHeight}
              viewBox={`0 0 ${width} ${rowsHeight}`}
              style={{ width, height: rowsHeight }}
              role="group"
              aria-label="부위와 시간의 기록"
            >
              <ChartDefs />
              {model.milestones.map((milestone, i) => (
                <line
                  key={`${milestone.t}-${i}`}
                  className="records-timeline-milestone"
                  x1={x(milestone.t)}
                  x2={x(milestone.t)}
                  y1={0}
                  y2={rowsHeight}
                />
              ))}
              {entries.map((entry) =>
                entry.kind === 'row' && entry.y > 0 ? (
                  <line
                    key={`r:${entry.id}`}
                    className="chart-row-rule"
                    x1={0}
                    x2={width}
                    y1={entry.y}
                    y2={entry.y}
                  />
                ) : null,
              )}
              <ChartLinks
                links={model.links}
                placed={placed}
                styles={LINK_STYLES}
                state={linkState}
              />
              <Glyphs
                model={model}
                placed={placed}
                cursor={shownCursor}
                episodeRecords={episodeRecords}
                chosen={card?.record}
                byRecord={byRecord}
                onPick={(record, part) =>
                  card?.record === record && card.part === part
                    ? setCard(undefined)
                    : openCard(record, part)
                }
              />
            </svg>
          </div>
          <div className="records-timeline-axis">
            <div style={{ width: NAME, flex: 'none' }} />
            <div className="records-timeline-axis-track" style={{ width }}>
              <input
                type="range"
                className="records-timeline-range"
                aria-label="시간 커서"
                aria-valuetext={localDate(at)}
                min={domain.start}
                max={domain.end}
                step={DAY}
                value={at}
                onChange={(event) => {
                  setPlaying(false);
                  moveCursor(Number(event.target.value));
                }}
                onPointerUp={(event) => settle(Number((event.target as HTMLInputElement).value))}
                onKeyUp={(event) => settle(Number((event.target as HTMLInputElement).value))}
                onKeyDown={(event) => {
                  if (!event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'))
                    return;
                  event.preventDefault();
                  const next = Math.min(
                    domain.end,
                    Math.max(domain.start, at + (event.key === 'ArrowLeft' ? -30 : 30) * DAY),
                  );
                  moveCursor(next);
                }}
              />
              <svg
                className="records-timeline-axis-svg"
                width={width}
                height={20}
                style={{ width, height: 20 }}
                aria-hidden="true"
              >
                {timeTicks(domain).map((tick) => (
                  <g key={tick.t}>
                    <line className="chart-tick" x1={x(tick.t)} x2={x(tick.t)} y1={12} y2={20} />
                    <text className="chart-tick-label" x={x(tick.t) + 3} y={19}>
                      {tick.label}
                    </text>
                  </g>
                ))}
                {model.milestones.map((milestone, i) => (
                  <text
                    key={`m-${milestone.t}-${i}`}
                    className="records-timeline-milestone-label"
                    x={x(milestone.t) + 3}
                    y={10}
                  >
                    {milestone.label}
                  </text>
                ))}
              </svg>
              <svg
                className="records-timeline-moments"
                width={width}
                height={8}
                style={{ width, height: 8 }}
              >
                {ticks.map(({ date, kind, lines }) => {
                  const t = midnight(date);
                  if (t < domain.start || t > domain.end) return null;
                  const review = kind === 'review';
                  return (
                    <g
                      key={date}
                      className={`records-timeline-moment records-timeline-moment-${review ? 'review' : 'sync'}`}
                      data-date={date}
                      onMouseEnter={() => setTip({ x: x(t), lines })}
                      onMouseLeave={() => setTip(undefined)}
                      onClick={() => {
                        setPlaying(false);
                        moveCursor(t);
                        settle(t);
                      }}
                    >
                      <rect x={x(t) - 4} y={0} width={8} height={8} className="chart-hit" />
                      <line x1={x(t)} x2={x(t)} y1={0} y2={review ? 6 : 4} />
                    </g>
                  );
                })}
              </svg>
              {tip ? (
                <div
                  className="records-timeline-tip"
                  role="tooltip"
                  style={{ left: Math.min(tip.x + 8, Math.max(0, width - 260)) }}
                >
                  {tip.lines.map((line, i) => (
                    <span key={i}>{line}</span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div
            className="records-timeline-cursor"
            style={{ left: NAME + x(at) }}
            aria-hidden="true"
          />
        </div>
      )}
      {card && cardRecord && !folded ? (
        <div
          className="records-timeline-card"
          role="dialog"
          aria-label="기록"
          style={{ left: Math.max(8, Math.min(NAME + card.x - 160, width + NAME - 320)) }}
        >
          <p className="records-timeline-card-head">
            <span className="records-timeline-card-date">{cardRecord.date}</span> ·{' '}
            {partNames.get(card.part) ?? '부위'} · {TYPE_NAME[cardRecord.type]}
          </p>
          <p className="records-timeline-card-text">{cardRecord.text}</p>
          {cardNote || (closedLink && !cardBundle?.objectIds.length) ? (
            <p className="records-timeline-card-note">
              {cardNote ?? '연결이 닫혀 있어 표시 못 함'}
            </p>
          ) : null}
          <div className="records-timeline-card-actions">
            {destination ? (
              <button type="button" className="link-button" onClick={destination}>
                출처로 가기
              </button>
            ) : null}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setWorkspace('records');
                showRecords(projectId, { open: cardRecord.id });
              }}
            >
              기록 탭에서 보기
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function destinationOf(
  record: RecordRow,
  projectId: string,
  options: TimelineOptions,
): (() => void) | undefined {
  const { requestId, reviewId, note } = record.attachments ?? {};
  if (requestId && options.openRequest) return () => options.openRequest!(requestId);
  if (reviewId) {
    const row = reviewRows(projectId).find((entry) => entry.id === reviewId);
    if (row) return () => openReview(projectId, row);
  }
  if (note) return () => setWorkspace('notes');
  return undefined;
}

/** The glyphs, drawn from the deferred cursor so a fast drag redraws them a little later. */
function Glyphs({
  model,
  placed,
  cursor,
  episodeRecords,
  chosen,
  byRecord,
  onPick,
}: {
  model: RecordsChartModel;
  placed: ReadonlyMap<string, RecordsPlacedItem>;

  cursor: number;
  episodeRecords: ReadonlySet<string> | undefined;
  chosen: string | undefined;
  byRecord: ReadonlyMap<string, RecordRow>;
  onPick: (record: string, part: string) => void;
}) {
  const [hover, setHover] = useState<string | undefined>();
  return (
    <g>
      {model.items.map((item) => {
        const at = placed.get(item.id);
        if (!at) return null;
        const type = item.kind.slice('record:'.length) as RecordType;
        const later = item.t !== null && item.t > cursor;
        const out = episodeRecords ? !episodeRecords.has(item.record) : false;
        const row = byRecord.get(item.record);
        return (
          <g
            key={item.id}
            className={`chart-item records-timeline-item${later ? ' records-timeline-later' : ''}${out ? ' chart-faded' : ''}${chosen === item.record ? ' chart-item-chosen' : ''}`}
            data-record-id={item.record}
            data-row={item.row}
            role="button"
            tabIndex={0}
            aria-label={`${row?.date ?? ''} · ${TYPE_NAME[type]} · ${(row?.text ?? '').split('\n')[0]}`}
            onClick={() => onPick(item.record, item.row)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onPick(item.record, item.row);
              }
            }}
            onMouseEnter={() => setHover(item.id)}
            onMouseLeave={() => setHover(undefined)}
          >
            {hover === item.id ? (
              <circle className="records-chart-hover" cx={at.x} cy={at.y} r={8} />
            ) : null}
            <circle className="chart-hit" cx={at.x} cy={at.y} r={8} />
            <RecordGlyph type={type} x={at.x} y={at.y} root={item.root} />
            {at.label ? (
              <text
                className="chart-label"
                x={at.label.anchor === 'end' ? at.label.x1 : at.label.x0}
                y={at.label.y}
                textAnchor={at.label.anchor}
              >
                {at.label.text}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

let mounted: { projectId: string; root: ReturnType<typeof createRoot> } | undefined;
/** Mount the band in the centre column (once per page; the model tab shows it). */
export function mountRecordsTimeline(projectId: string, options: TimelineOptions = {}) {
  if (mounted?.projectId === projectId) return;
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  let host = workspace.querySelector<HTMLElement>(':scope > .records-timeline');
  if (!host) {
    host = document.createElement('section');
    host.className = 'records-timeline';
    host.setAttribute('aria-label', '모델 위 타임라인');
    host.hidden = true;
    workspace.append(host);
  }
  mounted?.root.unmount();
  const root = createRoot(host);
  root.render(<RecordsTimeline projectId={projectId} host={host} options={options} />);
  mounted = { projectId, root };
}
