// `vide` CLI arguments (PLAN-52 T-315, ARCH-01 「작업 폴더(PLAN-52)」 CLI 진입점). Pure: no file or
// network access, so the parse is tested on its own.

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'jig-list' }
  | { kind: 'jig-run'; jig: string; inputs: { key: string; value: string | number | boolean }[] }
  | { kind: 'data'; role?: string }
  | { kind: 'export'; jig: string; exportKind: 'review' | 'report'; report?: string };

export interface CliArgs {
  command: CliCommand;
  json: boolean;
  /** `--new`: `jig run` opens a new instance instead of the latest one. */
  fresh: boolean;
  /** `--data <dir>`: the VIDE data folder (default VIDE_DATA_DIR or %LOCALAPPDATA%\VIDE). */
  dataDir?: string;
}

export class UsageError extends Error {
  code = 'USAGE';
}

/** `k=v`: numbers and true/false become values of that type; the rest stays text. */
export function parseInput(text: string): { key: string; value: string | number | boolean } {
  const at = text.indexOf('=');
  if (at <= 0) throw new UsageError(`--input는 키=값 모양이어야 합니다: ${text}`);
  const key = text.slice(0, at).trim();
  const raw = text.slice(at + 1).trim();
  if (!key) throw new UsageError(`--input의 키가 비었습니다: ${text}`);
  const value =
    raw === 'true'
      ? true
      : raw === 'false'
        ? false
        : raw !== '' && Number.isFinite(Number(raw))
          ? Number(raw)
          : raw;
  return { key, value };
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const words: string[] = [];
  const inputs: { key: string; value: string | number | boolean }[] = [];
  let json = false;
  let fresh = false;
  let dataDir: string | undefined;
  let exportKind: 'review' | 'report' = 'review';
  let report: string | undefined;
  let help = false;
  const value = (flag: string, i: number) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--'))
      throw new UsageError(`${flag} 뒤에 값이 필요합니다.`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const take = () => {
      if (inline !== undefined) return inline;
      const next = value(flag, i);
      i++;
      return next;
    };
    switch (flag) {
      case '--json':
        json = true;
        break;
      case '--new':
        fresh = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--input':
      case '-i':
        inputs.push(parseInput(take()));
        break;
      case '--data':
        dataDir = take();
        break;
      case '--kind': {
        const kind = take();
        if (kind !== 'review' && kind !== 'report')
          throw new UsageError('--kind는 review 또는 report입니다.');
        exportKind = kind;
        break;
      }
      case '--report':
        report = take();
        break;
      default:
        if (arg.startsWith('-')) throw new UsageError(`모르는 옵션입니다: ${arg}`);
        words.push(arg);
    }
  }
  const base = { json, fresh, ...(dataDir ? { dataDir } : {}) };
  if (help || !words.length) return { ...base, command: { kind: 'help' } };
  const [first, second, third, ...extra] = words;
  if (first === 'help') return { ...base, command: { kind: 'help' } };
  if (first === 'jig') {
    if (second === 'list' && third === undefined) return { ...base, command: { kind: 'jig-list' } };
    if (second === 'run' && third && !extra.length)
      return { ...base, command: { kind: 'jig-run', jig: third, inputs } };
    throw new UsageError('사용법: vide jig list | vide jig run <jig> [--input 키=값]…');
  }
  if (first === 'data') {
    if (third !== undefined) throw new UsageError('사용법: vide data [역할]');
    return { ...base, command: { kind: 'data', ...(second ? { role: second } : {}) } };
  }
  if (first === 'export') {
    if (!second || third !== undefined)
      throw new UsageError('사용법: vide export <jig> [--kind review|report]');
    return {
      ...base,
      command: { kind: 'export', jig: second, exportKind, ...(report ? { report } : {}) },
    };
  }
  throw new UsageError(`모르는 명령입니다: ${first}`);
}

export const USAGE = `vide — 작업 폴더에서 VIDE jig와 자료를 부릅니다

  vide jig list                          이 프로젝트에서 쓸 수 있는 jig 목록
  vide jig run <jig> [--input 키=값]…    jig를 계산합니다(값은 jig 설정값). --new는 새로 엽니다
  vide data [역할]                       역할 폴더 경로와 그 안의 목록(VIDE 없이도 동작)
  vide export <jig> [--kind review|report] [--report <보고서>]
                                         가장 최근 결과의 보고서를 검토(review)·산출물(output) 폴더에 저장

  공통: --json 기계용 출력, --data <폴더> VIDE 데이터 폴더(기본 VIDE_DATA_DIR 또는 %LOCALAPPDATA%\\VIDE)
  역할: ops raw rhino cad review output snapshots references tools archive
  종료 코드: 0 성공, 1 오류, 2 사용법 오류, 3 VIDE 화면에서 사람이 확인할 단계
`;
