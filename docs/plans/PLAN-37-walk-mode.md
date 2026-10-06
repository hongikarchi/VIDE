---
id: PLAN-37
title: 걷기 모드 — 눈높이로 걸으며 보기 (T-170~T-174)
status: draft
version: 0.1
updated: 2026-10-06
owner: agent:claude
related: [SPEC-01, SPEC-04, ARCH-01, PLAN-26, PLAN-33, RESEARCH-15, FR-02, FR-03]
---

# 걷기 모드 — 눈높이로 걸으며 보기 (T-170~T-174)

근거: 2026-10-06 사용자 결정 "walk mode는 3단계까지 구현하고, 오른쪽 끌기로 하자. 그리고 걷는 중에 선택/핀 허용해주고, 계정 사이트 뷰어에도 넣자." 출처 조사는 [RESEARCH-15](../research/RESEARCH-15-s18-feature-harvest.md) M-24(S-18 3D 컨텍스트 뷰어의 걷기). 동작은 [SPEC-01](../specs/SPEC-01-project-input-sync.md).9의 4와 [SPEC-04](../specs/SPEC-04-web-review.md).2, 화면은 [Design](../../Design.md) §05 「탐색과 카메라 조작」과 SCR-06·SCR-21.

걷기는 도구가 아니라 **카메라 방식**이다. 선택 도구의 클릭·창 선택, 사이트의 탐색·핀은 걷는 중에도 그대로 동작하고, 스케치 도구는 걷기를 끝낸다. 원본·호스트에는 아무것도 쓰지 않고 카메라는 호스트와 동기화하지 않는다(SPEC-01.9).

## 공용 모듈 — `src/ui/walk-controls.ts`

작업 화면 뷰포트와 사이트의 두 뷰어가 같은 모듈을 쓴다. 모듈은 카메라 이동, 바닥·벽 질의, 걷기 막대·조이스틱(DOM)을 소유하고 호스트(뷰포트)는 진입·종료와 그리기만 맡는다.

| 단계 | 동작 | 구현 |
|---|---|---|
| 1 눈높이 이동 | 눈높이 1.6 m, WASD·↑↓ 이동, Q/E·←→ 회전, Shift 달리기(1.4 → 4.5 m/s), **오른쪽 끌기**(터치는 한 손가락) 둘러보기, 더블클릭·두 번 탭 그 자리로, 시야각 60°·near 0.05 m(나갈 때 복원) | `createWalk()` |
| 2 바닥 따라가기 | 발 아래 0.45 m 위에서 아래로 광선, 법선이 수직에 가까운(\|nz\| ≥ 0.6) 면에 선다. 오르막은 빠르게, 낭떠러지는 중력으로 떨어진다. 바닥이 없으면 높이를 유지 | `floorBelow`, `settle` |
| 3 계단·층·벽 | 0.45 m까지의 단은 올라선다. 벽(\|nz\| < 0.6)은 무릎·가슴 높이 광선으로 막고 벽면을 따라 미끄러진다(반경 0.3 m, 막대의 [벽 충돌]로 끄기). 층 이동은 PageUp/PageDown·[위층]·[아래층] — 그 자리의 바닥 가운데 위로 1.9 m 이상 비어 있는 것만 층으로 본다 | `slide`, `levels`, `changeFloor` |

광선은 걷는 사람 주변 12 m 안의 메시만 후보로 두고(4 m 움직이면 갱신), 메시마다 처음 쓸 때 BVH를 만든다(`three-mesh-bvh` 0.9.1, MIT, `indirect`로 메시 인덱스를 바꾸지 않음). 18,000객체 합성 장면에서 한 걸음 계산은 0.01 ms 미만(2026-10-06 측정, 아래 T-174).

## T-170 작업 화면 뷰포트

| 변경 | 위치 |
|---|---|
| `walk(on)`·`walking()`·`walkKey()`, 진입은 궤도 중심 아래 바닥에서 카메라가 보던 방향으로(직교 보기면 원근으로 바꿔), 나가면 걷던 자리에서 보던 곳을 중심으로 궤도 카메라. 3D/위/앞/옆·맞춤·투영·jig 초점·스케치 도구가 걷기를 끝냄. 카메라 보고 `view: 'walk'` | `src/ui/viewport.ts` |
| 터치 한 손가락 끌기는 둘러보기(창 선택 없음), 탭은 선택 | `src/ui/viewport.ts` |
| [걷기] 버튼(발자국 아이콘, 3D/위/앞/옆 아래), `viewportActions.walk` | `src/ui/shell/viewport-area.tsx`, `src/ui/shell/viewport-actions.ts`, `src/ui/app/viewport.ts`, `src/ui/icons.ts` |
| 단축키 `walkKeys`(순서 5): 이동 키·PageUp/PageDown·Esc를 선택 해제보다 먼저 | `src/ui/app/shortcuts.ts`, `src/ui/app/viewport.ts` |
| 막대·조이스틱 표현 | `src/ui/style.css` |

## T-171 바닥·T-172 계단·층·벽

공용 모듈의 2·3단계(위 표). 의존성 `three-mesh-bvh` 0.9.1 추가(`package.json`).

## T-173 계정 사이트 뷰어

| 변경 | 위치 |
|---|---|
| 게시 모델 카메라 도구에 [걷기]: 모델 중심에서 시작, 탐색(선택)·핀은 그대로, 스케치 중에는 카메라 도구와 함께 막힘, Esc·[나가기]는 원근으로 | `src/sharing/web/model.tsx` |
| PC 없이 보기의 저장된 모델에 [걷기](평면·3D 옆): 걷는 동안만 프레임마다 그린다 | `src/sharing/web/offline.tsx` |
| 막대·조이스틱 표현 | `src/sharing/web/style.css` |

## T-174 검증

- 브라우저(`tests/integration/browser-walk.mjs`): 합성 장면(바닥·x = 8 벽·0.18 m 단 10개 계단과 참·위층 슬래브)에서 바닥에 서기, 벽 앞 0.3 m에서 멈춤, 비스듬히 부딪히면 미끄러짐, [벽 충돌] 끄면 통과, 계단 올라 1.8 m 참, 참 끝에서 떨어짐, 위층 3.6 m·없는 위층 안내·아래층, 막대 버튼, 더블클릭 그 자리로(묶어 그린 객체 포함), 회전·달리기, 걷는 중 클릭 선택(`pickAt`), 나가기, 18,000객체 한 걸음 < 8 ms, 작업 화면 [걷기]·Esc·스케치 도구로 종료.
- 사이트(`tests/sharing/browser-walk.mjs`): vite로 `Model`만 띄운 합성 장면에서 [걷기] → 막대, 걷는 중 핀 모드 클릭이 선택·핀을 만듦, W 이동, Esc → 원근.
- 회귀: `npm run typecheck`, `npm run typecheck:sharing`, `npm run build:web`, `npm run build:sharing`, browser-viewport-display·pin-tokens·large-model.

**완료 판단:** 위 자동 검증 통과(2026-10-06). 남은 조건: iPad 원격 실기(조이스틱·한 손가락 둘러보기·두 번 탭), 실제 18,000객체 프로젝트에서 프레임 확인, PC 없이 보기 [걷기]의 브라우저 확인(이번에는 타입·빌드만), 사이트 배포(사용자 지시 뒤). 기존 `tests/sharing/browser.mjs`는 2026-09-24 이후 로그인 화면(이메일 → 아이디) 변경으로 이번 변경과 무관하게 로그인 단계에서 멈춘다.
