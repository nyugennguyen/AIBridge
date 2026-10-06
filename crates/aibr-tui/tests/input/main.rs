//! The input engine, exercised through its public API only.
//!
//! Everything here goes through [`key`] and [`mouse`] and asserts on the [`Action`]s
//! they return, which is the property that makes this subsystem testable at all. There
//! is no test in this directory that touches a socket, a clipboard or a terminal.

mod common;
mod fixtures;
mod keyboard;
mod mouse;
mod units;
