// SPIKE CODE -- NOT PRODUCTION. A measurement stub for M7.1. See Cargo.toml for
// why it exists and, at greater length, for everything it deliberately omits.
// It is NOT the aibr-router binary, it implements no security gate, and nothing
// in it may be reused by M7.3.
//
// Two routes and a tokio runtime. Nothing else. Its RSS is the floor the real
// router will sit near, not an estimate of the real router: see Cargo.toml.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;

#[derive(Clone)]
struct AppState {
    accepted: Arc<AtomicU64>,
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn trigger(State(state): State<AppState>, body: String) -> impl IntoResponse {
    // The body is read but not validated: real request validation is M7.3's work,
    // and this stub must not acquire the appearance of a trust boundary.
    let _bytes = body.len();
    state.accepted.fetch_add(1, Ordering::Relaxed);
    (StatusCode::ACCEPTED, "{\"accepted\":true,\"spike\":true,\"persistent\":false}")
}

#[tokio::main]
async fn main() {
    // An ephemeral port by default, and `--port-file` so a caller that must issue
    // HTTP to this process can learn which port the kernel chose. A fixed 8787
    // here would collide with topology A's Fastify listener and with any leftover
    // from an earlier capture, and the resulting failure mode is a stub that
    // silently never bound while the measurement attributes its memory to nobody.
    let mut bind = "127.0.0.1:0".to_string();
    let mut port_file: Option<String> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => bind = args.next().unwrap_or(bind),
            "--port-file" => port_file = args.next(),
            other => {
                eprintln!("spike-router-stub: unknown argument {other}");
                std::process::exit(2);
            }
        }
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/trigger", post(trigger))
        .with_state(AppState {
            accepted: Arc::new(AtomicU64::new(0)),
        });

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|error| panic!("spike-router-stub: cannot bind {bind}: {error}"));
    let bound = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("spike-router-stub: cannot read the bound address: {error}"));

    if let Some(path) = port_file.as_deref() {
        std::fs::write(path, format!("{}\n", bound.port()))
            .unwrap_or_else(|error| panic!("spike-router-stub: cannot write the port file {path}: {error}"));
    }
    eprintln!(
        "spike-router-stub: MEASUREMENT STUB, NOT aibr-router -- listening on {bound}, \
         no SQLite, no durable write, no security gate"
    );

    axum::serve(listener, app).await.expect("spike-router-stub: serve");
}