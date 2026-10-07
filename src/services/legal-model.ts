import type {
  LegalConstraint,
  LegalConstraintLeft,
  LegalConstraintsOutput,
} from '../contracts/legal.ts';
import type { ClawdeAnswer } from '../contracts/clawde.ts';
import type { LegalAnswerView } from './legal-answers.ts';

/**
 * 모델과 잇기 (SPEC-13.8, PLAN-46 T-220, ARCH-01 「법규와 모델」). Three links between the legal answers
 * and the project's model, all without a formula of VIDE's own:
 * - **대지 모델 → 프로필:** the site-model jig's (`vide/site-model`, PLAN-45 T-207) 대지 요약 and the
 *   `vide-site-summary` metadata it leaves on the site-information point (SPEC-12.6, SITE_ATTRS) give
 *   profile values with the source 'model' and the run they came from. A user value is never
 *   replaced (`LegalProfile.offer` leaves a notice).
 * - **답 → 객체:** an answer's `targets` (대지 · 인접 대지 · 도로) resolve to the objects the site-model
 *   bakes made, by linked file (Link ID, ADR-030) and host object id: the answer card's target chips.
 * - **제한 → 가능 매스:** `legal.constraints`, the numeric limits whose every article is cited with its
 *   text, newest answer first, one per key, each with 근거 조항, 출처 표시 and 적용 여부.
 */

/** The objects one bake of the site model made in one linked file (JigRuntime.madeObjects). */
export interface MadeObjects {
  bakeId: string;
  linkId: string;
  nativeIds: string[];
}

/** What the engine reads of the project's newest computed site model. */
export interface SiteModelRead {
  instanceId: string;
  /** Shown with every value read: the site model and the run of its 대지 요약. */
  version: string;
  /** The `summary` step output (대지 요약, SPEC-12.5). */
  summary: unknown;
  /** The objects its bakes made (empty before Rhino에 만들기). */
  made: MadeObjects[];
}
export interface LegalModelSource {
  read(projectId: string): Promise<SiteModelRead | undefined>;
}

type Scalar = string | number | boolean;
export interface ModelOffer {
  key: string;
  value: Scalar;
  unit?: string;
}

interface SiteBrief {
  pnu?: string[];
  zones?: string[];
  roads?: { dir?: string; min?: number; avg?: number; contact?: number }[];
  convergenceDeg?: number;
  north?: 'true' | 'grid';
  buildings?: number;
  maxHeight?: number;
}
interface Summary {
  pnus?: string[];
  addresses?: string[];
  officialArea_m2?: number | null;
  computedArea_m2?: number;
  landCategories?: string;
  zones?: string;
  roads?: string;
  convergenceDeg?: number;
  buildings?: number;
  maxHeight_m?: number;
  siteInfo?: { summary?: string }[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** The `vide-site-summary` metadata of the site-information point (SPEC-12.6), if readable. */
function briefOf(summary: Summary): SiteBrief {
  const raw = summary.siteInfo?.[0]?.summary;
  if (!text(raw)) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SiteBrief) : {};
  } catch {
    return {};
  }
}

/**
 * Profile values from a site model's 대지 요약 (SPEC-13.4 대지·모델 요약). Values the site model does
 * not know (공부 면적 없음, 용도지역 미확인) are left out rather than sent as unknown.
 */
export function profileFromSiteModel(read: Pick<SiteModelRead, 'summary'>): ModelOffer[] {
  const summary = (read.summary ?? {}) as Summary;
  const brief = briefOf(summary);
  const out: ModelOffer[] = [];
  const add = (key: string, value: unknown, unit?: string) => {
    if (finite(value) || text(value)) out.push({ key, value, ...(unit ? { unit } : {}) });
  };
  add('site.pnu', summary.pnus?.join(', '));
  add('site.address', summary.addresses?.filter(text).join(', '));
  add('site.area', summary.officialArea_m2 ?? undefined, '㎡');
  add('model.siteArea', summary.computedArea_m2, '㎡');
  if (text(summary.landCategories) && !/^(미확인(, )?)+$/.test(summary.landCategories))
    add('site.landCategory', summary.landCategories);
  // 용도지역·지구·구역 with the 고시 the source gave (SPEC-12.5), as the site model wrote them.
  if (summary.zones !== '용도지역 미확인') add('site.zoning', summary.zones);
  const roads = (brief.roads ?? []).filter((r) => finite(r.min));
  if (roads.length) {
    add('site.roadAccess', summary.roads);
    // The widest touching road's computed width (도로 폭은 계산 값, SPEC-12.5); which road counts
    // and whether 접도 is met is the service's judgement.
    add('site.roadWidth', Math.max(...roads.map((r) => r.min as number)), 'm');
  }
  const north = brief.north === 'grid' ? '도북' : brief.north === 'true' ? '진북' : undefined;
  add('model.northBasis', north);
  add('model.convergenceDeg', brief.convergenceDeg ?? summary.convergenceDeg, '°');
  add('model.surroundingBuildings', summary.buildings);
  if ((summary.buildings ?? 0) > 0) add('model.surroundingMaxHeight', summary.maxHeight_m, 'm');
  return out;
}

export type LegalTargetKind = NonNullable<ClawdeAnswer['targets']>[number];
/** One target chip of an answer card (SPEC-13.8 답에서 모델로). */
export interface LegalTargetChip {
  kind: LegalTargetKind;
  label: string;
  /** False: '모델에 없음' (no site model, or its bake made nothing for this target). */
  found: boolean;
  /** The objects to highlight, per linked file (Link ID) with the host's object ids. */
  objects: { linkId: string; nativeIds: string[] }[];
}
const TARGET_LABEL: Record<LegalTargetKind, string> = {
  site: '대지',
  adjacent: '인접 대지',
  road: '도로',
};
/** The site-model bakes (jig.json `bake[].id`) each target points at. */
const TARGET_BAKES: Record<LegalTargetKind, readonly string[]> = {
  site: ['outline', 'targets'],
  adjacent: ['parcels'],
  road: ['roads'],
};

export function targetChips(
  targets: ClawdeAnswer['targets'],
  read: Pick<SiteModelRead, 'made'> | undefined,
): LegalTargetChip[] {
  return [...new Set(targets ?? [])].map((kind) => {
    const byLink = new Map<string, string[]>();
    for (const made of read?.made ?? [])
      if (TARGET_BAKES[kind].includes(made.bakeId) && made.nativeIds.length)
        byLink.set(made.linkId, [...(byLink.get(made.linkId) ?? []), ...made.nativeIds]);
    const objects = [...byLink].map(([linkId, nativeIds]) => ({ linkId, nativeIds }));
    return { kind, label: TARGET_LABEL[kind], found: objects.length > 0, objects };
  });
}

const APPLIES: Partial<Record<ClawdeAnswer['verdict'], LegalConstraint['applies']>> = {
  applies: '적용',
  'not-applies': '미적용',
  conditional: '판단 필요',
};

/**
 * The legal jig's output `legal.constraints` from the project's answers (newest first). The newest
 * answer that gives a key decides it: a constraint of a '다시 확인 필요' answer, of an answer shown
 * '판단 불가', with an article not among the citations, or with a cited article without its text or
 * link, is left out with why, and an older answer's value for that key is not used instead.
 */
export function constraintsOutput(
  answers: readonly Pick<
    LegalAnswerView,
    'ref' | 'question' | 'fetchedAt' | 'lawDbDate' | 'stale' | 'verdict' | 'noExcerpt' | 'answer'
  >[],
): LegalConstraintsOutput {
  const constraints: LegalConstraint[] = [];
  const left: LegalConstraintLeft[] = [];
  const decided = new Set<string>();
  for (const view of answers) {
    const cited = new Map(view.answer.citations.map((c) => [c.ref, c]));
    const noText = new Set(view.noExcerpt);
    for (const c of view.answer.constraints ?? []) {
      if (decided.has(c.key)) continue;
      decided.add(c.key);
      const reason: LegalConstraintLeft['reason'] | undefined = view.stale
        ? '다시 확인 필요'
        : !APPLIES[view.verdict]
          ? '판단 불가'
          : !c.refs.length || !c.refs.every((ref) => cited.has(ref))
            ? '근거 미확인'
            : c.refs.some((ref) => noText.has(ref))
              ? '원문 없음'
              : undefined;
      if (reason) {
        left.push({ key: c.key, answer: view.ref, reason });
        continue;
      }
      constraints.push({
        key: c.key,
        value: c.value,
        unit: c.unit,
        refs: [...c.refs],
        clauses: c.refs.map((ref) => {
          const article = cited.get(ref)!;
          return {
            ref,
            text: `${article.lawName} ${article.article}`,
            link: article.sourceUrl,
          };
        }),
        origin: c.basis === 'verified' ? '서비스 확정' : '서비스 해석',
        applies: APPLIES[view.verdict]!,
        answer: view.ref,
        question: view.question,
        fetchedAt: view.fetchedAt,
        lawDbDate: view.lawDbDate,
      });
    }
  }
  return { schema: 'vide.legal.constraints@1', constraints, left };
}
