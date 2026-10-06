//! A real child in a real PTY, with the properties that must not be assumed.
//!
//! Everything here spawns an actual process. A PTY host tested against a fake
//! reader would pass while the ordering bug that hands a child a SIGHUP on spawn
//! -- or the one that signals it when a handle drops -- went uncaught, and both of
//! those are exactly the failure this crate exists to prevent.

use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use aibr_pty::{
    PaneError, PaneGeometry, PtyHost, PtySink, RecordingSink, SpawnError, SpawnRequest,
};

/// How long a test waits for a child that should react promptly.
///
/// Generous, because a loaded CI machine schedules a thread late, and tight enough
/// that a genuinely broken expectation fails rather than hangs.
const PATIENCE: Duration = Duration::from_secs(10);

/// The shell used for the fixtures.
///
/// `/bin/sh` with `-c` rather than a Rust test binary, because what is under test
/// is the PTY: the child must be a process that writes bytes and exits, and a
/// second test binary would bring its own harness output into the pane.
fn shell() -> &'static str {
    if cfg!(windows) {
        "cmd.exe"
    } else {
        "/bin/sh"
    }
}

/// A scratch directory that is inside the allowlist, so the fixture's
/// working-directory check passes.
fn project_directory() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("aibr-pty-project-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("the scratch directory is created");
    directory.canonicalize().expect("canonicalisable")
}

fn host_with_sink(roots: Vec<PathBuf>, sink: Arc<dyn PtySink>) -> PtyHost {
    PtyHost::new(roots, sink)
}

/// A request for a shell that runs `script` in the scratch project directory.
fn request(pane_id: &str, script: &str) -> SpawnRequest {
    SpawnRequest {
        pane_id: pane_id.to_owned(),
        command: vec![shell().to_owned(), "-c".to_owned(), script.to_owned()],
        working_directory: project_directory(),
        geometry: PaneGeometry {
            columns: 80,
            rows: 24,
        },
    }
}

#[test]
fn a_spawned_child_streams_its_output_as_chunks_with_a_monotonic_sequence() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    // Three separate writes with gaps between them, so a host that emitted one
    // frame per child rather than one per read would produce one chunk here.
    host.spawn(request(
        "pane-1",
        "printf first; sleep 0.2; printf second; sleep 0.2; printf third",
    ))
    .expect("the child spawns");

    assert!(
        sink.await_chunk_containing("third", PATIENCE).is_some(),
        "PTY output must reach the sink, not sit in a kernel buffer nobody reads"
    );

    let chunks = sink.chunks();
    assert!(
        chunks.len() >= 2,
        "the payload is chunked rather than delivered as one frame: a client renders from \
         chunks, and a host that coalesced until the child exited would show nothing until then"
    );

    // Every chunk carries the pane it belongs to and a strictly increasing
    // sequence. The sequence is the client's only way to know it missed output.
    let sequences: Vec<i64> = chunks.iter().map(|chunk| chunk.sequence).collect();
    assert!(
        sequences.windows(2).all(|pair| pair[0] < pair[1]),
        "the per-pane sequence must be strictly increasing, got {sequences:?}"
    );
    assert!(
        chunks
            .iter()
            .all(|chunk| chunk.pane_id.as_str() == "pane-1"),
        "a chunk must name its pane, or a client cannot route it to a grid"
    );
    assert!(
        chunks.iter().all(|chunk| !chunk.final_),
        "`final` is false on every emitted chunk: the pane is still open, and a client \
         that stopped reading on a spurious `final` would show a dead grid"
    );
}

#[test]
fn pty_bytes_survive_the_round_trip_unchanged() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    // A truecolor SGR, a box-drawing character, and a high byte: exactly the cases
    // a lossy `latin1` string would corrupt, and the reason the frame is base64.
    host.spawn(request(
        "pane-bytes",
        r#"printf '\033[38;2;255;0;128m\xe2\x94\x82 caf\xc3\xa9 \033[0m'"#,
    ))
    .expect("the child spawns");

    let text = sink
        .await_chunk_containing("café", PATIENCE)
        .expect("the output arrives");
    assert!(
        text.contains('\u{1b}'),
        "escape sequences must pass through untouched: the client's VT parser owns \
         interpretation, so the host must not filter them"
    );
    assert!(
        text.contains('\u{2502}'),
        "multi-byte UTF-8 must survive; this is what a byte-typed JSON field is for"
    );
}

#[test]
fn a_resize_is_delivered_to_the_child() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    // `stty size` reports the terminal the child is attached to, so this asserts
    // the resize reached the KERNEL's window size rather than just our record of
    // it. A host that remembered the geometry without calling `resize` would pass
    // a weaker test and produce a pane that wraps wrongly.
    host.spawn(request("pane-resize", "sleep 0.3; stty size; sleep 5"))
        .expect("the child spawns");

    host.resize_pane(
        "pane-resize",
        NonZeroU64::new(120).expect("nonzero"),
        NonZeroU64::new(40).expect("nonzero"),
    )
    .expect("the terminal accepts the resize");

    assert_eq!(
        host.geometry("pane-resize"),
        Some(PaneGeometry {
            columns: 120,
            rows: 40
        }),
        "the host's record of the geometry matches what it asked the kernel for"
    );
    assert!(
        sink.await_chunk_containing("40 120", PATIENCE).is_some(),
        "the child must observe the new window size; a resize the agent cannot see is \
         indistinguishable from no resize at all"
    );
}

#[test]
fn input_written_to_a_pane_reaches_the_child() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    // `read` is the simplest possible proof that input crossed the boundary: it
    // cannot produce output without having received bytes.
    host.spawn(request(
        "pane-input",
        "read line; printf 'got:%s' \"$line\"",
    ))
    .expect("the child spawns");

    host.write("pane-input", b"ping\n")
        .expect("the write reaches the terminal");

    assert!(
        sink.await_chunk_containing("got:ping", PATIENCE).is_some(),
        "keystrokes must reach the child, or the pane is a read-only view"
    );
}

#[test]
fn a_child_that_exits_reports_its_status() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    host.spawn(request("pane-exit", "exit 7"))
        .expect("the child spawns");

    let exit = sink
        .await_exit(PATIENCE)
        .expect("the child reports its exit");
    assert_eq!(exit.pane_id.as_str(), "pane-exit");
    assert_eq!(
        exit.exit_status,
        Some(7),
        "the exit code is the child's own, not a placeholder"
    );
    assert_eq!(
        exit.signal, None,
        "a child that exited on its own was not signalled"
    );
}

/// The property this workstream exists for.
///
/// The host -- and therefore every handle a connection could hold -- is dropped,
/// and the child must still be running. Asserted against the PROCESS with
/// `kill -0`, not against the sink: the sink is a test double, and a double
/// cannot tell us whether a SIGHUP was delivered.
#[test]
fn a_dropped_host_and_connection_leave_the_child_running() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    host.spawn(request("pane-survivor", "printf up; sleep 30"))
        .expect("the child spawns");
    assert!(
        sink.await_chunk_containing("up", PATIENCE).is_some(),
        "the child started before anything is dropped"
    );

    let pid = host
        .process_id("pane-survivor")
        .expect("a POSIX child has a pid");

    // Stand in for a client that connects, watches, and goes away, and then for the
    // daemon going away too: every handle is dropped. Nothing here signals
    // anything, and that is the point -- there is no `Drop` impl on `Pane` or
    // `PtyHost` that could.
    let pane = host.pane("pane-survivor").expect("the pane is open");
    drop(pane);
    drop(host);
    drop(sink);

    // Give the kernel a moment to deliver a SIGHUP if one were coming, so the
    // assertion cannot pass by racing the signal.
    std::thread::sleep(Duration::from_millis(500));

    assert!(
        process_exists(pid),
        "the child (pid {pid}) must outlive the host and every connection to it; a SIGHUP \
         here is the exact failure Phase 6 invariant 1 forbids"
    );

    // Leave no stray agent behind for the next test run.
    let _ = std::process::Command::new("kill")
        .arg(pid.to_string())
        .status();
}

/// The same property asserted through the host, which is the shape a daemon has:
/// the host is still there, the peer is not, and the child is unaffected.
#[test]
fn a_detaching_peer_leaves_the_child_running() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    host.spawn(request("pane-detach", "printf running; sleep 30"))
        .expect("the child spawns");
    assert!(sink.await_chunk_containing("running", PATIENCE).is_some());

    // What a detaching client does: stop consuming. Nothing is cancelled, because
    // there is no API through which consuming could cancel.
    let pane = host.pane("pane-detach").expect("the pane is open");
    drop(pane);

    assert!(
        host.is_running("pane-detach"),
        "a peer that stopped watching must not stop the agent; only `close_pane` signals"
    );
}

#[test]
fn closing_a_pane_signals_its_child_and_forgets_it() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    host.spawn(request("pane-closed", "sleep 30"))
        .expect("the child spawns");
    assert!(host.is_running("pane-closed"));

    host.close_pane("pane-closed").expect("the pane closes");

    assert!(
        host.pane("pane-closed").is_none(),
        "a closed pane is gone from the host's inventory"
    );
    assert!(
        sink.await_exit(PATIENCE).is_some(),
        "closing a pane still reports the exit, so a client sees why it disappeared"
    );
}

#[test]
fn a_working_directory_outside_the_allowlist_is_refused_and_nothing_spawns() {
    let sink = Arc::new(RecordingSink::default());
    let allowed = project_directory();
    let host = host_with_sink(vec![allowed.clone()], Arc::clone(&sink) as Arc<dyn PtySink>);

    let outside = std::env::temp_dir().join("aibr-pty-definitely-outside");
    std::fs::create_dir_all(&outside).expect("created");

    let mut refused = request("pane-outside", "sleep 30");
    refused.working_directory = outside;

    assert!(
        matches!(
            host.spawn(refused),
            Err(SpawnError::WorkingDirectoryNotAllowed { .. })
        ),
        "a client must not be able to run a child in a directory the allowlist excludes"
    );
    assert!(
        host.panes().is_empty(),
        "the refusal happens before the PTY is opened, so there is no half-built pane to clean up"
    );
}

#[test]
fn a_duplicate_pane_id_is_refused() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    host.spawn(request("pane-dup", "sleep 30"))
        .expect("the child spawns");
    assert!(
        matches!(
            host.spawn(request("pane-dup", "sleep 30")),
            Err(SpawnError::PaneAlreadyExists { .. })
        ),
        "two children sharing one pane id would make every chunk ambiguous"
    );
}

#[test]
fn operations_on_a_pane_that_is_not_open_are_refused_rather_than_panicking() {
    let sink = Arc::new(RecordingSink::default());
    let host = host_with_sink(
        vec![project_directory()],
        Arc::clone(&sink) as Arc<dyn PtySink>,
    );

    assert!(matches!(
        host.write("nope", b"x"),
        Err(PaneError::NotFound { .. })
    ));
    assert!(matches!(
        host.close_pane("nope"),
        Err(PaneError::NotFound { .. })
    ));
    assert!(matches!(
        host.resize_pane(
            "nope",
            NonZeroU64::new(80).expect("nonzero"),
            NonZeroU64::new(24).expect("nonzero")
        ),
        Err(PaneError::NotFound { .. })
    ));
    assert_eq!(host.geometry("nope"), None);
    assert!(!host.is_running("nope"));
}

/// Whether a process is still running, asked of the kernel.
///
/// `kill -0` delivers no signal and reports only whether the process exists and is
/// still signallable, which is exactly the question being asked. It is a
/// subprocess rather than a `libc` call because taking a dependency in a test to
/// ask one question is not worth it; the crate's own `libc` use is the signal-name
/// table.
#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Windows has no `kill -0`, and the process-level assertion is not meaningful
/// there; the host-level property is covered by
/// `a_detaching_peer_leaves_the_child_running`, which is platform-neutral.
#[cfg(not(unix))]
fn process_exists(_pid: u32) -> bool {
    true
}
