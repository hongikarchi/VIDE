// vide/site-data (PLAN-45 T-205, SPEC-12.3·12.4·12.16): normalisation, paging, empty-result and
// area checks, malformed answers refused, keyless sources only 'no-key', errors inside HTTP 200,
// 낙착 detection, register `pageNo` always sent, only allowed endpoints called and no key in any
// record. Synthetic service only (tests/fixtures/site-data.mjs); nothing goes to the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_ENDPOINTS,
  FORBIDDEN_ENDPOINTS,
  collectSite,
  endpointAllowed,
  lookupParcel,
} from '../../src/jigs/official/site-data/index.ts';
import {
  tilesOf,
  areaOf,
  interiorPoint,
  pointInPolygons,
} from '../../src/jigs/official/site-data/geometry.ts';
import { buildPnu, registerKeys, trailingLot } from '../../src/jigs/official/site-data/pnu.ts';
import { requestJson } from '../../src/jigs/official/site-data/http.ts';
import { officialLibraries } from '../../src/jigs/runtime/loader.ts';
import { KEYS, P1, P2, ROAD, fakeSiteData } from '../fixtures/site-data.mjs';

const now = () => new Date('2026-10-08T03:00:00Z');
const context = (fake, keys = KEYS) => ({ keys, fetch: fake.fetch, now });
const allCallsAllowed = (calls) =>
  calls.every((url) => ALLOWED_ENDPOINTS.includes(url.origin + url.pathname));
const noKeyIn = (value) => {
  const text = JSON.stringify(value);
  for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), `key ${key} leaked`);
};

test('PNU helpers: build, register keys, 지번 vs road address', () => {
  assert.equal(buildPnu('1114010300', false, 31, 0), '1114010300100310000');
  assert.equal(buildPnu('1117013000', true, 1, 3), '1117013000200010003');
  assert.deepEqual(registerKeys('1117013000200010003'), {
    sigunguCd: '11170',
    bjdongCd: '13000',
    platGbCd: '1',
    bun: '0001',
    ji: '0003',
  });
  assert.deepEqual(trailingLot('서울특별시 중구 태평로1가 31'), {
    mountain: false,
    main: 31,
    sub: 0,
  });
  assert.deepEqual(trailingLot('서울특별시 용산구 용산동2가 산1-3번지'), {
    mountain: true,
    main: 1,
    sub: 3,
  });
  assert.equal(trailingLot('서울특별시 중구 세종대로 110'), null);
});

test('geometry: 2 km² tiles, area, a point inside an L-shaped lot', () => {
  const tiles = tilesOf({ minX: 0, minY: 0, maxX: 3000, maxY: 1000 });
  assert.ok(tiles.length >= 3);
  for (const t of tiles) assert.ok((t.maxX - t.minX) * (t.maxY - t.minY) <= 2_000_000);
  const L = [
    [
      [
        [0, 0],
        [30, 0],
        [30, 10],
        [10, 10],
        [10, 30],
        [0, 30],
        [0, 0],
      ],
    ],
  ];
  assert.equal(areaOf(L), 500);
  assert.ok(pointInPolygons(interiorPoint(L), L));
});

test('endpoints: allow-list only, forbidden personal-data services refused', () => {
  assert.ok(endpointAllowed('https://api.vworld.kr/req/data?x=1'));
  assert.ok(!endpointAllowed('https://urban.seoul.go.kr/api/map/kras/getKras.json'));
  assert.ok(!endpointAllowed('https://apis.data.go.kr/1611000/nsdi/LandUseService/x'));
  assert.ok(!endpointAllowed('https://api.vworld.kr/ned/data/getPossessionAttr?pnu=1'));
  assert.ok(!endpointAllowed('https://api.vworld.kr/ned/wfs/getGisGeneralBuildingWFS'));
  assert.ok(FORBIDDEN_ENDPOINTS.length >= 4);
});

test('collect: parcels, land use with 고시 번호, buildings with heights, provenance', async () => {
  const fake = fakeSiteData();
  const site = await collectSite(context(fake), { pnus: [P1], radius: 50 });
  assert.equal(site.crs, 'EPSG:5186');
  assert.equal(site.blocked, false);
  assert.equal(site.target.status, 'ok');
  assert.equal(site.target.items[0].landCategory, '대');
  assert.equal(site.target.items[0].computedArea, 600);
  assert.equal(site.landCharacteristics.items[0].officialArea, 600);
  assert.equal(site.landCharacteristics.items[0].year, 2025, 'last year when this year is empty');

  const use = site.landUse.items[0];
  const zone = use.entries.find((e) => e.name === '제2종일반주거지역');
  assert.equal(zone.conflict, '포함');
  assert.deepEqual(zone.notices, [{ year: '2020', number: '0123', layer: 'LT_C_UQ111' }]);
  assert.deepEqual(zone.from, ['attr', 'layer']);
  assert.equal(use.entries.find((e) => e.name === '가축사육제한구역').conflict, '저촉');
  assert.equal(use.districtPlans[0].name, '합성 지구단위계획구역');
  assert.equal(use.districtPlans[0].decisionId, 'W-1');

  assert.deepEqual(site.parcels.items.map((p) => p.pnu).sort(), [P1, P2, ROAD].sort());
  assert.equal(site.parcels.items.find((p) => p.pnu === ROAD).landCategory, '도');
  const [a, b] = ['합성 업무동', '합성 상가'].map((name) =>
    site.buildings.items.find((x) => x.name === name),
  );
  assert.deepEqual([a.height, a.heightSource, a.floorsAbove], [17.5, 'vworld-building-info', 5]);
  assert.deepEqual([b.height, b.heightSource, b.dongName], [10.2, 'building-register', '가동']);

  assert.equal(site.target.provenance.basis, 'source');
  assert.equal(site.target.provenance.crs, 'EPSG:5186');
  assert.deepEqual(site.target.provenance.ids, [P1]);
  assert.equal(site.target.fetchedAt, '2026-10-08T03:00:00.000Z');
  assert.ok(site.landUse.provenance.layers.includes('LT_C_UPISUQ161'));
  assert.deepEqual(site.sent.pnus, [P1]);
  noKeyIn(site);
  assert.ok(allCallsAllowed(fake.calls));
  // The register is always asked with pageNo (without it the gateway returns one row).
  const register = fake.calls.filter((u) => u.pathname.endsWith('getBrTitleInfo'));
  assert.ok(register.length >= 2);
  assert.ok(register.every((u) => u.searchParams.get('pageNo') && u.searchParams.get('numOfRows')));
  assert.equal(site.register.items.filter((t) => t.pnu === P2).length, 2);
});

test('collect: paging reads every page; missed pages and area gaps are 확인 필요', async () => {
  const paged = fakeSiteData({ pageSize: 2 });
  const site = await collectSite(context(paged), { pnus: [P1], radius: 50 });
  assert.equal(site.parcels.items.length, 3);
  assert.equal(site.parcels.status, 'ok');
  const pages = paged.calls.filter(
    (u) => u.searchParams.get('data') === 'LP_PA_CBND_BUBUN' && u.searchParams.get('geomFilter'),
  );
  assert.deepEqual(
    pages.map((u) => u.searchParams.get('page')),
    ['1', '2'],
  );
  assert.ok(pages.every((u) => u.searchParams.get('size') === '1000'));

  const short = await collectSite(context(fakeSiteData({ claimExtra: 5, officialArea: 700 })), {
    pnus: [P1],
    radius: 50,
  });
  assert.equal(short.parcels.status, 'check');
  assert.match(short.parcels.checks.join(), /전체 8건 중 3건만 받음/);
  assert.equal(short.target.status, 'check');
  assert.match(short.target.checks.join(), /대지면적 차이 -14\.3%/);
});

test('collect: empty answers are 확인 필요, a missing target blocks', async () => {
  const empty = await collectSite(context(fakeSiteData({ vworld: 'empty' })), { pnus: [P1] });
  assert.equal(empty.blocked, true);
  assert.equal(empty.target.status, 'check');
  assert.match(empty.target.checks[0], /연속지적에 없음/);
  assert.equal(empty.parcels.status, 'check');
  assert.match(empty.parcels.checks[0], /대상 필지 경계가 없어/);
});

test('collect: errors inside HTTP 200, malformed answers and missing keys stay per source', async () => {
  const limited = await collectSite(context(fakeSiteData({ vworld: 'limit' })), { pnus: [P1] });
  assert.equal(limited.target.status, 'failed');
  assert.equal(limited.target.reason, 'LIMIT');
  assert.equal(limited.target.detail, 'OVER_REQUEST_LIMIT');
  assert.equal(limited.buildings.status, 'failed', 'box copies follow the failed target');
  assert.equal(limited.register.status, 'ok', 'the register still answers for the target');

  const malformed = await collectSite(context(fakeSiteData({ vworld: 'malformed' })), {
    pnus: [P1],
  });
  assert.equal(malformed.target.reason, 'BAD_RESPONSE');
  assert.deepEqual(malformed.target.items, []);

  const rejected = await collectSite(context(fakeSiteData({ register: 'reject' })), {
    pnus: [P1],
    radius: 50,
  });
  assert.equal(rejected.register.status, 'failed');
  assert.equal(rejected.register.reason, 'REJECTED');
  assert.equal(rejected.target.status, 'ok');
  const quota = await collectSite(context(fakeSiteData({ register: 'limit' })), {
    pnus: [P1],
    radius: 50,
  });
  assert.equal(quota.register.reason, 'LIMIT');

  // No DATA_GO_KR_KEY: only the register is 'no-key'; VWorld copies are fetched.
  const fake = fakeSiteData();
  const partial = await collectSite(context(fake, { VWORLD_KEY: KEYS.VWORLD_KEY }), {
    pnus: [P1],
    radius: 50,
  });
  assert.equal(partial.register.status, 'no-key');
  assert.equal(partial.target.status, 'ok');
  assert.equal(partial.buildings.items.find((b) => b.name === '합성 상가').height, null);
  assert.ok(!fake.calls.some((u) => u.hostname === 'apis.data.go.kr'));

  // A wrong VWorld key: INVALID_KEY in a 200 body → REJECTED, never success.
  const wrong = await collectSite(context(fakeSiteData(), { ...KEYS, VWORLD_KEY: 'WRONG' }), {
    pnus: [P1],
  });
  assert.equal(wrong.target.reason, 'REJECTED');
  assert.equal(wrong.target.detail, 'INVALID_KEY');
  noKeyIn(wrong);
});

test('lookup: one matching candidate proposed, several asked, 낙착 rebuilt and checked', async () => {
  const one = await lookupParcel(context(fakeSiteData()), '합성시 가나구 가나동 1');
  assert.equal(one.kind, 'jibun');
  assert.equal(one.status, 'ok');
  assert.equal(one.proposal, P1);
  assert.equal(one.candidates.length, 2, 'the other lot stays visible');
  assert.deepEqual(
    [
      one.candidates[0].matchesInput,
      one.candidates[0].landCategory,
      one.candidates[0].officialArea,
    ],
    [true, '대', 600],
  );
  assert.ok(one.candidates[0].point);

  const road = await lookupParcel(context(fakeSiteData()), '합성시 가나구 가나로 10');
  assert.equal(road.kind, 'road');
  assert.equal(road.status, 'ambiguous');
  assert.equal(road.proposal, null);

  // 가나동 3 has no building; the service answers lot 1. Lot 3 is rebuilt, not in the cadastre.
  const snapped = await lookupParcel(context(fakeSiteData()), '합성시 가나구 가나동 3');
  assert.equal(snapped.proposal, null);
  assert.match(snapped.checks.join(), /낙착/);
  assert.match(snapped.checks.join(), /연속지적에 없는 PNU: 1199910100100030000/);
  assert.ok(snapped.candidates.every((c) => c.pnu !== '1199910100100030000'));

  // No JUSO_KEY: VWorld search gives the candidates.
  const search = await lookupParcel(
    context(fakeSiteData(), { VWORLD_KEY: KEYS.VWORLD_KEY }),
    '합성시 가나동 1',
  );
  assert.equal(search.candidates[0].source, 'vworld-search');
  assert.equal(search.proposal, P1);

  const typed = await lookupParcel(context(fakeSiteData()), P2);
  assert.equal(typed.kind, 'pnu');
  assert.equal(typed.proposal, P2);
  assert.equal(typed.candidates[0].verified, true);

  const none = await lookupParcel(
    { keys: {}, fetch: fakeSiteData().fetch, now },
    '합성시 가나동 1',
  );
  assert.equal(none.status, 'no-key');
  assert.match(none.checks[0], /PNU를 직접 입력/);

  const wrong = await lookupParcel(
    context(fakeSiteData(), { ...KEYS, JUSO_KEY: 'BAD' }),
    '합성시 가나동 1',
  );
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.detail, 'E0001');
  const malformed = await lookupParcel(
    context(fakeSiteData({ juso: 'malformed' })),
    '합성시 가나동 1',
  );
  assert.equal(malformed.reason, 'BAD_RESPONSE');
  noKeyIn([one, road, snapped, search, typed, wrong]);
});

test('an already-encoded data.go.kr key is sent as is; other values are encoded once', async () => {
  const seen = [];
  const fetch = async (href) => {
    seen.push(href);
    return new Response('{}');
  };
  const endpoint = 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo';
  await requestJson({ keys: {}, fetch }, 'building-register', endpoint, {
    serviceKey: 'ab%2Bcd%3D%3D',
    bun: '0031',
  });
  await requestJson({ keys: {}, fetch }, 'building-register', endpoint, { serviceKey: 'ab+cd==' });
  assert.match(seen[0], /serviceKey=ab%2Bcd%3D%3D&bun=0031$/);
  assert.match(seen[1], /serviceKey=ab%2Bcd%3D%3D$/);
});

test('library registry: jig steps get SHP and PNU helpers, never the keyed calls', async () => {
  const site = (await officialLibraries())['vide/site-data'];
  assert.equal(site.version, '0.1.0');
  for (const name of ['readShp', 'importShapefiles', 'isPnu'])
    assert.ok(site.functions.includes(name), name);
  for (const name of ['lookupParcel', 'collectSite', 'requestJson'])
    assert.ok(!site.functions.includes(name), name);
});

test('network failure is a NETWORK failure without the URL', async () => {
  const site = await collectSite(
    {
      keys: KEYS,
      now,
      fetch: async () => {
        throw new TypeError('fetch failed https://api.vworld.kr/req/data?key=V-KEY');
      },
    },
    { pnus: [P1] },
  );
  assert.equal(site.target.reason, 'NETWORK');
  noKeyIn(site);
});
