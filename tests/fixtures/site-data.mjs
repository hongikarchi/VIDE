// A synthetic public site-data service for vide/site-data tests (PLAN-45 T-205). Response shapes
// follow the 2026-10-08 keyed run at public points (SPIKE-2026-10-07-public-site-data); every
// address, PNU, name and coordinate here is invented (법정동 1199910100 does not exist).
//
// Site (EPSG:5186 metres): lot 1 (target, 20 × 30 m) and lot 1-1 side by side, lot 2 a road strip
// south of both. One building on each lot. Keys: V-KEY, J-KEY, D-KEY.

export const KEYS = { VWORLD_KEY: 'V-KEY', JUSO_KEY: 'J-KEY', DATA_GO_KR_KEY: 'D-KEY' };
export const DONG = '1199910100';
export const P1 = `${DONG}100010000`;
export const P2 = `${DONG}100010001`;
export const ROAD = `${DONG}100020000`;
const X = 200000;
const Y = 550000;

const square = (x0, y0, x1, y1) => ({
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  ],
});
const parcel = (pnu, jibun, geometry) => ({
  type: 'Feature',
  geometry,
  properties: {
    pnu,
    jibun,
    addr: `합성시 가나동 ${jibun.replace(/[가-힣]+$/, '')}`,
    bonbun: jibun.split('-')[0],
    bubun: '',
    gosi_year: '2025',
    gosi_month: '01',
    jiga: '1000000',
  },
  id: `LP_PA_CBND_BUBUN.${pnu.slice(-6)}`,
});

export function dataset() {
  return {
    LP_PA_CBND_BUBUN: [
      parcel(P1, '1대', square(X, Y, X + 20, Y + 30)),
      parcel(P2, '1-1대', square(X + 20, Y, X + 40, Y + 30)),
      parcel(ROAD, '2도', square(X - 10, Y - 10, X + 50, Y)),
    ],
    LT_C_SPBD: [
      {
        type: 'Feature',
        geometry: square(X + 5, Y + 5, X + 15, Y + 25),
        properties: {
          bd_mgt_sn: `${P1}000001`,
          buld_nm: '합성 업무동',
          buld_nm_dc: '',
          gro_flo_co: '5',
          sido: '합성시',
          sigungu: '가나구',
          rd_nm: '가나로',
          buld_no: '10',
          gu: '가나동',
        },
        id: 'LT_C_SPBD.1',
      },
      {
        type: 'Feature',
        geometry: square(X + 25, Y + 10, X + 35, Y + 20),
        properties: {
          bd_mgt_sn: `${P2}000001`,
          buld_nm: '합성 상가',
          buld_nm_dc: '가동',
          gro_flo_co: '3',
          sido: '합성시',
          sigungu: '가나구',
          rd_nm: '가나로',
          buld_no: '12',
          gu: '가나동',
        },
        id: 'LT_C_SPBD.2',
      },
    ],
    LT_C_BLDGINFO: [
      {
        type: 'Feature',
        geometry: square(X + 6, Y + 6, X + 14, Y + 24),
        properties: {
          height: '17.5',
          grnd_flr: '5',
          ugrnd_flr: '1',
          usability: '업무시설',
          bld_nm: '',
          dong_nm: '',
        },
        id: 'LT_C_BLDGINFO.1',
      },
      {
        type: 'Feature',
        geometry: square(X + 26, Y + 11, X + 34, Y + 19),
        properties: {
          height: '0',
          grnd_flr: '0',
          ugrnd_flr: '0',
          usability: '',
          bld_nm: '',
          dong_nm: '',
        },
        id: 'LT_C_BLDGINFO.2',
      },
    ],
    // Point layers: every point of the synthetic site is inside these areas.
    LT_C_UQ111: [
      {
        type: 'Feature',
        properties: { uname: '제2종일반주거지역', dyear: '2020', dnum: '0123' },
        id: 'LT_C_UQ111.1',
      },
    ],
    LT_C_UQ141: [
      {
        type: 'Feature',
        properties: { uname: '지구단위계획구역', dyear: '2019', dnum: '0456' },
        id: 'LT_C_UQ141.1',
      },
    ],
    LT_C_UPISUQ161: [
      {
        type: 'Feature',
        properties: {
          dgm_nm: '합성 지구단위계획구역',
          dgm_ar: '50000',
          wtnnc_sn: 'W-1',
          ntfc_sn: 'N-1',
        },
        id: 'LT_C_UPISUQ161.1',
      },
    ],
  };
}

const intersects = (geometry, [x0, y0, x1, y1]) => {
  const points = geometry.coordinates.flat(2);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return (
    Math.max(...xs) >= x0 && Math.min(...xs) <= x1 && Math.max(...ys) >= y0 && Math.min(...ys) <= y1
  );
};

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const vworldError = (code) =>
  json({
    response: {
      service: { name: 'data' },
      status: 'ERROR',
      error: { level: '2', code, text: '합성 오류' },
    },
  });

/**
 * A fetch that answers like the public services. Options:
 * - pageSize: largest page the fake serves (simulates paging with few features)
 * - claimExtra: VWorld box counts this many more features than it has (missed pages)
 * - officialArea: 공부 면적 of lot 1 (default 600 = the polygon)
 * - vworld / juso / register: 'reject' | 'limit' | 'malformed' | 'empty' to break one source
 * - noRegisterPageNo: the gateway trap (no pageNo → one row) is always on
 */
export function fakeSiteData(options = {}) {
  const data = options.data ?? dataset();
  const calls = [];
  const fetch = async (href) => {
    const url = new URL(href);
    const q = url.searchParams;
    calls.push(url);
    const path = url.origin + url.pathname;
    if (path === 'https://api.vworld.kr/req/data') {
      if (q.get('key') !== KEYS.VWORLD_KEY) return vworldError('INVALID_KEY');
      if (options.vworld === 'limit') return vworldError('OVER_REQUEST_LIMIT');
      if (options.vworld === 'malformed')
        return json({ response: { status: 'OK', result: 'none' } });
      const size = Number(q.get('size'));
      if (!(size >= 1 && size <= 1000))
        return json({
          response: { status: 'ERROR', error: { level: '1', code: 'INVALID_RANGE', text: 'size' } },
        });
      const page = Number(q.get('page') ?? 1);
      let features = data[q.get('data')] ?? [];
      const attr = q.get('attrFilter');
      const geom = q.get('geomFilter') ?? '';
      if (attr) features = features.filter((f) => `pnu:=:${f.properties.pnu}` === attr);
      const box = /^BOX\(([^)]+)\)$/.exec(geom);
      if (box)
        features = features.filter((f) => intersects(f.geometry, box[1].split(',').map(Number)));
      if (options.vworld === 'empty' || !features.length)
        return json({
          response: {
            status: 'NOT_FOUND',
            record: { total: '0', current: '0' },
            page: { total: '1', current: '1', size: String(size) },
          },
        });
      const served = Math.min(size, options.pageSize ?? size);
      const total = features.length + (box ? (options.claimExtra ?? 0) : 0);
      const slice = features
        .slice((page - 1) * served, page * served)
        .map((f) => (q.get('geometry') === 'false' ? { ...f, geometry: undefined } : f));
      return json({
        response: {
          service: { name: 'data', version: '2.0', operation: 'GetFeature' },
          status: 'OK',
          record: { total: String(total), current: String(slice.length) },
          page: {
            total: String(Math.ceil(total / served)),
            current: String(page),
            size: String(served),
          },
          result: { featureCollection: { type: 'FeatureCollection', features: slice } },
        },
      });
    }
    if (
      path === 'https://api.vworld.kr/ned/data/getLandUseAttr' ||
      path === 'https://api.vworld.kr/ned/data/getLandCharacteristics'
    ) {
      const root = url.pathname.endsWith('getLandUseAttr') ? 'landUses' : 'landCharacteristicss';
      if (q.get('key') !== KEYS.VWORLD_KEY)
        return json({ [root]: { resultCode: 'INVALID_KEY', resultMsg: '합성' } });
      const pnu = q.get('pnu');
      let rows = [];
      if (root === 'landUses' && pnu === P1)
        rows = [
          {
            pnu,
            prposAreaDstrcCodeNm: '제2종일반주거지역',
            prposAreaDstrcCode: 'UQA122',
            cnflcAt: '1',
            cnflcAtNm: '포함',
            registDt: '2020-01-01',
          },
          {
            pnu,
            prposAreaDstrcCodeNm: '지구단위계획구역',
            prposAreaDstrcCode: 'UQQ300',
            cnflcAt: '1',
            cnflcAtNm: '포함',
            registDt: '2019-01-01',
          },
          {
            pnu,
            prposAreaDstrcCodeNm: '가축사육제한구역',
            prposAreaDstrcCode: 'UMD200',
            cnflcAt: '2',
            cnflcAtNm: '저촉',
            registDt: '2018-01-01',
          },
        ];
      if (root === 'landCharacteristicss' && pnu === P1 && q.get('stdrYear') === '2025')
        rows = [
          {
            pnu,
            stdrYear: '2025',
            lndpclAr: String(options.officialArea ?? '600.0'),
            lndcgrCodeNm: '대',
            prposArea1Nm: '제2종일반주거지역',
            prposArea2Nm: '지정되지않음',
            roadSideCodeNm: '세로한면(가)',
            lastUpdtDt: '2025-08-01',
          },
        ];
      if (!rows.length)
        return json({
          response: {
            pageNo: '1',
            resultCode: '',
            totalCount: '0',
            numOfRows: '100',
            resultMsg: '',
          },
        });
      return json({
        [root]: {
          field: rows,
          pageNo: '1',
          resultCode: '',
          totalCount: String(rows.length),
          numOfRows: '100',
          resultMsg: '',
        },
      });
    }
    if (path === 'https://api.vworld.kr/req/search') {
      if (q.get('key') !== KEYS.VWORLD_KEY) return vworldError('INVALID_KEY');
      const items = q.get('query').includes('가나동 1')
        ? [
            {
              id: P1,
              address: {
                category: 'parcel',
                parcel: '합성시 가나동 1',
                road: '가나로 10',
                bldnm: '',
              },
              point: { x: '200010', y: '550015' },
            },
            {
              id: P2,
              address: { category: 'parcel', parcel: '합성시 가나동 1-1', road: '', bldnm: '' },
              point: { x: '200030', y: '550015' },
            },
          ]
        : [];
      if (!items.length)
        return json({ response: { status: 'NOT_FOUND', record: { total: '0', current: '0' } } });
      return json({
        response: {
          status: 'OK',
          record: { total: String(items.length), current: String(items.length) },
          result: { crs: 'EPSG:5186', items },
        },
      });
    }
    if (path === 'https://business.juso.go.kr/addrlink/addrLinkApi.do') {
      if (q.get('confmKey') !== KEYS.JUSO_KEY)
        return json({
          results: {
            common: {
              errorCode: 'E0001',
              errorMessage: '승인되지 않은 KEY 입니다.',
              totalCount: '0',
            },
            juso: null,
          },
        });
      if (options.juso === 'malformed') return json({ results: { juso: [] } });
      const row = (main, sub, road) => ({
        admCd: DONG,
        mtYn: '0',
        lnbrMnnm: String(main),
        lnbrSlno: String(sub),
        jibunAddr: `합성시 가나구 가나동 ${main}${sub ? `-${sub}` : ''}`,
        roadAddr: road,
        bdNm: '',
      });
      const keyword = q.get('keyword');
      const rows = keyword.endsWith('가나동 1')
        ? [row(1, 0, '합성시 가나구 가나로 10'), row(1, 1, '합성시 가나구 가나로 12')]
        : keyword.endsWith('가나동 3') // 건물 없는 지번 → 이웃 지번으로 낙착
          ? [row(1, 0, '합성시 가나구 가나로 10')]
          : keyword.endsWith('가나로 10')
            ? [row(1, 0, '합성시 가나구 가나로 10'), row(1, 1, '합성시 가나구 가나로 10')]
            : [];
      return json({
        results: {
          common: { errorCode: '0', errorMessage: '정상', totalCount: String(rows.length) },
          juso: rows,
        },
      });
    }
    if (path === 'https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo') {
      if (q.get('serviceKey') !== KEYS.DATA_GO_KR_KEY || options.register === 'reject')
        return json(
          {
            OpenAPI_ServiceResponse: {
              cmmMsgHeader: {
                errMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR',
                returnAuthMsg: '합성',
                returnReasonCode: '30',
              },
            },
          },
          403,
        );
      if (options.register === 'limit')
        return new Response(
          '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR</errMsg><returnReasonCode>22</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>',
          { status: 429 },
        );
      const pnu = `${q.get('sigunguCd')}${q.get('bjdongCd')}${q.get('platGbCd') === '1' ? 2 : 1}${q.get('bun')}${q.get('ji')}`;
      const title = (dongNm, heit, totArea, main = '0') => ({
        sigunguCd: q.get('sigunguCd'),
        bjdongCd: q.get('bjdongCd'),
        platGbCd: q.get('platGbCd'),
        bun: q.get('bun'),
        ji: q.get('ji'),
        mgmBldrgstPk: `${pnu.slice(-4)}${dongNm}`,
        bldNm: ' ',
        dongNm,
        mainAtchGbCd: main,
        mainPurpsCdNm: '근린생활시설',
        heit,
        grndFlrCnt: 3,
        ugrndFlrCnt: 1,
        platArea: 600,
        archArea: 100,
        totArea,
        bcRat: 16.7,
        vlRat: 50,
        useAprDay: '20000101',
      });
      let items =
        pnu === P2
          ? [title('가동', 10.2, 300), title('나동', 0, 120)]
          : pnu === P1
            ? [title(' ', 0, 500)]
            : [];
      if (!q.get('pageNo')) items = items.slice(0, 1);
      const rows = Number(q.get('numOfRows') ?? 10);
      const page = Number(q.get('pageNo') ?? 1);
      const slice = items.slice((page - 1) * rows, page * rows);
      return json({
        response: {
          header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' },
          body: {
            items: { item: slice },
            numOfRows: String(rows),
            pageNo: String(page),
            totalCount: String(items.length),
          },
        },
      });
    }
    throw new Error(`unexpected endpoint ${path}`);
  };
  return { fetch, calls };
}
