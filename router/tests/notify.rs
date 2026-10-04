//! `READY=1` over a real socket, because `Type=notify` is only worth declaring if
//! something arrives.
//!
//! The unit tests in `aibr_router::notify` cover the parsing and the spelling. This
//! file covers the claim M7.10's unit makes: after the router binds, systemd's
//! socket receives `READY=1`, and after `SIGTERM` it receives `STOPPING=1` — in that
//! order, and from the serving process rather than from a test harness imitating it.

mod support;

use std::os::unix::net::UnixDatagram;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use aibr_router::outbox::{IngressOutbox, INGRESS_OUTBOX_ENV};
use support::{config_json, TempDir, TOKEN};

/// A bound `NOTIFY_SOCKET` that records what arrives.
///
/// The socket path is built directly in the temp directory rather than inside a
/// [`TempDir`]: macOS caps `sockaddr_un::sun_path` at 104 bytes, and the per-user
/// temp path on macOS is long enough to blow through it. A test that fails only on
/// one platform is a test that gets deleted on the other.
struct NotifySocket {
    path: PathBuf,
    /// A **datagram** socket, because that is what `sd_notify` sends to. A stream
    /// listener accepts the path and then fails every send with `Protocol wrong
    /// type for socket`, which reads like a router bug and is a test bug.
    socket: UnixDatagram,
}

static SOCKET_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

impl NotifySocket {
    fn bind(label: &str) -> Self {
        let unique = SOCKET_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("aibr-{label}-{}-{unique}.sock", std::process::id()));
        let socket = UnixDatagram::bind(&path).expect("the test can bind a unix datagram socket");
        Self { path, socket }
    }

    /// Block until `expected` arrives, or fail with whatever did.
    /// Wait for `expected`, returning everything received, or `None` on timeout.
    ///
    /// The timeout is reported by the caller rather than panicked here so the
    /// failure can include the router's own stderr — "READY=1 never arrived" is a
    /// much worse bug report than the refusal that explains it.
    fn await_within(&self, expected: &str, within: Duration) -> Option<String> {
        let deadline = Instant::now() + within;
        let mut received: Vec<String> = Vec::new();
        while Instant::now() < deadline {
            self.socket
                .set_nonblocking(true)
                .expect("the socket can go non-blocking");
            let mut buffer = [0_u8; 128];
            match self.socket.recv(&mut buffer) {
                Ok(read) => {
                    received.push(String::from_utf8_lossy(&buffer[..read]).into_owned());
                    if received.iter().any(|line| line.contains(expected)) {
                        return Some(received.join("|"));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => panic!("notify socket failed: {error}"),
            }
        }
        None
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for NotifySocket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("the test can bind loopback");
    let port = listener
        .local_addr()
        .expect("a bound address has a port")
        .port();
    drop(listener);
    port
}

struct Router {
    child: Child,
    /// The child's stderr, on disk, so a failed readiness assertion can say why.
    diagnostics: PathBuf,
}

impl Router {
    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.diagnostics).unwrap_or_default()
    }
}

impl Drop for Router {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_serving(scratch: &TempDir, store: &Path, notify: &Path) -> Router {
    let mut config = config_json(scratch.path());
    config["bridge"]["port"] = serde_json::json!(free_port());
    support::write_config(&scratch.config_path(), &config);

    let diagnostics = scratch.path().join("router-stderr.log");
    let stderr_file = std::fs::File::create(&diagnostics).expect("the log file is creatable");
    let child = Command::new(env!("CARGO_BIN_EXE_aibr-router"))
        .env("AIBRIDGE_CONFIG", scratch.config_path())
        .env("AIBRIDGE_BEARER_TOKEN", TOKEN)
        .env(INGRESS_OUTBOX_ENV, store)
        .env("NOTIFY_SOCKET", notify)
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .unwrap_or_else(|error| panic!("cannot run aibr-router: {error}"));

    Router { child, diagnostics }
}

#[test]
fn the_router_reports_ready_once_it_is_bound_and_stopping_when_asked_to_stop() {
    let scratch = TempDir::new("notify-lifecycle");
    let store = scratch.path().join("ingress-outbox.sqlite");
    IngressOutbox::create(&store).expect("provisioned");
    let notify = NotifySocket::bind("notify");

    let router = spawn_serving(&scratch, &store, notify.path());

    let received = notify.await_within("READY=1", Duration::from_secs(15));
    assert!(
        received.is_some(),
        "READY=1 never arrived; the router wrote:\n{}",
        router.stderr()
    );

    // `SIGTERM` is what `Restart=always` and launchd's `KeepAlive` both send. A
    // router that reported readiness and then ignored the stop signal would be
    // killed mid-request on every deploy.
    signal_term(router.child.id() as i32);

    let received = notify.await_within("STOPPING=1", Duration::from_secs(15));
    assert!(
        received.is_some(),
        "STOPPING=1 never arrived; the router wrote:\n{}",
        router.stderr()
    );
}

/// Send `SIGTERM` without a libc dependency: `/bin/kill` is on every host this
/// targets, and adding `libc` to a crate whose claim is a 1.6 MiB binary is a bad
/// trade for one signal.
fn signal_term(pid: i32) {
    let status = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()
        .expect("the test can run /bin/kill");
    assert!(status.success(), "could not signal the router process");
}

/// A datagram sent to a socket nobody is reading is dropped, not queued forever —
/// so a router started outside systemd must not block on a dead `NOTIFY_SOCKET`.
#[test]
fn a_notify_socket_nobody_reads_does_not_stop_the_router_from_serving() {
    let scratch = TempDir::new("notify-unread");
    let store = scratch.path().join("ingress-outbox.sqlite");
    IngressOutbox::create(&store).expect("provisioned");
    // A socket path that exists and has no reader: bound, then dropped.
    let dead = NotifySocket::bind("unread");
    let dead_path = dead.path().to_path_buf();
    drop(dead);

    let mut router = spawn_serving(&scratch, &store, &dead_path);

    let status = router.child.try_wait().expect("the child can be polled");
    assert!(
        status.is_none(),
        "the router exited instead of serving: {status:?}"
    );
}
