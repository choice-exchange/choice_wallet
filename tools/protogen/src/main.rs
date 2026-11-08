//! Dev tool for `choice-wallet-injective`'s protobuf types.
//!
//! - `protogen vendor NAME@VERSION=DIR ...` copies the import closure of [`ROOTS`] from the
//!   given include directories (searched in order) into `crates/injective/proto`, and writes
//!   `proto/SOURCES.md` with each file's origin and SHA-256.
//! - `protogen gen` compiles the vendored files (and nothing else) into
//!   `crates/injective/src/proto`. The output is committed; wallet builds never run this.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs, process};

use sha2::{Digest, Sha256};

/// The files we generate code for. Their imports come along automatically.
const ROOTS: &[&str] = &[
    "cosmos/tx/v1beta1/tx.proto",
    "cosmos/bank/v1beta1/tx.proto",
    "cosmwasm/wasm/v1/tx.proto",
    "injective/crypto/v1beta1/ethsecp256k1/keys.proto",
    "injective/types/v1beta1/tx_ext.proto",
];

fn crate_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/injective")
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("vendor") => vendor(&args[1..]),
        Some("gen") => generate(),
        _ => Err("usage: protogen vendor NAME@VERSION=DIR ... | protogen gen".into()),
    };
    if let Err(e) = result {
        eprintln!("protogen: {e}");
        process::exit(1);
    }
}

fn vendor(sources: &[String]) -> Result<(), String> {
    let sources: Vec<(String, PathBuf)> = sources
        .iter()
        .map(|s| {
            let (label, dir) = s.split_once('=').ok_or(format!("expected NAME@VERSION=DIR, got {s}"))?;
            Ok((label.to_owned(), PathBuf::from(dir)))
        })
        .collect::<Result<_, String>>()?;

    let mut compiler = protox::Compiler::new(sources.iter().map(|(_, d)| d)).map_err(|e| e.to_string())?;
    compiler.include_imports(true);
    compiler.open_files(ROOTS).map_err(|e| format!("{e:?}"))?;

    let out = crate_dir().join("proto");
    if out.exists() {
        fs::remove_dir_all(&out).map_err(|e| e.to_string())?;
    }

    // file name -> (source label, sha256)
    let mut manifest: BTreeMap<String, (String, String)> = BTreeMap::new();
    for file in compiler.files() {
        let name = file.name();
        let Some(path) = file.path() else {
            // protox's built-in google/protobuf files: not vendored, not generated.
            continue;
        };
        let label = sources
            .iter()
            .find(|(_, dir)| path.starts_with(dir))
            .map(|(l, _)| l.clone())
            .ok_or(format!("{name}: not under any source dir"))?;
        let bytes = fs::read(path).map_err(|e| format!("{name}: {e}"))?;
        let dest = out.join(name);
        fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        manifest.insert(name.to_owned(), (label, hex(&Sha256::digest(&bytes))));
    }

    let mut md = String::from(
        "# Vendored .proto sources\n\nCopied by `tools/protogen vendor`. Do not edit these files; re-vendor instead.\n\n\
         | File | Source | SHA-256 |\n| --- | --- | --- |\n",
    );
    for (name, (label, sum)) in &manifest {
        writeln!(md, "| `{name}` | {label} | `{sum}` |").unwrap();
    }
    fs::write(out.join("SOURCES.md"), md).map_err(|e| e.to_string())?;
    println!("vendored {} files into {}", manifest.len(), out.display());
    Ok(())
}

fn generate() -> Result<(), String> {
    let proto = crate_dir().join("proto");
    let mut compiler = protox::Compiler::new([&proto]).map_err(|e| e.to_string())?;
    compiler.include_imports(true).include_source_info(true);
    compiler.open_files(ROOTS).map_err(|e| format!("{e:?}"))?;
    for file in compiler.files() {
        if let Some(path) = file.path()
            && !path.starts_with(&proto)
        {
            return Err(format!("{} resolved outside the vendored tree", file.name()));
        }
    }

    let out = crate_dir().join("src/proto");
    if out.exists() {
        fs::remove_dir_all(&out).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;

    prost_build::Config::new()
        .out_dir(&out)
        .include_file("mod.rs")
        // Our own `Any`, so the vault doesn't need prost-types.
        .compile_well_known_types()
        .extern_path(".google.protobuf", "crate::wkt")
        .enable_type_names()
        .compile_fds(compiler.file_descriptor_set())
        .map_err(|e| e.to_string())?;
    println!("generated code in {}", out.display());
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}
