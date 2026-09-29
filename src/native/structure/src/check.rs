//! Steel member checks following KDS 14 31 10, which mirrors AISC 360 (LRFD).
//! Clause labels use the AISC chapter letters; KDS article numbers are mapped later.
//! Units inside: N, mm, MPa.

use crate::model::{Material, Member};
use crate::section::Shape;
use crate::solve::{deflection, internal_forces, Analysis, Elem, Kind, SAMPLES};
use serde::Serialize;
use std::collections::BTreeMap;
use std::f64::consts::PI;

#[derive(Serialize, Clone)]
pub struct Part {
    pub clause: String,
    pub ratio: f64,
    pub combo: String,
    pub values: BTreeMap<String, f64>,
}

#[derive(Serialize)]
pub struct MemberCheck {
    pub member: String,
    pub status: String,
    pub ratio: Option<f64>,
    pub governing: Option<Governing>,
    pub parts: Vec<Part>,
    pub notes: Vec<String>,
}

#[derive(Serialize)]
pub struct Governing {
    pub combo: String,
    pub clause: String,
}

struct Strength {
    fy: f64,
    e: f64,
    phi_pn_c: Option<(f64, BTreeMap<String, f64>)>,
    phi_pn_t: f64,
    phi_mn3: Option<(f64, BTreeMap<String, f64>)>,
    phi_mn2: Option<f64>,
    phi_vn2: f64,
    phi_vn3: f64,
    pe1_2: f64,
    pe1_3: f64,
}

fn yield_strength(mat: &Material, t_max: f64) -> f64 {
    let mut rows = mat.fy_by_thickness.clone();
    rows.sort_by(|a, b| a.t_max_mm.total_cmp(&b.t_max_mm));
    rows.iter().find(|r| t_max <= r.t_max_mm + 1e-9).map(|r| r.fy_mpa).unwrap_or(mat.fy_mpa)
}

fn values(pairs: &[(&str, f64)]) -> BTreeMap<String, f64> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

/// Lateral-torsional buckling strength (F2) of a doubly symmetric I section; returns Mn and values.
pub fn f2_ltb(sp: &crate::section::SectionProps, h: f64, tf: f64, fy: f64, e: f64, lb: f64, cb: f64) -> (f64, BTreeMap<String, f64>) {
    let mp = fy * sp.z3;
    let sx = sp.s3;
    let ry = sp.r2();
    let rts = ((sp.i2 * sp.cw).sqrt() / sx).sqrt();
    let ho = h - tf;
    let jc = sp.j / (sx * ho);
    let lp = 1.76 * ry * (e / fy).sqrt();
    let lr = 1.95 * rts * e / (0.7 * fy) * (jc + (jc * jc + 6.76 * (0.7 * fy / e).powi(2)).sqrt()).sqrt();
    let mn = if lb <= lp {
        mp
    } else if lb <= lr {
        (cb * (mp - (mp - 0.7 * fy * sx) * (lb - lp) / (lr - lp))).min(mp)
    } else {
        let fcr = cb * PI * PI * e / (lb / rts).powi(2) * (1.0 + 0.078 * jc * (lb / rts).powi(2)).sqrt();
        (fcr * sx).min(mp)
    };
    (mn, values(&[("Mp_kNm", mp / 1e6), ("Lp_m", lp / 1e3), ("Lr_m", lr / 1e3), ("Lb_m", lb / 1e3), ("Cb", cb), ("rts_mm", rts), ("Mn_kNm", mn / 1e6)]))
}

/// Effective area for slender compression elements (E7). Each element: (b, t, λr, c1, c2, count).
pub fn e7_effective_area(ag: f64, fy: f64, fcr: f64, elements: &[(f64, f64, f64, f64, f64, f64)]) -> f64 {
    let mut ae = ag;
    for &(b, t, lam_r, c1, c2, count) in elements {
        let lam = b / t;
        if lam <= lam_r * (fy / fcr).sqrt() {
            continue;
        }
        let fel = (c2 * lam_r / lam).powi(2) * fy;
        let be = b * (1.0 - c1 * (fel / fcr).sqrt()) * (fel / fcr).sqrt();
        ae -= count * (b - be.min(b)) * t;
    }
    ae
}

/// Flexural buckling (E3) for a given slenderness; returns Fcr.
pub fn e3_fcr(fy: f64, e: f64, slenderness: f64) -> (f64, f64) {
    let fe = PI * PI * e / slenderness.powi(2);
    let fcr = if fy / fe <= 2.25 { 0.658f64.powf(fy / fe) * fy } else { 0.877 * fe };
    (fcr, fe)
}

fn strength(e_: &Elem, m: &Member, mat: &Material, rolled: bool, notes: &mut Vec<String>, incomplete: &mut bool) -> Strength {
    let sp = &e_.section;
    let fy = yield_strength(mat, sp.t_max);
    let e = mat.e_mpa;
    let l = e_.length * 1e3;
    let k2 = m.design.k2.unwrap_or(1.0);
    let k3 = m.design.k3.unwrap_or(1.0);
    if m.design.k2.is_none() || m.design.k3.is_none() {
        notes.push("K = 1.0 가정".into());
    }
    let (r2, r3) = (sp.r2(), sp.r3());
    let (lc2, lc3) = (k2 * l / r2, k3 * l / r3);
    let slender = lc2.max(lc3);
    let (fcr, fe) = e3_fcr(fy, e, slender);
    let mut phi_pn_c = Some((
        0.9 * fcr * sp.a,
        values(&[("Lc_r", slender), ("Fe_MPa", fe), ("Fcr_MPa", fcr), ("phiPn_kN", 0.9 * fcr * sp.a / 1e3), ("Fy_MPa", fy)]),
    ));
    let pe1_2 = PI * PI * e * sp.i2 / (k2 * l).powi(2);
    let pe1_3 = PI * PI * e * sp.i3 / (k3 * l).powi(2);
    let root = (e / fy).sqrt();
    let mut phi_mn3 = None;
    let mut phi_mn2 = None;
    let (mut phi_vn2, mut phi_vn3) = (0.0, 0.0);
    match sp.shape {
        Shape::I { h, b, tw, tf, r } => {
            let lam_f = b / (2.0 * tf);
            let hw = h - 2.0 * tf - 2.0 * r;
            let lam_w = hw / tw;
            // E7: slender web/flanges reduce the compression area to Ae (effective widths).
            let ae = e7_effective_area(sp.a, fy, fcr, &[(hw, tw, 1.49 * root, 0.18, 1.31, 1.0), (b / 2.0, tf, 0.56 * root, 0.22, 1.49, 4.0)]);
            if ae < sp.a {
                if let Some((phi, vals)) = phi_pn_c.as_mut() {
                    *phi = 0.9 * fcr * ae;
                    vals.insert("Ae_mm2".into(), ae);
                    vals.insert("phiPn_kN".into(), 0.9 * fcr * ae / 1e3);
                }
            }
            let (lpf, lrf) = (0.38 * root, 1.0 * root);
            if lam_w > 3.76 * root {
                notes.push("비조밀 웨브 휨(F4·F5) 미구현".into());
                *incomplete = true;
            }
            let lb = m.design.lb_m.map(|v| v * 1e3).unwrap_or(l);
            if m.design.lb_m.is_none() {
                notes.push("비지지 길이 Lb = 부재 길이 가정".into());
            }
            let cb = m.design.cb.unwrap_or(1.0);
            let (mut mn, mut vals) = f2_ltb(sp, h, tf, fy, e, lb, cb);
            let mp = fy * sp.z3;
            if lam_f > lpf {
                let flb = if lam_f <= lrf {
                    mp - (mp - 0.7 * fy * sp.s3) * (lam_f - lpf) / (lrf - lpf)
                } else {
                    let kc = (4.0 / lam_w.sqrt()).clamp(0.35, 0.76);
                    0.9 * e * kc * sp.s3 / (lam_f * lam_f)
                };
                if flb < mn {
                    mn = flb;
                }
                vals.insert("MnFLB_kNm".into(), flb / 1e6);
            }
            vals.insert("phiMn_kNm".into(), 0.9 * mn / 1e6);
            phi_mn3 = Some((0.9 * mn, vals));
            let mp2 = (fy * sp.z2).min(1.6 * fy * sp.s2);
            let mn2 = if lam_f <= lpf { mp2 } else { mp2 - (mp2 - 0.7 * fy * sp.s2) * ((lam_f - lpf) / (lrf - lpf)).min(1.0) };
            phi_mn2 = Some(0.9 * mn2);
            let kv = 5.34;
            let aw = h * tw;
            let (phi_v, cv1) = if rolled && lam_w <= 2.24 * root {
                (1.0, 1.0)
            } else if lam_w <= 1.10 * (kv * e / fy).sqrt() {
                (0.9, 1.0)
            } else {
                (0.9, 1.10 * (kv * e / fy).sqrt() / lam_w)
            };
            phi_vn2 = phi_v * 0.6 * fy * aw * cv1;
            phi_vn3 = 0.9 * 0.6 * fy * 2.0 * b * tf;
        }
        Shape::Box { h, b, t } => {
            if (b - 3.0 * t) / t > 1.12 * root || (h - 3.0 * t) / t > 2.42 * root {
                notes.push("비조밀 각형강관 휨 미구현".into());
                *incomplete = true;
            }
            phi_mn3 = Some((0.9 * fy * sp.z3, values(&[("Mp_kNm", fy * sp.z3 / 1e6)])));
            phi_mn2 = Some(0.9 * fy * sp.z2);
            phi_vn2 = 0.9 * 0.6 * fy * 2.0 * h * t;
            phi_vn3 = 0.9 * 0.6 * fy * 2.0 * b * t;
        }
        Shape::Pipe { d, t } => {
            if d / t > 0.07 * e / fy {
                notes.push("비조밀 원형강관 휨 미구현".into());
                *incomplete = true;
            }
            phi_mn3 = Some((0.9 * fy * sp.z3, values(&[("Mp_kNm", fy * sp.z3 / 1e6)])));
            phi_mn2 = Some(0.9 * fy * sp.z2);
            phi_vn2 = 0.9 * 0.6 * fy * sp.a / 2.0;
            phi_vn3 = phi_vn2;
        }
        Shape::Rod { .. } => {
            let mn = (fy * sp.z3).min(1.6 * fy * sp.s3);
            phi_mn3 = Some((0.9 * mn, values(&[("Mp_kNm", mn / 1e6)])));
            phi_mn2 = Some(0.9 * mn);
            phi_vn2 = 0.9 * 0.6 * fy * sp.a * 0.75;
            phi_vn3 = phi_vn2;
        }
        Shape::Other => {
            if e_.kind == Kind::Frame {
                notes.push("이 단면 형상의 휨·전단 검정 미구현".into());
                *incomplete = true;
            }
            phi_pn_c = phi_pn_c.filter(|_| e_.kind != Kind::Frame);
        }
    }
    Strength { fy, e, phi_pn_c, phi_pn_t: 0.9 * fy * sp.a, phi_mn3, phi_mn2, phi_vn2, phi_vn3, pe1_2, pe1_3 }
}

fn update(parts: &mut BTreeMap<String, Part>, clause: &str, ratio: f64, combo: &str, vals: impl FnOnce() -> BTreeMap<String, f64>) {
    let replace = match parts.get(clause) {
        Some(p) => ratio > p.ratio,
        None => true,
    };
    if replace {
        parts.insert(clause.to_string(), Part { clause: clause.to_string(), ratio, combo: combo.to_string(), values: vals() });
    }
}

/// `rolled[member]` is true for rolled sections (shape H), false for built-up (BH) and others.
pub fn check_members(an: &Analysis, members: &[Member], materials: &[Material], limits: &BTreeMap<String, f64>, rolled: &[bool]) -> Vec<MemberCheck> {
    let mut out = Vec::with_capacity(an.elems.len());
    for (idx, e_) in an.elems.iter().enumerate() {
        let m = &members[e_.member];
        let mat = &materials[e_.material];
        let mut notes = Vec::new();
        let mut incomplete = false;
        let st = strength(e_, m, mat, rolled[e_.member], &mut notes, &mut incomplete);
        let l = e_.length;
        let mut parts: BTreeMap<String, Part> = BTreeMap::new();
        let vertical = e_.r[0][2].abs() >= crate::frame::VERTICAL_COS;
        for combo in &an.combos {
            if !combo.active[idx] {
                continue;
            }
            let f = &combo.end_forces[idx];
            let load = &combo.loads[idx];
            if combo.service {
                if e_.kind == Kind::Frame && !vertical {
                    let n = limits.get(&m.role).or_else(|| limits.get("other")).copied().unwrap_or(240.0);
                    let mut dmax = 0.0f64;
                    for s in 0..SAMPLES {
                        let x = l * s as f64 / (SAMPLES - 1) as f64;
                        let d = deflection(e_, &combo.end_disp[idx], load, x);
                        dmax = dmax.max((d[0] * d[0] + d[1] * d[1]).sqrt());
                    }
                    let limit = l / n;
                    update(&mut parts, "처짐", dmax / limit, &combo.id, || values(&[("delta_mm", dmax * 1e3), ("limit_mm", limit * 1e3), ("L_over_n", n)]));
                }
                continue;
            }
            let mut xs: Vec<f64> = (0..SAMPLES).map(|s| l * s as f64 / (SAMPLES - 1) as f64).collect();
            for (a, _) in &load.points {
                xs.push((*a).clamp(0.0, l));
            }
            let forces: Vec<[f64; 6]> = xs.iter().map(|&x| internal_forces(e_, f, load, x)).collect();
            // Axial force (N): the most compressive and the most tensile.
            let n_min = forces.iter().map(|q| q[0]).fold(f64::INFINITY, f64::min) * 1e3;
            let n_max = forces.iter().map(|q| q[0]).fold(f64::NEG_INFINITY, f64::max) * 1e3;
            let transverse = load.q[1] != 0.0 || load.q[2] != 0.0 || !load.points.is_empty();
            let m3_end = (forces[0][5], forces[SAMPLES - 1][5]);
            let m2_end = (forces[0][4], forces[SAMPLES - 1][4]);
            let cm = |ends: (f64, f64)| -> f64 {
                if transverse {
                    return 1.0;
                }
                let (a, b) = if ends.0.abs() <= ends.1.abs() { ends } else { (ends.1, ends.0) };
                if b.abs() < 1e-12 {
                    return 1.0;
                }
                0.6 - 0.4 * (-(a / b))
            };
            let pr_c = (-n_min).max(0.0);
            let b1 = |pe1: f64, ends: (f64, f64)| -> f64 {
                if pr_c <= 0.0 {
                    return 1.0;
                }
                if pr_c >= pe1 {
                    return f64::INFINITY;
                }
                (cm(ends) / (1.0 - pr_c / pe1)).max(1.0)
            };
            let b1_3 = b1(st.pe1_3, m3_end);
            let b1_2 = b1(st.pe1_2, m2_end);
            if pr_c > 0.0 {
                match &st.phi_pn_c {
                    Some((phi_pn, vals)) => {
                        update(&mut parts, "E3 압축", pr_c / phi_pn, &combo.id, || {
                            let mut v = vals.clone();
                            v.insert("Pu_kN".into(), pr_c / 1e3);
                            v
                        });
                        let slender = vals.get("Lc_r").copied().unwrap_or(0.0);
                        let limit = if e_.kind == Kind::TensionOnly { f64::INFINITY } else { 200.0 };
                        update(&mut parts, "세장비", slender / limit, &combo.id, || values(&[("KL_r", slender), ("limit", 200.0)]));
                    }
                    None => incomplete = true,
                }
            }
            if n_max > 0.0 {
                update(&mut parts, "D2 인장", n_max / st.phi_pn_t, &combo.id, || values(&[("Tu_kN", n_max / 1e3), ("phiPn_kN", st.phi_pn_t / 1e3)]));
            }
            if e_.kind != Kind::Frame {
                continue;
            }
            let (Some((phi_mn3, vals3)), Some(phi_mn2)) = (&st.phi_mn3, st.phi_mn2) else {
                incomplete = true;
                continue;
            };
            let m3max = forces.iter().map(|q| q[5].abs()).fold(0.0, f64::max) * 1e6;
            let m2max = forces.iter().map(|q| q[4].abs()).fold(0.0, f64::max) * 1e6;
            let v2max = forces.iter().map(|q| q[1].abs()).fold(0.0, f64::max) * 1e3;
            let v3max = forces.iter().map(|q| q[2].abs()).fold(0.0, f64::max) * 1e3;
            // Cb from the moment diagram when the whole member is one unbraced segment.
            let mut phi_mn3_c = *phi_mn3;
            let mut vals3_c = vals3.clone();
            if let (Shape::I { h, tf, .. }, None, None) = (e_.section.shape, m.design.cb, m.design.lb_m) {
                let at = |frac: f64| internal_forces(e_, f, load, l * frac)[5].abs() * 1e6;
                let denom = 2.5 * m3max + 3.0 * at(0.25) + 4.0 * at(0.5) + 3.0 * at(0.75);
                if m3max > 0.0 && denom > 0.0 {
                    let cb = (12.5 * m3max / denom).min(3.0);
                    let (mut mn, mut v) = f2_ltb(&e_.section, h, tf, st.fy, st.e, l * 1e3, cb);
                    if let Some(flb) = vals3.get("MnFLB_kNm") {
                        mn = mn.min(flb * 1e6);
                        v.insert("MnFLB_kNm".into(), *flb);
                    }
                    v.insert("phiMn_kNm".into(), 0.9 * mn / 1e6);
                    phi_mn3_c = 0.9 * mn;
                    vals3_c = v;
                }
            }
            update(&mut parts, "F2 강축 휨", m3max / phi_mn3_c, &combo.id, || {
                let mut v = vals3_c.clone();
                v.insert("Mu_kNm".into(), m3max / 1e6);
                v
            });
            if m2max > 0.0 {
                update(&mut parts, "F6 약축 휨", m2max / phi_mn2, &combo.id, || values(&[("Mu_kNm", m2max / 1e6), ("phiMn_kNm", phi_mn2 / 1e6)]));
            }
            update(&mut parts, "G2 전단", (v2max / st.phi_vn2).max(v3max / st.phi_vn3), &combo.id, || {
                values(&[("Vu2_kN", v2max / 1e3), ("phiVn2_kN", st.phi_vn2 / 1e3), ("Vu3_kN", v3max / 1e3), ("phiVn3_kN", st.phi_vn3 / 1e3)])
            });
            // H1-1 at every sample with B1-amplified moments.
            let mut worst = (0.0f64, 0.0, 0.0, 0.0);
            for q in &forces {
                let n = q[0] * 1e3;
                let (pc, pr) = if n < 0.0 {
                    (st.phi_pn_c.as_ref().map(|p| p.0).unwrap_or(f64::NAN), -n)
                } else {
                    (st.phi_pn_t, n)
                };
                let amp = if n < 0.0 { (b1_3, b1_2) } else { (1.0, 1.0) };
                let r3 = q[5].abs() * 1e6 * amp.0 / phi_mn3_c;
                let r2 = q[4].abs() * 1e6 * amp.1 / phi_mn2;
                let rp = pr / pc;
                let ratio = if rp >= 0.2 { rp + 8.0 / 9.0 * (r3 + r2) } else { rp / 2.0 + r3 + r2 };
                if ratio > worst.0 || ratio.is_nan() {
                    worst = (ratio, rp, r3, r2);
                }
            }
            update(&mut parts, "H1-1 조합", worst.0, &combo.id, || {
                values(&[("Pr_Pc", worst.1), ("Mr3_Mc3", worst.2), ("Mr2_Mc2", worst.3), ("B1_3", b1_3), ("B1_2", b1_2), ("Cm3", cm(m3_end)), ("Cm2", cm(m2_end))])
            });
        }
        let mut parts: Vec<Part> = parts.into_values().collect();
        parts.sort_by(|a, b| b.ratio.total_cmp(&a.ratio));
        let any_nan = parts.iter().any(|p| !p.ratio.is_finite());
        let top = parts.iter().find(|p| p.ratio.is_finite());
        let status = if any_nan && parts.iter().any(|p| p.ratio.is_nan()) {
            "error"
        } else if parts.iter().any(|p| p.ratio > 1.0 + 1e-9) {
            "fail"
        } else if incomplete || parts.is_empty() {
            "incomplete"
        } else {
            "pass"
        };
        if parts.iter().any(|p| p.ratio.is_infinite()) {
            notes.push("압축력이 오일러 좌굴하중 이상(B1 발산)".into());
        }
        notes.sort();
        notes.dedup();
        out.push(MemberCheck {
            member: m.id.clone(),
            status: status.into(),
            ratio: parts.first().map(|p| if p.ratio.is_finite() { p.ratio } else { f64::MAX }),
            governing: top.map(|p| Governing { combo: p.combo.clone(), clause: p.clause.clone() }),
            parts,
            notes,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::section::{SectionProps, Shape};

    /// AISC Design Example F.1-2B (W18×50, A992, Lb = 35 ft / 3, Cb = 1.01), values as reproduced on
    /// Bentley's public STAAD.Pro verification page: Lp = 5.8339 ft, Lr = 16.964 ft, φMn = 304.7 kip-ft.
    #[test]
    fn ltb_matches_aisc_example_f1_2b() {
        let inch = 25.4;
        let sp = SectionProps {
            shape: Shape::I { h: 18.0 * inch, b: 7.5 * inch, tw: 0.355 * inch, tf: 0.57 * inch, r: 0.0 },
            a: 14.7 * inch.powi(2),
            i2: 40.1 * inch.powi(4),
            i3: 800.0 * inch.powi(4),
            j: 1.24 * inch.powi(4),
            z2: 16.6 * inch.powi(3),
            z3: 101.0 * inch.powi(3),
            s2: 10.7 * inch.powi(3),
            s3: 88.9 * inch.powi(3),
            cw: 3040.0 * inch.powi(6),
            t_max: 0.57 * inch,
        };
        let (e, fy) = (29000.0 * 6.894757, 50.0 * 6.894757);
        let ft = 304.8;
        let (mn, v) = f2_ltb(&sp, 18.0 * inch, 0.57 * inch, fy, e, 35.0 / 3.0 * ft, 1.01);
        let rel = |a: f64, b: f64, tol: f64| assert!((a - b).abs() <= tol * b, "{a} vs {b}");
        rel(v["Lp_m"] * 1e3 / ft, 5.8339, 0.005);
        rel(v["Lr_m"] * 1e3 / ft, 16.964, 0.005);
        let phi_mn_kipft = 0.9 * mn / 1e6 / 1.355818;
        rel(phi_mn_kipft, 304.7, 0.01);
    }

    #[test]
    fn column_curve_switches_at_fy_over_fe_2_25() {
        let (fy, e): (f64, f64) = (355.0, 205000.0);
        let limit = 4.71 * (e / fy).sqrt();
        let (below, _) = e3_fcr(fy, e, limit * 0.999);
        let (above, _) = e3_fcr(fy, e, limit * 1.001);
        assert!((below - above).abs() / below < 0.01, "continuous at the switch: {below} vs {above}");
    }
}

#[cfg(test)]
mod e7_tests {
    use super::*;

    /// E7 with a slender web: be = b(1 − c1√(Fel/Fcr))√(Fel/Fcr), Fel = (c2 λr/λ)² Fy.
    #[test]
    fn slender_web_reduces_area_by_the_e7_width() {
        let (fy, e): (f64, f64) = (355.0, 210000.0);
        let root = (e / fy).sqrt();
        let (hw, tw) = (342.0, 8.0);
        let fcr = 300.0;
        let lam_r = 1.49 * root;
        let fel = (1.31 * lam_r / (hw / tw)).powi(2) * fy;
        let be = hw * (1.0 - 0.18 * (fel / fcr).sqrt()) * (fel / fcr).sqrt();
        let ae = e7_effective_area(8412.0, fy, fcr, &[(hw, tw, lam_r, 0.18, 1.31, 1.0)]);
        assert!((ae - (8412.0 - (hw - be) * tw)).abs() < 1e-9);
        assert!(ae < 8412.0);
        // A stocky web is not reduced; low stress (small Fcr) also leaves the full width.
        assert_eq!(e7_effective_area(8412.0, fy, fcr, &[(200.0, 12.0, lam_r, 0.18, 1.31, 1.0)]), 8412.0);
        assert_eq!(e7_effective_area(8412.0, fy, 50.0, &[(hw, tw, lam_r, 0.18, 1.31, 1.0)]), 8412.0);
    }
}
