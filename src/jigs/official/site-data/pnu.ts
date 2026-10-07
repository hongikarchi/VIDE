// PNU (필지고유번호, 19 digits): 법정동코드 10 + 필지 구분 1 (1 일반, 2 산) + 본번 4 + 부번 4.
// 건축HUB `platGbCd` is 0 대지 / 1 산 / 2 블록, one off from the PNU digit (SPIKE §1).

export const PNU = /^\d{10}[12]\d{8}$/;
export const isPnu = (value: string) => PNU.test(value);

export function buildPnu(legalDong: string, mountain: boolean, main: number, sub: number) {
  if (!/^\d{10}$/.test(legalDong)) return null;
  if (!Number.isInteger(main) || !Number.isInteger(sub) || main < 1 || main > 9999) return null;
  if (sub < 0 || sub > 9999) return null;
  return `${legalDong}${mountain ? 2 : 1}${String(main).padStart(4, '0')}${String(sub).padStart(4, '0')}`;
}

export function splitPnu(pnu: string) {
  return {
    legalDong: pnu.slice(0, 10),
    mountain: pnu[10] === '2',
    main: Number(pnu.slice(11, 15)),
    sub: Number(pnu.slice(15, 19)),
  };
}

/** "31", "산1-3": the lot number as people write it. */
export function lotLabel(pnu: string) {
  const { mountain, main, sub } = splitPnu(pnu);
  return `${mountain ? '산' : ''}${main}${sub ? `-${sub}` : ''}`;
}

/** Building-register query keys for a PNU. */
export function registerKeys(pnu: string) {
  return {
    sigunguCd: pnu.slice(0, 5),
    bjdongCd: pnu.slice(5, 10),
    platGbCd: pnu[10] === '2' ? '1' : '0',
    bun: pnu.slice(11, 15),
    ji: pnu.slice(15, 19),
  };
}

/**
 * The lot number at the end of a 지번 address ("… 태평로1가 31", "… 용산동2가 산1-3번지"), or null
 * for a road address ("… 세종대로 110": the number follows a 로/길 name).
 */
export function trailingLot(address: string) {
  const match = /(\S+)\s+(산\s*)?(\d{1,4})(?:-(\d{1,4}))?\s*(?:번지)?$/.exec(address.trim());
  if (!match) return null;
  if (!match[2] && !/(동|가|리)$/.test(match[1])) return null;
  return { mountain: !!match[2], main: Number(match[3]), sub: Number(match[4] ?? 0) };
}
