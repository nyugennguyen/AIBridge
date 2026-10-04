//! M7.10's contract with a supervisor, asserted against the real binary.
//!
//! ## What was broken before this file existed
//!
//! `packaging/systemd/aibr-router.service` ran `aibr-router --preflight` and
//! `aibr-router --init-store`, and the binary parsed no arguments at all. Both
//! `ExecStartPre` lines would have failed on every boot with an "unknown argument"
//! that no test could see, because the only spawn in the suite asserted an exit
//! code for the argument-less mode.
//!
//! An `ExecStartPre` that always fails is not a startup failure that gets noticed.
//! It is a unit that never serves, discovered during an incident.
//!
//! ## What is asserted here
//!
//! Modes are about what the process must NOT do, so the assertions are mostly
//! negatives: a preflight that binds nothing, an init-store that cannot overwrite
//! a file it does not understand, and a refusal that reaches `EX_CONFIG` in every
//! case rather than only in the ones the happy path happened to exercise.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use aibr_router::bind::EX_CONFIG;
use aibr_router::outbox::{IngressOutbox, INGRESS_OUTBOX_ENV};
use support::{config_json, TempDir, TOKEN};

/// Run the binary in one of its non-serving modes and return `(code, stdout+stderr)`.
fn run(scratch: &TempDir, args: &[&str], store: Option<&Path>) -> (Option<i32>, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_aibr-router"));
    command
        .args(args)
        .env("AIBRIDGE_CONFIG", scratch.config_path())
        .env("AIBRIDGE_BEARER_TOKEN", TOKEN);
    match store {
        Some(path) => {
            command.env(INGRESS_OUTBOX_ENV, path);
        }
        None => {
            command.env_remove(INGRESS_OUTBOX_ENV);
        }
    }
    let output = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .unwrap_or_else(|error| panic!("cannot run aibr-router: {error}"));

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.code(), combined)
}

fn write_valid_config(scratch: &TempDir) -> PathBuf {
    support::write_config(&scratch.config_path(), &config_json(scratch.path()))
}

fn store_path(scratch: &TempDir) -> PathBuf {
    scratch.path().join("ingress-outbox.sqlite")
}

// ── --init-store ────────────────────────────────────────────────────────

#[test]
fn init_store_provisions_a_store_the_router_can_then_open() {
    let scratch = TempDir::new("init-store");
    write_valid_config(&scratch);
    let path = store_path(&scratch);

    let (code, output) = run(&scratch, &["--init-store"], Some(&path));

    assert_eq!(code, Some(0), "provisioning failed: {output}");
    assert!(path.exists(), "no store was created at {}", path.display());
    IngressOutbox::open(&path)
        .unwrap_or_else(|error| panic!("the provisioned store does not open: {error}"));
}

#[test]
fn init_store_is_idempotent_because_a_unit_runs_it_on_every_boot() {
    let scratch = TempDir::new("init-store-idempotent");
    write_valid_config(&scratch);
    let path = store_path(&scratch);

    assert_eq!(run(&scratch, &["--init-store"], Some(&path)).0, Some(0));
    let (code, output) = run(&scratch, &["--init-store"], Some(&path));

    assert_eq!(
        code,
        Some(0),
        "a second boot must not fail provisioning: {output}"
    );
    assert!(
        output.contains("already provisioned"),
        "the second run should say it found an existing store, not silently recreate it: {output}"
    );
}

#[test]
fn init_store_refuses_to_overwrite_a_file_it_cannot_read_as_a_store() {
    let scratch = TempDir::new("init-store-refuse");
    write_valid_config(&scratch);
    let path = store_path(&scratch);
    std::fs::write(&path, b"this is not a sqlite database").expect("the decoy file is written");

    let (code, output) = run(&scratch, &["--init-store"], Some(&path));

    assert_eq!(code, Some(i32::from(EX_CONFIG)), "{output}");
    assert_eq!(
        std::fs::read(&path).expect("the decoy survives"),
        b"this is not a sqlite database",
        "the file that could not be read as a store must be left exactly as it was"
    );
}

#[test]
fn init_store_refuses_a_relative_path_rather_than_resolving_it() {
    let scratch = TempDir::new("init-store-relative");
    write_valid_config(&scratch);

    let (code, output) = run(&scratch, &["--init-store"], Some(Path::new("queue.db")));

    assert_eq!(code, Some(i32::from(EX_CONFIG)), "{output}");
    assert!(output.contains("absolute"), "{output}");
    assert!(
        !Path::new("queue.db").exists(),
        "a relative path must not produce a file in the working directory"
    );
}

#[test]
fn init_store_refuses_when_the_variable_is_unset() {
    let scratch = TempDir::new("init-store-unset");
    write_valid_config(&scratch);

    let (code, output) = run(&scratch, &["--init-store"], None);

    assert_eq!(code, Some(i32::from(EX_CONFIG)), "{output}");
    assert!(output.contains(INGRESS_OUTBOX_ENV), "{output}");
}

// ── --preflight ─────────────────────────────────────────────────────────

#[test]
fn preflight_succeeds_on_a_host_that_can_actually_serve() {
    let scratch = TempDir::new("preflight-ok");
    write_valid_config(&scratch);
    let path = store_path(&scratch);
    IngressOutbox::create(&path).expect("provisioned");

    let (code, output) = run(&scratch, &["--preflight"], Some(&path));

    assert_eq!(code, Some(0), "{output}");
}

#[test]
fn preflight_binds_nothing() {
    // The property that makes `--preflight` worth having: the port the config asks
    // for is still bindable afterwards. A preflight that bound the port would be a
    // race with `ExecStart`, and on a slow boot it would hold the port itself.
    let scratch = TempDir::new("preflight-binds-nothing");
    let path = store_path(&scratch);
    IngressOutbox::create(&path).expect("provisioned");

    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("the test can bind loopback");
    let port = probe
        .local_addr()
        .expect("a bound address has a port")
        .port();
    drop(probe);

    let mut config = config_json(scratch.path());
    config["bridge"]["port"] = json_port(port);
    support::write_config(&scratch.config_path(), &config);

    let (code, output) = run(&scratch, &["--preflight"], Some(&path));
    assert_eq!(code, Some(0), "{output}");

    std::net::TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|error| {
        panic!("preflight left {port} bound, so ExecStart would race it: {error}")
    });
}

#[test]
fn preflight_does_not_provision_the_store_it_is_checking() {
    let scratch = TempDir::new("preflight-no-provision");
    write_valid_config(&scratch);
    let path = store_path(&scratch);

    let (code, output) = run(&scratch, &["--preflight"], Some(&path));

    assert_eq!(code, Some(i32::from(EX_CONFIG)), "{output}");
    assert!(
        !path.exists(),
        "a preflight that creates the store it is verifying cannot tell a healthy \
         queue from a freshly reset one"
    );
}

#[test]
fn preflight_fails_on_an_absent_bind_address() {
    let scratch = TempDir::new("preflight-absent-address");
    let mut config = config_json(scratch.path());
    config["bridge"]["host"] = serde_json::json!("192.0.2.1");
    support::write_config(&scratch.config_path(), &config);
    let path = store_path(&scratch);
    IngressOutbox::create(&path).expect("provisioned");

    let (code, output) = run(&scratch, &["--preflight"], Some(&path));

    assert_eq!(code, Some(i32::from(EX_CONFIG)), "{output}");
    assert!(
        output.contains("192.0.2.1"),
        "the refusal must name the address it could not use: {output}"
    );
}

#[test]
fn preflight_fails_on_a_bad_config_before_it_looks_at_anything_else() {
    let scratch = TempDir::new("preflight-bad-config");
    std::fs::write(scratch.config_path(), b"{ not json").expect("written");

    let (code, output) = run(&scratch, &["--preflight"], None);

    assert_eq!(code, Some(i32::from(EX_CONFIG)), "{output}");
}

/// A `serde_json::Value` for a port number.
fn json_port(port: u16) -> serde_json::Value {
    serde_json::json!(port)
}

// ── unknown arguments ───────────────────────────────────────────────────

#[test]
fn an_unknown_argument_exits_78_rather_than_serving() {
    // The failure this prevents is subtle: a unit with a typo in its flag makes the
    // binary fall through to `serve`, which would bind and answer requests while the
    // operator believed a preflight had run.
    let scratch = TempDir::new("unknown-arg");
    write_valid_config(&scratch);
    let path = store_path(&scratch);
    IngressOutbox::create(&path).expect("provisioned");

    let (code, output) = run(&scratch, &["--prefilight"], Some(&path));

    assert_eq!(code, Some(i32::from(EX_CONFIG)), "{output}");
    assert!(
        output.contains("--preflight"),
        "the usage line names the modes: {output}"
    );
}

#[test]
fn two_modes_at_once_is_refused_rather_than_one_winning() {
    let scratch = TempDir::new("two-modes");
    write_valid_config(&scratch);
    let path = store_path(&scratch);
    IngressOutbox::create(&path).expect("provisioned");

    let (code, output) = run(&scratch, &["--init-store", "--preflight"], Some(&path));

    assert_eq!(code, Some(i32::from(EX_CONFIG)), "{output}");
}
