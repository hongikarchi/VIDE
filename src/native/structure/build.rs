fn main() {
    // Node-API link setup is only needed for the addon build.
    if std::env::var_os("CARGO_FEATURE_NODE").is_some() {
        napi_build::setup();
    }
}
