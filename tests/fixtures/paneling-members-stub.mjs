// A stand-in stage-2 `MemberSet` for the stage-3 tests (PLAN-49 T-256 starts from a fixed member
// set while T-254 builds the real one): every layout panel becomes a member with the panel's own UV
// outline (no joint), so neighbouring plates share their vertices exactly. Failed layout panels stay
// failed. Shaped by `src/contracts/paneling.ts`; nothing here is a real stage-2 computation.

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** @param {import('../../src/contracts/paneling.ts').PanelLayout} layout */
export function membersOf(layout, o = {}) {
  const thickness = o.thickness ?? 0.05;
  return {
    schema: 'vide.paneling.members@1',
    layoutHash: o.layoutHash ?? HASH_A,
    settingsHash: o.settingsHash ?? HASH_B,
    members: layout.panels.map((p) => ({
      panelId: p.id,
      uv: (o.uvOf?.(p) ?? p.uv).map(([u, v]) => [u, v]),
      solid: null,
      flatSize: [p.width, p.height],
      flatSizeApprox: false,
      thickness,
      area: p.area,
      volume: p.area * thickness,
      jointGap: null,
      jointUneven: false,
      failure: p.failure,
    })),
    joints: [],
    overStock: [],
  };
}
