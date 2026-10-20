---
id: RESEARCH-19
title: DB 엔진(SQLite·PostgreSQL)·수집 시간·동시 편집 — 2026-10-20 사용자 메모
status: review
version: 0.2
updated: 2026-10-20
owner: agent:claude
related: [PLAN-42, PLAN-35, SPEC-08, SPEC-17, SPEC-18, ADR-018, ADR-032, ADR-037, RESEARCH-06]
---

# RESEARCH-19 — DB 엔진과 수집 시간

조사 사실과 대안 비교만 적는다. 결정은 사용자 몫이고 브리프 Q2로 묻는다.

## 1. 질문

- 6: 협의·텍스트·지오메트리·협의 주체가 오래 쌓일 때, AI가 RAG로 설계를 파악하고 지오메트리와 데이터를 잇는 데 SQLite와 PostgreSQL 중 무엇이 속도·정확성·유지관리에서 나은가.
- 7: 첫 DB 구축에서 어디가 가장 오래 걸리나. 검색·파싱도 LLM이 하나. Rust 같은 코드로 미리 처리할 수 있나.
- 3.2·3.3: 여러 사람이 웹에서 같은 기록을 동시에 계속 고치려면 무엇이 필요한가. PostgreSQL이 그 조건인가(§9).

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
| 서버 공유·동시 편집 | D1(ADR-037), JSON 행 전송, LWW | RLS·행 잠금, 업체 이중화 | §9(e) 참조 | 전송은 엔진 중립. 조건과 엔진 선택은 §9(c)·(e) |

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

**추천(v0.2): 서버 원본 + 푸시, 엔진은 측정·행 권한 결정 뒤.** 근거는 둘로 나뉜다. (1) 메모 3.3(동시 편집이 일상)이 요구하는 것은 엔진이 아니라 서버 원본과 푸시 층이다(§9(b)·(d)). (2) 엔진은 PostgreSQL만 주는 것 — DB 안 행 권한(RLS)·기록과 벡터를 한 질의로 JOIN(§9(c) 종합) — 이 제품 요구일 때만 ③을 고르고, 아니면 D1에 DO 푸시를 더한다. 3.3만으로는 ②·③의 조건(위 문장)이 충족되지 않는다. 협력사별 행 권한은 PRD에 아직 OQ가 없다(가장 가까운 것은 OQ-04 웹 접근 범위). 이행 순서는 §9(e), 서버 원본에 올릴 기록 모양은 §10.

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
| D1 동기화 실측 | 공유 한도 판단 | 업로드 시간, 받기 1회 행 읽기 × PC 수, pack 크기, 하루 쓰기 행 수, 200문 batch가 호출당 쿼리 한도(무료 50)에 어떻게 세이는지, 지금 플랜 |
| 검토 덮어쓰기 기록, 서버 revision 기준 | LWW 손실을 보이게 | 충돌 빈도 |
| dwg_text 좌표계 열(model·paper·block) 뒤 R*Tree | 도면 위치 질의 | bbox 질의 대 전체 스캔 |
| 임베딩 경로 OQ, 그 뒤 sqlite-vec SPIKE(발췌·진술) | 벡터 효과 확인 | 생성 시간·DB 증가·질의 지연·recall 향상 |
| 동시 편집 손실 실측(§9 1단계) | 서버 원본 이행 판단 | 덮어쓴 행 수·반영 지연 초 |
| 겹친 업로드 시험(두 PC begin) | 섞인 묶음 여부 | §9(a) 「동시 업로드」 행, commit 뒤 host_id별 행 수 |
| 협의 스레드 표 시안(§10) | 주간·월간 보기 질의 | 보고 질의 3개 결과 대조 |

## 9. 여러 사람이 동시에 고치려면 (메모 3.2·3.3)

### (a) 지금 공유 경로 (사실)

| 항목 | 지금 값 | 근거 |
|---|---|---|
| 서버 | Worker 하나 + D1·R2·DO | `src/sharing/wrangler.jsonc:4` |
| 자료 전송 단위 | 요청당 200행 | `knowledge-pack.ts:53` |
| 자료 반영 | commit 때 통째 교체 | `shared-layer.ts:377` |
| 동시 업로드 | 먼저 commit한 쪽 반영. begin이 겹치면 두 PC가 같은 revision을 받고 rows가 host_id를 확인하지 않아 두 PC의 행이 섞일 수 있음. 늦은 쪽만 rows·commit에서 409 | `shared-layer.ts:323-329`, `:344-345`, `:365-366`, `:377` |
| 판정·규칙 충돌 | 행 LWW(edited_at, 같으면 뒤 도착) | `shared-layer.ts:274`, `:301` |
| AI 지시 충돌 | revision 비교 + 충돌 사본 | `shared-layer.ts:80` |
| 시계 보정 | edited_at ≤ 서버 시각+60 s | `shared-layer.ts:41` |
| 방향 | PC가 당겨 옴(pull)만 | `shared-project.ts:528-534` |
| 하트비트 | 15 s | `remote-access.ts:18` |
| 공유 층 교환 | ≥120 s 간격(하트비트 15 s 뒤 확인) | `shared-project.ts:528-531` |
| 모델 스냅샷 | 링크별 ≥10분 | `offline-view.ts:30`, `:395` |
| 거른 기록 사본 | 기본 꺼짐. 켜면 지문 확인 ≤1회/분, 바뀌면 통째 교체 | `offline-view.ts:27-29`, `:508-516`, `summary.ts:775` |
| 사이트 할 일 수정 | 서버 대기열 → PC 하트비트 때 반영, 시간 LWW + 충돌 표시 | `summary.ts:417-485`, `offline-view.ts:19-22`, `:530-535` |
| 파일 작업 중 | 누가 어떤 서버 파일을 쓰는지 표시(PLAN-52) | `summary.ts:374-378` |
| D1 내용 | 지시·자료·판정·할 일과 대기열·이력 요약·기록 사본 | 위 행들 |
| 푸시(WebSocket) | 공유 노트(Yjs)만 | `src/sharing/note-room.ts:6` |
| 오프라인 큐 | outbox JSON, 다음 교환 때 | `shared-project.ts:354` |
| 인증 | 브라우저 세션 · PC Bearer | `worker.ts:143`, `hosts.ts:108` |
| 권한 | 멤버면 역할 무관 읽기·쓰기, 자료 업로드는 PC만(DEVICE_ONLY) | `shared-layer.ts:409`, `:319`, `projects.ts:12-22` |
| 로컬 쓰기 | §2 「쓰기 주체」 열(controller 잠금) | `src/core/store.ts:186` |

경로: `shared-layer.ts`·`worker.ts`·`hosts.ts`·`note-room.ts`·`summary.ts`·`projects.ts`는 `src/sharing/`, `shared-project.ts`·`remote-access.ts`·`offline-view.ts`는 `src/server/`, `knowledge-pack.ts`는 `src/contracts/`.

- 같은 판정 행을 두 사람이 고치면 각자 로컬에 바로 저장되고, 보낸 PC의 교환과 받는 PC의 교환이 모두 지난 뒤 edited_at이 늦은 한 사람 값만 남는다. 최악 약 2×(120+15) s ≈ 4.5분(추론, §8 「동시 편집 손실 실측」에서 측정 필요). 진 쪽에는 알림·충돌 사본이 없다: 받은 행은 로컬을 조용히 덮는다(`src/server/shared-project.ts:483-494`, `src/core/knowledge-review-store.ts:60`).
- 필드 단위 병합과 행 단위 실시간 협업 경로는 없다(§9(a) 「푸시」 행).

### (b) 실시간 공동 편집에 필요한 네 층 (엔진과 무관)

| 층 | 하는 일 | 지금 |
|---|---|---|
| 원본 서버 | 모두가 같은 행을 본다 | D1(§9(a) 「D1 내용」 행) |
| 변경 푸시 | 고친 즉시 열린 화면에 | 노트만(DO WebSocket) |
| 충돌 단위 | 아래 표 | 행 LWW |
| 오프라인 큐 | 끊겨도 쓰고 나중에 보냄 | outbox(판정·규칙) |
| 편집 잠금 | 한 사람만 고침 | 서버 파일 checkout 표시(`summary.ts:374`) |

| 충돌 단위 | 어울리는 기록 | 근거 |
|---|---|---|
| 행 LWW | 칸 적은 표, 손실 허용 | 현행 구현 `shared-layer.ts:274` |
| 필드 LWW + 진 값 보존 | 협의 대장 칸 | [Automerge][am] |
| CRDT 글 | 회의록·메모 | [Yjs][yjs] |
| 편집 잠금 | 결재·확정 항목 | [PG advisory lock][pg-adv] |

[am]: https://automerge.org/docs/reference/documents/conflicts/
[yjs]: https://docs.yjs.dev/
[pg-adv]: https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS

CRDT 문서는 바이너리로 저장하므로 DO·PG 어느 쪽에도 둘 수 있다([Yjs](https://docs.yjs.dev/)).

### (c) 서버 쪽 엔진 비교

| 기준 | PostgreSQL | D1 (+DO) | Supabase·Neon |
|---|---|---|---|
| 같은 행 동시 쓰기 | 행 잠금·격리·재시도 | 쿼리 하나씩, batch만 원자 | PG와 같음 |
| 변경 푸시 | LISTEN/NOTIFY(<8000 B) | 없음 → DO WebSocket | Realtime(Supabase) |
| 행 권한 | RLS(DB 안) | 없음 → Worker 코드 | RLS + auth.uid() |
| 벡터 | pgvector, 같은 DB JOIN | Vectorize 별도, JOIN 불가 | pgvector |
| 크기 | 디스크만큼 | DB 10 GB(유료) / 500 MB(무료) | 무료 500 MB(Supabase)·0.5 GB(Neon) |
| 쓰기 행/일 | 제한 없음 | 월 5천만 포함(유료) / 10만(무료) | 해당 없음 |
| 호출당 쿼리 | — | 1,000(유료) / 50(무료) | — |
| 백업 | WAL 아카이빙 직접 | Time Travel 30일(유료) / 7일(무료) | PITR: 무료는 Supabase 없음·Neon 6시간, 유료 7~30일 |
| 지금 플랜 | — | 측정 필요(코드 주석은 무료 전제: `wrangler.jsonc:27`, `note-room.ts:11`) | — |
| 로컬 개발 | 서비스 설치 | wrangler·Miniflare | Docker CLI |
| 지금 코드와 | 새로 붙임(Hyperdrive) | 이미 씀 | 새 업체 |

근거:

- PG: 행 잠금 [explicit-locking](https://www.postgresql.org/docs/current/explicit-locking.html), 재시도 [transaction-iso](https://www.postgresql.org/docs/current/transaction-iso.html), NOTIFY [sql-notify](https://www.postgresql.org/docs/current/sql-notify.html), RLS [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), 벡터 [pgvector](https://github.com/pgvector/pgvector), PITR [continuous-archiving](https://www.postgresql.org/docs/current/continuous-archiving.html).
- D1: 단일 스레드·크기·호출당 쿼리 [limits](https://developers.cloudflare.com/d1/platform/limits/), 쓰기 행 [pricing](https://developers.cloudflare.com/d1/platform/pricing/), batch [d1-database](https://developers.cloudflare.com/d1/worker-api/d1-database/), 쓰기는 주 인스턴스 하나 [read-replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), 푸시는 DO [websockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)(배포 때 연결 끊김), DO 트랜잭션 [storage-api](https://developers.cloudflare.com/durable-objects/api/storage-api/), 벡터 [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/), 백업 [time-travel](https://developers.cloudflare.com/d1/reference/time-travel/), 로컬 [local-development](https://developers.cloudflare.com/d1/best-practices/local-development/). 행 권한 기능이 없다는 것은 문서에 없다는 데서 나온 추론이다.
- 관리형: [Realtime](https://supabase.com/docs/guides/realtime)·[Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)(구독자마다 RLS 재검사, 단일 스레드), 요금 [Supabase](https://supabase.com/pricing)·[Neon](https://neon.com/pricing), [Neon RLS](https://neon.com/docs/guides/row-level-security), [Supabase 로컬](https://supabase.com/docs/guides/local-development).
- Worker→PG: [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) 가까우면 1~3 ms·멀면 20~30 ms, 쓰기 뒤 캐시 무효화 없음([how-hyperdrive-works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)). 그래서 기록 질의는 캐시를 꺼야 한다(추론).
- 종합: PG만의 몫은 DB 안 행 권한과 기록·벡터를 한 질의로 묻는 일이다. 동시 쓰기와 푸시는 D1+DO 코드로도 된다(위 근거의 종합). 업로드가 매번 전체 행을 다시 쓰므로(§9(a) 「자료 반영」) 동시 편집이 일상이 되면 D1에서 먼저 걸리는 것은 크기보다 하루 쓰기 행 수다(추론, §8 「D1 동기화 실측」).

### (d) PostgreSQL로 하면 웹에서 실시간으로 고칠 수 있나

된다. 다만 조건은 PostgreSQL이 아니라 **모두가 쓰는 서버 원본과 고친 즉시 밀어 주는 푸시 층**이다(지금 푸시: §9(a) 「푸시」 행). VIDE 화면은 이미 브라우저 UI라 서버에 올린 웹 화면으로도 열 수 있지만, Rhino·CAD 객체와 잇는 호스트 브리지는 각 PC에 남는다(웹 화면에서 쓸 수 있는 장 범위는 측정 필요).

### (e) 추천이 바뀌는 방식

- **추천(§7):** 서버가 기록·협의 원본이 되고 각 PC의 SQLite는 읽기 캐시·오프라인 큐·지오메트리 연결·AI 직접 읽기를 맡는다(§4 「설치·AI 직접 읽기」 행). 서버 엔진은 1단계 측정과 행 권한 결정 뒤 고른다: 행 권한·벡터 JOIN이 요구되면 PostgreSQL(§7 ③), 아니면 D1+DO(대가는 행 권한 검사를 Worker가 모두 맡고 벡터가 따로 놓이는 것, §9(c)).
- **①이 남는 조건:** 한 사람·한 PC가 쓰고 나머지는 보기만 할 때, 또는 1단계 실측에서 덮어쓴 행이 거의 없을 때.
- **브리프 Q2 대응:** ① 서버 원본 + 푸시 = 위 추천(엔진 미정) · ② 서버 PostgreSQL 바로 = §7 ③ · ③ 지금대로 = §7 ①.

이행 3단계:

1. **측정:** 지금 LWW에서 덮어쓴 행 수와 반영 지연을 기록한다(§8 「검토 덮어쓰기 기록」 행).
2. **서버 원본 스키마:** 엔진을 고르고 §10 엔티티를 서버 표로 만든다. PC는 받아 쓰는 캐시가 된다.
3. **푸시:** 프로젝트마다 변경 채널(NOTIFY·Realtime 또는 DO)을 열고 필드 LWW + 진 값 보존을 붙인다.

## 10. 기록의 실제 모양 (사용자 PDF 3장)

원문·실명은 옮기지 않고 구조만 적는다.

### 익명 구조

| 문서 | 꼴 | 묶음 |
|---|---|---|
| 협의 대장 | A3 표, 약 196행, 7개월 | 행 = 협의 한 건 |
| 월간 업무 | 월 1쪽 | 요약·금월·익월·이슈 |
| 주간 업무 | 주 1쪽 | 요약·금주·차주·이슈 |

| 협의 대장 열 | 값 모양 |
|---|---|
| 순번·분류 | 분류 어휘 약 10개 |
| 주체별 할 일 | 7칸(자사·구조·발주·토목·파사드·설비·기타) |
| 송부일·보낸 내용 | 날짜(범위 있음) + 글 |
| 수신일·받은 내용 | 날짜 + 글 |
| 첨부 | pdf·dwg·3dm·zip·mp4 여러 개 |
| 주요 이슈·결과 | 한 줄 |
| 강조 | 인허가·심의 행 |

| 보고 표 | 열 |
|---|---|
| 금월·금주 | 구분·내용(날짜 줄)·협력사·진행 |
| 익월·차주 | 구분·내용·협력사·비고 |
| 이슈 | 구분·내용·대응(→ 다음 행동) |

분류 빈도: 자료 송부 32·계약 30·구조 협의 27·기타 20·일정 20·회의·보고 17·심의·자문 17·도면 12·검토 요청 2. 진행 값: 월간 진행 18·완료 5·계약 대기 1·대기 1, 주간 진행·검토 중·예정. 기본 단위는 협의 스레드 한 행이고, 주간·월간 보고는 같은 행을 기간·구분으로 묶은 보기다.

### 엔티티 제안

| 엔티티 | 열 | 비고 |
|---|---|---|
| Party | id·role·name·aliases[]·active | role 7(아래) |
| Thread | seq·category·workstream·parties[]·status | parties = {partyId, task}, workstream = 보고 구분 |
| Thread | result·nextAction·nextOn | 결과·대응·예정일 |
| Thread | flagged·partIds[] | flagged = 인허가·심의 |
| Thread | openedOn·closedOn | 열림·닫힘 날짜 |
| Exchange | threadId·direction·partyId | direction = out·in |
| Exchange | sentOn·sentOnEnd·body | sentOnEnd = 날짜 범위 끝 |
| Exchange | channel·recordId | recordId → records |
| Attachment | exchangeId·path·kind·sha256 | path = 작업 폴더 상대 |
| Attachment | size·sourceId | sourceId → knowledge.source |
| ReportView | kind·period·groupBy=workstream | 저장 안 하는 질의 |
| ReportView | recipient·author·summary[] | 보고 머리·요약 줄 |

- role: own·structure·client·civil·facade·mep·other.
- category: send-docs·contract·structure·schedule·meeting·review-board·drawing·review-request·permit·other. 협의 대장의 「분류」 축이다.
- workstream: 보고의 「구분」 축(견적·계약, 구조·유수지 같은 업무 갈래). 자유 어휘 + 별칭이고 category와 다른 열이다.
- status: ongoing·done·contract-wait·waiting·reviewing·planned. 협의 대장의 열림·답함은 저장하지 않고 Exchange에서 끌어낸다: 미답 = 마지막 Exchange가 out이고 그 뒤 in 없음, 답함 = 마지막이 in이고 status≠done.
- ReportView를 저장한다면 이름+질의 문자열은 `table_views`(`src/core/migrations.ts:31`)에, 머리 값(recipient·author·summary)은 보고 한 회분마다 따로 둔다(자리는 측정 뒤 결정).

### 지금 표와의 대응

| 지금 | 제안 | 대응 | 근거 |
|---|---|---|---|
| records.text | Exchange.body | 있음 | `migrations.ts:249` |
| records.source(12종) | Exchange.channel | 있음 | `records.ts:24-37` |
| record_parts | Thread.partIds | 있음(위로 모음) | `migrations.ts:256-257` |
| knowledge attachment | Attachment | knowledge 안만 | `schema.ts:30-31` |
| records.date·time | Exchange.on | 범위 끝 없음 | `migrations.ts:247-252` |
| records.chapter | Thread.category | 자유 글, 어휘 없음 | `records.ts:58` |
| attachments.file | Attachment[] | 한 개, 종류·해시 없음 | `records.ts:83-89` |
| attachments.mail.from | Exchange.partyId | 문자열만 | `records.ts:90-97` |
| record_links | 답신·스레드 묶기 | 방향·스레드 없음 | `migrations.ts:258-259` |
| mail inReplyTo·refs | Exchange 답신 연결 | 있음(메일만) | `records.ts:94`, `schema.ts:28` |
| episode(day·counterpart) | Thread 후보(날짜·상대) | 묶음만, 분류·상태 없음 | `schema.ts:22` |
| party_alias | Party.aliases | 역할 없음·0행 | `schema.ts:41`, §2 |
| statement.party·said_on | Exchange.partyId·on | 방향·스레드 없음 | `schema.ts:37-39` |
| issue | Thread·이슈 절 | status 열 있음·어휘 없음, 대응·주체 없음 | `schema.ts:42-43` |
| mail.thread·from_addr | direction·threadId | 자사 주소 비교 필요 | `schema.ts:28-29` |
| parts.roleFrom·roleTo | Party.role | 문자열, 참조 아님 | `migrations.ts:261-263` |
| milestones·agenda_items | 예정·기간 | Thread 연결 없음 | `migrations.ts:264-265` |
| records.state·type | — | 별개 축(검토·앎) | `records.ts:9`, `:19` |

추가 근거: chapter 열 `migrations.ts:250`, agenda_items `migrations.ts:124-129`.

경로: `migrations.ts`는 `src/core/`, `records.ts`는 `src/contracts/`, `schema.ts`는 `src/knowledge/collect/`.

빈 곳: Party 표 · 보냄/받음 방향 · Exchange↔첨부 여러 개 · 진행 상태 어휘 · Thread 자체(`src/core/migrations.ts:247-265`, `src/knowledge/collect/schema.ts:12-49`).

### 보고 질의 모양

| 절 | 거름 | 묶음·열 |
|---|---|---|
| 금월·금주 | Exchange 날짜가 기간과 겹침 | workstream별 날짜+내용·진행 |
| 익월·차주 | status≠done, nextOn 다음 기간 | workstream·nextAction·협력사 |
| 익월·차주 | agenda_items 다음 기간 | 일정 행 |
| 이슈 | flagged 또는 대기류 | result·→ nextAction |

```sql
-- 금월·금주. 집계: PostgreSQL string_agg(…, E'\n') / SQLite group_concat(…, char(10))
SELECT t.workstream, string_agg(e.sentOn || ' ' || e.body, E'\n'), p.name, t.status
FROM exchange e
JOIN thread t ON t.id = e.threadId
JOIN party p ON p.id = e.partyId
WHERE e.sentOn <= :to AND coalesce(e.sentOnEnd, e.sentOn) >= :from
GROUP BY t.workstream, t.id, p.name, t.status
ORDER BY t.workstream, min(e.sentOn);
```

- 표·외래키·날짜 범위·GROUP BY만 쓰므로 두 엔진에서 같은 표·키 설계이고, 집계 함수 이름과 줄바꿈 구분자만 다르다. ReportView는 질의라 옮길 데이터가 없다.
- 엔진 차이는 §9(c)의 두 가지다: 열린 주간·월간 보기에 변경을 바로 밀어 주는 일, 협력사 Party에게 자기 행만 보여 주는 행 권한.
