//! `aibr-router` — the process.
//!
//! Four steps, in this order, and the order is the design:
//!
//! 1. Read `config.json` and the bearer token. Failure exits `78` (`EX_CONFIG`).
//! 2. **Preflight the bind address.** Failure exits `78` having bound nothing.
//! 3. Bind.
//! 4. Serve.
//!
//! Steps 2 and 3 are separate calls rather than "bind and see". Binding and then
//! discovering the address was unusable is not a plan; it is the failure mode
//! ADR 0008 §8 layer 1 exists to prevent, and the only way to be sure the router
//! does not answer on a wildcard after the tailnet address went away is to decide
//! *before* it holds a socket. See [`aibr_router::bind`].
//!
//! Exit codes are part of this program's interface to its supervisor (M7.10) and
//! to M7.11's negative tests, so they are named constants rather than literals:
//!
//! | Code | Meaning |
//! | --- | --- |
//! | `78` (`EX_CONFIG`) | configuration or bind address unusable; will not fix itself on restart |
//! | `0` | clean shutdown on `SIGTERM`/`SIGINT` |

use std::process::ExitCode;

use aibr_router::bind::{self, EX_CONFIG};
use aibr_router::config::RouterConfig;
use aibr_router::routes::{self, AppState};

/// What the process should do, decided by the things above it.
///
/// The `RouterConfig` is boxed. `BridgeConfig` is eight nested structs and measures
/// 448 bytes, so carrying it inline makes `Startup` a 448-byte enum that gets moved
/// twice — once out of `startup`, once into `serve` — for a value that lives for the
/// life of the process and is never moved again. This is also why the crate-level
/// `large_enum_variant` allowance is scoped to the generated module and not to the
/// crate: a hand-written enum gets the lint, as here.
enum Startup {
    /// Config loaded, preflight passed, socket bound.
    Serve(tokio::net::TcpListener, Box<RouterConfig>),
    /// Configuration or bind preflight failed. The message is safe to print: both
    /// sources are operator configuration, and neither carries the bearer token
    /// (see [`aibr_router::config::ConfigError`], whose variants cannot hold it).
    Refuse(String),
}

#[tokio::main]
async fn main() -> ExitCode {
    match startup().await {
        Startup::Serve(listener, config) => {
            serve(listener, config).await;
            ExitCode::SUCCESS
        }
        Startup::Refuse(message) => {
            eprintln!("aibr-router: {message}");
            ExitCode::from(EX_CONFIG)
        }
    }
}

/// Load configuration, preflight the address, then bind.
///
/// Returns [`Startup::Refuse`] rather than exiting, so every refusal takes the same
/// path to the same exit code. An `exit(78)` written at each of three call sites is
/// three places to get the code wrong.
async fn startup() -> Startup {
    let config = match RouterConfig::from_env() {
        Ok(config) => config,
        Err(error) => return Startup::Refuse(error.to_string()),
    };

    // Layer 1 of ADR 0008 §8. Runs before any socket exists in this process.
    if let Err(error) = bind::preflight(config.bridge.bridge.host.as_ref()) {
        return Startup::Refuse(error.to_string());
    }

    let address = config.bind_address();
    let listener = match tokio::net::TcpListener::bind(&address).await {
        Ok(listener) => listener,
        // A preflight that passed and a bind that fails is a race (the tailnet
        // address went away between the two calls) or a port conflict. Both are
        // `EX_CONFIG`: neither is fixed by an immediate restart into the same
        // state, and both are configuration-visible.
        Err(error) => {
            return Startup::Refuse(format!(
                "cannot bind {address} after a successful preflight: {error}"
            ))
        }
    };

    Startup::Serve(listener, Box::new(config))
}

/// Serve until the supervisor asks the process to stop.
///
/// The graceful shutdown is not optional politeness. M7.10's unit is
/// `Restart=always`, and a router killed without draining drops in-flight requests
/// on the floor — including a `POST /trigger` that M7.5 will have made durable, so
/// the caller saw no `202` and the work exists. `axum::serve` stops accepting,
/// finishes in-flight requests, and then returns.
async fn serve(listener: tokio::net::TcpListener, config: Box<RouterConfig>) {
    let app = routes::build(AppState::from_config(&config));

    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        // The socket has already failed. A supervisor will restart; say why.
        eprintln!("aibr-router: serve failed: {error}");
    }
}

/// Resolve when the process is asked to stop.
#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    // `SIGTERM` first: that is what `systemd`'s `Restart=always` and `launchd`'s
    // `KeepAlive` both send, and it is the signal this drain exists for.
    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("aibr-router: cannot install a SIGTERM handler: {error}");
            return;
        }
    };

    let mut interrupt = match signal(SignalKind::interrupt()) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("aibr-router: cannot install a SIGINT handler: {error}");
            return;
        }
    };

    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
}

/// The non-Unix drain.
///
/// Every target in M7.9's matrix is Linux or Darwin, so this arm exists only so
/// that the crate compiles if that matrix is ever widened to Windows, where the
/// analogue is a console control event this crate has no dependency to receive.
/// It does not install a handler; it is a documented gap rather than a silent one.
#[cfg(not(unix))]
async fn shutdown_signal() {
    std::future::pending::<()>().await
}
