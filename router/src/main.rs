//! `aibr-router` — the process.
//!
//! Five steps, in this order, and the order is the design:
//!
//! 1. Read `config.json` and the bearer token. Failure exits `78` (`EX_CONFIG`).
//! 2. **Open the admission store.** Failure exits `78`, and the store is never
//!    created here (M7.5).
//! 3. **Preflight the bind address.** Failure exits `78` having bound nothing.
//! 4. Bind.
//! 5. Serve.
//!
//! Steps 3 and 4 are separate calls rather than "bind and see". Binding and then
//! discovering the address was unusable is not a plan; it is the failure mode
//! ADR 0008 §8 layer 1 exists to prevent, and the only way to be sure the router
//! does not answer on a wildcard after the tailnet address went away is to decide
//! *before* it holds a socket. See [`aibr_router::bind`].
//!
//! The store is opened *before* the preflight because both are configuration and
//! neither is worth discovering once a listening socket exists: a store that cannot
//! be opened means every `POST /trigger` would answer `503`, and finding that out
//! after binding turns a configuration error into an outage that looks like a
//! dependency failure. Opening it before the preflight also means this process never
//! opens a database it is not going to serve with.
//!
//! Exit codes are part of this program's interface to its supervisor (M7.10) and
//! to M7.11's negative tests, so they are named constants rather than literals:
//!
//! | Code | Meaning |
//! | --- | --- |
//! | `78` (`EX_CONFIG`) | configuration, admission store, or bind address unusable; will not fix itself on restart |
//! | `0` | clean shutdown on `SIGTERM`/`SIGINT` |

use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use aibr_router::bind::{self, EX_CONFIG};
use aibr_router::config::RouterConfig;
use aibr_router::outbox::{self, IngressOutbox, INGRESS_OUTBOX_ENV};
use aibr_router::routes::{self, AppState};

/// What the process should do, decided by the things above it.
///
/// The `RouterConfig` is boxed. `BridgeConfig` is eight nested structs and measures
/// 448 bytes, so carrying it inline makes `Startup` a 448-byte enum that gets moved
/// twice — once out of `startup`, once into `serve` — for a value that lives for
/// the life of the process and is never moved again. This is also why the crate-level
/// `large_enum_variant` allowance is scoped to the generated module and not to the
/// crate: a hand-written enum gets the lint, as here.
enum Startup {
    /// Config loaded, store open, preflight passed, socket bound.
    Serve(
        tokio::net::TcpListener,
        Box<RouterConfig>,
        Arc<IngressOutbox>,
    ),
    /// Configuration, the admission store, or the bind preflight failed. The message
    /// is safe to print: all three sources are operator configuration, and none
    /// carries the bearer token (see [`aibr_router::config::ConfigError`], whose
    /// variants cannot hold it, and [`IngressOutbox`]'s errors, which are paths,
    /// schema versions and SQLite messages — never a payload).
    Refuse(String),
}

#[tokio::main]
async fn main() -> ExitCode {
    match startup().await {
        Startup::Serve(listener, config, outbox) => {
            serve(listener, config, outbox).await;
            ExitCode::SUCCESS
        }
        Startup::Refuse(message) => {
            eprintln!("aibr-router: {message}");
            ExitCode::from(EX_CONFIG)
        }
    }
}

/// Load configuration, open the store, preflight the address, then bind.
///
/// Returns [`Startup::Refuse`] rather than exiting, so every refusal takes the same
/// path to the same exit code. An `exit(78)` written at each of four call sites is
/// four places to get the code wrong.
async fn startup() -> Startup {
    let config = match RouterConfig::from_env() {
        Ok(config) => config,
        Err(error) => return Startup::Refuse(error.to_string()),
    };

    let outbox = match open_admission_store() {
        Ok(outbox) => outbox,
        Err(error) => return Startup::Refuse(error),
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

    Startup::Serve(listener, Box::new(config), outbox)
}

/// Open the admission store named by [`INGRESS_OUTBOX_ENV`].
///
/// **`open`, never `create`, and there is no third option.** The three refusals are
/// all `EX_CONFIG`, and the plan's crash-window row "SQLite store deleted" is exactly
/// this function:
///
/// - the variable is unset — the store has no default path, deliberately, because a
///   default would be relative to a working directory and a systemd unit with a
///   different `WorkingDirectory` than the shell that provisioned the store would
///   produce a second empty queue with no error anywhere;
/// - the file is absent — [`IngressOutbox::open`] refuses to create it, and this
///   process does not catch that and try again;
/// - the file exists but cannot be opened, or is at a schema version this build does
///   not speak.
///
/// Every one of them exits `78`. **There is no in-memory fallback**, and the absence
/// is the point: a router that admits into memory when SQLite is unavailable tells
/// every caller `202` and then drops everything on the next restart (ADR 0008 §2.5).
///
/// The returned string is a [`outbox::StoreError`]'s `Display`: a path, a schema
/// version or a SQLite message. It goes to stderr at startup, never to a socket.
fn open_admission_store() -> Result<Arc<IngressOutbox>, String> {
    let configured = std::env::var(INGRESS_OUTBOX_ENV)
        .map_err(|_| outbox::StoreError::MissingPath.to_string())?;

    let path = Path::new(&configured);
    if !path.is_absolute() {
        // Refused rather than resolved against the working directory, for the same
        // reason `bind::preflight` refuses a hostname: which file this process opens
        // must not depend on where a supervisor happened to start it.
        return Err(format!(
            "{INGRESS_OUTBOX_ENV} must be an absolute path, and {configured:?} is not. A \
             relative path resolves against this process's working directory, which is \
             whatever a supervisor chose, and two of them produce two empty queues"
        ));
    }

    IngressOutbox::open(path)
        .map(Arc::new)
        .map_err(|error| error.to_string())
}

/// Serve until the supervisor asks the process to stop.
///
/// The graceful shutdown is not optional politeness. M7.10's unit is
/// `Restart=always`, and a router killed without draining drops in-flight requests on
/// the floor. Since M7.5 that is a *bounded* failure rather than a silent one: the
/// router commits before it answers, so a dropped request is either a committed row
/// with no `202` (the caller's retry converges on it, one job) or no row at all (the
/// caller's retry creates it). Neither is loss, and neither is the pre-M7.5 outcome
/// where a `202` could be lost with nothing durable behind it. `axum::serve` stops
/// accepting, finishes in-flight requests, and then returns.
async fn serve(
    listener: tokio::net::TcpListener,
    config: Box<RouterConfig>,
    outbox: Arc<IngressOutbox>,
) {
    let app = routes::build(AppState::from_config(&config, outbox));

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
