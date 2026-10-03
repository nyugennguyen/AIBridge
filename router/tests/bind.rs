//! ADR 0008 §8 layer 1: the address preflight, and the exit code it produces.
//!
//! The unit tests in `aibr_router::bind` assert the *decision* over a fixed table of
//! interface addresses. This file asserts the thing that can only be observed from
//! outside: that the binary exits `78` and does so **without binding anything**.
//!
//! That second half is the part that matters. "Preflight failed" is worth nothing if
//! the process then falls back to a wildcard bind, which is the outcome §8 exists to
//! prevent. `the_refused_router_bound_nothing` proves the port is still bindable by
//! the test process immediately afterwards.

mod support;

use std::net::TcpListener;
use std::ops::Deref;
use std::path::Path;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::{bearer, config_json, oneshot, request, spawn_router, TempDir};

/// An address that is guaranteed not to be configured on any host.
///
/// `192.0.2.0/24` is TEST-NET-1 (RFC 5737): reserved for documentation, never
/// routable, never assigned. Choosing it rather than a CGNAT address matters — the
/// CGNAT address is absent on this host *by accident* (no `tailscale0`), and a test
/// that depends on that fact passes here and fails on a machine that has joined a
/// tailnet. TEST-NET-1 is absent everywhere, so the test is the same test everywhere.
const ABSENT_ADDRESS: &str = "192.0.2.1";

/// The configured address is absent, so the router exits `78` without binding.
///
/// The exit code is `EX_CONFIG`, the conventional code for "the configuration is
/// wrong", and it is the contract with M7.10's `systemd` unit and M7.11's negative
/// test.
#[test]
fn an_absent_bind_address_exits_78() {
    let scratch = TempDir::new("bind-absent");
    let config = scratch.config_path();
    support::write_config(&config, &config_with_host(scratch.path(), ABSENT_ADDRESS));

    let (code, stderr) = spawn_router(&config, support::TOKEN);

    assert_eq!(
        code,
        Some(i32::from(aibr_router::bind::EX_CONFIG)),
        "expected EX_CONFIG (78); stderr was:\n{stderr}"
    );
}

/// The refusal is diagnostic: it names the address and lists what the host does have.
///
/// An operator who sees only "exit 78" cannot act. The message has to say which
/// address was wanted and what the host actually offers, because the usual cause is
/// Tailscale not being up and the evidence for that is the absence of the address from
/// the list.
#[test]
fn the_refusal_names_the_address_and_what_the_host_has() {
    let scratch = TempDir::new("bind-absent-message");
    let config = scratch.config_path();
    support::write_config(&config, &config_with_host(scratch.path(), ABSENT_ADDRESS));

    let (_, stderr) = spawn_router(&config, support::TOKEN);

    assert!(
        stderr.contains(ABSENT_ADDRESS),
        "the refusal does not name the configured address:\n{stderr}"
    );
    assert!(
        stderr.contains("127.0.0.1"),
        "the refusal does not list the addresses this host does have, so an \
         operator cannot tell a missing tailnet address from a wrong one:\n{stderr}"
    );
}

/// A wildcard address is refused, and this is the most important single assertion in
/// the file.
///
/// `0.0.0.0` is a wildcard bind. It serves every interface on the host, which for a
/// two-node tailnet bridge means serving the LAN — the exact outcome ADR 0008 §8 layer
/// 1 exists to prevent, and one that produces no error message, no log line and no
/// failed connection. A preflight that waved a wildcard through would be worse than no
/// preflight.
#[test]
fn a_wildcard_bind_address_exits_78() {
    // `bridge.host` is a bare host, not a socket address, so the v6 wildcard is written
    // `::` and not `[::]`. `RouterConfig::bind_address` does the bracketing; a `[::]`
    // here would be refused as "not a literal IP address", which is right but tests
    // something else.
    for wildcard in ["0.0.0.0", "::"] {
        let scratch = TempDir::new("bind-wildcard");
        let config = scratch.config_path();
        support::write_config(&config, &config_with_host(scratch.path(), wildcard));

        let (code, stderr) = spawn_router(&config, support::TOKEN);

        assert_eq!(
            code,
            Some(i32::from(aibr_router::bind::EX_CONFIG)),
            "{wildcard} was not refused; stderr was:\n{stderr}"
        );
        assert!(
            stderr.contains("wildcard"),
            "{wildcard} was refused without saying it was a wildcard:\n{stderr}"
        );
    }
}

/// A hostname is refused rather than resolved.
///
/// A name is resolved by whatever resolver happens to be configured, so the address
/// this process binds can differ between the preflight and the bind, between a restart
/// and a DNS change, and between two hosts reading the same `config.json`. Layer 1
/// exists to eliminate that class of drift; accepting a name reintroduces it inside
/// the layer meant to remove it.
#[test]
fn a_hostname_bind_address_exits_78() {
    let scratch = TempDir::new("bind-hostname");
    let config = scratch.config_path();
    support::write_config(
        &config,
        &config_with_host(scratch.path(), "dev-main.tailnet"),
    );

    let (code, stderr) = spawn_router(&config, support::TOKEN);

    assert_eq!(
        code,
        Some(i32::from(aibr_router::bind::EX_CONFIG)),
        "a hostname was not refused; stderr was:\n{stderr}"
    );
}

/// The refusal happened **without binding**.
///
/// This is the assertion that gives layer 1 its value. "The process exited 78" and "the
/// process exited 78 without ever holding a socket" are different claims, and only the
/// second one means the router cannot serve the LAN.
#[test]
fn the_refused_router_bound_nothing() {
    let scratch = TempDir::new("bind-nothing-bound");

    // Port 0 asks the OS for an ephemeral port; the listener is held only for the
    // duration of the assertion and the port number is read back off it. That gives a
    // port nothing else on this machine is using, so a successful bind below is
    // evidence rather than luck.
    let probe = TcpListener::bind("127.0.0.1:0").expect("a free ephemeral port");
    let port = probe.local_addr().expect("a local address").port();
    drop(probe);

    let config = scratch.config_path();
    support::write_config(
        &config,
        &config_with_host_port(scratch.path(), "0.0.0.0", u64::from(port)),
    );

    let (code, stderr) = spawn_router(&config, support::TOKEN);
    assert_eq!(
        code,
        Some(i32::from(aibr_router::bind::EX_CONFIG)),
        "stderr was:\n{stderr}"
    );

    // If the router had bound the wildcard before discovering the address was
    // unusable, this bind would fail with EADDRINUSE — or, worse, succeed and mean the
    // router is still listening.
    TcpListener::bind(("0.0.0.0", port)).unwrap_or_else(|error| {
        panic!(
            "the router bound 0.0.0.0:{port} before refusing ({error}); layer 1 must \
             decide before it holds a socket"
        )
    });
}

/// A missing config file is also `78`, and the process does not fall back to defaults.
///
/// The fallback would be the more damaging bug: a router that starts with no
/// configuration has no project roots and no allowlist, and would be a structural gate
/// with nothing to gate on.
#[test]
fn a_missing_config_exits_78() {
    let scratch = TempDir::new("bind-no-config");
    let absent = scratch.path().join("not-there.json");

    let (code, stderr) = spawn_router(&absent, support::TOKEN);

    assert_eq!(
        code,
        Some(i32::from(aibr_router::bind::EX_CONFIG)),
        "a missing config did not exit 78; stderr was:\n{stderr}"
    );
    assert!(
        stderr.contains("not-there.json"),
        "the refusal does not name the file it could not read, so an operator has \
         nothing to go on:\n{stderr}"
    );
}

/// `AIBRIDGE_CONFIG` being *unset* is a distinct failure from the file being absent,
/// and it gets a distinct message naming the variable.
///
/// The alternative — reporting both as "cannot read the config" — is the same shape of
/// problem as the bearer being indistinguishable from the bearer being wrong: the
/// operator cannot tell whether to fix an environment or a file.
#[test]
fn an_unset_config_path_exits_78_and_names_the_variable() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_aibr-router"))
        .env_remove("AIBRIDGE_CONFIG")
        .env("AIBRIDGE_BEARER_TOKEN", support::TOKEN)
        .output()
        .expect("cannot run aibr-router");

    assert_eq!(
        output.status.code(),
        Some(i32::from(aibr_router::bind::EX_CONFIG)),
        "stderr was:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("AIBRIDGE_CONFIG"),
        "the refusal does not name the environment variable:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A config that is not a `BridgeConfig` is also `78`.
///
/// This is where `deny_unknown_fields` on the generated type earns its keep: a config
/// carrying a key this binary's contracts do not describe is refused rather than
/// ignored, so a typo in a security-relevant key cannot silently disable it.
#[test]
fn an_unparseable_config_exits_78() {
    let scratch = TempDir::new("bind-bad-config");
    let config = scratch.config_path();
    let mut value = config_with_host(scratch.path(), ABSENT_ADDRESS);
    value["a_key_this_contract_does_not_describe"] = Value::Bool(true);
    support::write_config(&config, &value);

    let (code, stderr) = spawn_router(&config, support::TOKEN);

    assert_eq!(
        code,
        Some(i32::from(aibr_router::bind::EX_CONFIG)),
        "a config with an unknown key did not exit 78; stderr was:\n{stderr}"
    );
}

/// A missing bearer token is `78`.
///
/// An empty or absent token would otherwise make `Authorization: Bearer ` authenticate
/// everything. Refusing to start is the only safe response, and it is a
/// configuration problem, which is what `78` means.
#[test]
fn a_missing_bearer_token_exits_78() {
    let scratch = TempDir::new("bind-no-token");
    let config = scratch.config_path();
    support::write_config(&config, &config_with_host(scratch.path(), ABSENT_ADDRESS));

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_aibr-router"))
        .env("AIBRIDGE_CONFIG", &config)
        .env_remove("AIBRIDGE_BEARER_TOKEN")
        .output()
        .expect("cannot run aibr-router");

    assert_eq!(
        output.status.code(),
        Some(i32::from(aibr_router::bind::EX_CONFIG)),
        "stderr was:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("AIBRIDGE_BEARER_TOKEN"),
        "the refusal does not name the environment variable"
    );
}

/// The preflight agrees with the real interface table on this host.
///
/// The unit tests in `bind.rs` assert the decision against a synthetic table. This
/// asserts that the *enumeration* is wired to reality: loopback is present, and
/// TEST-NET-1 is not. Without it, a `get_if_addrs` call that returned an empty vector
/// would make every address "absent" and every preflight test would still pass.
#[test]
fn the_preflight_agrees_with_the_real_interface_table() {
    assert!(
        aibr_router::bind::preflight("127.0.0.1").is_ok(),
        "loopback is present on every host, so it must pass the preflight. This is \
         what lets the router run on a developer machine at all."
    );

    let absent = aibr_router::bind::preflight(ABSENT_ADDRESS);
    assert!(
        absent.is_err(),
        "TEST-NET-1 is not configured on any host, so it must fail the preflight"
    );
    assert!(
        matches!(
            absent,
            Err(aibr_router::bind::PreflightError::AddressAbsent { .. })
        ),
        "expected AddressAbsent, got {absent:?}"
    );
}

/// The router does not start on the reference host's absent tailnet address, and that
/// is the correct behaviour on a host with no `tailscale0`.
///
/// This is the M7.11 note in executable form. ADR 0008 §8 layer 1 says the preflight
/// verifies "the address is on `tailscale0`"; M7.3 implements the address-presence half
/// only, because this host has no `tailscale0` and a router that cannot start cannot be
/// tested. The gap is recorded in `Docs/implementation-reports/m7.3-progress.md`.
#[test]
fn the_cgnat_address_of_the_example_config_is_refused_on_a_host_without_tailscale() {
    // `config/dev-main.example.json` binds `100.64.0.1`. On a host that has joined a
    // tailnet this passes; on this one it must not. The test asserts only the "must
    // not" direction, so it is correct on both kinds of host.
    if aibr_router::bind::preflight("100.64.0.1").is_ok() {
        eprintln!("note: this host HAS 100.64.0.1; the absence case is covered by TEST-NET-1");
        return;
    }

    let scratch = TempDir::new("bind-cgnat");
    let config = scratch.config_path();
    support::write_config(&config, &config_with_host(scratch.path(), "100.64.0.1"));

    let (code, stderr) = spawn_router(&config, support::TOKEN);

    assert_eq!(
        code,
        Some(i32::from(aibr_router::bind::EX_CONFIG)),
        "the router would have started on a host without the configured tailnet \
         address; stderr was:\n{stderr}"
    );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// The router parses the *committed* `config.json` example.
///
/// This is the claim the shared-fixture tests do not make: not "any config works" but
/// "the file the engine reads is a file the router can read". If M7.4 adds
/// `bridge.ingress_mode` without regenerating the contracts, this fails — which is the
/// correct behaviour, and is recorded as a known consequence in the M7.3 progress
/// report.
#[test]
fn the_committed_example_config_parses() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("router/ has a parent: the repository root")
        .join("config/dev-main.example.json");

    let config = aibr_router::config::RouterConfig::from_file(&path, "a-token-for-this-test")
        .unwrap_or_else(|error| {
            panic!(
                "the committed example config does not parse as a BridgeConfig: \
                 {error}.\n\
                 config/ is generated from src/config/schemas.ts. If this is failing, \
                 the committed contracts and the committed config are out of step."
            )
        });

    assert_eq!(config.bridge.bridge.port.get(), 8787);
    assert_eq!(
        config.bind_address(),
        format!(
            "{}:{}",
            config.bridge.bridge.host.deref(),
            config.bridge.bridge.port
        )
    );
}

/// The project roots the router derives are canonicalised at load.
///
/// `/tmp` is a symlink on macOS, so a non-canonical root would make every containment
/// comparison in the suite fail on a path prefix rather than on the behaviour under
/// test. Asserting the canonical form here means a fixture that forgot to canonicalise
/// fails at its own construction rather than as an unexplained mismatch in `gates.rs`.
#[test]
fn configured_project_roots_are_canonicalised_at_load() {
    let scratch = TempDir::new("config-roots");
    let config = aibr_router::config::RouterConfig::from_json(
        &config_with_host(scratch.path(), "127.0.0.1").to_string(),
        "a-token-for-this-test",
        &scratch.path().join("config.json"),
    )
    .expect("the fixture parses");

    assert_eq!(
        config.project_roots,
        vec![scratch.path().to_path_buf()],
        "the project root was not canonicalised at load"
    );
}

/// The router's error output never contains the bearer token.
///
/// The library's `ConfigError` variants cannot hold it by construction, and this
/// asserts the consequence end to end through the real binary: a config that fails to
/// parse, with a canary token set, produces output with no trace of that token.
#[test]
fn a_config_failure_does_not_print_the_token() {
    let scratch = TempDir::new("config-no-token");
    let config = support::write_raw_config(&scratch, "{ not json at all");

    let canary = "token-that-must-not-be-printed-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let (_, stderr) = spawn_router(&config, canary);

    assert!(
        !stderr.contains(canary),
        "a config failure printed the bearer token:\n{stderr}"
    );
}

/// `/health` is reachable on a router built from the committed example config's shape.
///
/// A narrow smoke test that the whole path — config file to `BridgeConfig` to
/// `AppState` to `Router` to response — works with the fixture this file already
/// parses, rather than only with a hand-written one.
#[tokio::test]
async fn a_router_built_from_a_config_file_answers_health() {
    let scratch = TempDir::new("config-health");
    let config_path = scratch.config_path();
    support::write_config(&config_path, &config_with_host(scratch.path(), "127.0.0.1"));

    let config = aibr_router::config::RouterConfig::from_file(&config_path, support::TOKEN)
        .expect("the written fixture parses");
    let router = aibr_router::routes::build(aibr_router::routes::AppState::from_config(&config));

    let reply = oneshot(router, support::authorized("GET", "/health", json!(null))).await;

    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json()["ok"], json!(true));
}

/// The handler state derived from configuration uses the *configured* token.
///
/// Guards against a future refactor that builds `AppState` with a default token
/// instead of the configured one — a bug that would make every deployment on a host
/// share one credential, and one that no bearer test would catch because they all
/// build their state from the same fixture the implementation reads.
#[tokio::test]
async fn handler_state_uses_the_configured_token() {
    let scratch = TempDir::new("config-state");
    let config_path = scratch.config_path();
    support::write_config(&config_path, &config_with_host(scratch.path(), "127.0.0.1"));

    // A deployment with its own token, different from the suite-wide canary.
    let router_for = || {
        let config =
            aibr_router::config::RouterConfig::from_file(&config_path, "the-configured-token")
                .expect("the written fixture parses");
        aibr_router::routes::build(aibr_router::routes::AppState::from_config(&config))
    };

    let accepted = oneshot(
        router_for(),
        request(
            "GET",
            "/health",
            Some(json!(null)),
            Some(&bearer("the-configured-token")),
        ),
    )
    .await;
    assert_eq!(accepted.status, StatusCode::OK);

    // The suite-wide canary is not this deployment's token.
    let refused = oneshot(
        router_for(),
        support::authorized("GET", "/health", json!(null)),
    )
    .await;
    assert_eq!(
        refused.status,
        StatusCode::UNAUTHORIZED,
        "the router accepted a token this deployment never configured"
    );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn config_with_host(root: &Path, host: &str) -> Value {
    config_with_host_port(root, host, 8787)
}

fn config_with_host_port(root: &Path, host: &str, port: u64) -> Value {
    let mut config = config_json(root);
    config["bridge"]["host"] = Value::String(host.to_owned());
    config["bridge"]["port"] = Value::from(port);
    config
}
/// An IPv6 `bridge.host` produces a bracketed socket address.
///
/// `format!("{}:{}", host, port)` yields `:::8787` for a v6 host, which is not a socket
/// address. Every target in M7.9's matrix can hold an IPv6 tailnet address, so this is
/// a shape a real deployment reaches — and the failure without the brackets is an
/// error naming neither the config key nor the missing character.
#[test]
fn an_ipv6_bind_host_is_bracketed() {
    let scratch = TempDir::new("bind-v6");
    let value = config_with_host(scratch.path(), "::1");

    let config = aibr_router::config::RouterConfig::from_json(
        &value.to_string(),
        "a-token-for-this-test",
        &scratch.config_path(),
    )
    .expect("the fixture parses");

    assert_eq!(config.bind_address(), "[::1]:8787");
}
