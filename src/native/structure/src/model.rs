//! Analysis model as received from the TypeScript contract (`vide.structure.model/1`).
//! The server validates the JSON with zod before it reaches the core; the core still
//! rejects references it cannot resolve.

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Clone, Copy, Default, Debug)]
pub struct DofFlags {
    #[serde(default)]
    pub dx: bool,
    #[serde(default)]
    pub dy: bool,
    #[serde(default)]
    pub dz: bool,
    #[serde(default)]
    pub rx: bool,
    #[serde(default)]
    pub ry: bool,
    #[serde(default)]
    pub rz: bool,
}

impl DofFlags {
    pub fn as_array(&self) -> [bool; 6] {
        [self.dx, self.dy, self.dz, self.rx, self.ry, self.rz]
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Thickness {
    #[serde(rename = "tMax_mm")]
    pub t_max_mm: f64,
    #[serde(rename = "Fy_MPa")]
    pub fy_mpa: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Material {
    pub id: String,
    #[serde(default)]
    pub grade: String,
    #[serde(rename = "E_MPa")]
    pub e_mpa: f64,
    #[serde(rename = "G_MPa")]
    pub g_mpa: f64,
    #[serde(rename = "density_kNpm3", default)]
    pub density: f64,
    #[serde(rename = "Fy_MPa")]
    pub fy_mpa: f64,
    #[serde(rename = "Fu_MPa")]
    pub fu_mpa: f64,
    #[serde(rename = "fyByThickness", default)]
    pub fy_by_thickness: Vec<Thickness>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Props {
    #[serde(rename = "A_mm2")]
    pub a: f64,
    #[serde(rename = "I2_mm4")]
    pub i2: f64,
    #[serde(rename = "I3_mm4")]
    pub i3: f64,
    #[serde(rename = "J_mm4")]
    pub j: f64,
    #[serde(rename = "Z2_mm3")]
    pub z2: Option<f64>,
    #[serde(rename = "Z3_mm3")]
    pub z3: Option<f64>,
    #[serde(rename = "S2_mm3")]
    pub s2: Option<f64>,
    #[serde(rename = "S3_mm3")]
    pub s3: Option<f64>,
    #[serde(rename = "Cw_mm6")]
    pub cw: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Section {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub shape: String,
    #[serde(rename = "dims_mm", default)]
    pub dims: HashMap<String, f64>,
    pub props: Option<Props>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Node {
    pub id: String,
    #[serde(rename = "xyz_m")]
    pub xyz: [f64; 3],
    pub support: Option<DofFlags>,
}

#[derive(Deserialize, Clone, Default, Debug)]
pub struct Releases {
    pub i: Option<DofFlags>,
    pub j: Option<DofFlags>,
}

#[derive(Deserialize, Clone, Default, Debug)]
pub struct Design {
    #[serde(rename = "Lb_m")]
    pub lb_m: Option<f64>,
    #[serde(rename = "K2")]
    pub k2: Option<f64>,
    #[serde(rename = "K3")]
    pub k3: Option<f64>,
    #[serde(rename = "Cb")]
    pub cb: Option<f64>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Member {
    pub id: String,
    pub i: String,
    pub j: String,
    pub section: String,
    pub material: String,
    pub role: String,
    pub kind: String,
    #[serde(rename = "betaDeg", default)]
    pub beta_deg: f64,
    #[serde(default)]
    pub releases: Releases,
    #[serde(default)]
    pub design: Design,
}

#[derive(Deserialize, Clone, Debug)]
pub struct LoadPattern {
    pub id: String,
    pub nature: String,
    #[serde(rename = "selfWeight", default)]
    pub self_weight: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type")]
pub enum Load {
    #[serde(rename = "memberUniform")]
    MemberUniform {
        id: String,
        pattern: String,
        targets: Vec<String>,
        direction: String,
        #[serde(rename = "value_kNpm")]
        value: f64,
    },
    #[serde(rename = "memberPoint")]
    MemberPoint {
        id: String,
        pattern: String,
        targets: Vec<String>,
        direction: String,
        #[serde(rename = "value_kN")]
        value: f64,
        position: f64,
    },
    #[serde(rename = "nodePoint")]
    NodePoint {
        id: String,
        pattern: String,
        targets: Vec<String>,
        direction: String,
        #[serde(rename = "value_kN")]
        value: f64,
    },
}

#[derive(Deserialize, Clone, Debug)]
pub struct Term {
    pub pattern: String,
    pub factor: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Combination {
    pub id: String,
    pub terms: Vec<Term>,
    #[serde(rename = "limitState")]
    pub limit_state: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct LateralRestraint {
    #[serde(default)]
    pub nodes: Vec<String>,
    #[serde(rename = "aboveZ_m")]
    pub above_z: Option<f64>,
    #[serde(default)]
    pub dofs: Vec<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct Analysis {
    #[serde(rename = "lateralRestraint")]
    pub lateral_restraint: Option<LateralRestraint>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct CheckSettings {
    #[serde(rename = "deflectionLimits", default)]
    pub deflection_limits: HashMap<String, f64>,
}

impl Default for CheckSettings {
    fn default() -> Self {
        let mut deflection_limits = HashMap::new();
        deflection_limits.insert("beam".into(), 360.0);
        deflection_limits.insert("girder".into(), 360.0);
        deflection_limits.insert("other".into(), 240.0);
        Self { deflection_limits }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Model {
    pub materials: Vec<Material>,
    pub sections: Vec<Section>,
    pub nodes: Vec<Node>,
    pub members: Vec<Member>,
    #[serde(rename = "loadPatterns")]
    pub load_patterns: Vec<LoadPattern>,
    #[serde(default)]
    pub loads: Vec<Load>,
    pub combinations: Vec<Combination>,
    #[serde(default)]
    pub analysis: Analysis,
    #[serde(rename = "checkSettings", default)]
    pub check_settings: CheckSettings,
}

/// Unit vector for a load direction; local directions return `None` (handled per member).
pub fn global_direction(direction: &str) -> Option<[f64; 3]> {
    Some(match direction {
        "+X" => [1.0, 0.0, 0.0],
        "-X" => [-1.0, 0.0, 0.0],
        "+Y" => [0.0, 1.0, 0.0],
        "-Y" => [0.0, -1.0, 0.0],
        "+Z" => [0.0, 0.0, 1.0],
        "-Z" => [0.0, 0.0, -1.0],
        _ => return None,
    })
}

pub fn local_direction(direction: &str) -> Option<usize> {
    match direction {
        "local-1" => Some(0),
        "local-2" => Some(1),
        "local-3" => Some(2),
        _ => None,
    }
}
