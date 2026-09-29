//! Entry point: model JSON → result JSON (`vide.structure.result/1`, ARCH-02 §4).

use crate::check::{check_members, MemberCheck};
use crate::model::Model;
use crate::solve::{deflection, internal_forces, run, Failure, DOF_NAMES, SAMPLES};
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::Instant;

#[derive(Serialize)]
struct DofOut {
    node: String,
    dof: &'static str,
}

#[derive(Serialize)]
struct Equilibrium {
    combo: String,
    error_rel: f64,
}

#[derive(Serialize)]
struct Diagnostics {
    mechanisms: Vec<DofOut>,
    #[serde(rename = "autoRestrained")]
    auto_restrained: Vec<DofOut>,
    equilibrium: Vec<Equilibrium>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct Forces {
    #[serde(rename = "N")]
    n: f64,
    #[serde(rename = "V2")]
    v2: f64,
    #[serde(rename = "V3")]
    v3: f64,
    #[serde(rename = "T")]
    t: f64,
    #[serde(rename = "M2")]
    m2: f64,
    #[serde(rename = "M3")]
    m3: f64,
}

#[derive(Serialize)]
struct NodeOut {
    disp: BTreeMap<String, [f64; 6]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reaction: Option<BTreeMap<String, [f64; 6]>>,
}

#[derive(Serialize)]
struct MemberOut {
    length_m: f64,
    stations: Vec<f64>,
    forces: BTreeMap<String, Vec<Forces>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deflection_mm: Option<BTreeMap<String, f64>>,
}

#[derive(Serialize)]
struct Summary {
    #[serde(rename = "steel_kN")]
    steel_kn: f64,
    #[serde(rename = "maxRatio")]
    max_ratio: Option<f64>,
    #[serde(rename = "failCount")]
    fail_count: usize,
    #[serde(rename = "incompleteCount")]
    incomplete_count: usize,
}

#[derive(Serialize)]
struct Output {
    schema: &'static str,
    #[serde(rename = "modelHash")]
    model_hash: String,
    #[serde(rename = "coreVersion")]
    core_version: &'static str,
    elapsed_ms: f64,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    diagnostics: Diagnostics,
    combos: Vec<String>,
    nodes: BTreeMap<String, NodeOut>,
    members: BTreeMap<String, MemberOut>,
    checks: Vec<MemberCheck>,
    summary: Summary,
    #[serde(rename = "notChecked")]
    not_checked: Vec<String>,
}

const STATIONS: [f64; 5] = [0.0, 0.25, 0.5, 0.75, 1.0];

fn empty(model_hash: &str, started: Instant, error: String, mechanisms: Vec<DofOut>) -> Output {
    Output {
        schema: "vide.structure.result/1",
        model_hash: model_hash.to_string(),
        core_version: env!("CARGO_PKG_VERSION"),
        elapsed_ms: started.elapsed().as_secs_f64() * 1e3,
        status: "error",
        error: Some(error),
        diagnostics: Diagnostics { mechanisms, auto_restrained: vec![], equilibrium: vec![], warnings: vec![] },
        combos: vec![],
        nodes: BTreeMap::new(),
        members: BTreeMap::new(),
        checks: vec![],
        summary: Summary { steel_kn: 0.0, max_ratio: None, fail_count: 0, incomplete_count: 0 },
        not_checked: vec![],
    }
}

pub fn analyze_json(model_json: &str, model_hash: &str) -> String {
    let started = Instant::now();
    let out = match serde_json::from_str::<Model>(model_json) {
        Err(e) => empty(model_hash, started, format!("model: {e}"), vec![]),
        Ok(model) => analyze(&model, model_hash, started),
    };
    serde_json::to_string(&out).unwrap_or_else(|e| format!("{{\"status\":\"error\",\"error\":\"serialize: {e}\"}}"))
}

fn analyze(model: &Model, model_hash: &str, started: Instant) -> Output {
    let an = match run(model) {
        Ok(an) => an,
        Err(Failure::Input(msg)) => return empty(model_hash, started, msg, vec![]),
        Err(Failure::Mechanism(dofs)) => {
            let mech = dofs
                .into_iter()
                .map(|d| DofOut { node: model.nodes[d.node].id.clone(), dof: DOF_NAMES[d.dof] })
                .collect();
            return empty(model_hash, started, "unstable model (mechanism)".into(), mech);
        }
    };
    let mut limits: BTreeMap<String, f64> = model.check_settings.deflection_limits.iter().map(|(k, v)| (k.clone(), *v)).collect();
    if limits.is_empty() {
        limits = crate::model::CheckSettings::default().deflection_limits.into_iter().collect();
    }
    let section_shape: BTreeMap<&str, &str> = model.sections.iter().map(|s| (s.id.as_str(), s.shape.as_str())).collect();
    let rolled: Vec<bool> = model.members.iter().map(|m| section_shape.get(m.section.as_str()) == Some(&"H")).collect();
    let checks = check_members(&an, &model.members, &model.materials, &limits, &rolled);

    let mut nodes = BTreeMap::new();
    for (n, id) in an.node_ids.iter().enumerate() {
        let mut disp = BTreeMap::new();
        let mut reaction = BTreeMap::new();
        let supported = (0..6).any(|d| an.restrained[n * 6 + d]);
        for c in &an.combos {
            let mut u = [0.0; 6];
            u.copy_from_slice(&c.u[n * 6..n * 6 + 6]);
            disp.insert(c.id.clone(), u);
            if supported {
                let mut r = [0.0; 6];
                r.copy_from_slice(&c.reactions[n * 6..n * 6 + 6]);
                reaction.insert(c.id.clone(), r);
            }
        }
        nodes.insert(id.clone(), NodeOut { disp, reaction: supported.then_some(reaction) });
    }
    let mut members = BTreeMap::new();
    let mut steel_kn = 0.0;
    for (idx, e) in an.elems.iter().enumerate() {
        let m = &model.members[e.member];
        steel_kn += model.materials[e.material].density * e.fp.a * e.length;
        let mut forces = BTreeMap::new();
        let mut defl = BTreeMap::new();
        for c in &an.combos {
            let rows = STATIONS
                .iter()
                .map(|s| {
                    let q = if c.active[idx] { internal_forces(e, &c.end_forces[idx], &c.loads[idx], s * e.length) } else { [0.0; 6] };
                    Forces { n: q[0], v2: q[1], v3: q[2], t: q[3], m2: q[4], m3: q[5] }
                })
                .collect();
            forces.insert(c.id.clone(), rows);
            if c.active[idx] {
                let mut dmax = 0.0f64;
                for s in 0..SAMPLES {
                    let x = e.length * s as f64 / (SAMPLES - 1) as f64;
                    let d = deflection(e, &c.end_disp[idx], &c.loads[idx], x);
                    dmax = dmax.max((d[0] * d[0] + d[1] * d[1]).sqrt());
                }
                defl.insert(c.id.clone(), dmax * 1e3);
            }
        }
        members.insert(
            m.id.clone(),
            MemberOut { length_m: e.length, stations: STATIONS.to_vec(), forces, deflection_mm: Some(defl) },
        );
    }
    let fail_count = checks.iter().filter(|c| c.status == "fail").count();
    let incomplete_count = checks.iter().filter(|c| c.status == "incomplete").count();
    let max_ratio = checks.iter().filter_map(|c| c.ratio).fold(None, |acc: Option<f64>, r| Some(acc.map_or(r, |a| a.max(r))));
    let mut not_checked = vec![
        "풍하중·지진하중 등 횡력 검토".to_string(),
        "구조물 2차 해석(P-Δ)".into(),
        "접합부 설계".into(),
        "기초·인발".into(),
        "신축줄눈(EJ)".into(),
        "캔틸레버 끝 처짐".into(),
    ];
    if !an.combos.iter().any(|c| c.service) {
        not_checked.push("처짐(사용성 조합 없음)".into());
    }
    let mut warnings = an.warnings.clone();
    for c in &an.combos {
        if c.equilibrium_error > 1e-6 {
            warnings.push(format!("combination {}: equilibrium error {:.2e}", c.id, c.equilibrium_error));
        }
    }
    Output {
        schema: "vide.structure.result/1",
        model_hash: model_hash.to_string(),
        core_version: env!("CARGO_PKG_VERSION"),
        elapsed_ms: started.elapsed().as_secs_f64() * 1e3,
        status: "ok",
        error: None,
        diagnostics: Diagnostics {
            mechanisms: vec![],
            auto_restrained: an
                .auto_restrained
                .iter()
                .map(|d| DofOut { node: an.node_ids[d.node].clone(), dof: DOF_NAMES[d.dof] })
                .collect(),
            equilibrium: an.combos.iter().map(|c| Equilibrium { combo: c.id.clone(), error_rel: c.equilibrium_error }).collect(),
            warnings,
        },
        combos: an.combos.iter().map(|c| c.id.clone()).collect(),
        nodes,
        members,
        checks,
        summary: Summary { steel_kn, max_ratio, fail_count, incomplete_count },
        not_checked,
    }
}
