// Official library `vide/compliance-kit` (SPEC-15, PLAN-48, ARCH-03 §2.3·§8.6): the 법규 체크 model
// reader (검사 역할 rules, display rows → `ClassifiedModel`), the AI role proposal summary and answer
// check (T-237), and the check engine `runCheck` with its CSV report rows (T-238). Pure TypeScript
// without node: imports. No legal value is written here: every limit the check uses is a 규제 조건
// item with its source (SPEC-15.5).

export const library = { id: 'vide/compliance-kit', version: '0.1.0' } as const;

export {
  CHECK_ATTRS,
  JIG_TAGS,
  LAYER_NAMES,
  MASSING_JIG,
  alternativeReading,
  countOf,
  floorLabel,
  indexRecords,
  isComplianceRole,
  layerRule,
  roleOf,
  useLabel,
} from './conventions.ts';
export type { RecordIndex, RoleDecision, RoleRow } from './conventions.ts';
export {
  LEVEL_TOL,
  analyzeRow,
  attributesOfRow,
  layerOfRow,
  readClassifiedModel,
  unitsToMeters,
  unusedShapeOf,
} from './read-model.ts';
export type { AnalyzedShape, Frame, ReadInput, ReadOutput, RowFacts } from './read-model.ts';
export { checkComplianceRoles, complianceRolesRequest, unroledGroups } from './proposals.ts';
export type { CheckedProposal, ProposalRejection, UnroledGroup } from './proposals.ts';
export { ComplianceInputError, NOTICE, canonical, fingerprint, runCheck } from './check.ts';
export type { CheckRefs } from './check.ts';
export { REPORT_COLUMNS, reportCsv, reportRows } from './report-rows.ts';
export type { ReportRow } from './report-rows.ts';
