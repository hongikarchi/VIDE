//! Executable form of the core (fallback when the Node addon cannot be used).
//! `vide-structure bench <nx> <ny> <nz> <combos>` prints the benchmark report JSON.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("bench") => {
            let n = |i: usize, d: usize| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(d);
            match vide_structure::bench::run(n(2, 20), n(3, 20), n(4, 6), n(5, 23)) {
                Ok(r) => println!("{}", serde_json::to_string(&r).unwrap()),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        Some("--version") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("usage: vide-structure bench <nx> <ny> <nz> <combos>");
            std::process::exit(2);
        }
    }
}
