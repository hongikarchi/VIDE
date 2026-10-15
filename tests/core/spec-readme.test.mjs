import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SPEC_MARKS,
  appendHistory,
  differenceSentence,
  lastHistoryReason,
  panelWritesFiles,
  parseSpecReadme,
  replaceSection,
  rewriteSkillFrontMatter,
  skillFieldsFromSpec,
  skillFieldsOf,
  specDraft,
  specMatch,
  specPurpose,
  specSectionsFromManifest,
} from '../../src/jigs/spec-readme.ts';
import { briefReadme, emptyBrief } from '../../src/ui/make-brief.ts';

// PLAN-54 T-353: the jig's 명세 (README.md) — SPEC-07.2 명세 규칙, ARCH-03 §2.1·§5.3·§11.
const JIGS = [
  'src/jigs/official/jigs/building-summary',
  'src/jigs/official/jigs/buildable-mass',
  'src/jigs/official/jigs/compliance-check',
  'src/jigs/official/jigs/paneling',
  'src/jigs/official/jigs/site-model',
  'extensions/jigs/example-grid',
  'extensions/jigs/s06-frame',
];
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const packageOf = (dir) => {
  const manifest = JSON.parse(read(`${dir}/jig.json`));
  return {
    readme: read(`${dir}/README.md`),
    manifest,
    skill: read(`${dir}/${manifest.skill ?? 'skill.md'}`),
    panel: manifest.panel ? read(`${dir}/${manifest.panel}`) : null,
  };
};
// All seven agree with their jig.json (s06-frame writes ⑦ as a numbered table: its rows count).
const KNOWN = {};

test('the seven official specs have the nine sections and the three ② lists of their skill.md', () => {
  for (const dir of JIGS) {
    const { readme, skill } = packageOf(dir);
    const spec = parseSpecReadme(readme);
    assert.equal(spec.complete, true, dir);
    assert.deepEqual(Object.keys(spec.sections).sort(), [...SPEC_MARKS].sort(), dir);
    const fields = skillFieldsFromSpec(spec);
    assert.ok(fields.words.length > 0, `${dir}: 판정 낱말`);
    assert.ok(fields.notFor.length > 0, `${dir}: 언제 아니다`);
    // skill.md's three fields are the ones made from ② (written in one place only).
    assert.deepEqual(skillFieldsOf(skill), fields, dir);
    assert.ok(specPurpose(spec)?.length, `${dir}: ① 첫 문단`);
  }
});

test('spec-match: the official specs agree with their jig.json (known README gaps aside)', () => {
  for (const dir of JIGS) {
    const { readme, manifest, panel } = packageOf(dir);
    const result = specMatch(readme, manifest, { tablePart: panelWritesFiles(panel) });
    const left = result.differences.map(({ section, field, item }) => ({ section, field, item }));
    assert.deepEqual(left, KNOWN[dir] ?? [], dir);
  }
});

test('spec-match ⑦: a numbered table counts its rows when there is no numbered list', () => {
  const { readme, manifest, panel } = packageOf('extensions/jigs/s06-frame');
  const options = { tablePart: panelWritesFiles(panel) };
  assert.equal(specMatch(readme, manifest, options).ok, true);
  const fewer = readme.replace(/^\| 45 \|.*\n/m, '');
  const count = specMatch(fewer, manifest, options).differences.find((d) => d.section === '⑦');
  assert.equal(count?.field, 'count');
});

test('spec-match: an input, a setting default and a gate count changed in the README fail', () => {
  const { readme, manifest, panel } = packageOf('src/jigs/official/jigs/building-summary');
  const options = { tablePart: panelWritesFiles(panel) };
  assert.equal(specMatch(readme, manifest, options).ok, true);
  // ③: an input renamed in the spec only.
  const renamed = readme.replace('| 대지 요약(사이트 모델링) |', '| 대지 정보 |');
  const inputs = specMatch(renamed, manifest, options).differences;
  assert.deepEqual(
    inputs.map((d) => [d.section, d.field]),
    [
      ['③', 'missing'],
      ['③', 'extra'],
    ],
  );
  // ④: the default of a choice the jig does not have.
  const defaults = specMatch(
    readme.replace(
      '| 공사종별 (`constructionType`) | 선택 | 사람 입력 필요 (`unset`)',
      '| 공사종별 (`constructionType`) | 선택 | 신축',
    ),
    manifest,
    options,
  ).differences;
  assert.deepEqual(
    defaults.map((d) => [d.section, d.field, d.item]),
    [['④', 'default', '공사종별']],
  );
  assert.match(
    differenceSentence(defaults[0]),
    /명세의 설정값 '공사종별' 기본값 신축이\(가\) jig에서는/,
  );
  // ⑦: one gate more in the spec.
  const gates = specMatch(
    readme.replace('3. 일관성 점검 —', '3. 일관성 점검 —\n4. 하나 더 —'),
    manifest,
    options,
  ).differences;
  assert.deepEqual(gates, [
    { section: '⑦', item: '통과 조건', field: 'count', spec: '4', jig: '3' },
  ]);
  // ⑥: a kind the jig does not make.
  const kinds = specMatch(
    readme.replace('- **Rhino에 만들기:** 없음.', '- **Rhino에 만들기:** 개요 표를 문자로.'),
    manifest,
    options,
  ).differences;
  assert.deepEqual(
    kinds.map((d) => [d.section, d.field, d.item]),
    [['⑥', 'kind', 'Rhino에 만들기']],
  );
});

test('spec-match: units and defaults are compared in the shown or stored form', () => {
  const manifest = {
    inputs: [{ key: 'site', title: '대지(슬래브)', kind: 'assembly' }],
    params: [
      {
        key: 'width',
        title: '패널 가로',
        type: 'length',
        unit: 'm',
        display: { unit: 'mm', decimals: 0 },
        default: 1.2,
      },
      {
        key: 'ratio',
        title: '보 춤 비',
        type: 'ratio',
        display: { unit: '%', decimals: 1 },
        default: 0.07,
      },
      { key: 'angle', title: '격자 각도', type: 'angle', unit: 'deg', default: 15 },
      { key: 'on', title: '지형 포함', type: 'toggle', default: false },
      {
        key: 'mode',
        title: '배치 방식',
        type: 'choice',
        default: 'auto',
        choices: [{ value: 'auto', label: '자동' }],
      },
    ],
    steps: [{ id: 'a', gates: [{ use: 'no-nan' }] }],
    panel: 'panel.json',
  };
  const spec = (rows) =>
    specDraft({
      name: '시험',
      purpose: '목적',
      inputs: [{ role: '대지' }],
      params: rows,
      outputs: [{ kind: '화면' }],
      checks: ['계산 — 숫자 오류 없음'],
    });
  const ok = spec([
    { name: '패널 가로', key: 'width', unit: 'm (화면 mm)', value: '1,200 mm' },
    { name: '보 춤 비', key: 'ratio', unit: '비율', value: '7 %' },
    { name: '격자 각도', key: 'angle', unit: '°', value: '15' },
    { name: '지형 포함', key: 'on', unit: '켬/끔', value: '끔' },
    { name: '배치 방식', key: 'mode', unit: '선택', value: '자동(auto)' },
  ]);
  assert.deepEqual(specMatch(ok, manifest).differences, []);
  const wrong = spec([
    { name: '패널 가로', key: 'width', unit: 'mm', value: '1,000' },
    { name: '보 춤 비', key: 'ratio', unit: '%', value: '0.07' },
    { name: '격자 각도', key: 'angle', unit: 'm', value: '15' },
    { name: '지형 포함', key: 'on', unit: '-', value: '켬' },
    { name: '배치 방식', key: 'mode', unit: '선택', value: '수동' },
  ]);
  assert.deepEqual(
    specMatch(wrong, manifest).differences.map((d) => [d.item, d.field]),
    [
      ['패널 가로', 'default'],
      ['격자 각도', 'unit'],
      ['지형 포함', 'default'],
      ['배치 방식', 'default'],
    ],
  );
});

test('a spec with a section missing is 명세 없음 and is not compared', () => {
  const { readme, manifest } = packageOf('extensions/jigs/example-grid');
  const cut = readme.replace(/## ⑦[\s\S]*?(?=## ⑧)/, '');
  const spec = parseSpecReadme(cut);
  assert.equal(spec.complete, false);
  assert.deepEqual(spec.missing, ['⑦']);
  assert.deepEqual(specMatch(cut, manifest), { ok: true, differences: [] });
  assert.equal(parseSpecReadme(readme + '\n## ⑦ 통과 조건\n\n1. 또\n').complete, false);
  assert.equal(parseSpecReadme(null).complete, false);
});

test('the start form becomes a spec draft of nine sections; empty parts say 아직 적지 않음', () => {
  const brief = {
    ...emptyBrief(),
    purpose: '기둥을 격자로 놓는다',
    when: '계획안 검토 때\n배치를 빨리 바꿔 볼 때',
    inputs: ['layers', 'zone'],
    layerShapes: ['곡선'],
    params: [
      {
        name: '간격',
        type: 'length',
        unit: 'm',
        value: '8',
        min: '3',
        max: '12',
        basis: 'assumed',
      },
    ],
    steps: [
      { name: '배치', by: 'code', note: '' },
      { name: '확인', by: 'human', note: '' },
    ],
    outputs: ['preview', 'extrude', 'table'],
    checks: [{ text: '기둥이 슬래브 안', level: 'block' }],
    start: 'blank',
  };
  const text = briefReadme(brief, '2026-10-15');
  const spec = parseSpecReadme(text);
  assert.equal(spec.complete, true);
  assert.equal(spec.title, '기둥을 격자로 놓는다');
  assert.equal(specPurpose(spec), '기둥을 격자로 놓는다');
  assert.deepEqual(skillFieldsFromSpec(spec), {
    examples: ['계획안 검토 때', '배치를 빨리 바꿔 볼 때'],
    words: [],
    notFor: [],
  });
  assert.match(spec.sections['③'].body, /\| Rhino·CAD 레이어 \| 곡선 \|/);
  assert.match(spec.sections['④'].body, /\| 간격 \| m \| 8 \| 3 ~ 12 \| 가정 \|/);
  assert.match(spec.sections['⑤'].body, /2\. 【사람】 \*\*확인\*\*/);
  assert.match(spec.sections['⑥'].body, /\*\*Rhino에 만들기:\*\* 기둥 돌출/);
  assert.match(spec.sections['⑦'].body, /^1\. 기둥이 슬래브 안 \(막음\)$/m);
  assert.equal(spec.sections['⑧'].body, '아직 적지 않음');
  assert.equal(lastHistoryReason(spec), '시작 양식에서 만든 명세 초안');
  // A form with only the purpose leaves ②~⑧ empty for the AI to fill from the plan.
  const bare = parseSpecReadme(briefReadme({ ...emptyBrief(), purpose: '목적만' }, '2026-10-15'));
  assert.equal(bare.complete, true);
  for (const mark of ['②', '③', '④', '⑤', '⑥', '⑦', '⑧'])
    assert.equal(bare.sections[mark].body, '아직 적지 않음', mark);
});

test('skill.md front matter: the three fields replaced in place, the rest kept; a new one made', () => {
  const skill =
    '---\nname: 격자\nwords: [옛 낱말]\nintent_en: grid\nnot_for:\n  - 옛것\ntools: []\n---\n\n# 본문\n';
  const fields = { examples: ['격자 놓아 줘'], words: ['격자', '기둥, 배치'], notFor: [] };
  const next = rewriteSkillFrontMatter(skill, fields, { name: '격자' });
  assert.equal(
    next,
    // `not_for` had no items left: it goes, and the new `examples` takes its place.
    '---\nname: 격자\nwords: [격자, "기둥, 배치"]\nintent_en: grid\nexamples: [격자 놓아 줘]\ntools: []\n---\n\n# 본문\n',
  );
  assert.deepEqual(skillFieldsOf(next), fields);
  // Round trip: writing the same fields again changes nothing.
  assert.equal(rewriteSkillFrontMatter(next, fields, { name: '격자' }), next);
  const made = rewriteSkillFrontMatter(null, fields, { name: '새 도구', description: '목적 문단' });
  assert.match(made, /^---\nname: 새 도구\ndescription: 목적 문단\nexamples: \[격자 놓아 줘\]/);
  assert.deepEqual(skillFieldsOf(made), fields);
});

test('[명세 고치기] sections from jig.json pass spec-match; history and section edits', () => {
  const { readme, manifest, panel } = packageOf('extensions/jigs/example-grid');
  const options = { tablePart: panelWritesFiles(panel) };
  const sections = specSectionsFromManifest(manifest, options);
  let text = readme;
  for (const mark of ['③', '④', '⑤', '⑥', '⑦'])
    text = replaceSection(text, mark, () => sections[mark]);
  assert.deepEqual(specMatch(text, manifest, options).differences, []);
  const more = appendHistory(text, { version: 'v0.1.1', date: '2026-10-15', reason: '명세 고침' });
  assert.equal(lastHistoryReason(more), '명세 고침');
  assert.equal(parseSpecReadme(more).complete, true);
  // The blank template's manifest too.
  const blank = {
    inputs: [],
    params: [{ key: 'count', title: '개수', type: 'count', unit: 'EA', default: 3 }],
    steps: [{ id: 'main', title: '계산', kind: 'code', gates: [{ use: 'no-nan' }] }],
    panel: 'panel.json',
  };
  const made = specDraft({ name: '빈 초안', purpose: '목적' });
  let filled = made;
  const blankSections = specSectionsFromManifest(blank, { tablePart: true });
  for (const mark of ['③', '④', '⑤', '⑥', '⑦'])
    filled = replaceSection(filled, mark, () => blankSections[mark]);
  assert.equal(specMatch(made, blank, { tablePart: true }).ok, false);
  assert.deepEqual(specMatch(filled, blank, { tablePart: true }).differences, []);
});

test('the built-in jig specs (Sync·구조 분석·프로젝트 자료) have the nine sections', () => {
  for (const id of ['sync', 'structure', 'knowledge']) {
    const spec = parseSpecReadme(read(`src/jigs/builtin-specs/${id}.md`));
    assert.equal(spec.complete, true, id);
    const fields = skillFieldsFromSpec(spec);
    assert.ok(fields.examples.length && fields.words.length && fields.notFor.length, id);
  }
});
