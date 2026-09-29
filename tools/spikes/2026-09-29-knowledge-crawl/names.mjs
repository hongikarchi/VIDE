// Stage 2: read meaning from folder and file names — date, direction, counterpart, document type,
// superseded versions, episodes. Rules first; Jev classifies only what the rules leave open.
// With --compare N, the same N random files are also typed by Jev and Claude for the SPIKE table.
import { logRun, tx } from './db.mjs';
import { jev, claude, pool, usage } from './llm.mjs';

export const TYPES = {
  minutes: '회의록·협의 내용',
  review: '검토 의견·검토 요청·검토 결과',
  drawing: '도면(평면·단면·배치 등)',
  report: '보고·발표 자료(PT, 보고자료)',
  study: '조사·진단 보고서(지반조사, 구조안전진단 등)',
  estimate: '견적·공사비·용역비',
  contract: '계약서·제안서',
  regulation: '법규·기준·가이드라인·심의 양식',
  schedule: '공정표·일정·연락망',
  mail: '메일',
  other: '기타(사진, 참고자료, 템플릿 등)',
};
const RULES = [
  ['mail', /\.eml$/i],
  ['minutes', /회의록|협의내용|협의 내용|회의 ?결과/],
  ['contract', /계약서|제안서|용역리스트/],
  ['estimate', /견적|공사비|용역비|설계비|적산/],
  ['study', /지반조사|안전진단|진단보고서|조사보고서/],
  ['regulation', /법규|가이드라인|기준|양식|예상 질문/],
  ['schedule', /공정표|연락망|일정/],
  ['review', /검토|자문|의견|체크/],
  ['drawing', /\.(dwg|dxf)$|도면|평면도|단면도|배치도|입면도|상세도/i],
  ['report', /보고|발표|PT|실무회의 자료|심의자료|심의 자료/i],
];
const DAY = /(?:^|[^\d])(2[0-9])(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/;

export function parsePath(rel) {
  const parts = rel.split('/');
  const out = {};
  // Deepest dated segment is the episode (a meeting, a sending, a receipt).
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(DAY);
    if (m) {
      out.day = `20${m[1]}-${m[2]}-${m[3]}`;
      if (i < parts.length - 1) out.episode = parts.slice(0, i + 1).join('/');
      break;
    }
  }
  if (/(^|\/)(old|del)(\/|$)/i.test(rel)) out.superseded = 'yes';
  const sent = rel.match(/^03_Data\/01_Sent\/([^/]+)/),
    received = rel.match(/^03_Data\/02_Receive\/([^/]+)/);
  if (sent || received) {
    out.direction = sent ? 'sent' : 'received';
    const group = (sent ?? received)[1].replace(/^[\d-]+\s*/, '');
    const company = group.match(/\(([^)]+)\)/);
    out.party = (company ? company[1] : group).trim();
    out.discipline = group.replace(/\(.*\)/, '').trim();
  } else if (/^02_Document\/03 회의록\//.test(rel)) {
    out.direction = 'meeting';
    const folder = parts[2] ?? '';
    out.party = folder.replace(DAY, '').replace(/^[\s_-]+/, '').trim();
  } else if (/99_MAIL/.test(rel)) out.direction = 'mail';
  else if (/^01_DWG\//.test(rel)) out.direction = 'drawing-set';
  // Last matching rule on the file name wins over the folder name.
  const name = parts.at(-1),
    folders = parts.slice(0, -1).join('/');
  for (const [type, pattern] of RULES) if (pattern.test(name)) { out.type = type; break; }
  if (!out.type) for (const [type, pattern] of RULES) if (pattern.test(folders.split('/').at(-1) ?? '')) { out.type = type; break; }
  return out;
}

const typeQuestion = {
  type: {
    type: 'choice',
    instructions: '건축 설계 프로젝트 서버 폴더의 파일이다. 경로와 파일 이름으로 볼 때 이 파일의 자료 종류는 무엇인가?',
    criteria: TYPES,
  },
};
const jevType = async (meter, rel) => {
  const answer = (await jev(meter, `파일 경로: ${rel}`, typeQuestion)).type ?? {};
  return { type: answer.choice, confidence: answer.confidence ?? 0 };
};

export async function names(db, _root, args) {
  const started = performance.now();
  const meter = usage();
  const rows = db.prepare('select id, rel_path, kind from source where skip is null').all();
  const put = db.prepare(`insert into source_meta(source_id, key, value, method, confidence) values(?, ?, ?, ?, ?)
    on conflict(source_id, key) do update set value = excluded.value, method = excluded.method, confidence = excluded.confidence`);
  const episode = db.prepare('insert or ignore into episode(day, counterpart, rel_folder) values(?, ?, ?)');
  const parsed = new Map();
  tx(db, () => {
    for (const row of rows) {
      const meta = parsePath(row.rel_path);
      parsed.set(row.id, meta);
      for (const [key, value] of Object.entries(meta)) put.run(row.id, key, value, 'rule', 1);
      if (meta.episode) episode.run(meta.day, meta.party ?? null, meta.episode);
    }
  });
  // Jev only for text-bearing files the rules could not type.
  const open = rows.filter((r) => r.kind !== 'binary' && !parsed.get(r.id).type);
  const typed = await pool(open, 12, (r) => jevType(meter, r.rel_path));
  tx(db, () => open.forEach((r, i) => typed[i].type && put.run(r.id, 'type', typed[i].type, 'jev', typed[i].confidence)));
  const result = {
    files: rows.length,
    ruleTyped: rows.filter((r) => r.kind !== 'binary' && parsed.get(r.id).type).length,
    jevTyped: open.length,
    episodes: db.prepare('select count(*) as n from episode').get().n,
  };
  const i = args.indexOf('--compare');
  if (i >= 0) result.compare = await compare(db, rows.filter((r) => r.kind !== 'binary'), Number(args[i + 1] ?? 100), parsed);
  result.ms = logRun(db, 'names', started, { items: rows.length, ...meter, note: JSON.stringify(result) });
  return result;
}

/** Rules vs Jev vs Claude on the same random files; Claude is the reference label. */
async function compare(db, rows, n, parsed) {
  const sample = [...rows].sort(() => Math.random() - 0.5).slice(0, n);
  const jevMeter = usage(),
    claudeMeter = usage();
  let t = performance.now();
  const byJev = await pool(sample, 12, (r) => jevType(jevMeter, r.rel_path));
  const jevMs = Math.round(performance.now() - t);
  t = performance.now();
  const list = sample.map((r, k) => `${k}\t${r.rel_path}`).join('\n');
  const byClaude = await claude(
    claudeMeter,
    `건축 설계 프로젝트 서버 폴더의 파일 목록이다. 경로와 파일 이름으로 각 파일의 자료 종류를 고르라.\n종류: ${JSON.stringify(TYPES)}\n` +
      `JSON 배열로만 답하라: [{"i":번호,"type":"키"}]\n\n${list}`,
  );
  const claudeMs = Math.round(performance.now() - t);
  const reference = new Map(byClaude.map((x) => [Number(x.i), x.type]));
  let ruleHit = 0, ruleCovered = 0, jevHit = 0, jevHigh = 0, jevHighHit = 0;
  const rows2 = sample.map((r, k) => {
    const ref = reference.get(k), rule = parsed.get(r.id).type, j = byJev[k];
    if (rule) { ruleCovered++; if (rule === ref) ruleHit++; }
    if (j.type === ref) jevHit++;
    if (j.confidence >= 0.8) { jevHigh++; if (j.type === ref) jevHighHit++; }
    return { path: r.rel_path, rule, jev: j.type, jevConfidence: j.confidence, claude: ref };
  });
  db.prepare('insert or replace into meta(key, value) values(?, ?)').run('compare_names', JSON.stringify(rows2));
  return {
    n: sample.length,
    rule: { covered: ruleCovered, agree: ruleHit },
    jev: { agree: jevHit, high: jevHigh, highAgree: jevHighHit, ms: jevMs, calls: jevMeter.jevCalls, tokens: jevMeter.jevTokens },
    claude: { ms: claudeMs, calls: claudeMeter.llmCalls, in: claudeMeter.llmIn, out: claudeMeter.llmOut },
  };
}
