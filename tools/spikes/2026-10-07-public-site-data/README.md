# T-203 공공 자료 접근 실험 코드

기록: [SPIKE-2026-10-07-public-site-data](../../../docs/tdd/SPIKE-2026-10-07-public-site-data.md)

| 파일 | 역할 |
|---|---|
| `keys.mjs` | 키 읽기(환경 변수 → `<VIDE 데이터 폴더>/public-data.env`), 끝 네 글자 마스킹, 로그에서 키 지우기 |
| `probe.mjs` | 비프로젝트 공개 필지 두 곳(서울특별시청, 남산서울타워)으로 질문 1~5를 호출한다. 상태·개수·필드 이름·좌표계만 출력하고 응답은 저장하지 않는다 |

## 다시 돌리기

```sh
node tools/spikes/2026-10-07-public-site-data/probe.mjs keyless   # 키 없이: 오류 형식, 키 없는 엔드포인트
node tools/spikes/2026-10-07-public-site-data/probe.mjs keyed     # 키가 있을 때: 질문 1~4
```

- Node 20 이상. 의존성 없음.
- 키 이름: `VWORLD_KEY`, `VWORLD_DOMAIN`, `JUSO_KEY`, `DATA_GO_KR_KEY`. 같은 이름의 환경 변수가 파일보다 우선한다.
- 키 파일은 PC 전용이다. 저장소·fixture·검수 증거·채팅에 키 값을 넣지 않는다. 출력에는 `key:****abcd`만 남는다.
- `TEST_SITES`에는 공공기관 청사·공개 명소만 둔다. 사용자 프로젝트 주소를 넣지 않는다.
- 서울도시공간포털 `KRAS*` 서비스(토지대장·토지이용계획확인원)는 소유자 정보를 돌려주므로 호출하지 않는다.
