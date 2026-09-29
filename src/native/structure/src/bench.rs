//! Synthetic 3D frame benchmark for the core-binding experiment (PLAN-17 T-033).
//! A regular grid of columns and two-way beams, fixed at the base, loaded by gravity
//! point loads at every node. Solves one factorization for many load vectors.

use crate::frame::{global_stiffness, FrameProps};
use faer::sparse::{SparseColMat, Triplet};
use faer::prelude::Solve;
use faer::{Mat, Side};
use serde::Serialize;
use std::time::Instant;

#[derive(Serialize)]
pub struct BenchReport {
    pub nodes: usize,
    pub members: usize,
    pub dof: usize,
    pub nnz: usize,
    pub combos: usize,
    pub assemble_ms: f64,
    pub factor_ms: f64,
    pub solve_ms: f64,
    pub total_ms: f64,
    pub residual_rel: f64,
    pub reaction_error_rel: f64,
}

pub fn run(nx: usize, ny: usize, nz: usize, combos: usize) -> Result<BenchReport, String> {
    let t0 = Instant::now();
    let (bay, story) = (6.0, 4.0);
    let id = |i: usize, j: usize, k: usize| (k * ny + j) * nx + i;
    let n_nodes = nx * ny * nz;
    let xyz: Vec<[f64; 3]> = (0..n_nodes)
        .map(|n| {
            let (i, j, k) = (n % nx, (n / nx) % ny, n / (nx * ny));
            [i as f64 * bay, j as f64 * bay, k as f64 * story]
        })
        .collect();
    let col = FrameProps { e: 205e6, g: 79e6, a: 0.0119, i2: 1.6e-4, i3: 4.72e-4, j: 2.0e-6 };
    let beam = FrameProps { e: 205e6, g: 79e6, a: 0.0085, i2: 1.4e-5, i3: 2.37e-4, j: 5.0e-7 };
    let mut members: Vec<(usize, usize, FrameProps)> = Vec::new();
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                if k + 1 < nz {
                    members.push((id(i, j, k), id(i, j, k + 1), col));
                }
                if k > 0 && i + 1 < nx {
                    members.push((id(i, j, k), id(i + 1, j, k), beam));
                }
                if k > 0 && j + 1 < ny {
                    members.push((id(i, j, k), id(i, j + 1, k), beam));
                }
            }
        }
    }
    // Base nodes (k = 0) are fixed; every other DOF is free.
    let mut eq = vec![usize::MAX; n_nodes * 6];
    let mut dof = 0;
    for n in nx * ny..n_nodes {
        for d in 0..6 {
            eq[n * 6 + d] = dof;
            dof += 1;
        }
    }
    let mut trips: Vec<(usize, usize, f64)> = Vec::with_capacity(members.len() * 144);
    for &(a, b, p) in &members {
        let k = global_stiffness(p, xyz[a], xyz[b], 0.0);
        let map = |loc: usize| if loc < 6 { eq[a * 6 + loc] } else { eq[b * 6 + loc - 6] };
        for r in 0..12 {
            let gr = map(r);
            if gr == usize::MAX {
                continue;
            }
            for c in 0..12 {
                let gc = map(c);
                if gc != usize::MAX && k[r][c] != 0.0 {
                    trips.push((gr, gc, k[r][c]));
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
    let nnz = merged.len();
    let kmat = SparseColMat::<usize, f64>::try_new_from_triplets(dof, dof, &merged)
        .map_err(|e| format!("assemble: {e:?}"))?;
    let assemble_ms = t0.elapsed().as_secs_f64() * 1e3;

    let t1 = Instant::now();
    let llt = kmat.sp_cholesky(Side::Lower).map_err(|e| format!("factor: {e:?}"))?;
    let factor_ms = t1.elapsed().as_secs_f64() * 1e3;

    // Load vectors: gravity at every free node, scaled per combination, plus a small lateral part.
    let mut f = Mat::<f64>::zeros(dof, combos);
    for c in 0..combos {
        let s = 1.0 + 0.1 * c as f64;
        for n in nx * ny..n_nodes {
            f[(eq[n * 6 + 2], c)] = -10.0 * s;
            f[(eq[n * 6], c)] = 0.05 * c as f64;
        }
    }
    let t2 = Instant::now();
    let u = llt.solve(&f);
    let solve_ms = t2.elapsed().as_secs_f64() * 1e3;

    // Residual of the first combination.
    let ku = &kmat * &u;
    let (mut rn, mut fnorm) = (0.0f64, 0.0f64);
    for r in 0..dof {
        rn += (ku[(r, 0)] - f[(r, 0)]).powi(2);
        fnorm += f[(r, 0)].powi(2);
    }
    // Equilibrium: base reactions from the column forces must balance the applied vertical load.
    let mut applied_z = 0.0;
    for n in nx * ny..n_nodes {
        applied_z += f[(eq[n * 6 + 2], 0)];
    }
    let mut reaction_z = 0.0;
    for &(a, b, p) in &members {
        if a >= nx * ny {
            continue;
        }
        let k = global_stiffness(p, xyz[a], xyz[b], 0.0);
        let mut ue = [0.0; 12];
        for loc in 6..12 {
            let g = eq[b * 6 + loc - 6];
            if g != usize::MAX {
                ue[loc] = u[(g, 0)];
            }
        }
        reaction_z += (0..12).map(|c| k[2][c] * ue[c]).sum::<f64>();
    }
    Ok(BenchReport {
        nodes: n_nodes,
        members: members.len(),
        dof,
        nnz,
        combos,
        assemble_ms,
        factor_ms,
        solve_ms,
        total_ms: t0.elapsed().as_secs_f64() * 1e3,
        residual_rel: (rn / fnorm).sqrt(),
        reaction_error_rel: ((reaction_z + applied_z) / applied_z).abs(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn small_grid_is_in_equilibrium() {
        let r = super::run(3, 3, 3, 2).unwrap();
        assert!(r.residual_rel < 1e-9, "residual {}", r.residual_rel);
        assert!(r.reaction_error_rel < 1e-9, "reaction {}", r.reaction_error_rel);
    }
}
