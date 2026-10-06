//! Turning a crossterm key event into the bytes a PTY expects.
//!
//! # WHY THIS IS NOT A ONE-LINER
//!
//! A terminal client receives *keys*, and a PTY expects *bytes* that follow one of
//! several conventions at once: control characters for `Ctrl`, CSI sequences for
//! arrows and modified keys, UTF-8 for printable characters. Getting the boundary
//! wrong is silent and total -- forward `Ctrl+C` as the letter `c` and the operator
//! cannot interrupt an agent; forward an arrow as three bytes and the agent sees
//! `[[A` typed into its prompt.
//!
//! # UTF-8 CANNOT BE SPLIT HERE, AND THE TYPE SYSTEM SAYS SO
//!
//! [`encode_key`] returns one `Vec<u8>` per key event, and the only path that
//! produces text bytes is [`encode_char`], which encodes a single `char` with
//! `char::encode_utf8`. There is no path that takes a byte slice of unknown length
//! and writes part of it, so a multi-byte codepoint cannot be split across two
//! commands. Crossterm delivers a `KeyEvent` with at most one `char`, and
//! [`encode_paste`] encodes a whole `&str`, so the two places text enters are the two
//! places where a split would have been possible and neither can split.
//!
//! Splitting could still happen one layer down -- if the daemon chunks a large paste
//! at an arbitrary byte offset -- and that is the PTY workstream's invariant to hold,
//! not this file's.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// The byte `Ctrl+C` sends.
///
/// Named because it is the one control character every operator knows by its
/// meaning, and because a test that asserts `== 3` without this line is a test that
/// will be "fixed" to `== b'c'` the first time someone refactors it wrongly.
pub const ETX: u8 = 0x03;

/// Encode one key event for a PTY.
///
/// `None` means "this key has no byte representation" and the caller must drop it
/// rather than substitute something: a `Super`ed key, or `Ctrl` held with a
/// non-ASCII character, has no agreed encoding, and inventing one puts bytes in a
/// remote agent's stdin that the agent will read as input.
#[must_use]
pub fn encode_key(event: &KeyEvent) -> Option<Vec<u8>> {
    if event.modifiers.contains(KeyModifiers::SUPER) {
        return None;
    }
    match event.code {
        KeyCode::Char(character) => encode_char(character, event.modifiers),
        KeyCode::Enter => encode_enter(event.modifiers),
        KeyCode::Tab => encode_tab(event.modifiers),
        KeyCode::BackTab => Some(vec![0x1b, b'[', b'Z']),
        KeyCode::Esc => Some(vec![0x1b]),
        KeyCode::Backspace => encode_backspace(event.modifiers),
        KeyCode::Null => Some(vec![0x00]),
        KeyCode::Delete => csi_tilde(3, event.modifiers),
        KeyCode::Insert => csi_tilde(2, event.modifiers),
        KeyCode::Home => csi_final(b'H', event.modifiers),
        KeyCode::End => csi_final(b'F', event.modifiers),
        KeyCode::PageUp => csi_tilde(5, event.modifiers),
        KeyCode::PageDown => csi_tilde(6, event.modifiers),
        KeyCode::Left => csi_final(b'D', event.modifiers),
        KeyCode::Right => csi_final(b'C', event.modifiers),
        KeyCode::Up => csi_final(b'A', event.modifiers),
        KeyCode::Down => csi_final(b'B', event.modifiers),
        KeyCode::F(number) => encode_function(number, event.modifiers),
        KeyCode::CapsLock
        | KeyCode::ScrollLock
        | KeyCode::NumLock
        | KeyCode::PrintScreen
        | KeyCode::Pause
        | KeyCode::Menu
        | KeyCode::KeypadBegin
        | KeyCode::Media(..)
        | KeyCode::Modifier(..) => None,
    }
}

/// A printable character, a control character, or `ESC` plus one of those.
///
/// `Alt` becomes a leading `ESC`, which is the `xterm` convention every well-behaved
/// readline and every PTY-attached library understands, and is the same convention
/// that makes `Alt+B` reach a shell as `ESC b` rather than as a bare `b`.
#[must_use]
pub fn encode_char(character: char, modifiers: KeyModifiers) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(8);
    if modifiers.contains(KeyModifiers::ALT) {
        bytes.push(0x1b);
    }
    if modifiers.contains(KeyModifiers::CONTROL) {
        match control_byte(character) {
            Some(byte) => bytes.push(byte),
            None => return None,
        }
        return Some(bytes);
    }
    let mut encoded = [0u8; 4];
    bytes.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
    Some(bytes)
}

/// The byte `Ctrl+<character>` sends.
///
/// Only ASCII is mappable. `Ctrl+é` has no agreed encoding -- terminals disagree, and
/// sending the UTF-8 bytes would type `é` rather than interrupt anything.
#[must_use]
fn control_byte(character: char) -> Option<u8> {
    if !character.is_ascii() {
        return None;
    }
    let byte = character.to_ascii_uppercase() as u8;
    match byte {
        b' ' | b'@' => Some(0x00),
        // `A`..`_` is 0x01..=0x1f, so `Ctrl+C` is 0x03 and `Ctrl+[` is `ESC`.
        b'A'..=b'_' => Some(byte & 0x1f),
        b'?' => Some(0x7f),
        _ => None,
    }
}

/// `Enter` is `CR` unmodified and `CSI 1;2E` with `Shift`.
///
/// `Shift+Enter` is the one that matters: an agent session treats it as "newline
/// without submit", and forwarding `CR` for it submits the prompt instead, so the
/// operator's multiline input is cut in half at the first wrapped line.
#[must_use]
fn encode_enter(modifiers: KeyModifiers) -> Option<Vec<u8>> {
    match modifier_parameter(modifiers) {
        None => Some(vec![b'\r']),
        Some(parameter) => Some(format!("\x1b[1;{parameter}E").into_bytes()),
    }
}

/// `Tab` is `HT`; `Shift+Tab` is `CSI Z`, which is a DIFFERENT sequence.
#[must_use]
fn encode_tab(modifiers: KeyModifiers) -> Option<Vec<u8>> {
    if modifiers.contains(KeyModifiers::SHIFT) {
        return Some(vec![0x1b, b'[', b'Z']);
    }
    match modifier_parameter(modifiers) {
        None => Some(vec![b'\t']),
        Some(parameter) => Some(format!("\x1b[1;{parameter}I").into_bytes()),
    }
}

/// `Backspace` is `DEL` (0x7f) on every terminal this client will be attached to.
///
/// `Ctrl+Backspace` is `BS` (0x08), which is what erases a word in readline.
#[must_use]
fn encode_backspace(modifiers: KeyModifiers) -> Option<Vec<u8>> {
    let byte = if modifiers.contains(KeyModifiers::CONTROL) {
        0x08
    } else {
        0x7f
    };
    if modifiers.contains(KeyModifiers::ALT) {
        return Some(vec![0x1b, byte]);
    }
    Some(vec![byte])
}

/// `CSI <n> ~`.
fn csi_tilde(number: u8, modifiers: KeyModifiers) -> Option<Vec<u8>> {
    Some(match modifier_parameter(modifiers) {
        None => format!("\x1b[{number}~").into_bytes(),
        Some(parameter) => format!("\x1b[{number};{parameter}~").into_bytes(),
    })
}

/// `CSI <final>`, or `CSI 1;<mod><final>` when a modifier is held.
fn csi_final(final_byte: u8, modifiers: KeyModifiers) -> Option<Vec<u8>> {
    Some(match modifier_parameter(modifiers) {
        None => vec![0x1b, b'[', final_byte],
        Some(parameter) => format!("\x1b[1;{parameter}{}", final_byte as char).into_bytes(),
    })
}

/// The F1..F12 encodings: SS3 for the first four, `CSI n ~` for the rest.
///
/// The split is not a choice -- it is what `xterm` does, and a PTY-attached
/// application's key table is built against `xterm`.
#[must_use]
fn encode_function(number: u8, modifiers: KeyModifiers) -> Option<Vec<u8>> {
    let parameter = modifier_parameter(modifiers);
    match number {
        1 => ss3(b'P', parameter),
        2 => ss3(b'Q', parameter),
        3 => ss3(b'R', parameter),
        4 => ss3(b'S', parameter),
        5 => csi_tilde(15, modifiers),
        6 => csi_tilde(17, modifiers),
        7 => csi_tilde(18, modifiers),
        8 => csi_tilde(19, modifiers),
        9 => csi_tilde(20, modifiers),
        10 => csi_tilde(21, modifiers),
        11 => csi_tilde(23, modifiers),
        12 => csi_tilde(24, modifiers),
        _ => None,
    }
}

/// `ESC O <final>`, with the modifier folded into the final byte's high bits.
///
/// `Shift+F1` is `ESC O P` in `xterm`, where the shift is encoded in the final byte's
/// value -- hence the arithmetic rather than a parameter.
fn ss3(final_byte: u8, parameter: Option<u16>) -> Option<Vec<u8>> {
    let mut bytes = vec![0x1b, b'O'];
    bytes.push(
        final_byte
            + match parameter {
                Some(parameter) => parameter.saturating_sub(1) as u8,
                None => 0,
            },
    );
    Some(bytes)
}

/// The xterm modifier parameter: `1 + shift + 2*alt + 4*ctrl + 8*meta`.
///
/// `None` when no modifier is held, because the unmodified form omits the parameter
/// entirely and `CSI 1;1A` is not universally understood to mean `CSI A`.
#[must_use]
fn modifier_parameter(modifiers: KeyModifiers) -> Option<u16> {
    let mut parameter = 1u16;
    let mut held = false;
    if modifiers.contains(KeyModifiers::SHIFT) {
        parameter += 1;
        held = true;
    }
    if modifiers.contains(KeyModifiers::ALT) {
        parameter += 2;
        held = true;
    }
    if modifiers.contains(KeyModifiers::CONTROL) {
        parameter += 4;
        held = true;
    }
    if modifiers.contains(KeyModifiers::META) {
        parameter += 8;
        held = true;
    }
    held.then_some(parameter)
}

/// A bracketed-paste payload, including the delimiters.
///
/// Whole-`&str` in and whole bytes out, encoded `char` by `char`. The alternative --
/// pushing the `&str`'s bytes directly -- is faster and equally uncorruptible *here*,
/// but it makes the invariant untestable and undocumented, and the paste path is
/// exactly where a mid-codepoint split produces mojibake in an agent's prompt that
/// nobody can reproduce.
#[must_use]
pub fn encode_paste(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + 12);
    bytes.extend_from_slice(b"\x1b[200~");
    let mut buffer = [0u8; 4];
    for character in text.chars() {
        bytes.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
    }
    bytes.extend_from_slice(b"\x1b[201~");
    bytes
}
