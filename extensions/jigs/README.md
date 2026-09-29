# extensions/jigs

프로젝트 jig 소스(검증용 샘플 규칙). 형식의 정본은 `docs/architecture/ARCH-03-jig-runtime.md` §2~§5(`jig.json` v3·폴더·`panel.json`·자체 시험), 동작은 `docs/specs/SPEC-07-jig-platform.md`다. 여기에는 단계 코드·화면·보고서 틀·합성 시험 자료만 둔다. 실제 프로젝트 값(설정값 근거·입력 조립·구역·수정 사항)은 사용자 데이터 폴더의 작업본에만 있다.

- `example-grid/` — jig 형식 v3의 일반 예제(격자 기둥 배치·보 연결, 합성 자료). 새 jig의 본보기.
- `s06-frame/` — S-06 골조 jig(PLAN-23).

명령: `npm run jig:validate -- <폴더>` · `npm run jig:test -- <폴더> [--runner engine|child]` · `npm run jig:pack -- <폴더> --data-dir <데이터 폴더>`.
