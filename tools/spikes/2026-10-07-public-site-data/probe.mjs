// T-203 SPIKE — public site-data access probe (PLAN-45, SPEC-12.3·12.4).
// Usage: node probe.mjs [keyless|keyed|all]   (default: all — keyed steps skip themselves without keys)
// Prints only status, counts, field NAMES and CRS. Responses are not saved, keys are masked.
// Test parcels are non-project public sites (see TEST_SITES). Never put a project address here.
import { loadKeys, mask, redact } from './keys.mjs';

const TEST_SITES = [
  // 일반 지번 + 도로명: 서울특별시청 (공공기관 청사)
  { label: 'city-hall', jibun: '서울특별시 중구 태평로1가 31', road: '서울특별시 중구 세종대로 110' },
  // 산 지번 + 도로명: 남산서울타워 (공개 명소)
  { label: 'namsan-tower', jibun: '서울특별시 용산구 용산동2가 산1-3', road: '서울특별시 용산구 남산공원길 105' },
];

const mode = process.argv[2] || 'all';
const { keys, file } = loadKeys();
const results = [];
const note = (step, data) => {
  const row = { step, ...data };
  results.push(row);
  console.log(redact(JSON.stringify(row), keys));
};

async function get(url, init) {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, type: response.headers.get('content-type'), text, json, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, error: redact(error.message, keys), ms: Date.now() - started };
  }
}

const fieldsOf = (object) => (object && typeof object === 'object' ? Object.keys(object).sort() : []);
const vworldFeatures = (json) => json?.response?.result?.featureCollection?.features ?? [];
const nedFields = (json, root) => {
  const list = json?.[root]?.field ?? json?.response?.field ?? [];
  return (Array.isArray(list) ? list : [list]).filter(Boolean);
};
const hubItems = (json) => {
  const items = json?.response?.body?.items?.item ?? [];
  return (Array.isArray(items) ? items : [items]).filter(Boolean);
};

// ── keyless: error formats and keyless public endpoints ──
async function keyless() {
  // 1. VWorld without key → error envelope shape
  const v = await get(
    'https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&format=json&geomFilter=POINT(126.9779%2037.5663)&crs=EPSG:4326',
  );
  note('vworld-data:no-key', { http: v.status, status: v.json?.response?.status, error: v.json?.response?.error, envelope: fieldsOf(v.json?.response) });
  const n = await get('https://api.vworld.kr/ned/data/getLandUseAttr?pnu=1114010300100310000&format=json');
  note('vworld-ned:no-key', { http: n.status, type: n.type, top: fieldsOf(n.json), head: n.json ? undefined : n.text?.slice(0, 160) });
  // 2. data.go.kr gateway without key
  const h = await get('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?sigunguCd=11140&bjdongCd=10300&platGbCd=0&bun=0031&ji=0000&_type=json');
  note('data.go.kr:no-key', { http: h.status, type: h.type, head: h.text?.slice(0, 200) });
  // 3. juso without key
  const j = await get(`https://business.juso.go.kr/addrlink/addrLinkApi.do?confmKey=&currentPage=1&countPerPage=10&keyword=${encodeURIComponent(TEST_SITES[0].road)}&resultType=json`);
  note('juso:no-key', { http: j.status, common: j.json?.results?.common });
  // 4. Seoul urban portal parcel polygon (keyless; public parcel only; KRAS services are never called)
  const s = await get('https://urban.seoul.go.kr/api/map/pacbnd/getList2.json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: 'https://urban.seoul.go.kr/view/map/main.html',
      'User-Agent': 'Mozilla/5.0',
    },
    body: 'pnu=1114010300100310000',
  });
  const first = Array.isArray(s.json) ? s.json[0] : (s.json?.list?.[0] ?? s.json?.data?.[0] ?? s.json);
  note('seoul-portal:pacbnd', { http: s.status, type: s.type, top: fieldsOf(s.json), firstFields: fieldsOf(first), head: s.json ? undefined : s.text?.slice(0, 160) });
}

// ── keyed probes ──
async function keyed() {
  const V = keys.VWORLD_KEY, J = keys.JUSO_KEY, D = keys.DATA_GO_KR_KEY;
  const domain = encodeURIComponent(keys.VWORLD_DOMAIN || 'http://localhost');
  note('keys', { file, VWORLD_KEY: mask(V), JUSO_KEY: mask(J), DATA_GO_KR_KEY: mask(D), VWORLD_DOMAIN: keys.VWORLD_DOMAIN ? 'present' : 'absent' });
  const pnus = {};

  for (const site of TEST_SITES) {
    // Q1 주소 → PNU
    if (J) {
      for (const keyword of [site.jibun, site.road]) {
        const r = await get(`https://business.juso.go.kr/addrlink/addrLinkApi.do?confmKey=${J}&currentPage=1&countPerPage=10&keyword=${encodeURIComponent(keyword)}&resultType=json`);
        const list = r.json?.results?.juso ?? [];
        const first = list[0];
        const pnu = first ? `${first.admCd}${first.mtYn === '1' ? '2' : '1'}${String(first.lnbrMnnm).padStart(4, '0')}${String(first.lnbrSlno).padStart(4, '0')}` : null;
        if (pnu) pnus[site.label] ??= pnu;
        note(`juso:${site.label}:${keyword === site.jibun ? 'jibun' : 'road'}`, { http: r.status, code: r.json?.results?.common?.errorCode, total: r.json?.results?.common?.totalCount, mtYn: first?.mtYn, pnu, fields: fieldsOf(first), ms: r.ms });
      }
    }
    if (V) {
      for (const [type, keyword] of [['parcel', site.jibun], ['road', site.road]]) {
        const r = await get(`https://api.vworld.kr/req/address?service=address&request=getcoord&version=2.0&crs=epsg:4326&address=${encodeURIComponent(keyword)}&type=${type}&refine=true&simple=false&format=json&key=${V}`);
        note(`vworld-geocode:${site.label}:${type}`, { http: r.status, status: r.json?.response?.status, error: r.json?.response?.error?.code, refinedFields: fieldsOf(r.json?.response?.refined?.structure), point: r.json?.response?.result?.point ? 'yes' : 'no', crs: r.json?.response?.result?.crs, ms: r.ms });
        const s = await get(`https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=10&page=1&query=${encodeURIComponent(keyword)}&type=address&category=${type}&format=json&key=${V}`);
        const items = s.json?.response?.result?.items ?? [];
        note(`vworld-search:${site.label}:${type}`, { http: s.status, status: s.json?.response?.status, total: s.json?.response?.record?.total, itemFields: fieldsOf(items[0]), addressFields: fieldsOf(items[0]?.address), hasPnuLikeId: items.some((x) => /^\d{19}$/.test(x.id ?? '')), ms: s.ms });
        if (!pnus[site.label]) {
          const id = items.find((x) => /^\d{19}$/.test(x.id ?? ''))?.id;
          if (id) pnus[site.label] = id;
        }
      }
    }
  }

  if (!V) {
    note('vworld:skipped', { reason: 'VWORLD_KEY 없음' });
  }
  for (const [label, pnu] of Object.entries(pnus)) {
    let ring = null;
    if (V) {
      // Q2 연속지적 PNU 필터
      const r = await get(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${V}&domain=${domain}&attrFilter=pnu:=:${pnu}&geometry=true&crs=EPSG:5186&format=json&size=10`);
      const f = vworldFeatures(r.json)[0];
      ring = f?.geometry;
      note(`cadastral-pnu:${label}`, { http: r.status, status: r.json?.response?.status, record: r.json?.response?.record, page: r.json?.response?.page, props: fieldsOf(f?.properties), geomType: f?.geometry?.type, crsParam: 'EPSG:5186', sampleXY: f ? f.geometry.coordinates.flat(3).slice(0, 2).map((v) => Math.round(v)) : null, ms: r.ms });
      // Q2 범위 필터 + 페이지 나눔 (중심 ±150 m)
      if (ring) {
        const xy = ring.coordinates.flat(3);
        const xs = xy.filter((_, i) => i % 2 === 0), ys = xy.filter((_, i) => i % 2 === 1);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const box = `BOX(${cx - 150},${cy - 150},${cx + 150},${cy + 150})`;
        for (const size of [1000, 100]) {
          const b = await get(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${V}&domain=${domain}&geomFilter=${box}&geometry=false&crs=EPSG:5186&format=json&size=${size}&page=1`);
          note(`cadastral-box:${label}:size${size}`, { http: b.status, status: b.json?.response?.status, record: b.json?.response?.record, page: b.json?.response?.page, error: b.json?.response?.error?.code, ms: b.ms });
        }
        const big = await get(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${V}&domain=${domain}&geomFilter=${box}&geometry=false&crs=EPSG:5186&format=json&size=1001&page=1`);
        note(`cadastral-box:${label}:size1001`, { http: big.status, status: big.json?.response?.status, error: big.json?.response?.error, record: big.json?.response?.record });
        // Q4 건물 레이어 후보 (같은 범위)
        for (const layer of ['LT_C_SPBD', 'LT_C_BLDGINFO', 'LT_C_UQ111']) {
          const g = await get(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=${layer}&key=${V}&domain=${domain}&geomFilter=${box}&geometry=true&crs=EPSG:5186&format=json&size=1000&page=1`);
          const feats = vworldFeatures(g.json);
          note(`layer-box:${label}:${layer}`, { http: g.status, status: g.json?.response?.status, error: g.json?.response?.error?.code, record: g.json?.response?.record, props: fieldsOf(feats[0]?.properties), geomType: feats[0]?.geometry?.type, ms: g.ms });
        }
        // Q4 GIS건물통합정보 (NED WFS)
        const w = await get(`https://api.vworld.kr/ned/wfs/getGisGeneralBuildingWFS?key=${V}&domain=${domain}&typename=dt_d010&bbox=${cx - 150},${cy - 150},${cx + 150},${cy + 150},EPSG:5186&srsName=EPSG:5186&maxFeatures=1000&output=application/json`);
        note(`ned-wfs:${label}:gis-building`, { http: w.status, type: w.type, top: fieldsOf(w.json), props: fieldsOf(w.json?.features?.[0]?.properties), count: w.json?.features?.length, total: w.json?.totalFeatures, head: w.json ? undefined : w.text?.slice(0, 200), ms: w.ms });
        // Q3 용도지역 점 필터
        const pt = `POINT(${cx}%20${cy})`;
        const z = await get(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_UQ111&key=${V}&domain=${domain}&geomFilter=${pt}&geometry=false&crs=EPSG:5186&format=json&size=10`);
        note(`zoning-point:${label}`, { http: z.status, status: z.json?.response?.status, record: z.json?.response?.record, props: fieldsOf(vworldFeatures(z.json)[0]?.properties) });
        const d = await get(`https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_UPISUQ161&key=${V}&domain=${domain}&geomFilter=${pt}&geometry=false&crs=EPSG:5186&format=json&size=10`);
        note(`district-plan-point:${label}`, { http: d.status, status: d.json?.response?.status, record: d.json?.response?.record, props: fieldsOf(vworldFeatures(d.json)[0]?.properties) });
      }
      // Q3 토지이용계획 속성 (PNU)
      const u = await get(`https://api.vworld.kr/ned/data/getLandUseAttr?key=${V}&domain=${domain}&pnu=${pnu}&format=json&numOfRows=100&pageNo=1`);
      const uses = nedFields(u.json, 'landUses');
      note(`land-use-attr:${label}`, { http: u.status, top: fieldsOf(u.json?.landUses ?? u.json), count: uses.length, total: u.json?.landUses?.totalCount, fields: fieldsOf(uses[0]), conflictValues: [...new Set(uses.map((x) => x.cnflcAtNm ?? x.cnflcAt))] });
      // 토지특성 (면적·지목)
      const year = new Date().getFullYear();
      for (const y of [year, year - 1]) {
        const c = await get(`https://api.vworld.kr/ned/data/getLandCharacteristics?key=${V}&domain=${domain}&pnu=${pnu}&stdrYear=${y}&format=json&numOfRows=10&pageNo=1`);
        const rows = nedFields(c.json, 'landCharacteristicss');
        note(`land-characteristics:${label}:${y}`, { http: c.status, count: rows.length, fields: fieldsOf(rows[0]), hasArea: rows.some((x) => x.lndpclAr) });
        if (rows.length) break;
      }
    }
    // Q4 건축물대장 표제부 + 페이지 나눔
    if (D) {
      const base = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${D}&sigunguCd=${pnu.slice(0, 5)}&bjdongCd=${pnu.slice(5, 10)}&platGbCd=${pnu[10] === '2' ? 1 : 0}&bun=${pnu.slice(11, 15)}&ji=${pnu.slice(15, 19)}&_type=json`;
      for (const q of ['&numOfRows=100&pageNo=1', '&numOfRows=100', '&numOfRows=1&pageNo=1']) {
        const t = await get(base + q);
        const items = hubItems(t.json);
        note(`building-register:${label}${q}`, { http: t.status, code: t.json?.response?.header?.resultCode, total: t.json?.response?.body?.totalCount, received: items.length, fields: fieldsOf(items[0]), hasHeight: items.some((x) => +x.heit > 0), head: t.json ? undefined : t.text?.slice(0, 160), ms: t.ms });
      }
    } else note('building-register:skipped', { reason: 'DATA_GO_KR_KEY 없음' });
  }
  if (!Object.keys(pnus).length) note('pnu:none', { reason: 'JUSO_KEY·VWORLD_KEY 둘 다 없어 PNU를 얻지 못함' });
}

if (mode === 'keyless' || mode === 'all') await keyless();
if (mode === 'keyed' || mode === 'all') {
  if (!keys.VWORLD_KEY && !keys.JUSO_KEY && !keys.DATA_GO_KR_KEY) note('keyed:skipped', { reason: '키 없음 — 환경 변수 또는 public-data.env', file });
  else await keyed();
}
console.log(`\n${results.length} steps`);
