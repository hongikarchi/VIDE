//! Linear static analysis of 3D frames (ARCH-02 §5). Units inside: kN, m.

use crate::frame::{local_axes, local_stiffness, FrameProps, Mat12, Vec3};
use crate::model::{global_direction, local_direction, Load, Material, Model};
use crate::section::{properties, SectionProps};
use faer::prelude::Solve;
use faer::sparse::{SparseColMat, Triplet};
use faer::{Mat, Side};
use std::collections::HashMap;

pub const DOF_NAMES: [&str; 6] = ["dx", "dy", "dz", "rx", "ry", "rz"];
/// Sample positions (fractions) used for checks and deflection.
pub const SAMPLES: usize = 21;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Frame,
    Truss,
    TensionOnly,
}

/// Loads on one member in local axes for one pattern or combination.
#[derive(Clone, Default, Debug)]
pub struct MemberLoad {
    /// Uniform load per length (local 1, 2, 3), kN/m.
    pub q: [f64; 3],
    /// Point loads: (distance from i in m, local force kN).
    pub points: Vec<(f64, [f64; 3])>,
}

impl MemberLoad {
    fn is_empty(&self) -> bool {
        self.q == [0.0; 3] && self.points.is_empty()
    }
    fn add_scaled(&mut self, other: &MemberLoad, s: f64) {
        for k in 0..3 {
            self.q[k] += s * other.q[k];
        }
        for (a, p) in &other.points {
            self.points.push((*a, [p[0] * s, p[1] * s, p[2] * s]));
        }
    }
}

pub struct Elem {
    pub member: usize,
    pub ni: usize,
    pub nj: usize,
    pub r: [Vec3; 3],
    pub length: f64,
    pub section: SectionProps,
    pub material: usize,
    pub fp: FrameProps,
    pub kind: Kind,
    /// Uncondensed local stiffness.
    pub k: Mat12,
    /// Released local DOFs (0–5 at i, 6–11 at j).
    pub released: [bool; 12],
    /// Condensed local stiffness (released rows/columns are zero).
    pub kc: Mat12,
    /// Inverse of the released block, indexed by `rel_idx`.
    rel_idx: Vec<usize>,
    krr_inv: Vec<Vec<f64>>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DofRef {
    pub node: usize,
    pub dof: usize,
}

pub struct ComboResult {
    pub id: String,
    pub service: bool,
    /// Global displacements, 6 per node.
    pub u: Vec<f64>,
    /// Reactions at restrained DOFs, 6 per node (zero elsewhere).
    pub reactions: Vec<f64>,
    /// Local end forces per element (force on the member by the node).
    pub end_forces: Vec<[f64; 12]>,
    /// Full local end displacements per element (released DOFs recovered).
    pub end_disp: Vec<[f64; 12]>,
    pub loads: Vec<MemberLoad>,
    pub active: Vec<bool>,
    pub equilibrium_error: f64,
}

pub struct Analysis {
    pub node_ids: Vec<String>,
    pub elems: Vec<Elem>,
    pub restrained: Vec<bool>,
    pub auto_restrained: Vec<DofRef>,
    pub combos: Vec<ComboResult>,
    pub warnings: Vec<String>,
}

pub enum Failure {
    Input(String),
    Mechanism(Vec<DofRef>),
}

fn mat_vec(k: &Mat12, u: &[f64; 12]) -> [f64; 12] {
    let mut out = [0.0; 12];
    for i in 0..12 {
        out[i] = (0..12).map(|j| k[i][j] * u[j]).sum();
    }
    out
}

/// Local (12) ← global (12) with T = diag(R, R, R, R).
fn to_local(r: &[Vec3; 3], g: &[f64; 12]) -> [f64; 12] {
    let mut out = [0.0; 12];
    for b in 0..4 {
        for a in 0..3 {
            out[b * 3 + a] = (0..3).map(|c| r[a][c] * g[b * 3 + c]).sum();
        }
    }
    out
}

fn to_global(r: &[Vec3; 3], l: &[f64; 12]) -> [f64; 12] {
    let mut out = [0.0; 12];
    for b in 0..4 {
        for c in 0..3 {
            out[b * 3 + c] = (0..3).map(|a| r[a][c] * l[b * 3 + a]).sum();
        }
    }
    out
}

fn global_k(e: &Elem) -> Mat12 {
    // Tᵀ·Kc·T.
    let mut kt = [[0.0; 12]; 12];
    for i in 0..12 {
        for j in 0..12 {
            let b = (j / 3) * 3;
            kt[i][j] = (0..3).map(|m| e.kc[i][b + m] * e.r[m][j % 3]).sum();
        }
    }
    let mut kg = [[0.0; 12]; 12];
    for i in 0..12 {
        let b = (i / 3) * 3;
        for j in 0..12 {
            kg[i][j] = (0..3).map(|m| e.r[m][i % 3] * kt[b + m][j]).sum();
        }
    }
    kg
}

/// Invert a small dense matrix; rows whose pivot vanishes are returned as `None` positions.
fn invert(a: Vec<Vec<f64>>) -> (Vec<Vec<f64>>, Vec<bool>) {
    let n = a.len();
    let mut m = a;
    let mut inv: Vec<Vec<f64>> = (0..n).map(|i| (0..n).map(|j| if i == j { 1.0 } else { 0.0 }).collect()).collect();
    let scale = (0..n).map(|i| m[i][i].abs()).fold(0.0, f64::max).max(1e-300);
    let mut dead = vec![false; n];
    for col in 0..n {
        let piv = (col..n).max_by(|&x, &y| m[x][col].abs().total_cmp(&m[y][col].abs())).unwrap();
        if m[piv][col].abs() <= 1e-12 * scale {
            dead[col] = true;
            continue;
        }
        m.swap(col, piv);
        inv.swap(col, piv);
        let p = m[col][col];
        for j in 0..n {
            m[col][j] /= p;
            inv[col][j] /= p;
        }
        for row in 0..n {
            if row != col && m[row][col] != 0.0 {
                let f = m[row][col];
                for j in 0..n {
                    m[row][j] -= f * m[col][j];
                    inv[row][j] -= f * inv[col][j];
                }
            }
        }
    }
    for i in 0..n {
        if dead[i] {
            for j in 0..n {
                inv[i][j] = 0.0;
                inv[j][i] = 0.0;
            }
        }
    }
    (inv, dead)
}

fn build_elem(
    member: usize,
    ni: usize,
    nj: usize,
    xi: Vec3,
    xj: Vec3,
    beta: f64,
    section: SectionProps,
    material: usize,
    mat: &Material,
    kind: Kind,
    released: [bool; 12],
) -> Result<Elem, String> {
    let (r, length) = local_axes(xi, xj, beta);
    if !(length > 1e-9) {
        return Err("zero-length member".into());
    }
    let fp = FrameProps {
        e: mat.e_mpa * 1e3,
        g: mat.g_mpa * 1e3,
        a: section.a * 1e-6,
        i2: section.i2 * 1e-12,
        i3: section.i3 * 1e-12,
        j: section.j * 1e-12,
    };
    let mut k = local_stiffness(fp, length);
    let mut released = released;
    if kind != Kind::Frame {
        // Axial-only: keep the two axial terms.
        let ea = fp.e * fp.a / length;
        k = [[0.0; 12]; 12];
        k[0][0] = ea;
        k[6][6] = ea;
        k[0][6] = -ea;
        k[6][0] = -ea;
        released = [false; 12];
    }
    let rel_idx: Vec<usize> = (0..12).filter(|&d| released[d]).collect();
    let fr: Vec<usize> = (0..12).filter(|&d| !released[d]).collect();
    let mut kc = k;
    let mut krr_inv = Vec::new();
    if !rel_idx.is_empty() {
        let krr: Vec<Vec<f64>> = rel_idx.iter().map(|&a| rel_idx.iter().map(|&b| k[a][b]).collect()).collect();
        let (inv, _) = invert(krr);
        kc = [[0.0; 12]; 12];
        for &a in &fr {
            for &b in &fr {
                let mut v = k[a][b];
                for (x, &ra) in rel_idx.iter().enumerate() {
                    for (y, &rb) in rel_idx.iter().enumerate() {
                        v -= k[a][ra] * inv[x][y] * k[rb][b];
                    }
                }
                kc[a][b] = v;
            }
        }
        krr_inv = inv;
    }
    Ok(Elem { member, ni, nj, r, length, section, material, fp, kind, k, released, kc, rel_idx, krr_inv })
}

/// Fixed-end forces (force on the member by the supports) for local loads.
fn fixed_end(e: &Elem, load: &MemberLoad) -> [f64; 12] {
    let l = e.length;
    let mut f = [0.0; 12];
    let [q1, q2, q3] = load.q;
    f[0] -= q1 * l / 2.0;
    f[6] -= q1 * l / 2.0;
    if e.kind == Kind::Frame {
        f[1] -= q2 * l / 2.0;
        f[7] -= q2 * l / 2.0;
        f[5] -= q2 * l * l / 12.0;
        f[11] += q2 * l * l / 12.0;
        f[2] -= q3 * l / 2.0;
        f[8] -= q3 * l / 2.0;
        f[4] += q3 * l * l / 12.0;
        f[10] -= q3 * l * l / 12.0;
    } else {
        // Axial members carry transverse load as simple beams straight to the nodes.
        f[1] -= q2 * l / 2.0;
        f[7] -= q2 * l / 2.0;
        f[2] -= q3 * l / 2.0;
        f[8] -= q3 * l / 2.0;
    }
    for &(a, p) in &load.points {
        let b = l - a;
        f[0] -= p[0] * b / l;
        f[6] -= p[0] * a / l;
        if e.kind == Kind::Frame {
            f[1] -= p[1] * b * b * (3.0 * a + b) / l.powi(3);
            f[7] -= p[1] * a * a * (a + 3.0 * b) / l.powi(3);
            f[5] -= p[1] * a * b * b / (l * l);
            f[11] += p[1] * a * a * b / (l * l);
            f[2] -= p[2] * b * b * (3.0 * a + b) / l.powi(3);
            f[8] -= p[2] * a * a * (a + 3.0 * b) / l.powi(3);
            f[4] += p[2] * a * b * b / (l * l);
            f[10] -= p[2] * a * a * b / (l * l);
        } else {
            f[1] -= p[1] * b / l;
            f[7] -= p[1] * a / l;
            f[2] -= p[2] * b / l;
            f[8] -= p[2] * a / l;
        }
    }
    f
}

/// Condensed fixed-end forces: f0_f − K_fr·K_rr⁻¹·f0_r.
fn condense_load(e: &Elem, f0: &[f64; 12]) -> [f64; 12] {
    if e.rel_idx.is_empty() {
        return *f0;
    }
    let mut out = *f0;
    for &r in &e.rel_idx {
        out[r] = 0.0;
    }
    for a in 0..12 {
        if e.released[a] {
            continue;
        }
        for (x, &ra) in e.rel_idx.iter().enumerate() {
            for (y, &rb) in e.rel_idx.iter().enumerate() {
                out[a] -= e.k[a][ra] * e.krr_inv[x][y] * f0[rb];
            }
        }
    }
    out
}

/// Recover released local displacements: u_r = −K_rr⁻¹ (K_rf·u_f + f0_r).
fn recover(e: &Elem, u: &[f64; 12], f0: &[f64; 12]) -> [f64; 12] {
    let mut full = *u;
    if e.rel_idx.is_empty() {
        return full;
    }
    let rhs: Vec<f64> = e
        .rel_idx
        .iter()
        .map(|&r| f0[r] + (0..12).filter(|&c| !e.released[c]).map(|c| e.k[r][c] * u[c]).sum::<f64>())
        .collect();
    for (x, &r) in e.rel_idx.iter().enumerate() {
        full[r] = -(0..rhs.len()).map(|y| e.krr_inv[x][y] * rhs[y]).sum::<f64>();
    }
    full
}

fn assemble(elems: &[Elem], active: &[bool], eq: &[usize], n: usize) -> Result<SparseColMat<usize, f64>, String> {
    let mut trips: Vec<(usize, usize, f64)> = Vec::with_capacity(elems.len() * 144);
    for (idx, e) in elems.iter().enumerate() {
        if !active[idx] {
            continue;
        }
        let kg = global_k(e);
        let map = |loc: usize| if loc < 6 { eq[e.ni * 6 + loc] } else { eq[e.nj * 6 + loc - 6] };
        for r in 0..12 {
            let gr = map(r);
            if gr == usize::MAX {
                continue;
            }
            for c in 0..12 {
                let gc = map(c);
                if gc != usize::MAX && kg[r][c] != 0.0 {
                    trips.push((gr, gc, kg[r][c]));
                }
            }
        }
    }
    trips.sort_unstable_by_key(|t| (t.1, t.0));
    let mut merged: Vec<Triplet<usize, usize, f64>> = Vec::with_capacity(trips.len() / 2);
    for (r, c, v) in trips {
        match merged.last_mut() {
            Some(last) if last.row == r && last.col == c => last.val += v,
            _ => merged.push(Triplet::new(r, c, v)),
        }
    }
    SparseColMat::<usize, f64>::try_new_from_triplets(n, n, &merged).map_err(|e| format!("assemble: {e:?}"))
}

/// Find the DOFs of a mechanism: solve with two tiny regularisations; mechanism DOFs scale with
/// 1/ε while restrained ones stay put.
fn find_mechanism(elems: &[Elem], active: &[bool], eq: &[usize], n: usize, dof_owner: &[DofRef]) -> Vec<DofRef> {
    let Ok(k) = assemble(elems, active, eq, n) else { return vec![] };
    let mut max_diag = 0.0f64;
    for t in k.triplet_iter() {
        if t.row == t.col {
            max_diag = max_diag.max(*t.val);
        }
    }
    let solve_eps = |eps: f64| -> Option<Vec<f64>> {
        let mut trips: Vec<Triplet<usize, usize, f64>> = k.triplet_iter().map(|t| Triplet::new(t.row, t.col, *t.val)).collect();
        for d in 0..n {
            trips.push(Triplet::new(d, d, eps * max_diag));
        }
        let reg = SparseColMat::<usize, f64>::try_new_from_triplets(n, n, &trips).ok()?;
        let llt = reg.sp_cholesky(Side::Lower).ok()?;
        let mut f = Mat::<f64>::zeros(n, 1);
        for d in 0..n {
            f[(d, 0)] = 1.0 + ((d * 7919) % 13) as f64 * 0.1;
        }
        let u = llt.solve(&f);
        Some((0..n).map(|d| u[(d, 0)]).collect())
    };
    let (Some(u1), Some(u2)) = (solve_eps(1e-8), solve_eps(1e-10)) else { return vec![] };
    let peak = u2.iter().fold(0.0f64, |a, v| a.max(v.abs()));
    let mut out: Vec<(f64, DofRef)> = (0..n)
        .filter(|&d| u2[d].abs() > 1e-3 * peak && u2[d].abs() > 10.0 * u1[d].abs().max(1e-300))
        .map(|d| (u2[d].abs(), dof_owner[d]))
        .collect();
    out.sort_by(|a, b| b.0.total_cmp(&a.0));
    out.into_iter().take(24).map(|x| x.1).collect()
}

pub fn run(model: &Model) -> Result<Analysis, Failure> {
    let node_index: HashMap<&str, usize> = model.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    let section_props: HashMap<&str, SectionProps> = model
        .sections
        .iter()
        .map(|s| properties(s).map(|p| (s.id.as_str(), p)))
        .collect::<Result<_, _>>()
        .map_err(Failure::Input)?;
    let material_index: HashMap<&str, usize> =
        model.materials.iter().enumerate().map(|(i, m)| (m.id.as_str(), i)).collect();
    let member_index: HashMap<&str, usize> =
        model.members.iter().enumerate().map(|(i, m)| (m.id.as_str(), i)).collect();
    let mut warnings = Vec::new();

    let mut elems = Vec::with_capacity(model.members.len());
    for (idx, m) in model.members.iter().enumerate() {
        let ni = *node_index.get(m.i.as_str()).ok_or_else(|| Failure::Input(format!("member {} node {}", m.id, m.i)))?;
        let nj = *node_index.get(m.j.as_str()).ok_or_else(|| Failure::Input(format!("member {} node {}", m.id, m.j)))?;
        let sp = *section_props
            .get(m.section.as_str())
            .ok_or_else(|| Failure::Input(format!("member {} section {}", m.id, m.section)))?;
        let mi = *material_index
            .get(m.material.as_str())
            .ok_or_else(|| Failure::Input(format!("member {} material {}", m.id, m.material)))?;
        let kind = match m.kind.as_str() {
            "truss" => Kind::Truss,
            "tensionOnly" => Kind::TensionOnly,
            _ => Kind::Frame,
        };
        let mut released = [false; 12];
        if let Some(f) = m.releases.i {
            released[..6].copy_from_slice(&f.as_array());
        }
        if let Some(f) = m.releases.j {
            released[6..].copy_from_slice(&f.as_array());
        }
        if released[0] && released[6] {
            return Err(Failure::Input(format!("member {} releases axial force at both ends", m.id)));
        }
        let e = build_elem(
            idx,
            ni,
            nj,
            model.nodes[ni].xyz,
            model.nodes[nj].xyz,
            m.beta_deg,
            sp,
            mi,
            &model.materials[mi],
            kind,
            released,
        )
        .map_err(|e| Failure::Input(format!("member {}: {e}", m.id)))?;
        elems.push(e);
    }

    // Restraints: supports, optional lateral restraint, then DOFs with no stiffness at all.
    let n_nodes = model.nodes.len();
    let mut restrained = vec![false; n_nodes * 6];
    for (n, node) in model.nodes.iter().enumerate() {
        if let Some(s) = node.support {
            for (d, fixed) in s.as_array().into_iter().enumerate() {
                restrained[n * 6 + d] |= fixed;
            }
        }
    }
    if let Some(lr) = &model.analysis.lateral_restraint {
        let dofs: Vec<usize> = lr.dofs.iter().filter_map(|d| DOF_NAMES.iter().position(|x| x == d)).collect();
        let mut targets: Vec<usize> = lr.nodes.iter().filter_map(|id| node_index.get(id.as_str()).copied()).collect();
        if let Some(z) = lr.above_z {
            targets.extend((0..n_nodes).filter(|&n| model.nodes[n].xyz[2] >= z - 1e-6));
        }
        for n in targets {
            for &d in &dofs {
                restrained[n * 6 + d] = true;
            }
        }
    }
    let mut diag = vec![0.0f64; n_nodes * 6];
    for e in &elems {
        let kg = global_k(e);
        for loc in 0..12 {
            let g = if loc < 6 { e.ni * 6 + loc } else { e.nj * 6 + loc - 6 };
            diag[g] += kg[loc][loc];
        }
    }
    let max_diag = diag.iter().cloned().fold(0.0, f64::max);
    let mut auto_restrained = Vec::new();
    for g in 0..n_nodes * 6 {
        if !restrained[g] && diag[g] <= 1e-12 * max_diag {
            restrained[g] = true;
            auto_restrained.push(DofRef { node: g / 6, dof: g % 6 });
        }
    }
    let mut eq = vec![usize::MAX; n_nodes * 6];
    let mut dof_owner = Vec::new();
    for g in 0..n_nodes * 6 {
        if !restrained[g] {
            eq[g] = dof_owner.len();
            dof_owner.push(DofRef { node: g / 6, dof: g % 6 });
        }
    }
    let n_free = dof_owner.len();
    // Scale for the displacement sanity check that catches near-singular (mechanism) systems.
    let extent = {
        let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for n in &model.nodes {
            for c in 0..3 {
                lo[c] = lo[c].min(n.xyz[c]);
                hi[c] = hi[c].max(n.xyz[c]);
            }
        }
        (0..3).map(|c| hi[c] - lo[c]).fold(0.0, f64::max).max(1.0)
    };

    // Loads per pattern: nodal (global) and member (local).
    let pattern_index: HashMap<&str, usize> =
        model.load_patterns.iter().enumerate().map(|(i, p)| (p.id.as_str(), i)).collect();
    let n_pat = model.load_patterns.len();
    let mut nodal = vec![vec![0.0f64; n_nodes * 6]; n_pat];
    let mut member_loads = vec![vec![MemberLoad::default(); elems.len()]; n_pat];
    for (p, pat) in model.load_patterns.iter().enumerate() {
        if pat.self_weight {
            for e in &elems {
                let w = model.materials[e.material].density * e.fp.a;
                let g = [0.0, 0.0, -w];
                for a in 0..3 {
                    member_loads[p][e.member].q[a] += (0..3).map(|c| e.r[a][c] * g[c]).sum::<f64>();
                }
            }
        }
    }
    for load in &model.loads {
        let (pattern, targets, direction) = match load {
            Load::MemberUniform { pattern, targets, direction, .. }
            | Load::MemberPoint { pattern, targets, direction, .. }
            | Load::NodePoint { pattern, targets, direction, .. } => (pattern, targets, direction),
        };
        let p = *pattern_index.get(pattern.as_str()).ok_or_else(|| Failure::Input(format!("load pattern {pattern}")))?;
        for target in targets {
            match load {
                Load::NodePoint { value, .. } => {
                    let n = *node_index.get(target.as_str()).ok_or_else(|| Failure::Input(format!("load node {target}")))?;
                    let dir = global_direction(direction).ok_or_else(|| Failure::Input(format!("node load direction {direction}")))?;
                    for c in 0..3 {
                        nodal[p][n * 6 + c] += dir[c] * value;
                    }
                }
                Load::MemberUniform { value, .. } | Load::MemberPoint { value, .. } => {
                    let m = *member_index.get(target.as_str()).ok_or_else(|| Failure::Input(format!("load member {target}")))?;
                    let e = &elems[m];
                    let local = match (global_direction(direction), local_direction(direction)) {
                        (Some(g), _) => [0, 1, 2].map(|a| (0..3).map(|c| e.r[a][c] * g[c] * value).sum::<f64>()),
                        (None, Some(a)) => {
                            let mut v = [0.0; 3];
                            v[a] = *value;
                            v
                        }
                        _ => return Err(Failure::Input(format!("load direction {direction}"))),
                    };
                    if let Load::MemberPoint { position, .. } = load {
                        member_loads[p][m].points.push((position.clamp(0.0, 1.0) * e.length, local));
                    } else {
                        for a in 0..3 {
                            member_loads[p][m].q[a] += local[a];
                        }
                    }
                }
            }
        }
    }

    let any_tension_only = elems.iter().any(|e| e.kind == Kind::TensionOnly);
    let all_active = vec![true; elems.len()];
    let mut combos = Vec::new();

    // Pattern load vector (free DOFs) for a given active set.
    let pattern_rhs = |active: &[bool], factors: &[f64]| -> (Vec<f64>, Vec<MemberLoad>) {
        let mut f = vec![0.0; n_free];
        let mut loads = vec![MemberLoad::default(); elems.len()];
        for (p, &s) in factors.iter().enumerate() {
            if s == 0.0 {
                continue;
            }
            for g in 0..n_nodes * 6 {
                if eq[g] != usize::MAX {
                    f[eq[g]] += s * nodal[p][g];
                }
            }
            for (m, ml) in member_loads[p].iter().enumerate() {
                if !ml.is_empty() {
                    loads[m].add_scaled(ml, s);
                }
            }
        }
        for (m, e) in elems.iter().enumerate() {
            if !active[m] || loads[m].is_empty() {
                continue;
            }
            let f0 = condense_load(e, &fixed_end(e, &loads[m]));
            let fg = to_global(&e.r, &f0);
            for loc in 0..12 {
                let g = if loc < 6 { e.ni * 6 + loc } else { e.nj * 6 + loc - 6 };
                if eq[g] != usize::MAX {
                    f[eq[g]] -= fg[loc];
                }
            }
        }
        (f, loads)
    };

    let factors_of = |c: &crate::model::Combination| -> Result<Vec<f64>, Failure> {
        let mut factors = vec![0.0; n_pat];
        for t in &c.terms {
            let p = *pattern_index
                .get(t.pattern.as_str())
                .ok_or_else(|| Failure::Input(format!("combination {} pattern {}", c.id, t.pattern)))?;
            factors[p] += t.factor;
        }
        Ok(factors)
    };

    let solve_with = |active: &[bool], f: &[f64]| -> Result<Vec<f64>, Failure> {
        if n_free == 0 {
            return Ok(vec![]);
        }
        let k = assemble(&elems, active, &eq, n_free).map_err(Failure::Input)?;
        let llt = k
            .sp_cholesky(Side::Lower)
            .map_err(|_| Failure::Mechanism(find_mechanism(&elems, active, &eq, n_free, &dof_owner)))?;
        let mut rhs = Mat::<f64>::zeros(n_free, 1);
        for d in 0..n_free {
            rhs[(d, 0)] = f[d];
        }
        let u = llt.solve(&rhs);
        let u: Vec<f64> = (0..n_free).map(|d| u[(d, 0)]).collect();
        // A factorisation can pass on a singular system by round-off; absurd displacements expose it.
        let absurd = u.iter().enumerate().any(|(d, v)| {
            let limit = if dof_owner[d].dof < 3 { 10.0 * extent } else { 10.0 };
            !v.is_finite() || v.abs() > limit
        });
        if absurd {
            return Err(Failure::Mechanism(find_mechanism(&elems, active, &eq, n_free, &dof_owner)));
        }
        Ok(u)
    };

    for combo in &model.combinations {
        let factors = factors_of(combo)?;
        let mut active = all_active.clone();
        let mut iterations = 0;
        let (u_free, loads) = loop {
            let (f, loads) = pattern_rhs(&active, &factors);
            let u = solve_with(&active, &f)?;
            if !any_tension_only {
                break (u, loads);
            }
            iterations += 1;
            let mut changed = false;
            for (m, e) in elems.iter().enumerate() {
                if e.kind != Kind::TensionOnly || !active[m] {
                    continue;
                }
                let mut ug = [0.0; 12];
                for loc in 0..12 {
                    let g = if loc < 6 { e.ni * 6 + loc } else { e.nj * 6 + loc - 6 };
                    if eq[g] != usize::MAX {
                        ug[loc] = u[eq[g]];
                    }
                }
                let ul = to_local(&e.r, &ug);
                let axial = e.kc[0][0] * (ul[6] - ul[0]);
                if axial < -1e-9 {
                    active[m] = false;
                    changed = true;
                }
            }
            if !changed {
                break (u, loads);
            }
            if iterations >= 20 {
                warnings.push(format!("combination {}: tension-only members did not settle in 20 iterations", combo.id));
                break (u, loads);
            }
        };

        let mut u = vec![0.0; n_nodes * 6];
        for g in 0..n_nodes * 6 {
            if eq[g] != usize::MAX {
                u[g] = u_free[eq[g]];
            }
        }
        let mut end_forces = vec![[0.0; 12]; elems.len()];
        let mut end_disp = vec![[0.0; 12]; elems.len()];
        let mut node_force = vec![0.0; n_nodes * 6];
        for (m, e) in elems.iter().enumerate() {
            if !active[m] {
                continue;
            }
            let mut ug = [0.0; 12];
            ug[..6].copy_from_slice(&u[e.ni * 6..e.ni * 6 + 6]);
            ug[6..].copy_from_slice(&u[e.nj * 6..e.nj * 6 + 6]);
            let ul = to_local(&e.r, &ug);
            let f0_raw = fixed_end(e, &loads[m]);
            let f0 = condense_load(e, &f0_raw);
            let mut f = mat_vec(&e.kc, &ul);
            for i in 0..12 {
                f[i] += f0[i];
            }
            end_forces[m] = f;
            end_disp[m] = recover(e, &ul, &f0_raw);
            let fg = to_global(&e.r, &f);
            for loc in 0..12 {
                let g = if loc < 6 { e.ni * 6 + loc } else { e.nj * 6 + loc - 6 };
                node_force[g] += fg[loc];
            }
        }
        // Reactions R = Σ member end forces − applied nodal load, at restrained DOFs.
        let mut reactions = vec![0.0; n_nodes * 6];
        let mut applied_total = [0.0; 3];
        for g in 0..n_nodes * 6 {
            let applied: f64 = factors.iter().enumerate().map(|(p, s)| s * nodal[p][g]).sum();
            if g % 6 < 3 {
                applied_total[g % 6] += applied;
            }
            if restrained[g] {
                reactions[g] = node_force[g] - applied;
            }
        }
        for (m, e) in elems.iter().enumerate() {
            if !active[m] {
                continue;
            }
            let ml = &loads[m];
            let mut local = [ml.q[0] * e.length, ml.q[1] * e.length, ml.q[2] * e.length];
            for (_, p) in &ml.points {
                for a in 0..3 {
                    local[a] += p[a];
                }
            }
            for c in 0..3 {
                applied_total[c] += (0..3).map(|a| e.r[a][c] * local[a]).sum::<f64>();
            }
        }
        let mut reaction_total = [0.0; 3];
        for g in 0..n_nodes * 6 {
            if g % 6 < 3 {
                reaction_total[g % 6] += reactions[g];
            }
        }
        let applied_norm = applied_total.iter().map(|v| v * v).sum::<f64>().sqrt();
        let residual = (0..3).map(|c| (reaction_total[c] + applied_total[c]).powi(2)).sum::<f64>().sqrt();
        combos.push(ComboResult {
            id: combo.id.clone(),
            service: combo.limit_state == "service",
            u,
            reactions,
            end_forces,
            end_disp,
            loads,
            active,
            equilibrium_error: if applied_norm > 1e-12 { residual / applied_norm } else { residual },
        });
    }

    if !auto_restrained.is_empty() {
        warnings.push(format!(
            "{} degrees of freedom had no stiffness and were restrained automatically",
            auto_restrained.len()
        ));
    }
    Ok(Analysis {
        node_ids: model.nodes.iter().map(|n| n.id.clone()).collect(),
        elems,
        restrained,
        auto_restrained,
        combos,
        warnings,
    })
}

/// Internal forces at distance x from end i (ARCH-02 §4 sign convention), [N, V2, V3, T, M2, M3].
pub fn internal_forces(e: &Elem, f: &[f64; 12], load: &MemberLoad, x: f64) -> [f64; 6] {
    let fi = [f[0], f[1], f[2]];
    let mi = [f[3], f[4], f[5]];
    let mut fs = [fi[0] + load.q[0] * x, fi[1] + load.q[1] * x, fi[2] + load.q[2] * x];
    let mut ms = [mi[0], mi[1] + x * fi[2] + x * x / 2.0 * load.q[2], mi[2] - x * fi[1] - x * x / 2.0 * load.q[1]];
    for &(a, p) in &load.points {
        if a < x - 1e-12 {
            for k in 0..3 {
                fs[k] += p[k];
            }
            ms[1] += (x - a) * p[2];
            ms[2] -= (x - a) * p[1];
        }
    }
    let _ = e;
    [-fs[0], -fs[1], -fs[2], -ms[0], -ms[1], -ms[2]]
}

/// Chord-relative transverse deflection (local 2, local 3) at distance x, in m.
pub fn deflection(e: &Elem, u: &[f64; 12], load: &MemberLoad, x: f64) -> [f64; 2] {
    let l = e.length;
    let s = x / l;
    let n1 = 1.0 - 3.0 * s * s + 2.0 * s.powi(3);
    let n2 = l * (s - 2.0 * s * s + s.powi(3));
    let n3 = 3.0 * s * s - 2.0 * s.powi(3);
    let n4 = l * (-s * s + s.powi(3));
    // v along local 2 with slope r3; w along local 3 with slope −r2.
    let mut v = n1 * u[1] + n2 * u[5] + n3 * u[7] + n4 * u[11];
    let mut w = n1 * u[2] - n2 * u[4] + n3 * u[8] - n4 * u[10];
    if e.kind == Kind::Frame {
        let ei3 = e.fp.e * e.fp.i3;
        let ei2 = e.fp.e * e.fp.i2;
        v += load.q[1] * x * x * (l - x).powi(2) / (24.0 * ei3);
        w += load.q[2] * x * x * (l - x).powi(2) / (24.0 * ei2);
        for &(a, p) in &load.points {
            let fixed = |pv: f64, ei: f64| -> f64 {
                let (aa, bb, xx) = if x <= a { (a, l - a, x) } else { (l - a, a, l - x) };
                pv * bb * bb * xx * xx * (3.0 * aa * l - (3.0 * aa + bb) * xx) / (6.0 * ei * l.powi(3))
            };
            v += fixed(p[1], ei3);
            w += fixed(p[2], ei2);
        }
    }
    [v - ((1.0 - s) * u[1] + s * u[7]), w - ((1.0 - s) * u[2] + s * u[8])]
}
