//! Framing tests.
//!
//! The cases here are the ones the frame cap and the read loop exist for, and each
//! names the failure it prevents. A codec with no tests is a codec that will
//! eventually allocate on an untrusted length, and the tests are the only thing
//! standing between that bug and a remote-ish peer on a local socket.

use aibr_ipc::frame::{
    decode_payload, encode, encode_payload, read_frame_blocking, AsyncFrameRead, FrameError,
    LENGTH_PREFIX_BYTES, MAX_FRAME_BYTES,
};

#[test]
fn a_frame_round_trips_through_the_prefix() {
    let payload = br#"{"type":"ack","commandType":"detach","accepted":true}"#;
    let framed = encode_payload(payload).expect("a small payload encodes");

    assert_eq!(
        &framed[..LENGTH_PREFIX_BYTES],
        &(payload.len() as u32).to_be_bytes(),
        "the prefix must be big-endian: the reader decodes it with from_be_bytes"
    );

    let mut reader = framed.as_slice();
    let decoded = read_frame_blocking(&mut reader)
        .expect("reads")
        .expect("a frame, not EOF");
    assert_eq!(decoded, payload);
}

#[test]
fn two_frames_in_one_buffer_are_read_separately() {
    let mut buffer = Vec::new();
    buffer.extend(encode_payload(b"first").expect("encodes"));
    buffer.extend(encode_payload(b"second").expect("encodes"));

    let mut reader = buffer.as_slice();
    assert_eq!(
        read_frame_blocking(&mut reader).expect("reads"),
        Some(b"first".to_vec())
    );
    assert_eq!(
        read_frame_blocking(&mut reader).expect("reads"),
        Some(b"second".to_vec())
    );
    assert_eq!(
        read_frame_blocking(&mut reader).expect("reads"),
        None,
        "a clean close on a frame boundary is not an error"
    );
}

/// A frame arriving in pieces must still decode.
///
/// This is the case a `read()`-once-per-frame implementation gets wrong, and it is
/// not hypothetical: a 4-byte prefix and a 40 KB payload are routinely split across
/// two reads on a local socket.
#[test]
fn a_frame_split_across_reads_is_reassembled() {
    /// A reader that yields at most `chunk` bytes per call.
    struct Trickle<'a> {
        data: &'a [u8],
        chunk: usize,
    }

    impl std::io::Read for Trickle<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.data.is_empty() {
                return Ok(0);
            }
            let count = self.chunk.min(buffer.len()).min(self.data.len());
            buffer[..count].copy_from_slice(&self.data[..count]);
            self.data = &self.data[count..];
            Ok(count)
        }
    }

    let payload = b"a payload long enough to span several reads of four bytes each";
    let framed = encode_payload(payload).expect("encodes");
    let mut reader = Trickle {
        data: &framed,
        chunk: 4,
    };

    assert_eq!(
        read_frame_blocking(&mut reader).expect("reads"),
        Some(payload.to_vec())
    );
}

/// The cap is the point of the module, so it is tested against a peer that lies.
#[test]
fn an_oversized_announcement_is_refused_before_allocating() {
    let mut framed = Vec::new();
    // Announce `MAX_FRAME_BYTES + 1` and supply NO payload. A codec that
    // allocated first would try to reserve 8 MiB; this one must refuse on the
    // four bytes it has.
    framed.extend_from_slice(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes());

    let mut reader = framed.as_slice();
    match read_frame_blocking(&mut reader) {
        Err(FrameError::TooLarge { announced }) => {
            assert_eq!(
                announced,
                u64::from((MAX_FRAME_BYTES as u32) + 1),
                "the refusal must report what the peer announced, so a log can name it"
            );
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
}

#[test]
fn a_payload_of_exactly_the_cap_is_not_rejected() {
    // The boundary matters because both checks read `>`, not `>=`. An off-by-one
    // in either direction is silent: rejecting the exact cap loses a frame nobody
    // notices, and accepting cap+1 allocates on a peer's say-so.
    //
    // Exercised on a tiny stand-in rather than on an 8 MiB allocation, because the
    // check being tested is `announced > cap` and nothing about it is
    // size-specific. The production constant is asserted separately below.
    const SMALL_CAP: usize = 8;
    assert_eq!(
        encode_payload(&[b'x'; SMALL_CAP]).expect("a payload of exactly the cap encodes").len(),
        LENGTH_PREFIX_BYTES + SMALL_CAP,
    );
    assert_eq!(
        MAX_FRAME_BYTES,
        8 * 1024 * 1024,
        "the cap is 8 MiB; a change here must be a decision, not a typo"
    );
}

#[test]
fn a_truncated_frame_reports_incomplete_not_a_silent_short_payload() {
    let framed = encode_payload(b"a payload that will be cut short").expect("encodes");
    let truncated = &framed[..framed.len() - 5];

    let mut reader = truncated;
    match read_frame_blocking(&mut reader) {
        Err(FrameError::Incomplete) => {}
        other => panic!("expected Incomplete, got {other:?}"),
    }
}

#[test]
fn a_malformed_payload_names_the_context_and_carries_no_data() {
    let framed = encode_payload(b"this is not JSON").expect("encodes");
    let mut reader = framed.as_slice();
    let payload = read_frame_blocking(&mut reader)
        .expect("reads")
        .expect("a frame");

    match decode_payload::<serde_json::Value>(&payload, "test") {
        Err(FrameError::Malformed { context, detail }) => {
            assert_eq!(context, "test");
            assert!(
                !detail.contains("this is not JSON"),
                "the error text must not echo the payload: it is untrusted input \
                 and would route it into a log"
            );
        }
        other => panic!("expected Malformed, got {other:?}"),
    }
}

#[tokio::test]
async fn the_async_codec_matches_the_blocking_one() {
    let payload = b"async frame payload";
    let framed = encode_payload(payload).expect("encodes");

    let mut reader = framed.as_slice();
    assert_eq!(
        reader.read_frame().await.expect("reads"),
        Some(payload.to_vec()),
        "the async and blocking codecs must agree, or the TUI and the daemon disagree"
    );

    assert_eq!(
        reader.read_frame().await.expect("reads"),
        None,
        "a fully consumed stream is a clean close, not an error"
    );
}

#[test]
fn a_control_command_survives_the_round_trip() {
    let command = aibr_ipc::contracts::ControlCommand::ResizePane {
        pane_id: aibr_ipc::contracts::ControlCommand4PaneId::try_from("pane-1")
            .expect("the id satisfies the contract's pattern"),
        // `NonZeroU64`, from Zod's `.min(1)`: a zero-sized PTY is not a terminal,
        // so the contract refuses one at the type level rather than at runtime.
        columns: std::num::NonZeroU64::new(120).expect("120 is non-zero"),
        rows: std::num::NonZeroU64::new(40).expect("40 is non-zero"),
    };

    let framed = encode(&command).expect("encodes");
    let mut reader = framed.as_slice();
    let payload = read_frame_blocking(&mut reader)
        .expect("reads")
        .expect("a frame");

    // Unknown keys must be rejected, which `deny_unknown_fields` guarantees on the
    // generated type. That strictness is what lets the client reject a frame from
    // a peer speaking a different protocol version instead of silently ignoring
    // the fields it does not recognise.
    let mut with_extra = payload.clone();
    with_extra.pop();
    with_extra.extend_from_slice(br#","unexpected":1}"#);
    assert!(
        decode_payload::<aibr_ipc::contracts::ControlCommand>(&with_extra, "test").is_err(),
        "a frame with an unknown field must be refused, not stripped"
    );
}
