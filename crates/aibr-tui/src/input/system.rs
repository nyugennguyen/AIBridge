//! The two effects that need the operating system: the clipboard and the URL handler.
//!
//! # WHY THEY ARE HERE AND NOT CALLED FROM A REDUCER
//!
//! Both can block. An `arboard` clipboard write on X11 is an inter-process selection
//! transfer that waits for the previous owner to acknowledge, and a URL opener waits for
//! a process to start. A reducer that blocked would have timing-dependent tests and could
//! stall the event loop, which is the loop that also delivers an agent's output. So both
//! are [`Clipboard`] and [`UrlOpener`] implementations that the shell calls while acting
//! on an [`Action`](crate::input::Action) -- never from inside [`key`](crate::input::key)
//! or [`mouse`](crate::input::mouse).
//!
//! # WHY THE URL OPENER RE-VALIDATES
//!
//! [`SystemUrlOpener::open`] takes a [`SanitizedUrl`], which cannot be constructed without
//! [`sanitize_url`](crate::input::sanitize_url), and it does NOT re-check. Adding a
//! second check here would be the "belt and braces" that turns into two rule sets: the
//! second one would be the one someone edits when a new scheme needs allowing, and it
//! would be in a file about spawning processes rather than a file about URLs.
//!
//!
//! The risk that IS handled here is the argument. The scheme is passed as a separate
//! argument to the platform command and the URL is passed as one more, never joined into
//! a shell string, so a URL containing a space or a quote cannot become a second
//! argument. `std::process::Command` does not use a shell, and that is the property this
//! implementation depends on.

use std::process::Command;

use crate::input::sanitize::SanitizedUrl;
use crate::input::traits::{Clipboard, ClipboardError, UrlOpenError, UrlOpener};

/// The operating system clipboard, through `arboard`.
///
/// `Debug` IS MANUAL because `arboard::Clipboard` does not implement it, and a type that
/// cannot be printed cannot go in a struct that derives `Debug` -- which matters here
/// because `InputState` is `Debug` and a shell will want to dump it.
#[derive(Default)]
pub struct SystemClipboard {
    /// `arboard`'s handle, created on first use.
    ///
    /// LAZY because construction is fallible and can fail for reasons that are not
    /// errors at start-up: on a bare container there is no clipboard mechanism at all,
    /// and a client that refused to draw because of that would be wrong.
    inner: Option<arboard::Clipboard>,
}

impl SystemClipboard {
    /// A clipboard that connects on first write.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The handle, connecting if this is the first use.
    fn handle(&mut self) -> Result<&mut arboard::Clipboard, ClipboardError> {
        if self.inner.is_none() {
            self.inner = Some(
                arboard::Clipboard::new()
                    .map_err(|error| ClipboardError::Unavailable(format!("arboard: {error}")))?,
            );
        }
        Ok(self.inner.as_mut().expect("the handle was just assigned"))
    }
}

impl std::fmt::Debug for SystemClipboard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Whether a handle has been opened, never what it contains: an `arboard`
        // clipboard holds the last copied text, and a `Debug` dump is the last place that
        // should put it in a log.
        formatter
            .debug_struct("SystemClipboard")
            .field("connected", &self.inner.is_some())
            .finish()
    }
}

impl Clipboard for SystemClipboard {
    fn copy(&mut self, text: &str) -> Result<(), ClipboardError> {
        self.handle()?
            .set_text(text.to_owned())
            .map_err(|error| ClipboardError::Rejected(format!("arboard: {error}")))
    }
}

/// A clipboard that discards everything.
///
/// FOR TESTS AND FOR A HEADLESS CLIENT. Not a default: a client that silently discards a
/// copy is a client that lies with its toast, so the shell must install this explicitly
/// to get that behaviour.
#[derive(Debug, Clone, Copy, Default)]
pub struct NullClipboard;

impl Clipboard for NullClipboard {
    fn copy(&mut self, _text: &str) -> Result<(), ClipboardError> {
        Err(ClipboardError::Unavailable(
            "no clipboard is installed".to_owned(),
        ))
    }
}

/// The operating system's default URL handler.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemUrlOpener;

impl UrlOpener for SystemUrlOpener {
    fn open(&mut self, url: &SanitizedUrl) -> Result<(), UrlOpenError> {
        open_in_system_browser(url.as_str())
    }
}

/// Spawn the platform's URL handler.
///
/// ARGUMENTS ARE NEVER JOINED. `Command::arg` passes one argument; nothing here builds
/// a command line, so a URL containing a space, a quote or a `;` is still one argument
/// and cannot introduce a second one.
#[cfg(target_os = "macos")]
fn open_in_system_browser(url: &str) -> Result<(), UrlOpenError> {
    // `-g` so the handler does not steal focus from the TUI. An operator who clicks a
    // link in a terminal and is thrown into a browser window has lost the session they
    // were reading.
    Command::new("open")
        .arg("-g")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| UrlOpenError::Failed(error.to_string()))
}

/// Spawn the platform's URL handler.
#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_system_browser(url: &str) -> Result<(), UrlOpenError> {
    Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| UrlOpenError::Failed(error.to_string()))
}

/// Spawn the platform's URL handler.
#[cfg(windows)]
fn open_in_system_browser(url: &str) -> Result<(), UrlOpenError> {
    // `rundll32 url.dll,FileProtocolHandler` is the documented way to hand a URI to the
    // registered default handler without a shell. `cmd /C start` would work too and is
    // worse: it introduces a command interpreter into the path of a peer's output.
    Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| UrlOpenError::Failed(error.to_string()))
}

/// Spawn the platform's URL handler.
#[cfg(not(any(unix, windows)))]
fn open_in_system_browser(_url: &str) -> Result<(), UrlOpenError> {
    Err(UrlOpenError::UnsupportedPlatform)
}

/// A URL opener that records what it was asked to open instead of opening it.
///
/// FOR TESTS. Because [`UrlOpener`] takes a [`SanitizedUrl`], a test can assert that a
/// `file://` URI never reaches the opener at all -- which is the property that matters,
/// and one that a test asserting on the opener's calls could not distinguish from "the
/// opener was called with the right thing".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordingUrlOpener {
    /// Every URL this opener was asked to open, in order.
    pub opened: Vec<SanitizedUrl>,
}

impl UrlOpener for RecordingUrlOpener {
    fn open(&mut self, url: &SanitizedUrl) -> Result<(), UrlOpenError> {
        self.opened.push(url.clone());
        Ok(())
    }
}

/// A clipboard that records what it was asked to copy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordingClipboard {
    /// Every payload this clipboard was asked to store, in order.
    pub copied: Vec<String>,
}

impl Clipboard for RecordingClipboard {
    fn copy(&mut self, text: &str) -> Result<(), ClipboardError> {
        self.copied.push(text.to_owned());
        Ok(())
    }
}
