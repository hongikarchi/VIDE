---
id: ADR-043
title: 사용자 자신의 GitHub·Cloudflare 계정을 VIDE에 연결하되, 푸시·게시는 사람이 누를 때만 하고 기본 공유 경로는 VIDE 공유 사이트로 둔다
status: review
version: 0.1
updated: 2026-10-15
owner: user
related: [C-11, FR-18, FR-14, ADR-040, ADR-042, ADR-037, ADR-039, SPEC-05, SPEC-07, SPEC-13, ARCH-01, PLAN-52, PLAN-54, RESEARCH-17]
---

# 사용자 계정 서비스 — GitHub·Cloudflare

## 맥락

- 2026-10-15 사용자 결정([RESEARCH-17](../research/RESEARCH-17-workspace-and-records.md) §6): 외부 계정은 **GitHub·Cloudflare 둘 다 1차**다. 용도는 둘이다 — 작업 폴더의 이력·재현(GitHub), 보고용 산출물을 본인 계정에 비밀번호와 함께 게시(Cloudflare, 논현동 164의 `cloudflare-deploy`가 이미 하던 일).
- [ADR-040](ADR-040-domain-services.md)은 VIDE가 **연결하는 도메인 서비스**(cLAWde 등, VIDE 계정으로 토큰을 받음)를 다룬다. 사용자가 **자기 계정**으로 쓰는 범용 서비스는 다루지 않으므로 결정이 하나 더 필요했다. [ADR-042](ADR-042-workspace-folders.md)는 "GitHub은 네 번째 저장소가 아니라 폴더의 이력"이라고만 정했다.
- 이미 있는 틀: 설정 → '외부 서비스'(SPEC-13.11), `service-settings.json` + DPAPI 봉인(`src/services/secrets.ts`), 공유 사이트의 게시·R2 저장소(SPEC-04.1·04.9, ADR-035 — 비밀번호 링크는 이 결정으로 신설하는 VIDE 공유 사이트의 보고용 게시(SPEC-04.14)), 공공 자료 키의 '값은 보이지 않고 있음/없음만' 규칙.

## 결정

1. **사용자 계정 서비스는 도메인 서비스와 다른 종류다.** VIDE 계정으로 토큰을 받지 않고, 사용자가 자기 계정에서 만든 토큰을 이 PC에 넣는다. VIDE는 그 계정을 소유·공유·대리하지 않는다. 의미는 SPEC-05.11, 물리 형식은 ARCH-01 「외부 도메인 서비스」의 설정·비밀 항이 소유한다.
2. **둘 다 1차다.** GitHub(개인 접근 토큰)과 Cloudflare(API 토큰 + 계정 ID). 저장은 cLAWde 토큰과 같은 봉인 저장소, 화면은 상태와 마지막 확인 시각만, 진단 묶음·로그·업로드 제외.
3. **보고용 공유의 기본은 VIDE 공유 사이트다.** [공유]는 먼저 VIDE 공유 사이트의 보고용 게시(SPEC-04.14)로 비밀번호 링크를 만들고, 본인 Cloudflare 게시는 계정을 연결한 사람에게만 보이는 선택이다. 올리는 것은 보고용(SPEC-07.11)뿐이며 검토용은 어느 경로로도 올리지 않는다.
4. **GitHub은 폴더의 이력이다(ADR-042 5).** 로컬 작업 폴더에만 git을 두고 원격 만들기·푸시·가져오기를 VIDE가 대신 누른다. 회사 서버 연결 폴더에는 git을 만들지 않는다. 충돌은 VIDE가 풀지 않고 멈춘다.
5. **푸시·게시·내리기는 사람이 누를 때만 한다(FR-18).** 대화의 AI는 이 동작을 부르지 못한다. 요청 안에서 "올려 줘"가 나오면 안내만 한다.
6. **토큰 범위는 용도에 맞게 최소로 요구한다.** GitHub은 저장소 읽기·쓰기(필요하면 저장소 만들기), Cloudflare는 Workers 스크립트·자산·비밀 쓰기와 토큰 확인. 범위가 모자라면 무엇이 모자란지 보이고 저장은 한다.
7. **배포 방식.** VIDE 내장 게시 템플릿(비밀번호 확인 Worker + 정적 자산)을 Cloudflare API로 올리고 wrangler를 동봉하지 않는다. API만으로 되는지는 PLAN-54 T-347 SPIKE가 확인하며, 안 되면 이 항을 다시 정한다.

## 대안과 기각 이유

| 대안 | 기각 이유 |
|---|---|
| VIDE 계정으로 GitHub·Cloudflare 토큰을 중계(도메인 서비스와 같은 길) | VIDE가 사용자의 외부 계정을 대리하게 되어 책임과 범위가 커진다. 사용자 결정은 "본인 계정으로". |
| OAuth device flow | 편하지만 VIDE 쪽 OAuth 앱 등록·갱신 관리가 필요하다. 1차는 토큰 붙여넣기, device flow는 2차 후보. |
| Cloudflare만 1차(GitHub은 뒤로) | 사용자가 둘 다 1차로 정했고, GitHub 없이는 폴더 재현(ADR-042)의 다른 PC 경로가 없다. |
| 본인 Cloudflare를 기본 공유 경로로 | 계정이 없는 팀원·발주처도 받아야 하므로 기본은 VIDE 공유 사이트, 본인 계정은 선택. |
| wrangler 동봉 배포 | 설치본 크기와 Node 도구 체인 의존이 커진다. API 직접 호출을 먼저 시험한다(SPIKE). |
| 팀 공유 토큰(조직 계정) | 누가 올렸는지 흐려지고 토큰 회수가 어렵다. 1차 밖. |

## 결과

- **SPEC:** SPEC-05.11(외부 서비스 계정 — 의미·권한·실패), SPEC-07.11 두 등급 항의 '공유 경로는 둘' 문장, SPEC-13.11은 cLAWde 칸으로 그대로.
- **ARCH:** ARCH-01 「외부 도메인 서비스」 설정·비밀 항에 `github`·`cloudflare` 필드, 봉인 키, 확인 끝점, 게시 템플릿 위치, `publish.json`; 「데이터 위치」 PC 설정·키 행에 봉인 저장소 명시.
- **PLAN:** [PLAN-54](../plans/PLAN-54-outputs-accounts-proposals.md) 2부 T-344~T-347(설정·봉인, GitHub 용도, Cloudflare 배포 SPIKE), 1부 T-343의 [공유] 기본 경로. GitHub 훅 지점은 [PLAN-52](../plans/PLAN-52-workspace-folders.md) T-314.
- **PRD:** §4.4 C-11이 이 결정을 가리킨다. §14.2 범위 태그는 PRD가 정한다.
- ADR-040 「결과」에 이 문서를 역링크한다.

## 미결

- 보고용 비밀번호의 수명(링크당 고정 vs 만료): 1차는 고정 + 사람이 바꿈(PLAN-54 「결정이 필요한 질문」).
- Cloudflare API만으로 Worker + 정적 자산 배포가 되는지(T-347 SPIKE). 안 되면 7항을 다시 정한다.
- device flow 도입 시점.
