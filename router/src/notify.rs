//! `sd_notify` readiness, so `Type=notify` in M7.10's unit is a true statement.
//!
//! ## Why this is hand-rolled rather than a crate
//!
//! The protocol is two datagrams. A dependency would add compile time, transitive
//! supply chain, and a version bump to a binary whose entire resource claim is
//! that it is 1.6 MiB — for `READY=1` and `STOPPING=1`.
//!
//! ## Why a failure here is never fatal
//!
//! This process owns admitted work. A supervisor that never receives `READY=1`
//! will eventually kill a router that is serving perfectly well, and a
//! notification that cannot be delivered must not be the thing that takes ingress
//! down. Every failure here is reported to stderr and swallowed at the call site.

use std::env;
use std::io;
use std::os::unix::net::UnixDatagram;
use std::path::PathBuf;

/// The variable systemd sets on a `Type=notify` unit.
pub const NOTIFY_SOCKET_ENV: &str = "NOTIFY_SOCKET";

/// The readiness states this process reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// The socket is bound and requests are being served.
    Ready,
    /// A stop signal arrived and the graceful drain has begun.
    Stopping,
}

impl State {
    /// The `KEY=VALUE` line systemd reads.
    pub fn field(self) -> &'static str {
        match self {
            State::Ready => "READY=1",
            State::Stopping => "STOPPING=1",
        }
    }
}

/// Where the notification socket lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A filesystem socket path.
    Path(PathBuf),
    /// A Linux abstract-namespace socket, which has no filesystem entry at all.
    Abstract(String),
}

/// Interpret a `NOTIFY_SOCKET` value.
///
/// systemd writes an abstract socket as a leading `@`, which is shorthand for a
/// leading NUL byte, and optionally prefixes a real path with `/`. An empty value
/// means "not under systemd" and yields `None` rather than an error, because
/// running this binary from a shell is the normal case on macOS and in tests.
pub fn target(value: &str) -> Option<Target> {
    if value.is_empty() {
        return None;
    }
    if let Some(name) = value.strip_prefix('@') {
        if name.is_empty() {
            return None;
        }
        return Some(Target::Abstract(name.to_string()));
    }
    Some(Target::Path(PathBuf::from(value)))
}

/// The configured target for this process, if it is under a notifier.
pub fn configured_target() -> Option<Target> {
    env::var(NOTIFY_SOCKET_ENV).ok().as_deref().and_then(target)
}

/// Send one readiness state. Returns `false` when no notifier is configured.
pub fn notify(state: State) -> io::Result<bool> {
    let Some(target) = configured_target() else {
        return Ok(false);
    };
    let payload = state.field();

    match target {
        Target::Path(path) => UnixDatagram::unbound()?.send_to(payload.as_bytes(), path),
        Target::Abstract(name) => send_abstract(payload, &name),
    }
    .map(|_| true)
}

/// The abstract namespace exists only on Linux.
///
/// On other unixes an `@`-prefixed `NOTIFY_SOCKET` is a configuration this build
/// cannot honour, and it is reported as an error the caller logs rather than
/// silently dropped.
#[cfg(target_os = "linux")]
fn send_abstract(payload: &str, name: &str) -> io::Result<usize> {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::SocketAddr;

    let address = SocketAddr::from_abstract_name(name.as_bytes())?;
    // `send_to_addr`, not `send_to`: the latter takes `AsRef<Path>`, and an
    // abstract-namespace socket has no path. This arm is `cfg(target_os =
    // "linux")`, so a macOS build never type-checks it -- the first Linux CI run
    // is what caught the wrong method, which is precisely why M7.9's build matrix
    // exists.
    UnixDatagram::unbound()?.send_to_addr(payload.as_bytes(), &address)
}

#[cfg(not(target_os = "linux"))]
fn send_abstract(_payload: &str, name: &str) -> io::Result<usize> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!(
            "an abstract NOTIFY_SOCKET ({name}) cannot be addressed on this platform; \
             only Linux provides the abstract namespace"
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_states_use_the_protocols_spelling() {
        assert_eq!(State::Ready.field(), "READY=1");
        assert_eq!(State::Stopping.field(), "STOPPING=1");
    }

    #[test]
    fn a_filesystem_socket_is_taken_as_a_path() {
        assert_eq!(
            target("/run/systemd/notify"),
            Some(Target::Path(PathBuf::from("/run/systemd/notify")))
        );
    }

    #[test]
    fn a_leading_at_is_the_abstract_namespace() {
        assert_eq!(
            target("@aibridge"),
            Some(Target::Abstract("aibridge".into()))
        );
    }

    #[test]
    fn an_empty_value_means_no_notifier_rather_than_a_bad_one() {
        assert_eq!(target(""), None);
        assert_eq!(target("@"), None);
    }

    #[test]
    fn notifying_without_a_configured_socket_is_a_no_op() {
        // The environment is process-global, so this asserts only what it can:
        // an unset variable must never be an error, because that is the state
        // every test in this crate and every manual run on macOS is in.
        if env::var(NOTIFY_SOCKET_ENV).is_err() {
            assert!(
                !notify(State::Ready).expect("unset NOTIFY_SOCKET is not a failure"),
                "a notifier that does not exist cannot have been notified"
            );
        }
    }
}
