---
id: RESEARCH-19
title: DB 엔진(SQLite·PostgreSQL)과 수집 시간 — 2026-10-20 사용자 메모 6·7
status: review
version: 0.1
updated: 2026-10-20
owner: agent:claude
related: [PLAN-42, SPEC-08, SPEC-17, SPEC-18, ADR-018, ADR-032, ADR-037, RESEARCH-06]
---

# RESEARCH-19 — DB 엔진과 수집 시간

조사 사실과 대안 비교만 적는다. 결정은 사용자 몫이고 브리프 Q3로 묻는다.

## 1. 질문

- 6: 협의·텍스트·지오메트리·협의 주체가 오래 쌓일 때, AI가 RAG로 설계를 파악하고 지오메트리와 데이터를 잇는 데 SQLite와 PostgreSQL 중 무엇이 속도·정확성·유지관리에서 나은가.
- 7: 첫 DB 구축에서 어디가 가장 오래 걸리나. 검색·파싱도 LLM이 하나. Rust 같은 코드로 미리 처리할 수 있나.

## 2. 현행 구조 (사실)

| 저장소 | 주요 표 | 검색 | 쓰기 주체 | 연결 식별자 |
|---|---|---|---|---|
| `app.sqlite`·`project.sqlite` | records·record_parts·record_links·parts·milestones | `text LIKE` (FTS 없음) | 엔진 메인 스레드 하나 | linkId+객체 id, partId, requestId |
| `knowledge.sqlite` | source·excerpt·`excerpt_fts`·statement·issue·dwg_text·mail·party_alias | FTS5 trigram+bm25, 3자 미만은 LIKE | 같은 프로세스의 수집기, 다른 PC는 `.copy` 교체 | rel_path, dwg handle, statement id |
| D1 (사이트) | knowledge_rows(JSON body)·knowledge_reviews·project_records | 없음(받은 PC가 로컬 재구축) | 수집한 PC(begin→200행→commit), 검토는 `edited_at` LWW | project_id, revision, row_key |

근거:

- 배치: `src/core/store.ts:124`, `src/core/project-split.ts:2-3`, ADR-032. 마이그레이션 2~19는 `src/core/migrations.ts:268-288`. `knowledge.sqlite`는 이 체계 밖(`src/knowledge/collect/schema.ts:54-78`).
- 설정: project/app은 `WAL·synchronous=FULL·FK`, `busy_timeout` 없음(`store.ts:143`). knowledge는 `WAL·busy_timeout=5000`(`schema.ts:57`).
- 쓰기: 추출 워커는 DB를 열지 않는다(`extract.ts:170-176`). AI 턴은 읽기 전용(`agent-connection.ts:90,148`, `project-files.ts:123`).
- 검색: `src/jigs/knowledge.ts:190-248`. 벡터 검색은 src에 없다.
- 동기화: `src/contracts/knowledge-pack.ts:13-49`, `shared-layer.ts:269-301`, ADR-037(approved: 정리된 자료의 원본은 서버).
- 빈 곳: Party 엔터티 없음, 진술↔기록·객체 연결 열 없음, R*Tree 사용처 없음, `party_alias` 0행(라운드 7).

## 3. 수집 시간은 어디서 쓰이나 (라운드 7 실측)

첫 정리. 단계는 차례로 돈다(`collector.ts:364-419`). 출처: VERIFY-2026-10-16-loop-round-7.

| 단계 | 초 | 비율 | 종류 | 하는 일 |
|---|---|---|---|---|
| inventory | 710 | 10.4% | 코드 | 공유 폴더 나열·stat·바뀐 파일 SHA-256 (22,286파일) |
| extract | 434 | 6.4% | 코드 | PDF·Office·HWP·메일 텍스트 추출 → 발췌 6,434 |
| dwg | 117 | 1.7% | 코드+숨은 ZWCAD | 도면 문자 일괄 읽기 |
| select | 1,292 | 18.9% | Haiku 107회 | 글 5,106개 거르기 라벨 |
| statements | 1,464 | 21.5% | Sonnet 217회 | 진술·인용 추출, 인용 검증은 코드 |
| issues | 2,735 | 40.1% | Opus 1,384회 | 쟁점 라벨·노트 |
| proposals | 69 | 1.0% | Opus 20회 | 할 일 제안 |
| **합** | **6,821** | 코드 18.5 · LLM 81.5 | 1,728회 | 입력 약 7.0M·출력 약 2.4M 토큰 |

증분 실행은 380 s, LLM 82.9%(issues 174 s·62회).

- **검색·파싱은 LLM이 아니라 코드다.** FTS5·LIKE·bm25, PDF·ZIP·CFB·HWP·MIME 리더, 해시·이름 규칙·인용 검증 모두 TypeScript·SQLite다. LLM은 거르기·진술·쟁점·제안 네 가지 의미 판단에만 쓴다.
- **LLM 단계가 단계 합의 약 80%다.** 단계 합 6,821 s와 문서 벽시계 6,180 s가 641 s 어긋나고 이유는 확인 못 했다. 비율은 근사다.
- **네이티브 코드로 줄일 수 있는 몫은 작다.** inventory 710 s는 회사 공유 폴더 나열 I/O라 언어보다 원격 왕복이 지배한다. extract는 pdfjs→pdfium 같은 대체로 줄여도 몇 분 수준이다. 가장 큰 덩어리는 issues의 호출 수(문장당 약 3회, F33)다. 구현 언어는 TS·C#만 쓴다는 결정(PLAN-08:292)과 '측정 후에만 네이티브'(PLAN-27 §7)가 있다.

## 4. SQLite vs PostgreSQL 비교

세 관점(속도·정확성·유지관리) 분석과 반박을 합쳤다. 반박에서 깨진 행은 수정본이다.

| 기준 | SQLite | PostgreSQL | 유리한 쪽 | 이유 |
|---|---|---|---|---|
| 엔진 안 소량 조회 | 동기 호출, 소켓 없음. 기록 5,000건 목록 API 전체 53 ms(T-337) | 질의마다 소켓 왕복 | SQLite(엔진 안) | AI 셸 경로는 둘 다 프로세스 기동이 지배해 동등. `knowledge.ts`는 호출마다 연결을 새로 연다 |
| 일괄 쓰기·색인 재구축 중 응답성 | dwg_text 44만 행 삽입·`excerpt_fts` rebuild·사본 쓰기가 이벤트 루프를 멈춘다 | 비동기 드라이버라 안 막는다 | 현 코드는 PG, 작업 스레드로 옮기면 동등 | 정지 시간 측정 필요. 처리량은 쓰는 주체가 하나라 동등 |
| 증분 전문 색인 | rebuild가 두 곳(`extract.ts:147`, `knowledge-copy.ts:171`) | pg_trgm GIN 행 단위 갱신 | 동등 | FTS5도 delete/insert로 증분 가능. 코드 선택 문제 |
| 한국어 키워드 검색 | 3자 이상만 trigram, 2자(기둥·구조)는 LIKE 전수. 진술 열은 LIKE만 | pg_trgm도 2자 약함. pg_bigm·PGroonga 선택지 | 정확도 동등, 운영은 SQLite | bigram 그림자 열·진술 FTS가 엔진 교체보다 먼저. 2자 질의 p95 측정 필요 |
| 진술 30만~100만 규모 검색 | 현 질의는 진술 전수 + LIKE OR | 진술 열 pg_trgm GIN + BitmapOr | 현 코드는 PG, 진술 FTS 추가 시 동등 | 위험은 엔진보다 질의 모양. 측정 필요 |
| 벡터 검색 | sqlite-vec 전수 KNN, v1 이전, D1 불가, DLL 배포 | pgvector 순차/HNSW, 성숙 | 정확도 동등. 발췌·진술만이면 SQLite, dwg_text까지면 PG | 병목은 임베딩 생성 경로. 측정 필요 |
| 하이브리드 결합·그래프 이웃 | CTE 하나로 RRF, 재귀 CTE 사용 중(`records.ts:579`) | 같은 SQL, CYCLE 절·AGE | 동등 | 부족한 것은 관계 표 자체 |
| 객체→기록 역조회 | 요청 changes+부위 매핑 메모리 색인, 60/43 ms | jsonb GIN | 동등(현 규모) | `attachments.objects`는 역조회에 안 쓰고 linkId도 없다 |
| 공간 질의 | R*Tree 내장(미사용) | PostGIS 면 연산 | SQLite | 필요한 것은 점·bbox. 먼저 dwg_text 좌표계(블록·종이·모델 혼재)를 나눠야 한다 |
| 프로젝트 격리·교차 조회 | 프로젝트=파일(ADR-032). 교차는 ATTACH(기본 10)+앱 병합 | 한 질의로 교차 | 격리는 SQLite, 교차는 PG | 교차 RAG가 요구되면 뒤집힌다 |
| 설치·AI 직접 읽기 | node:sqlite 내장. AI CLI가 파일을 읽기 전용으로 연다(ADR-031 6) | 서비스는 권한·포트, PGlite는 단일 연결 | SQLite | 내장·서비스 PG 모두 AI 직접 읽기 경로가 깨진다 |
| 버전 이행·백업 | 백업·sha256 목록 구현. knowledge 스키마 세 벌, 백업은 엔진 정지 때만 | 메이저 업그레이드마다 pg_upgrade | SQLite | 옛 엔진은 새 DB를 거절(`migrations.ts:296`) |
| 장애 복구 | WAL 복구. 사본 교체는 -wal/-shm 삭제 뒤 rename 2단계 | 서비스·고아 postmaster | SQLite | 교체는 원자적이 아니고 열린 핸들이 있으면 실패할 수 있다(측정 필요) |
| 서버 공유·동시 편집 | D1(ADR-037), JSON 행 전송, LWW | RLS·행 잠금, 업체 이중화 | 현 요구는 SQLite+D1 | 전송은 엔진 중립. 동시 편집·행 권한이 요구되면 서버 PG |

## 5. 지오메트리와 데이터 연결

- **지금 있는 것:** 기록→객체는 `(linkId, 객체 id)` 복합 키(ADR-027), 요청 경유 changes, 부위 매핑 3종(layer·objects·jig-output). 도면 문자는 `handle·layer·x,y·layout`.
- **부족한 것:** 진술↔기록·부위·객체 연결 표, 위치(좌표계가 섞인 dwg_text, 객체 bbox 없음), 버전(어느 revision의 객체인지).
- **엔진:** 위 셋은 키와 연결 표의 문제라 두 엔진에서 같은 설계로 된다(RESEARCH-06 §3, ARCH-01:890).
- **공간 DB가 필요한 조건:** 면 교차·면적·간섭 같은 기하 연산을 DB 안, 특히 서버에서 해야 할 때. 점·bbox 검색은 R*Tree로 충분하다.

## 6. AI 문맥(RAG)으로 쓰려면

| 층 | 구성 | 필요한 것 |
|---|---|---|
| 키워드 | FTS(발췌+진술) + bigram 보조 | 진술 FTS, 2자 처리 |
| 의미 | 벡터 KNN | 임베딩 생성 경로(구독 CLI는 못 만든다: 로컬 모델 또는 API 키), 인덱스 |
| 그래프 이웃 | record_links·statement_issue·mail 스레드 깊이 ≤2 | 진술↔기록·Party 연결 표 |
| 결합 | RRF + VISIBLE 필터 + 확정 우선 | 평가 세트(정답 진술 id) |

| 엔진 | 구현 차이 |
|---|---|
| SQLite | FTS5 내장, sqlite-vec DLL을 설치본에 실어 로드. 벡터는 로컬 전용(D1 불가) |
| PostgreSQL | pg_trgm/pg_bigm + pgvector를 한곳에. 로컬이면 서비스나 PGlite(WASM), 서버면 모든 PC가 공유 |

## 7. 선택지와 뒤집히는 조건

**① SQLite 유지 + 보강.** 로컬은 지금 그대로, 공유는 D1. 진술 FTS·연결 표·스키마 통합·작업 스레드를 더한다. 뒤집힘: 교차 프로젝트 RAG가 일상, 벡터가 수백만 개, 무거운 작업의 정지가 해소되지 않을 때.

**② PostgreSQL 전환.** 로컬 서비스·내장(PGlite·embedded-postgres)·서버 셋. 로컬형은 AI 직접 읽기·설치·업그레이드 비용이 생긴다. 서버형은 오프라인 사본이 여전히 필요하다. 유리해지는 조건: 여러 사람이 같은 행을 동시에 고치고 LWW 손실이 기록될 때, 협력사별 행 권한이 PRD에서 확정될 때.

**③ 혼합.** 로컬은 SQLite, 서버 공용 원본만 PostgreSQL(Supabase 등). 서버 공간·벡터 검색과 RLS를 얻고 업체가 둘이 된다. ADR-037 변경이 필요하다. 조건: 서버 쪽 벡터·행 권한이 제품 요구가 될 때, D1 한도·업로드 시간이 넘칠 때.

## 8. 바로 할 수 있는 개선(측정 가능)

| 개선 | 기대 효과 | 측정 |
|---|---|---|
| RAG 평가 세트 50~100문(2자 질의 포함) | 모든 개선의 판단 기준 | recall@20·MRR 기준선 |
| 진술 FTS + bigram 그림자 열 | 2자 질의 재현율·속도 | 평가 세트, 2자 질의 p95 |
| 합성 벤치(발췌 10만·진술 100만·기록 1만·링크 10만) | 엔진 한계 실측 | project_search p95, chains(), 재귀 CTE |
| rebuild → 증분 FTS, 무거운 쓰기를 작업 스레드로 | 수집 중 엔진 응답성 | rebuild 대 증분 시간, 이벤트 루프 정지 ms |
| `run` 표에 단계별 DB 쓰기 ms | DB가 수집 시간에서 차지하는 몫 | 단계별 비율 |
| issues 단계 호출 묶기(F33) | 가장 큰 덩어리 단축 | 호출 수·초 |
| knowledge 스키마 세 벌을 하나로, 버전 이행+백업 | 스키마 어긋남 제거 | 옛 사본 열기 시 버전·백업 생성 |
| 사본 교체 전 연결 닫기·재시도, 강제 종료 시험 | 교체 실패·손상 방지 | VERIFY: 복구 시간·integrity_check |
| 일괄 수집 뒤 `PRAGMA optimize`, 업로드 전 `wal_checkpoint(TRUNCATE)` | 질의 계획·WAL 크기 | 전후 검색 지연, WAL 크기 |
| project/app `busy_timeout` 점검, knowledge `quick_check` 백업 | SQLITE_BUSY·손상 조기 발견 | BUSY 빈도, 121.9 MB 백업 시간 |
| D1 동기화 실측 | 공유 한도 판단 | 업로드 시간, 받기 1회 행 읽기 × PC 수, pack 크기 |
| 검토 덮어쓰기 기록, 서버 revision 기준 | LWW 손실을 보이게 | 충돌 빈도 |
| dwg_text 좌표계 열(model·paper·block) 뒤 R*Tree | 도면 위치 질의 | bbox 질의 대 전체 스캔 |
| 임베딩 경로 OQ, 그 뒤 sqlite-vec SPIKE(발췌·진술) | 벡터 효과 확인 | 생성 시간·DB 증가·질의 지연·recall 향상 |
