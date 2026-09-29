---
id: SPIKE-2026-09-29-structure-core-binding
title: 구조 코어(Rust)를 Node 서버에서 부르는 방식
status: review
version: 0.1
updated: 2026-09-29
owner: agent:claude
related: [PLAN-17, ARCH-02, ADR-019]
---

# 구조 코어(Rust)를 Node 서버에서 부르는 방식

PLAN-17 T-033의 실험 기록이다.

## 질문

Rust로 만든 해석 코어를 Node 24 서버에서 Node-API 애드온으로 부를 수 있는가? 약 12,000 자유도 골조에서 속도·정확도는 어떤가? 대체안인 실행 파일 방식과는 무엇이 다른가?

## 방법과 환경

- Windows 11 Pro, Node 24.15.0, Rust 1.98.1(rustup stable, x86_64-pc-windows-msvc), VS Build Tools 2026(MSVC, Windows SDK 10.0.26100).
- crate `src/native/structure/`(`vide-structure` 0.1.0): faer 0.24.4(희소 Cholesky), napi 3·napi-derive 3(Node-API 4 기능). 요소 강성은 ARCH-02 §2 규약의 3D 12자유도 보 요소(`src/frame.rs`).
- 합성 모델(`src/bench.rs`): 6 m 격자·층고 4 m의 기둥 + 양방향 보, 기초 고정, 모든 절점 연직 하중 + 조합별 수평 성분. 한 번 분해하고 우변 23개를 푼다.
- 애드온: `cargo build --release --lib` → `vide_structure.dll`을 `process.dlopen`으로 로드(확장자 무관). 실행 파일: `cargo build --release --bin vide-structure --no-default-features --target-dir target/exe`.

## 결과

| 모델 | 자유도 | 비영 항목 | 조립 | 분해 | 23개 풀이 | 합계(애드온 호출) | 잔차 | 반력 평형 오차 |
|---|---|---|---|---|---|---|---|---|
| 3×3×3 | 108 | 984 | 0.1 ms | 0.6 ms | 0.01 ms | 0.7 ms | 1.0e-15 | 0 |
| 20×20×6 | 12,000 | 144,000 | 13 ms | 119~193 ms | 55~94 ms | 230~265 ms | 6.9e-15 | 3.6e-16 |
| 30×30×6 | 27,000 | 327,000 | 32 ms | 245 ms | 178 ms | 466 ms | 7.0e-15 | 1.6e-16 |

- 실행 파일로 같은 12,000 자유도를 풀면 232~265 ms였고, Node에서 `execFileSync`로 부르면 프로세스 시작을 포함해 286 ms였다.
- 산출물 크기: 애드온 2.96 MB, 실행 파일 2.83 MB.
- `cargo test --no-default-features`: 요소 축 규약·대칭·강체 이동 무응력·작은 격자 평형 4개 통과.

## 발견한 함정

- 같은 crate에서 Node 기능 없이 실행 파일을 빌드하면 공유되는 `target/release/vide_structure.dll`이 덮어써진다. 그 뒤 애드온을 로드하면 "Module did not self-register" 오류가 난다. 실행 파일은 별도 `--target-dir`로 빌드해야 한다.
- faer 0.24의 `solve`는 `faer::prelude::Solve` 트레이트를 가져와야 쓸 수 있다.

## 결론

애드온 방식을 채택한다. 설치 없이 Node 24에서 로드되고, 한 번의 호출로 12,000 자유도·23개 조합을 약 0.25초에 정확하게 푼다. 실행 파일 방식도 동작해서, 코어 오류가 서버를 흔드는 문제가 생기면 대체 경로로 쓸 수 있다. 설치본 포함은 기존 호스트 플러그인처럼 빌드 후 명시 경로로 복사하는 방식(`src/desktop/build.mjs`)을 따르며, T-039에서 실제 설치본 로드로 확인한다(이번 실험에서는 미시험).

## 한계

- 합성 격자 모델이며 단부해제·트러스·하중 분배는 없다. 기구(불안정) 탐지는 T-035 범위다.
- 설치본에서의 로드와 다른 PC에서의 실행은 확인하지 않았다.
- wasm 빌드는 이번 범위에서 측정하지 않았다.
