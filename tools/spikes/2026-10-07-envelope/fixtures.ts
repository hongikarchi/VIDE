// T-204 spike: five synthetic sites (PLAN-45 T-204 방법). Invented coordinates in local metres,
// x = east, y = north (north is +y for every case); no real parcel, address or survey value.
// Rule values are illustrative parameters, not a legal reading (SPEC-12.7 5·6: the values come
// from SPEC-13 or a person).
import type { SiteCase, Sunlight } from './rules.ts';

const sun = (datum: Sunlight['datum'], zone?: Sunlight['zone']): Sunlight => ({
  datum,
  baseHeight: 10,
  nearDistance: 1.5,
  ratio: 0.5,
  ...(zone ? { zone } : {}),
});

// L-shape hand calculation (see SPIKE record §2): lower bar + column − quarter disk − half segment − chamfer.
const lArea = (() => {
  const r = 1.5,
    c = 0.5;
  const segment = r * r * Math.acos(c / r) - c * Math.sqrt(r * r - c * c);
  return 28.5 * 12.5 + (14 * 1.5 + 13.5 * 13.5) - (Math.PI * r * r) / 4 - segment / 2 - 0.5;
})();

export const cases: SiteCase[] = [
  {
    id: 'rect',
    title: '직사각형 20×30, 남측 도로, 북측 인접 대지',
    site: [
      [0, 0],
      [20, 0],
      [20, 30],
      [0, 30],
    ],
    heightCap: 30,
    setbacks: [
      { rule: '건축선 후퇴', edge: { a: [0, 0], b: [20, 0] }, distance: 1 },
      { rule: '민법 이격', edge: { a: [20, 0], b: [20, 30] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [20, 30], b: [0, 30] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [0, 30], b: [0, 0] }, distance: 0.5 },
    ],
    chamfers: [],
    sunlight: [sun([{ a: [0, 30], b: [20, 30] }])],
    analytic: { area: 19 * 27.5, extrude: 19 * 27.5 * 30, sun: 20 * 685, max: 19 * 655 },
  },
  {
    id: 'l-shape',
    title: '오목 L형 30×30(북동 15×15 제외), 남·서 도로와 가각, 꺾인 북측 두 구간',
    site: [
      [0, 0],
      [30, 0],
      [30, 15],
      [15, 15],
      [15, 30],
      [0, 30],
    ],
    heightCap: 25,
    setbacks: [
      { rule: '건축선 후퇴', edge: { a: [0, 0], b: [30, 0] }, distance: 1 },
      { rule: '건축선 후퇴', edge: { a: [0, 30], b: [0, 0] }, distance: 1 },
      { rule: '민법 이격', edge: { a: [30, 0], b: [30, 15] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [30, 15], b: [15, 15] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [15, 15], b: [15, 30] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [15, 30], b: [0, 30] }, distance: 0.5 },
    ],
    chamfers: [
      {
        corner: [0, 0],
        along: [
          [30, 0],
          [0, 30],
        ],
        length: 3,
      },
    ],
    sunlight: [
      sun([
        { a: [0, 30], b: [15, 30] },
        { a: [15, 15], b: [30, 15] },
      ]),
    ],
    analytic: { area: lArea },
  },
  {
    id: 'north-road',
    title: '직사각형 20×24, 정북에 너비 6 m 도로(기준선 = 도로 건너편 경계)',
    site: [
      [0, 0],
      [20, 0],
      [20, 24],
      [0, 24],
    ],
    heightCap: 40,
    setbacks: [
      { rule: '민법 이격', edge: { a: [0, 0], b: [20, 0] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [20, 0], b: [20, 24] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [0, 24], b: [0, 0] }, distance: 0.5 },
    ],
    chamfers: [],
    sunlight: [sun([{ a: [0, 30], b: [20, 30] }])],
    analytic: { area: 19 * 23.5, extrude: 19 * 23.5 * 40, sun: 20 * 764, max: 19 * 744 },
  },
  {
    id: 'kinked-north',
    title: '북측 경계가 오목하게 꺾인 대지(두 구간의 원뿔 이음)',
    site: [
      [0, 0],
      [24, 0],
      [24, 28],
      [12, 24],
      [0, 28],
    ],
    heightCap: 30,
    setbacks: [
      { rule: '건축선 후퇴', edge: { a: [0, 0], b: [24, 0] }, distance: 1 },
      { rule: '민법 이격', edge: { a: [24, 0], b: [24, 28] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [24, 28], b: [12, 24] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [12, 24], b: [0, 28] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [0, 28], b: [0, 0] }, distance: 0.5 },
    ],
    chamfers: [],
    sunlight: [
      sun([
        { a: [24, 28], b: [12, 24] },
        { a: [12, 24], b: [0, 28] },
      ]),
    ],
  },
  {
    id: 'two-zones',
    title: '두 용도지역 걸침 30×20: 서측 12 m만 일조 적용',
    site: [
      [0, 0],
      [30, 0],
      [30, 20],
      [0, 20],
    ],
    heightCap: 35,
    setbacks: [
      { rule: '건축선 후퇴', edge: { a: [0, 0], b: [30, 0] }, distance: 1 },
      { rule: '민법 이격', edge: { a: [30, 0], b: [30, 20] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [30, 20], b: [0, 20] }, distance: 0.5 },
      { rule: '민법 이격', edge: { a: [0, 20], b: [0, 0] }, distance: 0.5 },
    ],
    chamfers: [],
    sunlight: [
      sun(
        [{ a: [0, 20], b: [30, 20] }],
        [
          [-5, -5],
          [12, -5],
          [12, 25],
          [-5, 25],
        ],
      ),
    ],
    analytic: {
      area: 11.5 * 17.5 + 17.5 * 18.5,
      extrude: (11.5 * 17.5 + 17.5 * 18.5) * 35,
      sun: 12 * 403.75 + 18 * 20 * 35,
      max: 11.5 * 368.75 + 17.5 * 18.5 * 35,
    },
  },
];

/** Synthetic survey-scale offset (EPSG:5186-like magnitudes; not a real place). */
export const SURVEY: [number, number] = [198765.432, 551234.567];
