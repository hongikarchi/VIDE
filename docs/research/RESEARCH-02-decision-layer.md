---
id: RESEARCH-02
title: 판정 계층 조사 — Jev와 대안의 VIDE 적용 가능성
status: review
version: 0.3
updated: 2026-09-29
owner: agent:claude
related: [PLAN, PLAN-02, PLAN-05, ARCH-01, SPEC-02, FR-08, FR-18, OQ-04, RESEARCH-04, RESEARCH-06, RESEARCH-07]
---

# 판정 계층 조사 — Jev와 대안의 VIDE 적용 가능성

PLAN §9.4(코드와 LLM 사이의 판정 계층)의 조사 문서다. 2026-09-24에 웹 공개 자료를 조사했으며 Jev는 2026-09-15 공개라 모든 수치는 출시 9일 시점 기준이다. 실측·실험은 하지 않았고 벤더 주장·3자 출처·상충 사항을 본문에 구분해 표시했다. 구현 계획과 TDD는 이 문서의 마지막 절 "PLAN·TDD 착수 전 확인 목록"을 해소한 뒤 PLAN §9.4의 시점 조건(전환과 PLAN-02 1~2단계 완료 후)에 따라 세운다. Jev는 구현 수단이며 PRD·SPEC에 이름을 올리지 않는다(PLAN §9.4).

TypeSafe AI의 Jev(System One model, 2026-09-15 스텔스 공개)는 상태(state)와 타입이 정해진 질문(Choice/Score/Noul)을 입력받아 확률·신뢰도가 붙은 답을 한 번의 병렬 패스로 반환하는 비생성 판정 전용 모델로, 70–500ms·$0.042/M 입력 토큰이라는 벤더 주장 수치대로라면 VIDE의 "코드와 LLM 사이 판정 계층"에 구조적으로 정확히 들어맞는다([TypeSafe AI docs](https://docs.typesafe.ai/introduction), [TypeSafe AI blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). 그러나 벤더 자신의 4개 워크플로 벤치마크에서조차 정확도는 **67.8%**로 중위권 LLM(GPT-5.6 Terra 67.9%)과 사실상 동률이고 상위 모델(Claude Opus 5 73.1%)에는 못 미치며, "환각 없음"은 스키마 유효성만 보장할 뿐 판단의 정오는 보장하지 않는다는 것이 벤더 자신과 모든 독립 논평자의 공통된 해석이다([BenchLM.ai](https://benchlm.ai/blog/posts/what-is-jev), [KDnuggets](https://www.kdnuggets.com/what-everyone-is-getting-wrong-about-typesafe-ais-jev)). 출시 9일 시점에 대규모 독립 검증은 전무하고, 유일한 한국어 전용 독립 테스트는 동일 입력에 대한 답변 불안정("flip rate") **13%(범위 8–21%)**를 보고했다(기준 flip rate 1–2%) — VIDE가 한국어 입력을 다룬다는 점에서 가장 직접적인 경고 신호다([GitHub: mahlernim/jev-korean-benchmark](https://github.com/mahlernim/jev-korean-benchmark)). 여기에 SLA 미공개, ZDR(영구 미보관) 여부가 1차 출처와 3자 출처 간 상충, PIPA 국외이전 별도 동의 요건까지 겹쳐, 결론적으로 지금 시점에서는 Jev를 판정 계층의 기본/단독 백엔드로 채택하기보다 판정 계층 인터페이스를 벤더 중립적으로 설계하고 코드 규칙·소형 한국어 인코더를 우선 경로로 삼은 뒤 Jev는 섀도 모드로 별도 검증하는 편이 근거에 부합한다.

## Jev는 무엇이고 무엇을 못 하는가 — 판정 전용, 텍스트 생성 불가

Jev는 `state`(문자열 또는 구조화 데이터)와 이름 붙은 타입 질문 맵을 입력받아 `POST https://api.typesafe.ai/v1/systemone`로 호출하며, 질문 타입은 세 가지뿐이다: **Choice**(최대 255개 옵션 중 선택, 확률분포+신뢰도 반환), **Score**(2–10단계 순서형 루브릭 평가), **Noul**(예/아니오, 0.0–1.0 확률)([TypeSafe AI docs API reference](https://docs.typesafe.ai/api)). 총 컨텍스트는 64,000토큰이며 그중 state+최장 질문은 32,000토큰 예산 안에 들어야 한다는 수치는 벤더 1차 문서가 아닌 3자 애그리게이터에서만 확인되어 교차검증이 안 된 상태다([systemonemodels.org](https://systemonemodels.org/models/jev/)). 순위/다중라벨 같은 복합 판단 타입은 별도로 존재하지 않고 "원자적 질문을 코드에서 조합하라"는 것이 벤더의 설계 지침이다([TypeSafe AI docs](https://docs.typesafe.ai/introduction)). 가격은 입력 $0.042/M 토큰, 출력 토큰은 무료이며, 벤더 스스로 이 가격이 "지속 가능함을 증명할 수 없다"고 인정한다([TypeSafe AI blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev); [flaviocopes.com이 중계한 벤더 블로그](https://flaviocopes.com/jev/)). 접근은 대기자 명단 기반 얼리 액세스이고, 현재까지 발표된 모델 버전은 `jev-1.13.0` 하나뿐이며 모델 changelog 자체가 없다 — `jev-latest`가 조용히 새 버전으로 이동할 수 있다는 뜻이다([systemonemodels.org, 2026-09-20 확인](https://systemonemodels.org/models/jev/)). 벤더가 직접 문서화한 아홉 가지 "jaggedness"(취약점) 목록이 핵심이다: 문자 그대로 읽기(의도가 아닌 문구 그대로 해석), 수치·개수 계산 부정확, 날짜/시간을 순서량이 아닌 텍스트로 처리, 다중 부정·간접화 취약, 관련 없는 긴 컨텍스트에서 정확도 저하(distractor 효과), **적대적 콘텐츠를 기본적으로 의심하지 않음**(프롬프트 주입 방어 없음), 상충하는 지시/기준 처리 실패, 개별 질문 간 확률 합이 1.0을 보장하지 않음, 텍스트 생성 불가 — 이 중 여섯째 항목(적대적 콘텐츠 무방비)은 VIDE가 Jev를 "주입 의심" 판정에 쓰려는 계획과 정면으로 충돌한다([docs.typesafe.ai/model-jaggedness/jev-1.13, RedHub AI가 재확인](https://blog.redhub.ai/jev-ai-limits)).

## "환각 없음"은 스키마 유효성일 뿐, 정확도는 벤더 벤치마크에서도 미들급

TypeSafe의 핵심 마케팅 문구 "수학적으로 환각·타입 오류를 낼 수 없다"는 구조적 사실이지만, 이는 "닫힌 옵션 집합 밖의 값을 낼 수 없다"는 뜻이지 "정답을 맞힌다"는 뜻이 아니다 — KDnuggets의 표현을 빌리면 "Legal이 유효 옵션이 아니면 절대 Legal을 반환하지 않지만, 정답이 Technical인데 Billing을 골라도 그것은 여전히 스키마상 유효하다"([KDnuggets](https://www.kdnuggets.com/what-everyone-is-getting-wrong-about-typesafe-ais-jev)). 벤더 자체 4-워크플로(보안 사고 대응, 에이전트 추적 관찰, 송장 처리, 고객 서비스) 벤치마크 결과는 아래와 같다.

| 모델 | 정확도 | 케이스당 비용 | 지연 |
|---|---|---|---|
| Jev | 67.8% | $0.0004 | 0.4s |
| GPT-5.6 Terra | 67.9% | $0.0304 | 10.1s |
| GPT-5.6 Sol | 74.1% | $0.0836 | 23.3s |
| Claude Opus 5 | 73.1% | $0.1761 | 37.8s |

([BenchLM.ai](https://benchlm.ai/blog/posts/what-is-jev))

여기서 "정확도"는 사람이 검증한 정답이 아니라 **GPT-6 Astra와 Anthropic Fable(5.1)의 평균 답변에 대한 일치율**로 정의된다([Kingy AI](https://kingy.ai/blog/typesafe-jev-review-the-ai-model-that-doesnt-generate-text/)). 즉 "68% 정확"은 "68% 확률로 다른 두 LLM의 평균과 일치"라는, 훨씬 약한 주장이다. 독립(에 가까운) 테스트들은 서로 모순된다: buildfastwithai의 108개 라벨 클레임 테스트에서는 Jev 96.3%가 Gemini 3.1 Flash Lite(94.4%)·Claude Haiku 4.5(93.5%)를 앞섰지만 저자 스스로 "단일 소규모 평가"라 경고했고([buildfastwithai.com](https://blog.buildfastwithai.com/jev-ai-review)), 반대로 경쟁 오픈소스 인코더 openJev-verdict-2.0(1.496억 파라미터 ModernBERT 기반)은 자체 데이터셋에서 Jev(72.70%)를 Laya(76.60%)·자사 모델(77.10%)보다 낮게, Brier score도 Jev 0.1480 대 자사 0.0636으로 훨씬 나쁘게 보고했다(단, 경쟁사 자체 발표 수치로 중립성 없음)([GitHub: Heman10x-NGU/openJev-verdict-2.0](https://github.com/Heman10x-NGU/openJev-verdict-2.0)). 피싱 탐지 과제에서는 단순 정규식 베이스라인이 91.8%, Jev 출력 신호 5개를 로지스틱 회귀로 앙상블한 것이 95.0%로, **Jev 원출력 단독보다 경량 앙상블이 더 나은 사례**도 확인됐다([XenoSpectrum](https://xenospectrum.com/en/jev-typesafe-bert-classifier-decomposition/)). Hacker News 런칭 스레드(~1,800점, ~480댓글)에서는 한 참가자가 오픈웨이트 모델로 약 2시간 만에 핵심 기능을 재현했다고 주장하며 아키텍처의 신규성에 의문을 제기했고, 다른 참가자는 "BERT류이지만 최신 LLM 수준의 데이터·연산·학습 레시피를 쓴 것"이라 정리했다([Hacker News #49717558](https://news.ycombinator.com/item?id=49717558)). 가장 심각한 미해결 사항은 **캘리브레이션 곡선(ECE)이 전혀 공개되지 않았다**는 점으로, RLCD(Reinforcement Learning for Calibrated Decisions)라는 학습 기법명 자체가 캘리브레이션을 핵심으로 내세우는데도 신뢰도 다이어그램이 없다는 지적이 반복된다([RedHub AI](https://blog.redhub.ai/jev-ai-limits)). 한국어 관련 유일한 독립 데이터는 GitHub `mahlernim/jev-korean-benchmark`로, Belebele·PAWS-X·KorMedMCQA 각 100문항에 대해 정확도는 보고되지 않았으나 **동일 입력 재질의 시 답이 바뀌는 flip rate가 13%(범위 8–21%)**로 기준선(1–2%)의 약 한 자릿수 위였다([GitHub: mahlernim/jev-korean-benchmark](https://github.com/mahlernim/jev-korean-benchmark)). TypeSafe 자체도 영어가 주 학습 언어이며 CJK를 포함한 타 언어는 "지원되지만 동등한 정확도는 보장되지 않는다"고 검색 결과를 통해서만 확인되었고(1차 문서 직접 인용은 실패), 실사용 데이터로 검증하라고 권고한다([검색 종합, docs.typesafe.ai/models 등 인용](https://www.datacamp.com/blog/system-one-models-jev)).

## 판정 계층 설계 패턴 — 난이도 라우팅부터 주입 탐지까지, 공통점은 "에스컬레이션을 기본 설계로"

VIDE가 요구하는 다섯 가지 판정 기능(난이도 라우팅, 문맥 선별, 즉시 되묻기, 개입 관련성, 주입 의심) 각각에 대해 성숙도가 크게 다른 선행 연구가 존재한다. **난이도 라우팅**은 가장 근거가 탄탄한 영역으로, RouteLLM은 Chatbot Arena 인간 선호 데이터에 LLM 심판이 생성한 합성 라벨을 보강해 학습한 매트릭스 인수분해/BERT/인과 LLM 분류기로 MT-Bench에서 85% 이상, MMLU 45%, GSM8K 35% 비용 절감을 GPT-4 품질의 95% 유지하며 달성했다([RouteLLM/LMSYS blog](https://www.lmsys.org/blog/2024-07-01-routellm/), [arXiv:2406.18665](https://arxiv.org/pdf/2406.18665)). FrugalGPT의 캐스케이드(저가 모델 우선 시도 후 신뢰도 낮으면 상위 모델로 승격)는 최대 98% 비용 절감을 보고한다([arXiv:2305.05176](https://arxiv.org/abs/2305.05176)). OpenRouter의 Auto Router는 2단계 설계 — 약 30개 세분화 작업 유형 분류 후 "커뮤니티 지출 점유율(Share of Spend)"로 모델을 고르는 방식으로, 정확도가 아닌 시장 행태 기반이라 CAD 도메인 전이 가능성은 낮다([OpenRouter blog](https://openrouter.ai/blog/announcements/introducing-the-new-auto-router/)). 다만 2026년 논문 "The Routing Plateau"는 어떤 라우터 아키텍처도 근접 완벽한 정확도에 도달하지 못한다는 점을 지적하며, 오분류 복구(에스컬레이션)를 예외가 아닌 필수 설계 요소로 만들어야 한다고 시사한다([arXiv:2606.07587](https://arxiv.org/pdf/2606.07587), 요약만 확인). LangChain은 실제로 Jev 기반 `TypeSafeClassifier`로 모델 라우팅과 위험 도구 호출을 사전 차단하는 `AutoModeMiddleware`를 시연했으나, 구체적 지연·정확도·임계값 튜닝 수치는 제시하지 않았다([LangChain blog](https://www.langchain.com/blog/building-a-harness-with-jev)).

**문맥 선별**에서는 크로스인코더 재순위화기가 top-K=50 기준 GPU에서 100ms 이하로 동작하는 반면([DEV.to](https://dev.to/gabrielanhaia/reranker-selection-cross-encoder-vs-llm-as-reranker-vs-colbert-which-earns-its-latency-2h7o)), LLM 기반 재순위화는 4–6초, 쿼리당 $0.01–0.03가 추가되지만 일부 리스트형 과제에서 5–8% 높은 정확도를 보인다 — 다만 도메인 튜닝된 크로스인코더가 파라미터 37배 적은 규모로 4B LLM 재순위화기를 이긴 사례도 있다([DEV.to](https://dev.to/gabrielanhaia/reranker-selection-cross-encoder-vs-llm-as-reranker-vs-colbert-which-earns-its-latency-2h7o)). **즉시 되묻기(clarification gating)**는 슬롯 채우기 아키텍처가 표준으로, 필수 슬롯이 비었거나 모호할 때만 되묻고 여러 누락 슬롯을 한 턴에 묶어 질문하며 "그냥 진행" 오버라이드를 제공하는 패턴이 문서화되어 있다([AWARE-US, arXiv:2601.02643](https://arxiv.org/pdf/2601.02643); [AnythingLLM docs](https://docs.anythingllm.com/features/agent-surveys)). **개입 관련성 판정**은 다섯 기능 중 가장 근거가 빈약한 영역으로, 전환 인지형 대화 연구는 성공적인 복구의 **34%만 원래 의도로 복귀**하고 대부분은 같은 모드 안에서 새 의도를 시작한다는 점을 보여 — "동일 의도 여부"가 아니라 "동일 작업 범위 여부"로 프레이밍해야 함을 시사하지만, 에이전트 도구 사용 맥락에서 이 정확한 분류기를 벤치마크한 문헌은 존재하지 않는다([arXiv:2511.08835](https://arxiv.org/pdf/2511.08835)). **주입 의심 판정**에 대해서는 OWASP LLM Top 10이 프롬프트 주입 탐지기를 심층 방어의 한 층으로만 쓰고 결코 단독 통제 수단으로 쓰지 말라고 명시하며, Meta의 Prompt Guard 2도 벤치마크에 따라 오탐률 4.4%에서 위양성 52.5%까지 큰 편차를 보이고, LLM 기반 2차 스캐너 Rebuff는 스캐너 자체를 겨냥한 주입에 취약함이 확인됐다([OWASP 요약, Mend.io](https://www.mend.io/blog/2025-owasp-top-10-for-llm-applications-a-quick-guide/); [Rebuff 취약점](https://qaskills.sh/blog/rebuff-prompt-injection-testing-guide)). Jev처럼 닫힌 스키마만 반환하는 비생성 모델이 이 특정 회피 유형에 구조적으로 더 강할 수 있다는 것은 논리적 추론일 뿐, 어떤 소스도 Jev를 주입 공격으로 실제 테스트하지 않았다. 마지막으로 **캘리브레이션 엔지니어링**은 선택적 예측(risk-coverage tradeoff를 라벨된 평가셋에서 튜닝)과, 정확도와 별개로 캘리브레이션 드리프트를 추적해야 한다는 두 갈래로 정리되며([READY 프레임워크, arXiv:2609.02095](https://arxiv.org/pdf/2609.02095)), **확률적 컴포넌트의 TDD**는 골든셋 평가(정확한 문자열 대신 점수화, flaky 테스트는 비차단 처리)와 스키마 안정성만 확인하는 계약 테스트를 분리해 함께 운용하는 것이 정착된 관행이다([DeepEval docs](https://deepeval.com/docs/evaluation-introduction); [TianPan.co](https://tianpan.co/blog/2026/04/27/contract-tests-llm-tool-surfaces)).

## 대안 비교 — 코드 규칙, 소형 한국어 인코더, 소형 LLM 모두 경쟁력 있는 근거를 갖췄다

Jev 없이도 판정 계층을 구성할 수 있는 세 대안 각각에 구체적 근거가 있다. **코드 규칙**은 좁고 잘 정의된 과제에서 여전히 강력하다 — 피싱 탐지에서 정규식 단독이 91.8%를 냈고([XenoSpectrum](https://xenospectrum.com/en/jev-typesafe-bert-classifier-decomposition/)), 레이블 데이터가 있으면 미세조정된 ModernBERT/DeBERTa 분류기가 F1 0.99 이상을 달성한 사례도 있다([philschmid.de](https://www.philschmid.de/fine-tune-modern-bert-in-2025)). **소형 한국어 인코더**는 특히 유망한데, KoBERT는 의도분류 F1 0.9493, KorBERT는 0.9525를 기록했고, KR-BERT는 더 적은 파라미터·어휘로도 다국어 BERT-base를 감성분석·QA·개체명인식·패러프레이즈 탐지 네 과제 모두에서 능가했으며, KoELECTRA는 1,400만 파라미터(비교 대상 평균 대비 약 7배 작음)로도 경쟁력 있는 성능을 냈다([arXiv:2008.03979](https://arxiv.org/pdf/2008.03979); [KR-BERT 논문 리뷰](https://cpm0722.github.io/paper-review/kr-bert-a-small-scale-korean-specific-language-model)). 단, 이 수치들은 일반 챗봇/금융 도메인 의도분류이며 "한국어 CAD 지시문에서 대상 객체·호스트 명령·목적지 레이어를 추출"하는 VIDE 고유 과제로의 전이는 검증된 바 없다. **소형 LLM**(Claude Haiku 4.5, Gemini Flash급)은 buildfastwithai의 108건 소규모 테스트에서 Jev(96.3%)에 근소하게 뒤졌으나(94.4%, 93.5%) 이는 단일 소규모 평가에 불과하다([buildfastwithai.com](https://blog.buildfastwithai.com/jev-ai-review)). 세 대안 모두 실제 서비스 데이터로 검증이 필요하다는 점은 Jev와 동일하지만, 데이터 소유권·지연·규정 준수 측면에서 자체 인코더/규칙 경로는 PIPA 국외이전 문제 자체를 원천적으로 피할 수 있다는 차별점이 있다. 어떤 소스도 RouteLLM·OpenRouter Auto Router·재순위화기·주입 탐지기의 한국어 성능을 벤치마크하지 않았다는 점은 Jev만의 약점이 아니라 이 전체 영역의 공통된 증거 공백이다.

## VIDE 통합 조건 — Cloudflare 릴레이는 기술적으로 무난하나 법적·운영적 확인이 다수 남아 있다

Cloudflare Workers를 통한 Jev 릴레이는 기술적으로는 무리가 없다: `fetch()` 대기 시간은 CPU 시간에 포함되지 않으므로 Free 플랜의 10ms CPU 예산 안에서도 릴레이가 충분히 동작하고, 서브요청 한도는 2026-02-11 변경 이후 Free 50/Paid 최대 1,000만까지 확장 가능하며, 벤더 키는 `wrangler secret put`으로 코드에 노출 없이 암호화 보관된다([Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/); [Cloudflare Secrets docs](https://developers.cloudflare.com/workers/configuration/secrets/); [Changelog 2026-02-11](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)). Cloudflare AI Gateway는 캐싱·속도제한·분석이 무료이고 `custom-{slug}` 경로로 비표준 프로바이더를 프록시할 수 있지만, Jev의 요청/응답 형태와의 실제 호환성은 검증된 바 없고 비주류 프로바이더 관련 GitHub 이슈들이 마찰을 보고한다([AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/); [cloudflare/ai issue #617](https://github.com/cloudflare/ai/issues/617)). Cloudflare 자체 속도제한 바인딩은 PoP별로만 강하게 일관되므로, 정확한 사용자별 일일 비용 상한에는 Durable Object나 D1 기반 카운터가 필요하고, 벤더 측 지출 알림은 Cloudflare가 볼 수 없는 경로(키 유출 등)에 대비해 TypeSafe 계정에서 별도로 설정해야 한다([Cloudflare Durable Objects rate-limiter](https://developers.cloudflare.com/durable-objects/examples/build-a-rate-limiter)). 장애 대응은 서킷 브레이커(closed/open/half-open)와 기능 플래그를 Worker 릴레이 자체에 두어 모든 데스크톱 클라이언트가 동시에 로컬 LLM 폴백으로 전환되게 하는 패턴이 표준이며, Jev의 주장 지연(70–500ms)을 기준으로 타임아웃을 3–10배 수준(약 2–5초)으로 잡는 것이 합리적이다([BackendBytes](https://backendbytes.com/articles/llm-provider-outage-resilience/); [getmaxim.ai](https://www.getmaxim.ai/articles/retries-fallbacks-and-circuit-breakers-in-llm-apps-a-production-guide/)). 법적으로 가장 중요한 지점은 PIPA 제28조의8(국외이전)로, 미국에 서버를 두는 TypeSafe AI로 데이터를 보내려면 정보주체의 **별도·구체적 동의**와 수신자·목적·보유기간·거부 방법 및 거부 시 효과에 대한 사전 고지가 필요하며, TypeSafe AI가 PIPC 적정성 인정이나 지정 인증을 받았다는 근거는 발견되지 않았다([PIPA 제28조의8](https://casenote.kr/%EB%B2%95%EB%A0%B9/%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4_%EB%B3%B4%ED%98%B8%EB%B2%95/%EC%A0%9C28%EC%A1%B0%EC%9D%988); [privacy.go.kr](https://www.privacy.go.kr/front/contents/cntntsView.do?contsNo=367)). TypeSafe AI 자체 개인정보처리방침은 프롬프트를 학습에 쓰지 않는다고 두 번 명시하고 미국 전용 호스팅을 확인하지만, API 요청 데이터의 구체적 보유기간과 하위처리자 목록을 명시하지 않으며, 3자 애그리게이터(Opper.ai)가 주장하는 엔터프라이즈용 ZDR(영구 미보관)은 벤더 1차 정책 문서에서 확인되지 않는 **상충 사항**이다([TypeSafe AI Privacy Policy](https://typesafe.ai/legal/privacy-policy); [Opper.ai 요약](https://opper.ai/provider/typesafe)). SLA/가동률 공약도 어떤 출처에서도 발견되지 않았다. 평가셋 구축은 정규식+NER(예: Presidio) 계층형 익명화와 합성/수기검수/적대 사례 3종 검증셋 구성이 정착된 관행이며, AI.md의 "비공개 프로젝트 원본을 저장소나 검수 증거에 넣지 않는다" 규칙과 맞물려 실사용 로그보다 합성 데이터를 기본으로 삼아야 한다([OneUptime](https://oneuptime.com/blog/post/2026-01-30-llmops-pii-detection/view); [red-gate/Simple-Talk](https://www.red-gate.com/simple-talk/data-security-privacy-compliance/how-to-anonymize-pii-in-llm-pipelines-5-key-techniques-explained/)).

## VIDE 적용에 대한 판단

**반대 근거가 더 무겁다.** Jev의 아키텍처 패턴(state+타입 질문→확률 응답)은 VIDE가 필요로 하는 난이도 라우팅·문맥 선별·주입 의심 판정과 개념적으로 정확히 일치하지만, (1) 벤더 자체 벤치마크조차 중위권 LLM과 동률(67.8% vs 67.9%)이며 정답은 사람이 검증한 것이 아니라 두 LLM의 평균과의 일치율일 뿐이고, (2) 캘리브레이션이 핵심 판매 논리인데도 ECE/신뢰도 곡선이 전혀 공개되지 않았으며, (3) VIDE의 사용 맥락과 가장 직접적으로 관련된 한국어 독립 테스트는 유일하게 존재하는 것이 우호적이지 않은 결과(flip rate 13% vs 기준 1–2%)이고, (4) 벤더가 스스로 문서화한 "적대적 콘텐츠를 기본적으로 의심하지 않음"이라는 약점이 VIDE가 Jev에 맡기려는 주입 탐지 역할과 정면 충돌하며, (5) SLA 미공개·ZDR 여부 상충·PIPA 국외이전 별도 동의 요건까지 겹쳐 규정 준수 설계 부담이 작지 않고, (6) 제품이 9일 된 첫 버전(1.13.0)으로 changelog 정책도 없어 재현성·안정성 리스크가 크다. 반면 소형 한국어 인코더(KoBERT/KR-BERT/KoELECTRA류, F1 ~0.95)와 코드 규칙은 이미 유사 규모의 정확도 근거를 갖췄고, 데이터가 국내/자체 인프라에 머물러 PIPA 국외이전 문제 자체를 피할 수 있으며, VIDE가 어차피 구축해야 하는 골든셋·계약 테스트·드리프트 모니터링 인프라는 어떤 백엔드를 쓰든 동일하게 필요하다 — 즉 Jev 채택이 "신뢰할 수 있는 판정 계층을 만드는 공학적 부담"을 줄여주지 않는다.

**그럼에도 완전히 배제할 이유는 없다.** 지연·비용(벤더 주장 70–500ms, $0.042/M)이 사실이라면 대화형 CLI의 판정 계층에는 10–60초짜리 전체 LLM 세션보다 훨씬 적합하고, 닫힌 스키마 출력이라는 특성은 Rebuff류 LLM 스캐너가 취약한 "스캐너 자체를 겨냥한 주입" 회피 유형에 구조적으로 더 강할 가능성이 있다(단, 검증되지 않은 추론). 판정 계층 인터페이스를 벤더 중립적으로 설계하면 Jev를 배제하지 않고도 위 리스크를 관리할 수 있다.

**권고:** 지금 시점에는 Jev를 판정 계층의 기본/단독 백엔드로 채택하지 말 것. 대신 (1) 판정 계층을 Choice/Score/Noul 형태의 벤더 중립 인터페이스로 설계해 코드 규칙·소형 한국어 인코더·소형 LLM·Jev를 상호 교체 가능하게 하고, (2) 기본 경로는 코드 규칙 + 자체 학습/파인튜닝한 소형 한국어 인코더로 시작하며, (3) Jev는 실제 판정을 게이팅하지 않는 섀도(비교) 모드로만 파일럿에 투입해 VIDE 자체 한국어 CAD 골든셋으로 정확도·캘리브레이션·flip rate를 직접 재측정한 뒤 재검토한다.

## 2026-09-29 보강 — 공식 문서 확인과 용도별 적용

2026-09-29 사용자가 Jev API 키를 발급받았다(2026-09-25의 가입 보류 해소). 사용자는 두 관점의 용도를 제시했다.
- **제품:** 요청에 따른 모델 선택(모델 라우팅), sync jig처럼 정해진 부분을 빠르게 찾아 수정할 대상 찾기.
- **개발:** 개발 요청을 넣으면 어느 파일의 어느 부분을 고쳐야 하는지 찾기.

이 절은 [공식 문서](https://docs.typesafe.ai/introduction)로 위 조사의 3자 출처 수치를 대조하고, 용도별 적용을 판단한다. 실제 API 호출·측정은 하지 않았다.

### 공식 문서로 확인한 사실

| 항목 | 확인 내용 | 출처 |
|---|---|---|
| 모델 | Jev 1.13(`jev-1.13.0`), 별칭 `jev-latest`(안정)·`jev-preview`(최신 빌드, 현재 동일). 계정별 파인튜닝 없이 요청의 `state`·`instructions`·`criteria`로 맞춤 | [Models](https://docs.typesafe.ai/models) |
| API | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, 본문 `state`·`model`·`questions`, 응답 `answers`·`usage`. 오류 401·422·429·529, 429는 지수 백오프 재시도 | [API](https://docs.typesafe.ai/api.md) |
| 질문 유형 | Choice(선택, 확률·신뢰도, **옵션 최대 255개**), Score(루브릭 점수·신뢰도), Noul(참/거짓 0~1). 한 요청에 섞어 병렬·독립 평가, 질문을 늘려도 응답 시간은 거의 늘지 않음. 질문은 원자적으로 좁게 쓰고 조합은 코드에서 | [Introduction](https://docs.typesafe.ai/introduction), [Line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find) |
| 한도·요금 | 요청당 64k 토큰(`state` 32k + 가장 긴 질문), 입력 100만 토큰당 $0.042(출력 무료), 25만 토큰/초·1,200 요청/분. **텍스트만**(이미지 불가) | [Models](https://docs.typesafe.ai/models) |
| 한국어 | 영어가 최적이며 CJK 등 다른 언어는 **신뢰도가 낮다**고 명시. 도입 전 자체 콘텐츠로 시험 권고 | [Models](https://docs.typesafe.ai/models) |
| 약점(공식) | 계산기가 아님(수치 추론·세기 불안정, 두 값이 가까운지 판단 불가), 날짜를 텍스트로 읽음(선후·간격 불안정), 간접 참조·이중 부정에 약하고 문자 그대로 이해함, **상태에 무관한 내용이 늘면 정확도 하락**, 상태 안의 적대적 콘텐츠에 취약, 생성 불가 | [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) |
| 코딩 에이전트 | Jev는 Claude Code·Codex 등의 LLM을 **대체하지 않는다**. 코딩 에이전트가 Jev를 쓰는 코드를 짜게 할 수 있고, 연동 작성을 돕는 에이전트 스킬 제공 | [Coding agents](https://docs.typesafe.ai/introduction/coding-agents.md) |
| SDK | JavaScript·Python SDK. JS SDK는 환경 변수 `TYPESAFE_API_KEY`·`TYPESAFE_BASE_URL`·`TYPESAFE_LOG_LEVEL`·`TYPESAFE_DEFAULT_MODEL`을 읽음 | [JS SDK ENV](https://docs.typesafe.ai/sdk/javascript/api/variables/ENV.md) |
| 데이터 | 개인정보처리방침에 “사용자 데이터로 모델을 학습하지 않는다”, ZDR(영구 미보관)은 **엔터프라이즈 고객만**. DPA의 보관 기간은 “목적에 필요한 기간”으로 구체 기간 없음. 하위 처리자는 Trust Center 목록 | [Legal](https://docs.typesafe.ai/legal.md), [DPA](https://typesafe.ai/legal/data-processing) |

위 확인으로 아래 “PLAN·TDD 착수 전 확인 목록” 중 API 세부사항·요금·속도제한은 1차 문서로 확인됐고, ZDR은 “엔터프라이즈 한정”으로 정리됐다. 한국어 정확도·캘리브레이션·SLA는 여전히 미확인이다.

### 관련 공식 패턴·레시피

| 레시피 | 내용 | VIDE 관련 |
|---|---|---|
| [Intent routing](https://docs.typesafe.ai/patterns/intent-routing.md)·Confidence-gated routing | 요청을 결정적 코드·전문 LLM·사람 중 어디로 보낼지 분류. 신뢰도가 낮으면 사람에게 넘김 | 모델 라우팅 |
| [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) | 182개 스킬 중 하나를 2단계(짧은 설명으로 순위 → 상위 3개를 긴 설명으로 검증)로 선택. 틀린 선택 16.8% → 7.3%, 불필요한 로드 9.8% → 4.0%, 결정당 약 0.2~0.4초. 해당 없음 판정 임계값 0.30 | jig·스킬 선택, 파일 찾기 |
| [Line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find) | 줄마다 ID를 붙여 상태에 넣고, Choice로 가장 관련 있는 줄을, Noul로 “답이 있기는 한가”를 함께 판정. Choice는 확률 합이 1이라 답이 없어도 1등이 생기므로 Noul이 필요 | 파일 안 위치 찾기, 대상 찾기 |
| [Function calling](https://docs.typesafe.ai/cookbooks/function_calling) | 자연어 요청을 신뢰도 기반으로 타입 있는 함수에 매핑 | 정해진 동작 어휘 선택(RESEARCH-07) |
| [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification) | 깊은 분류 계층을 병렬 빔 탐색으로 | 255개를 넘는 후보(파일·객체)의 단계적 좁히기 |
| [Entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment)·[Citation check](https://docs.typesafe.ai/cookbooks/citation_check)·[RAG passage 분류](https://docs.typesafe.ai/cookbooks/classifying_rag_passages) | 후보 대응, 인용이 원문을 뒷받침하는지 검증, 검색 결과 걸러내기 | 프로젝트 지식 DB(RESEARCH-06) |
| [LLM guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails) | 위험도 임계값으로 통과·검토·차단·전환 | 외부 텍스트 주입 의심(단독 차단 금지) |

### 용도별 적용 판단

공통 원칙(RESEARCH-02 권고와 2026-09-22 사용자 결정 유지): Jev는 **권한·원본 적용·대상 확정·기하 검증에 단독으로 쓰지 않는다.** 제안·선별·순서 정하기에 쓰고, 신뢰도가 낮으면 기존 경로로 넘긴다. 벤더 중립 판정 인터페이스(Choice/Score/Noul)와 섀도 비교(PLAN-05)를 유지한다.

| 용도 | 방식 | 기대 이득 | 위험·제약 | 판단 |
|---|---|---|---|---|
| **개발: 수정할 파일·위치 찾기** | ① 파일 목록(경로 + 한 줄 설명)을 폴더 단위로 나눠 Choice로 좁힘(255개 한도, 계층 분류) → ② 상위 파일의 줄에 ID를 붙여 Choice로 위치 + Noul로 “여기에 있는가” 판정 → ③ 결과(파일·줄·신뢰도)를 코딩 에이전트에게 “참고 후보”로 전달 | 에이전트가 넓게 훑는 탐색을 줄여 착수 시간·토큰 절감 가능 | 코드 대부분이 영어 식별자, 요청은 한국어(언어 혼합). 상태가 커지면 정확도 하락 → 파일 전체가 아니라 설명·시그니처를 먼저 넣어야 함. 에이전트의 grep 검색보다 나은지 불확실. 저장소 코드가 외부로 전송됨 | **가장 먼저 시도.** 제품이 아니라 개발 도구라 위험이 낮고, 실제 한국어·혼합 텍스트에서 Jev의 성능을 빨리 배울 수 있음. 에이전트 검색 대비 적중률(top-k)·시간으로 비교 |
| **제품: 모델·effort 라우팅** | 요청 + 첨부 요약을 상태로, Choice(작업 유형: 조회·단순 수정·복잡 생성·해석/최적화)와 Score(복잡도)로 모델·effort 선택. 신뢰도가 낮으면 사용자 기본 설정 | 단순 요청은 빠른 모델, 복잡한 요청은 높은 effort → 체감 지연·사용량 절감 | 잘못 낮춰 보내면 실패 후 재시도로 더 느려짐. 모델 능력 설명은 사람이 criteria로 써 줘야 함. 계정·사용량 한도 기반 전환은 수치 판단이라 Jev가 아니라 코드로(다른 세션의 계정별 사용량·자동 전환과 분리) | **섀도 모드부터.** 실제 선택은 기존대로 두고 Jev 추천만 기록 → 실패율·지연 비교 뒤 “추천 + 사용자 확인” → 기본값 순서 |
| **제품: 수정 대상 찾기(sync jig 등)** | 요청 문장(“북측 창호”, “3층 회의실 벽”)을 레이어·블록·그룹·객체 이름·속성 텍스트 후보에 매핑. ① 레이어/그룹 Choice(≤255) → ② 후보 객체 Choice + 후보별 Noul 검증 → ③ **의도 카드의 대상 제안**(RESEARCH-07) | AI가 모델 전체를 조회하며 대상을 찾는 왕복을 줄임. 정해진 수정(sync jig)에서 즉시 대상 제시 | 텍스트만 가능 — 공간 관계(“북측”, “3층”)는 이름·속성에 없으면 못 찾음 → 결정적 공간 필터(층 높이·방위·범위 상자)와 조합해야 함. 수치·위치 판단 약점. 대상 확정은 사용자·결정적 조회가 함 | **제안 전용으로 적합.** 의도 카드의 “대상” 후보를 먼저 채우고 사용자가 확인. 대상 확정·쓰기 권한에는 쓰지 않음 |
| jig·스킬 선택 | skill suggestion 레시피 그대로(짧은 설명 순위 → 상위 3개 검증, 해당 없음 판정) | jig 수가 늘어도 빠르게 고름 | jig 설명 품질에 좌우 | jig가 여러 개 생기면 적용(RESEARCH-04·05) |
| 요청 처리 검증 보조 | “실제 수행 설명이 실행된 단계와 일치하는가”, “의도 카드 항목이 충족됐다고 결과 텍스트가 주장하는가”를 Noul로(문자 그대로 이해하는 성질이 오히려 유리) | 자기 보고와 실제의 불일치 탐지 | 수치 검사는 계산으로(RESEARCH-07) | RESEARCH-07 구현 시 보조 |
| 지식 DB | 인용 검증, 검색 결과 걸러내기, 별칭(한빛/한빛건설) 대응, 진행 중 개입의 관련성 | 추출 품질·질의 속도 | 날짜 선후 판단 약함 → 날짜는 코드로 | C-02 채택 시 |
| 외부 텍스트 주입 의심 | guardrails 레시피 | 빠른 선별 | 적대적 콘텐츠에 취약(공식) | 사용자 확인 트리거로만, 단독 차단 금지 |

### 키 관리와 보안

- **개발용:** 저장소 루트 `.env`에 `TYPESAFE_API_KEY=...`(JS SDK 기본 이름). `.gitignore`의 `.env`·`.env.*`가 막고, 배포 ZIP은 Git이 추적하는 파일만 담으므로(`src/desktop/build.mjs`) 포함되지 않는다. 커밋 전 비밀정보 검사(gitleaks)가 스테이징된 키를 잡는다.
- **제품용:** 2026-09-22 결정대로 배포물에 키를 넣지 않고, 우리 서버(Cloudflare Workers 등) 중계로 호출한다. 사용자 요청·객체 이름이 TypeSafe로 전송되므로 FR-18 전송 고지·끄기 옵션과 국외 이전 동의가 필요하다. 오프라인·장애 시 기존 경로로 넘어간다.
- **다른 사용자의 사용(2026-09-29 사용자 확인):** 다른 사용자가 자기 PC의 VIDE(채팅 요청이나 jig)에서 Jev가 필요한 요청을 하면, 그 PC의 엔진은 Jev를 직접 부르지 않고 사용자의 VIDE 계정 로그인(PC도 같은 아이디로 로그인)으로 우리 서버에 요청한다. 서버가 Worker 비밀값으로 보관한 우리 키를 붙여 Jev를 호출하고 결과만 돌려준다. 사용자는 Jev 키를 발급·입력하지 않고 키는 사용자 PC에 오지 않는다. Claude·ChatGPT는 지금처럼 각자의 구독 로그인을 쓴다. 조건: VIDE 계정 로그인 필요(미로그인·오프라인이면 LLM 경로로 넘어감, 계정은 가입 코드로만 생성), 모든 사용자가 우리 키 하나의 비용·한도를 공유하므로 계정별 일일 상한(D1/Durable Object 카운터)과 TypeSafe 쪽 지출 알림, 우리 키로 타인 요청을 대리 호출하는 것이 TypeSafe 약관상 허용되는지 확인(미확인). 선택지로 사용자가 자기 키를 설정에 넣으면 그 키로 부르는 방식(BYOK)을 나중에 더할 수 있다. 구현 범위: Worker 중계 경로(로그인 확인·계정별 상한·비밀값 키), 엔진의 중계 호출과 실패 시 LLM 전환, 설정 창의 사용 안내·끄기.
- **환경 변수 전파(2026-09-29 확인):** VIDE는 서버 환경을 자식 프로세스에 넘긴다. Claude/Codex CLI 자식 환경은 알려진 AI 공급자 키만 지우는 방식이라 `TYPESAFE_API_KEY`가 전달된다(CLI는 VIDE MCP 도구만 허용돼 직접 읽을 경로는 제한적). Rhino 작업 프로세스도 서버 환경을 물려받지만, 생성 코드 검사가 `System.Environment` 접근을 막아 AI 생성 코드가 읽을 수는 없다. 방어를 한 겹 더 두려면 자식 프로세스 환경에서 `TYPESAFE_*`와 알려진 비밀 변수를 지우거나 허용 목록 방식으로 바꾸는 것이 안전하다.
- **데이터:** 개발 용도는 저장소 코드와 개발 요청이, 제품 용도는 사용자 요청·객체 이름이 전송된다. 학습 미사용은 명시돼 있으나 보관 기간은 불특정이고 ZDR은 엔터프라이즈 한정이다.

### 다음 단계 제안

1. 개발 도구로 “수정 위치 찾기”를 먼저 만든다(`tools/` 아래, 제품 코드 아님). 최근 개발 요청 20~30건과 실제 수정 파일(Git 이력)로 적중률·시간을 측정하고, 코딩 에이전트의 자체 탐색과 비교한다.
2. 이 과정에서 한국어·혼합 텍스트에서의 신뢰도 분포를 기록해 제품 용도의 임계값 근거로 쓴다.
3. 제품의 모델 라우팅·대상 찾기는 PLAN-05의 섀도 비교(벤더 중립 인터페이스, 실측 평가셋) 절차로 진행한다. 키 중계와 전송 동의는 제품 적용 전에 정한다.
4. 버전은 재현성을 위해 `jev-1.13.0`으로 고정하고 `jev-latest` 변경을 추적한다.

## PLAN·TDD 착수 전 확인 목록

| 확인 항목 | 왜 남아 있는가 | 해소 방법 |
|---|---|---|
| Jev의 한국어 정확도·캘리브레이션 실측 부재 | 유일한 독립 한국어 테스트가 flip rate만 측정, 정확도·ECE 수치 없음([GitHub: mahlernim/jev-korean-benchmark](https://github.com/mahlernim/jev-korean-benchmark)) | VIDE 자체 한국어 CAD 지시문 골든셋(레이블 포함)을 구축해 Jev로 정확도·신뢰도-정확도 곡선·재현율을 직접 측정 |
| API 세부사항(질문 수 상한, 배치 동작, 64k/32k 한도)이 1차 문서로 미확인 | 수치가 systemonemodels.org(3자 애그리게이터)에서만 확인됨([systemonemodels.org](https://systemonemodels.org/models/jev/)) | 얼리 액세스 확보 후 `docs.typesafe.ai/api`·`docs.typesafe.ai/concepts/system-one` 원문 직접 대조, 또는 벤더에 직접 문의 |
| ZDR(영구 미보관) 여부 상충 | 1차 개인정보처리방침에는 ZDR 언급 없음, 3자(Opper.ai)만 주장([TypeSafe AI Privacy Policy](https://typesafe.ai/legal/privacy-policy) vs [Opper.ai](https://opper.ai/provider/typesafe)) | privacy@typesafe.ai로 ZDR·DPA·하위처리자 목록·보유기간 서면 확인 요청 |
| PIPA 국외이전 동의 문구·플로우 미확정 | 별도·구체적 동의와 필수 사전고지(수신자/목적/보유기간/거부방법과 효과)가 필요하나 UI·문구 미정([PIPA 제28조의8](https://casenote.kr/%EB%B2%95%EB%A0%B9/%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4_%EB%B3%B4%ED%98%B8%EB%B2%95/%EC%A0%9C28%EC%A1%B0%EC%9D%988)) | 법무 검토로 동의 화면 문구 확정, 거부 시 로컬 LLM 대체 흐름을 제품 정책으로 명문화 |
| SLA/가동률 미공개, 서킷브레이커 임계값 근거 부재 | 어떤 출처도 Jev의 가동률·장애 이력을 제공하지 않음 | 파일럿 기간 동안 자체 지연·성공률 로그를 수집해 타임아웃(예: 지연 3–10배)·연속 실패 임계값을 실측 기반으로 설정 |
| 요금·속도제한 수치가 비1차 출처 | $0.042/M, 250,000 tokens/sec, 1,200 req/min 등이 systemonemodels.org·llmgateway.io 등에서만 확인됨 | TypeSafe 대시보드/계약서에서 직접 확인 후 비용 상한(Durable Object/D1 카운터) 설계에 반영 |
| Jev vs 코드 규칙·소형 한국어 인코더·소형 LLM의 동일 조건 비교 부재 | 모든 비교가 서로 다른 데이터셋·평가방식 사용, 어느 것도 CAD 도메인 아님 | 자체 골든셋으로 네 후보(Jev/규칙/한국어 인코더/소형 LLM)를 동일 조건 스파이크로 비교 후 PLAN에 결정 근거 기록 |
| Jev를 주입 탐지에 쓸 때의 방어력 미실측 | 벤더가 "적대적 콘텐츠 기본 미방어"를 명시하고, 닫힌 스키마의 저항성은 추론일 뿐 검증 없음([docs.typesafe.ai/model-jaggedness/jev-1.13](https://blog.redhub.ai/jev-ai-limits)) | 한국어 포함 적대적 테스트 케이스로 직접 측정하기 전에는 트리거(사용자 확인 요구) 용도로만 사용, 단독 차단 게이트 금지 |
| 개입 관련성(mid-run interruption) 판정의 선행 근거 부재 | 에이전트 도구 사용 맥락에서 벤치마크된 문헌이 없음(가장 근거가 약한 영역) | 외부 벤치마크에 의존하지 말고 VIDE 자체 상호작용 로그로 처음부터 설계·검증한다고 PLAN에 명시 |
| Cloudflare AI Gateway custom-provider 경로와 Jev 호환성 미검증 | 비주류 프로바이더 관련 마찰 이슈가 다수 보고됨([cloudflare/ai #617](https://github.com/cloudflare/ai/issues/617)) | 스파이크로 AI Gateway 경유 Jev 호출을 테스트, 실패 시 순수 Worker+D1 릴레이로 대체 |
| 평가셋 구축 시 PII/프로젝트 기밀 처리 방식 미정 | 실사용 로그 재사용 시 정규식만으로는 자유텍스트 속 클라이언트명·프로젝트명을 못 거름 | 합성 데이터 우선 원칙 채택, 실로그 파생 픽스처는 정규식+NER 익명화·저장소 외부 보관·보유기한 명시 후 TEST_PLAN에 기록 |
| 버전 고정 정책(jev-latest vs jev-1.13) 미정 | changelog가 없어 `jev-latest`가 조용히 변경될 수 있음([systemonemodels.org](https://systemonemodels.org/models/jev/)) | 재현성을 위해 특정 버전(`jev-1.13`)을 명시 고정하고, SDK breaking change(예: msgspec→Pydantic) 대응 정책을 PLAN에 기록 |
| 에스컬레이션(신뢰도 임계값) 결정 공식 부재 | 선택적 예측 문헌은 메커니즘만 제공하고 업계 표준 임계값은 없음 | 위험-커버리지 트레이드오프를 VIDE 자체 오류비용/에스컬레이션비용 함수로 도출해 TEST_PLAN에 문서화 |
