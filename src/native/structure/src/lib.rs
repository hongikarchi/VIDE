//! VIDE structure analysis core (ARCH-02). Pure computation: model JSON in, result JSON out.

pub mod analyze;
pub mod bench;
pub mod check;
pub mod frame;
pub mod model;
pub mod section;
pub mod solve;

pub use analyze::analyze_json;

#[cfg(feature = "node")]
mod node {
    use napi_derive::napi;

    /// Analyse a validated `vide.structure.model/1` JSON; returns `vide.structure.result/1` JSON.
    #[napi]
    pub fn analyze(model_json: String, model_hash: String) -> String {
        crate::analyze_json(&model_json, &model_hash)
    }

    /// Synthetic benchmark used by the binding experiment (PLAN-17 T-033). Returns report JSON.
    #[napi]
    pub fn benchmark(nx: u32, ny: u32, nz: u32, combos: u32) -> napi::Result<String> {
        let report = crate::bench::run(nx as usize, ny as usize, nz as usize, combos as usize)
            .map_err(napi::Error::from_reason)?;
        serde_json::to_string(&report).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn core_version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}
