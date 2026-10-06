//! The listener's observable behaviour: bind, accept, refuse, survive.
//!
//! Each test binds a real socket in a real directory, because what is under test
//! is the bind-probe-accept sequence itself; a mock of it would pass while the
//! stale-socket rule or the private-parent rule silently did nothing. Each is
//! written as the failure it prevents.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use aibr_ipc::contracts::{ControlCommand, ServerMessage};
use aibr_ipc::frame::{self, AsyncFrameRead};
use aibr_ipc::server::{
    socket_path, ConnectionHandler, PeerHandle, PublishOutcome, Server, ServerError,
};
// `ToFsName` for building a name from a path; `ListenerOptions` for the corpse a
// crashed listener leaves. The tokio `Stream` trait is imported per-call inside
// `connect` instead of here, because the prelude glob also pulls in the SYNC `Stream`
// trait and `Stream::connect` through it is ambiguous between the two transports.
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName};

/// A socket path private to one test.
///
/// Unique per name AND per process, so neither two tests nor two concurrent test
/// binaries can collide on it the way they would on the real `/tmp/aibr/aibrd.sock`.
fn test_socket(name: &str) -> String {
    let directory =
        std::env::temp_dir().join(format!("aibr-ipc-test-{}-{name}", std::process::id()));
    directory.join("daemon.sock").to_string_lossy().into_owned()
}

fn name_of(path: &str) -> interprocess::local_socket::Name<'static> {
    path.to_owned()
        .to_fs_name::<GenericFilePath>()
        .expect("the test path is a usable local socket name")
}

/// The tokio local socket stream, named explicitly rather than through
/// `prelude::*`: that glob also imports the SYNC `Stream` trait, and
/// `Stream::connect` through it is ambiguous between the two transports.
type Client = interprocess::local_socket::tokio::Stream;

async fn connect(path: &str) -> Client {
    use interprocess::local_socket::traits::tokio::Stream as _;
    Client::connect(name_of(path))
        .await
        .expect("the daemon is listening")
}

/// A handler that records what arrived and can answer on connect.
#[derive(Default)]
struct RecordingHandler {
    connected: AtomicUsize,
    peers: Mutex<Vec<PeerHandle>>,
    commands: Mutex<Vec<ControlCommand>>,
    answer: Mutex<Option<ServerMessage>>,
}

impl RecordingHandler {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn answer_on_connect(&self, frame: ServerMessage) {
        *self.answer.lock().expect("unpoisoned") = Some(frame);
    }

    fn attached(&self) -> usize {
        self.peers.lock().expect("unpoisoned").len()
    }

    /// The handle the last peer was given, so a test can publish through the same
    /// queue the daemon writes to rather than reaching into private state.
    fn last_peer(&self) -> Option<PeerHandle> {
        self.peers.lock().expect("unpoisoned").last().cloned()
    }

    fn received(&self) -> Vec<ControlCommand> {
        self.commands.lock().expect("unpoisoned").clone()
    }
}

impl ConnectionHandler for RecordingHandler {
    fn on_connect(
        self: Arc<Self>,
        peer: PeerHandle,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async move {
            self.connected.fetch_add(1, Ordering::SeqCst);
            self.peers.lock().expect("unpoisoned").push(peer.clone());
            if let Some(frame) = self.answer.lock().expect("unpoisoned").clone() {
                peer.publish(frame);
            }
        })
    }

    fn on_command(
        self: Arc<Self>,
        peer: PeerHandle,
        command: ControlCommand,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async move {
            self.commands.lock().expect("unpoisoned").push(command);
            let _ = peer;
        })
    }
}

/// An `ack` frame, used to prove a queued frame reached a specific client.
fn ack(command_type: &str) -> ServerMessage {
    ServerMessage::Ack {
        accepted: true,
        command_type: aibr_ipc::contracts::ServerMessage4CommandType::try_from(
            command_type.to_owned(),
        )
        .expect("a valid command type"),
    }
}

fn resize(columns: u64, rows: u64) -> ControlCommand {
    ControlCommand::ResizePane {
        columns: std::num::NonZeroU64::new(columns).expect("nonzero"),
        pane_id: aibr_ipc::contracts::ControlCommand4PaneId::try_from("pane-1".to_owned())
            .expect("a valid pane id"),
        rows: std::num::NonZeroU64::new(rows).expect("nonzero"),
    }
}

async fn write(stream: &mut Client, bytes: &[u8]) {
    use tokio::io::AsyncWriteExt;
    stream
        .write_all(bytes)
        .await
        .expect("the socket accepts writes");
}

/// Read one frame, failing rather than hanging if the daemon says nothing.
async fn read_frame(reader: &mut tokio::io::BufReader<Client>) -> Vec<u8> {
    tokio::time::timeout(std::time::Duration::from_secs(5), reader.read_frame())
        .await
        .expect("the daemon answered within five seconds")
        .expect("no framing error")
        .expect("a frame, not EOF")
}

/// Poll a condition, because the accept loop runs in another task and a test
/// cannot await its progress directly.
async fn wait_for(mut condition: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if condition() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    false
}

#[cfg(unix)]
#[tokio::test]
async fn binding_creates_the_parent_directory_privately() {
    use std::os::unix::fs::PermissionsExt;

    let path = test_socket("private-parent");
    let _server = Server::bind(&path).expect("a fresh path binds");

    let parent = PathBuf::from(&path)
        .parent()
        .expect("the socket has a parent")
        .to_path_buf();
    let mode = std::fs::metadata(&parent)
        .expect("the parent exists")
        .permissions()
        .mode();
    assert_eq!(
        mode & 0o077,
        0,
        "a daemon reachable by any local user is a daemon any local user can drive"
    );
}

#[tokio::test]
async fn binding_over_a_live_daemon_is_refused_rather_than_stolen() {
    let path = test_socket("already-running");
    let _first = Server::bind(&path).expect("the first bind succeeds");

    match Server::bind(&path) {
        Err(ServerError::AlreadyRunning { .. }) => {}
        Err(other) => panic!("expected AlreadyRunning, got {other:?}"),
        Ok(_) => panic!(
            "a second daemon must refuse to start, not replace the socket. Replacing it would \
             leave the first daemon running and unreachable, so two daemons would both answer \
             clients"
        ),
    }
}

/// A crashed daemon leaves its socket file behind. This is the case the probe
/// exists for, reproduced by binding with reclamation disabled rather than by
/// killing a process.
#[cfg(unix)]
#[tokio::test]
async fn binding_over_a_dead_daemons_socket_reclaims_the_name() {
    use std::os::unix::fs::PermissionsExt;

    let path = test_socket("stale");
    // Created privately, as `Server::bind` would: a `create_dir_all` under the
    // default umask yields 0755, which the bind path refuses for exactly the
    // reason this test's own sibling asserts.
    let parent = PathBuf::from(&path)
        .parent()
        .expect("the socket has a parent")
        .to_path_buf();
    std::fs::create_dir_all(&parent).expect("the directory exists");
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
        .expect("the directory is made private");
    {
        let corpse = ListenerOptions::new()
            .name(name_of(&path))
            // Exactly what a crash leaves: a socket file with nothing behind it.
            .reclaim_name(false)
            .create_tokio()
            .expect("the first listener binds");
        drop(corpse);
    }
    assert!(
        PathBuf::from(&path).exists(),
        "the corpse is still on disk, which is the condition being tested"
    );

    let server = Server::bind(&path);
    assert!(
        server.is_ok(),
        "a stale socket must be reclaimed rather than failing forever with AddrInUse: {:?}",
        server.err()
    );
}

#[tokio::test]
async fn several_peers_are_served_concurrently_and_each_answers_its_own_socket() {
    let path = test_socket("multi-client");
    let handler = RecordingHandler::new();
    handler.answer_on_connect(ack("request_snapshot"));
    let server = Server::bind(&path).expect("binds");
    let accepting = tokio::spawn({
        let handler = Arc::clone(&handler);
        async move { server.serve(handler).await }
    });

    let mut clients = Vec::new();
    for _ in 0..4 {
        let stream = connect(&path).await;
        clients.push(tokio::io::BufReader::new(stream));
    }

    // Each client reads the frame queued for ITS socket. If peers shared a queue,
    // or if the accept loop served them one at a time, a client would read another
    // client's frame or nothing at all.
    for reader in &mut clients {
        let payload = read_frame(reader).await;
        let decoded = aibr_ipc::message::decode(&payload).expect("the frame decodes");
        assert_eq!(
            decoded.tag(),
            aibr_ipc::message::MessageTag::Ack,
            "every attached client is answered on its own socket"
        );
    }

    assert!(
        wait_for(|| handler.attached() == 4).await,
        "all four peers were accepted, not just the first"
    );

    accepting.abort();
}

#[tokio::test]
async fn a_command_frame_reaches_the_handler_decoded() {
    let path = test_socket("commands");
    let handler = RecordingHandler::new();
    let server = Server::bind(&path).expect("binds");
    let accepting = tokio::spawn({
        let handler = Arc::clone(&handler);
        async move { server.serve(handler).await }
    });

    let mut client = connect(&path).await;
    write(
        &mut client,
        &frame::encode(&resize(120, 40)).expect("encodes"),
    )
    .await;

    assert!(
        wait_for(|| handler.received().len() == 1).await,
        "a well-formed command is delivered"
    );
    match handler.received().first() {
        Some(ControlCommand::ResizePane { columns, rows, .. }) => {
            assert_eq!(columns.get(), 120);
            assert_eq!(rows.get(), 40);
        }
        other => panic!("the pane geometry must survive the round trip: {other:?}"),
    }

    accepting.abort();
}

#[tokio::test]
async fn a_frame_above_the_cap_costs_the_peer_its_connection_and_nothing_else() {
    let path = test_socket("frame-cap");
    let handler = RecordingHandler::new();
    let server = Server::bind(&path).expect("binds");
    let accepting = tokio::spawn({
        let handler = Arc::clone(&handler);
        async move { server.serve(handler).await }
    });

    // One peer announces more than the cap, which is refused before any
    // allocation on the strength of a number a peer supplied.
    let mut offender = connect(&path).await;
    let announced = (frame::MAX_FRAME_BYTES as u32) + 1;
    write(&mut offender, &announced.to_be_bytes()).await;
    drop(offender);

    // The daemon is still serving, and the budget is still available.
    let mut honest = connect(&path).await;
    write(
        &mut honest,
        &frame::encode(&ControlCommand::Ping).expect("encodes"),
    )
    .await;
    assert!(
        wait_for(|| handler.received().len() == 1).await,
        "a peer that announced an oversized frame must cost only its own connection; the daemon \
         holds every other client's PTYs"
    );

    accepting.abort();
}

#[tokio::test]
async fn a_contract_violation_costs_the_peer_its_connection_and_nothing_else() {
    let path = test_socket("contract");
    let handler = RecordingHandler::new();
    let server = Server::bind(&path).expect("binds");
    let accepting = tokio::spawn({
        let handler = Arc::clone(&handler);
        async move { server.serve(handler).await }
    });

    let mut offender = connect(&path).await;
    let framed =
        frame::encode_payload(br#"{"type":"not_a_command","unexpected":true}"#).expect("encodes");
    write(&mut offender, &framed).await;
    drop(offender);

    let mut honest = connect(&path).await;
    write(
        &mut honest,
        &frame::encode(&ControlCommand::Ping).expect("encodes"),
    )
    .await;
    assert!(
        wait_for(|| handler.received().len() == 1).await,
        "an unknown command type is a protocol violation for that peer alone; the peer is never \
         silently tolerated, because a skipped command is a command that did not happen"
    );

    accepting.abort();
}

/// The queue's bound is enforced on the real per-peer queue the daemon hands to a
/// handler, not on a synthetic one.
/// The memory bound, exercised on the real per-peer queue a handler is handed.
///
/// A stalled client -- connected, then never reading -- is what the ceiling
/// exists for: the socket's own buffers fill, the queue fills behind them, and
/// from then on the only question is whether the queue stays bounded. PTY chunks
/// are the frame that matters because they are the large ones.
#[tokio::test]
async fn a_stalled_peer_cannot_grow_the_daemons_queue() {
    let path = test_socket("bounded");
    let handler = RecordingHandler::new();
    let server = Server::bind(&path).expect("binds");
    let accepting = tokio::spawn({
        let handler = Arc::clone(&handler);
        async move { server.serve(handler).await }
    });

    let _stalled = connect(&path).await;
    assert!(
        wait_for(|| handler.attached() == 1).await,
        "the stalled peer attached"
    );
    let peer = handler.last_peer().expect("a peer handle");

    // The largest chunk the contract permits -- `MAX_PTY_CHUNK_BYTES` of raw bytes,
    // base64-encoded -- because that is the frame that decides whether a byte bound
    // is real. Forty of them is roughly 10 MiB against a 4 MiB ceiling, so the
    // socket buffers fill, the queue fills, and the eviction policy takes over.
    let payload = "A".repeat(349_525);
    let mut outcomes: Vec<PublishOutcome> = Vec::new();
    for sequence in 0..40 {
        outcomes.push(
            peer.publish(ServerMessage::PtyChunk {
                data: aibr_ipc::contracts::ServerMessage2Data::try_from(payload.clone())
                    .expect("valid base64"),
                final_: false,
                pane_id: aibr_ipc::contracts::ServerMessage2PaneId::try_from("pane-1".to_owned())
                    .expect("a valid pane id"),
                sequence,
            }),
        );
    }

    assert!(
        outcomes
            .iter()
            .any(|outcome| *outcome != PublishOutcome::Delivered),
        "a peer that stopped reading must stop getting Delivered: {:?}",
        outcomes
            .iter()
            .filter(|o| **o == PublishOutcome::Delivered)
            .count()
    );
    assert!(
        peer.queued() <= aibr_ipc::server::MAX_OUTBOUND_FRAMES,
        "the queue never exceeds its frame ceiling, whatever the peer does: {}",
        peer.queued()
    );

    accepting.abort();
}

/// The invariant Phase 6 names: a client leaving is not a daemon action.
#[tokio::test]
async fn detaching_closes_the_connection_and_cancels_nothing() {
    let path = test_socket("detach");
    let handler = RecordingHandler::new();
    let server = Server::bind(&path).expect("binds");
    let accepting = tokio::spawn({
        let handler = Arc::clone(&handler);
        async move { server.serve(handler).await }
    });

    let mut client = connect(&path).await;
    write(
        &mut client,
        &frame::encode(&ControlCommand::Detach).expect("encodes"),
    )
    .await;
    assert!(
        wait_for(|| handler.received().len() == 1).await,
        "detach arrives as a command like any other"
    );

    // A second peer attaches immediately afterwards and is served, so the daemon
    // neither shut down nor shed its state.
    let mut second = connect(&path).await;
    write(
        &mut second,
        &frame::encode(&ControlCommand::Ping).expect("encodes"),
    )
    .await;
    assert!(
        wait_for(|| handler.received().len() == 2).await,
        "detach is not shutdown: there is deliberately no code path where leaving the TUI \
         stops a job"
    );

    accepting.abort();
}

#[tokio::test]
async fn a_frame_published_on_connect_reaches_the_client() {
    let path = test_socket("snapshot-on-connect");
    let handler = RecordingHandler::new();
    handler.answer_on_connect(ack("request_snapshot"));
    let server = Server::bind(&path).expect("binds");
    let accepting = tokio::spawn({
        let handler = Arc::clone(&handler);
        async move { server.serve(handler).await }
    });

    let stream = connect(&path).await;
    let mut reader = tokio::io::BufReader::new(stream);
    let decoded = aibr_ipc::message::decode(&read_frame(&mut reader).await).expect("decodes");
    assert_eq!(
        decoded.tag(),
        aibr_ipc::message::MessageTag::Ack,
        "a client that asks for a snapshot is answered on connect without polling"
    );

    accepting.abort();
}

/// The path resolution the daemon binds must be the one the client dials.
#[test]
fn the_override_env_var_wins_over_every_default() {
    let previous = std::env::var_os("AIBRIDGE_IPC_SOCKET");
    // The environment is process-global, so this asserts only what it can: that
    // the override is honoured. Every test in this crate and every manual run on
    // macOS is otherwise in the "unset" state this restores.
    std::env::set_var("AIBRIDGE_IPC_SOCKET", "/tmp/aibr-test-override.sock");
    let resolved = socket_path().expect("the override is honoured");
    assert_eq!(resolved, "/tmp/aibr-test-override.sock");

    match previous {
        Some(value) => std::env::set_var("AIBRIDGE_IPC_SOCKET", value),
        None => std::env::remove_var("AIBRIDGE_IPC_SOCKET"),
    }
}
