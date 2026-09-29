//! Section properties from dimensions (mm units throughout).
//! Rolled H sections include the four root fillets so that A, I and Z follow KS D 3502 tables.

use crate::model::Section;
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub enum Shape {
    I { h: f64, b: f64, tw: f64, tf: f64, r: f64 },
    Box { h: f64, b: f64, t: f64 },
    Pipe { d: f64, t: f64 },
    Rod { d: f64 },
    Other,
}

#[derive(Clone, Copy, Debug)]
pub struct SectionProps {
    pub shape: Shape,
    pub a: f64,
    pub i2: f64,
    pub i3: f64,
    pub j: f64,
    pub z2: f64,
    pub z3: f64,
    pub s2: f64,
    pub s3: f64,
    pub cw: f64,
    /// Thickest plate, for thickness-dependent yield strength.
    pub t_max: f64,
}

impl SectionProps {
    pub fn r2(&self) -> f64 {
        (self.i2 / self.a).sqrt()
    }
    pub fn r3(&self) -> f64 {
        (self.i3 / self.a).sqrt()
    }
}

fn dim(section: &Section, key: &str) -> Result<f64, String> {
    section
        .dims
        .get(key)
        .copied()
        .filter(|v| *v > 0.0)
        .ok_or_else(|| format!("section {} needs dims_mm.{key}", section.id))
}

pub fn properties(section: &Section) -> Result<SectionProps, String> {
    let shape = match section.shape.as_str() {
        "H" | "BH" => Shape::I {
            h: dim(section, "h")?,
            b: dim(section, "b")?,
            tw: dim(section, "tw")?,
            tf: dim(section, "tf")?,
            r: section.dims.get("r").copied().unwrap_or(0.0).max(0.0),
        },
        "BOX" => Shape::Box { h: dim(section, "h")?, b: dim(section, "b")?, t: dim(section, "t")? },
        "PIPE" => Shape::Pipe { d: dim(section, "d")?, t: dim(section, "t")? },
        "ROD" => Shape::Rod { d: dim(section, "d")? },
        _ => Shape::Other,
    };
    let mut p = computed(shape);
    if let Some(given) = &section.props {
        // Explicit properties win; missing moduli fall back to the computed ones when possible.
        p.a = given.a;
        p.i2 = given.i2;
        p.i3 = given.i3;
        p.j = given.j;
        if let Some(v) = given.z2 {
            p.z2 = v;
        }
        if let Some(v) = given.z3 {
            p.z3 = v;
        }
        if let Some(v) = given.s2 {
            p.s2 = v;
        }
        if let Some(v) = given.s3 {
            p.s3 = v;
        }
        if let Some(v) = given.cw {
            p.cw = v;
        }
    } else if matches!(shape, Shape::Other) {
        return Err(format!("section {} ({}) needs props", section.id, section.shape));
    }
    if !(p.a > 0.0 && p.i2 > 0.0 && p.i3 > 0.0 && p.j > 0.0) {
        return Err(format!("section {} has non-positive properties", section.id));
    }
    Ok(p)
}

fn computed(shape: Shape) -> SectionProps {
    let zero = SectionProps {
        shape,
        a: 0.0,
        i2: 0.0,
        i3: 0.0,
        j: 0.0,
        z2: 0.0,
        z3: 0.0,
        s2: 0.0,
        s3: 0.0,
        cw: 0.0,
        t_max: 0.0,
    };
    match shape {
        Shape::I { h, b, tw, tf, r } => {
            let hw = h - 2.0 * tf;
            // Root fillet: area (1 − π/4)r², centroid 0.2234r from the corner.
            let af = (1.0 - PI / 4.0) * r * r;
            let cf = r * (10.0 - 3.0 * PI) / (12.0 - 3.0 * PI);
            let yf = h / 2.0 - tf - cf;
            let xf = tw / 2.0 + cf;
            let a = 2.0 * b * tf + hw * tw + 4.0 * af;
            let i3 = (b * h.powi(3) - (b - tw) * hw.powi(3)) / 12.0 + 4.0 * af * yf * yf;
            let i2 = 2.0 * tf * b.powi(3) / 12.0 + hw * tw.powi(3) / 12.0 + 4.0 * af * xf * xf;
            let z3 = b * tf * (h - tf) + tw * hw * hw / 4.0 + 4.0 * af * yf;
            let z2 = tf * b * b / 2.0 + hw * tw * tw / 4.0 + 4.0 * af * xf;
            let j = (2.0 * b * tf.powi(3) + (h - tf) * tw.powi(3)) / 3.0;
            let cw = i2 * (h - tf).powi(2) / 4.0;
            SectionProps { a, i2, i3, j, z2, z3, s2: i2 / (b / 2.0), s3: i3 / (h / 2.0), cw, t_max: tf.max(tw), ..zero }
        }
        Shape::Box { h, b, t } => {
            let (hi, bi) = (h - 2.0 * t, b - 2.0 * t);
            let a = b * h - bi * hi;
            let i3 = (b * h.powi(3) - bi * hi.powi(3)) / 12.0;
            let i2 = (h * b.powi(3) - hi * bi.powi(3)) / 12.0;
            let (hm, bm) = (h - t, b - t);
            let j = 4.0 * (hm * bm).powi(2) * t / (2.0 * (hm + bm));
            let z3 = b * h * h / 4.0 - bi * hi * hi / 4.0;
            let z2 = h * b * b / 4.0 - hi * bi * bi / 4.0;
            SectionProps { a, i2, i3, j, z2, z3, s2: i2 / (b / 2.0), s3: i3 / (h / 2.0), t_max: t, ..zero }
        }
        Shape::Pipe { d, t } => {
            let di = d - 2.0 * t;
            let a = PI / 4.0 * (d * d - di * di);
            let i = PI / 64.0 * (d.powi(4) - di.powi(4));
            let z = (d.powi(3) - di.powi(3)) / 6.0;
            SectionProps { a, i2: i, i3: i, j: 2.0 * i, z2: z, z3: z, s2: i / (d / 2.0), s3: i / (d / 2.0), t_max: t, ..zero }
        }
        Shape::Rod { d } => {
            let a = PI * d * d / 4.0;
            let i = PI * d.powi(4) / 64.0;
            let z = d.powi(3) / 6.0;
            SectionProps { a, i2: i, i3: i, j: 2.0 * i, z2: z, z3: z, s2: i / (d / 2.0), s3: i / (d / 2.0), t_max: d, ..zero }
        }
        Shape::Other => zero,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(h: f64, b: f64, tw: f64, tf: f64, r: f64) -> SectionProps {
        computed(Shape::I { h, b, tw, tf, r })
    }

    fn near(actual: f64, expected: f64, rel: f64) {
        assert!((actual - expected).abs() <= rel * expected, "{actual} vs {expected}");
    }

    /// KS D 3502 table values (cm units, 3–4 significant figures), tolerance 1 %.
    #[test]
    fn rolled_h_matches_ks_table() {
        let p = h(400.0, 200.0, 8.0, 13.0, 16.0);
        near(p.a / 1e2, 84.12, 0.01);
        near(p.i3 / 1e4, 23700.0, 0.01);
        near(p.i2 / 1e4, 1740.0, 0.01);
        near(p.s3 / 1e3, 1190.0, 0.01);
        near(p.s2 / 1e3, 174.0, 0.01);
        let p = h(300.0, 300.0, 10.0, 15.0, 18.0);
        near(p.a / 1e2, 119.8, 0.01);
        near(p.i3 / 1e4, 20400.0, 0.01);
        near(p.i2 / 1e4, 6750.0, 0.01);
        near(p.s3 / 1e3, 1360.0, 0.01);
        near(p.s2 / 1e3, 450.0, 0.01);
    }

    #[test]
    fn pipe_and_box_closed_forms() {
        let p = computed(Shape::Pipe { d: 100.0, t: 10.0 });
        near(p.a, PI / 4.0 * (100.0f64.powi(2) - 80.0f64.powi(2)), 1e-12);
        near(p.j, 2.0 * p.i2, 1e-12);
        let b = computed(Shape::Box { h: 200.0, b: 100.0, t: 10.0 });
        near(b.a, 200.0 * 100.0 - 180.0 * 80.0, 1e-12);
        assert!(b.i3 > b.i2);
    }
}
