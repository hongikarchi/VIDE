//! 3D Euler–Bernoulli frame element (ARCH-02 §2, §5).
//!
//! Local axes: 1 runs i → j; 2 is the section web direction, lying in the vertical plane
//! through axis 1 and pointing toward +Z (global +X for vertical members); 3 = 1 × 2.
//! `beta_deg` rotates axes 2 and 3 about axis 1 by the right-hand rule. Strong-axis
//! bending is the moment about axis 3 (M3), carried by I3. DOF order per node is
//! [u1, u2, u3, r1, r2, r3].

pub type Vec3 = [f64; 3];
pub type Mat12 = [[f64; 12]; 12];

/// Cosine threshold above which a member counts as vertical.
pub const VERTICAL_COS: f64 = 0.9999;

#[derive(Clone, Copy, Debug)]
pub struct FrameProps {
    pub e: f64,
    pub g: f64,
    pub a: f64,
    pub i2: f64,
    pub i3: f64,
    pub j: f64,
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: Vec3) -> Vec3 {
    scale(a, 1.0 / norm(a))
}

/// Rows are the local axes 1, 2, 3 expressed in global coordinates.
pub fn local_axes(xi: Vec3, xj: Vec3, beta_deg: f64) -> ([Vec3; 3], f64) {
    let d = sub(xj, xi);
    let length = norm(d);
    let e1 = scale(d, 1.0 / length);
    let z = [0.0, 0.0, 1.0];
    let e2 = if e1[2].abs() >= VERTICAL_COS {
        [1.0, 0.0, 0.0]
    } else {
        unit(sub(z, scale(e1, dot(z, e1))))
    };
    let e3 = cross(e1, e2);
    let (s, c) = beta_deg.to_radians().sin_cos();
    let r2 = [c * e2[0] + s * e3[0], c * e2[1] + s * e3[1], c * e2[2] + s * e3[2]];
    let r3 = [-s * e2[0] + c * e3[0], -s * e2[1] + c * e3[1], -s * e2[2] + c * e3[2]];
    ([e1, r2, r3], length)
}

/// Local 12×12 stiffness.
pub fn local_stiffness(p: FrameProps, l: f64) -> Mat12 {
    let mut k = [[0.0; 12]; 12];
    let mut set = |r: usize, c: usize, v: f64| {
        k[r][c] = v;
        k[c][r] = v;
    };
    let ea = p.e * p.a / l;
    let gj = p.g * p.j / l;
    set(0, 0, ea);
    set(6, 6, ea);
    set(0, 6, -ea);
    set(3, 3, gj);
    set(9, 9, gj);
    set(3, 9, -gj);
    // Bending in the 1-2 plane (u2, r3) — I3.
    let (a, b, c, d) = (
        12.0 * p.e * p.i3 / l.powi(3),
        6.0 * p.e * p.i3 / l.powi(2),
        4.0 * p.e * p.i3 / l,
        2.0 * p.e * p.i3 / l,
    );
    set(1, 1, a);
    set(1, 5, b);
    set(1, 7, -a);
    set(1, 11, b);
    set(5, 5, c);
    set(5, 7, -b);
    set(5, 11, d);
    set(7, 7, a);
    set(7, 11, -b);
    set(11, 11, c);
    // Bending in the 1-3 plane (u3, r2) — I2.
    let (a, b, c, d) = (
        12.0 * p.e * p.i2 / l.powi(3),
        6.0 * p.e * p.i2 / l.powi(2),
        4.0 * p.e * p.i2 / l,
        2.0 * p.e * p.i2 / l,
    );
    set(2, 2, a);
    set(2, 4, -b);
    set(2, 8, -a);
    set(2, 10, -b);
    set(4, 4, c);
    set(4, 8, b);
    set(4, 10, d);
    set(8, 8, a);
    set(8, 10, b);
    set(10, 10, c);
    k
}

/// Global stiffness Tᵀ·K·T with T = diag(R, R, R, R).
pub fn global_stiffness(p: FrameProps, xi: Vec3, xj: Vec3, beta_deg: f64) -> Mat12 {
    let (r, l) = local_axes(xi, xj, beta_deg);
    let kl = local_stiffness(p, l);
    let t = |row: usize, col: usize| -> f64 {
        if row / 3 != col / 3 {
            0.0
        } else {
            r[row % 3][col % 3]
        }
    };
    // KT = K·T, then Tᵀ·KT (T is block-diagonal, so each entry sums three terms).
    let mut kt = [[0.0; 12]; 12];
    for i in 0..12 {
        for j in 0..12 {
            let b = (j / 3) * 3;
            kt[i][j] = (0..3).map(|m| kl[i][b + m] * t(b + m, j)).sum();
        }
    }
    let mut kg = [[0.0; 12]; 12];
    for i in 0..12 {
        let b = (i / 3) * 3;
        for j in 0..12 {
            kg[i][j] = (0..3).map(|m| t(b + m, i) * kt[b + m][j]).sum();
        }
    }
    kg
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: FrameProps = FrameProps { e: 200e6, g: 77e6, a: 0.01, i2: 2e-5, i3: 1e-4, j: 1e-6 };

    #[test]
    fn horizontal_member_axes_follow_convention() {
        let (r, l) = local_axes([0.0, 0.0, 0.0], [4.0, 0.0, 0.0], 0.0);
        assert!((l - 4.0).abs() < 1e-12);
        assert_eq!(r[0], [1.0, 0.0, 0.0]);
        assert_eq!(r[1], [0.0, 0.0, 1.0]);
        assert_eq!(r[2], [0.0, -1.0, 0.0]);
    }

    #[test]
    fn vertical_member_axis_two_is_global_x() {
        let (r, _) = local_axes([0.0, 0.0, 0.0], [0.0, 0.0, 3.0], 0.0);
        assert_eq!(r[1], [1.0, 0.0, 0.0]);
        assert_eq!(r[2], [0.0, 1.0, 0.0]);
    }

    #[test]
    fn global_stiffness_is_symmetric_and_rigid_body_free() {
        let k = global_stiffness(P, [1.0, 2.0, 0.5], [4.0, -1.0, 3.0], 30.0);
        for i in 0..12 {
            for j in 0..12 {
                assert!((k[i][j] - k[j][i]).abs() <= 1e-6 * k[i][i].abs().max(1.0));
            }
        }
        // A rigid translation produces no force.
        for axis in 0..3 {
            for i in 0..12 {
                let f = k[i][axis] + k[i][6 + axis];
                assert!(f.abs() < 1e-3, "translation {axis} leaks {f}");
            }
        }
    }
}
