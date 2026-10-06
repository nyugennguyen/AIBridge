//! Copy mode: vi-style navigation over a pane's scrollback.
//!
//! # WHY THIS IS ITS OWN MODULE AND NOT A FEW MATCH ARMS IN `keyboard.rs`
//!
//! Copy mode has a state inside it -- a search prompt that accumulates characters, a
//! visual anchor, a last-search cursor -- and it has a search that can fail. Folding
//! that into the key dispatcher's match arms makes the dispatcher the place where the
//! mode's invariants live, and the invariants are the interesting part:
//!
//! * A search that fails must say so. Silently doing nothing is indistinguishable from
//!   a hung client, and an operator looking for a line in a 200k-line scrollback will
//!   try the query three more times before concluding the pane is frozen.
//! * A search must be able to match ACROSS a line boundary, because the thing an
//!   operator is looking for is often split by the terminal's own wrapping or by a
//!   log line that spans two rows.
//! * Every movement must keep the cursor visible, or the operator scrolls into a
//!   region and cannot see where they are.

use crate::input::selection::CellCoords;

/// A search match: a line and a column within it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchHit {
    /// Absolute line index in the pane's scrollback.
    pub line: i64,
    /// Column within that line.
    pub column: u16,
}

/// What copy mode is waiting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CopyPrompt {
    /// Navigating.
    #[default]
    None,
    /// Accumulating a `/` query.
    Search,
}

/// The state of copy mode.
#[derive(Debug, Clone, Default)]
pub struct CopyMode {
    /// The line the cursor is on, absolute.
    pub cursor_line: i64,
    /// The column the cursor is on.
    pub cursor_column: u16,
    /// The visual-mode anchor, once `v` has been pressed.
    pub anchor: Option<CellCoords>,
    /// Whether visual mode is on.
    pub visual: bool,
    /// What the next key is for.
    pub prompt: CopyPrompt,
    /// The characters typed so far into the `/` prompt.
    pub query: String,
    /// The last committed query, for `n` / `N`.
    pub last_query: String,
    /// Where the last search landed, for `n` / `N`.
    pub last_hit: Option<SearchHit>,
    /// Whether searches are case-insensitive.
    ///
    /// ON by default: the operator searching an audit log is looking for a token
    /// they can see on screen, and a case-sensitive search that fails on a case
    /// difference is indistinguishable from a broken pane.
    pub ignore_case: bool,
    /// The message the modal status line shows: `pattern not found`, `"/foo"`, etc.
    pub message: Option<String>,
}

impl CopyMode {
    /// Copy mode entered at the bottom of the scrollback, where the operator was.
    ///
    /// Entering at the cursor rather than at the oldest line matters: an operator who
    /// presses `Ctrl+B [` wants to look at what just scrolled past, not to be dropped
    /// 200,000 lines into the past.
    #[must_use]
    pub fn entering(bottom_line: i64, column: u16) -> Self {
        Self {
            cursor_line: bottom_line,
            cursor_column: column,
            ..Self::default()
        }
    }

    /// The cursor as pane-content coordinates, for the render pass.
    #[must_use]
    pub fn cursor(&self) -> CellCoords {
        CellCoords::new(self.cursor_column, 0)
    }

    /// Move the cursor, clamped to `..=max_line` and `..=max_column`.
    ///
    /// Clamping rather than wrapping: wrapping on `j` at the last line is a jump
    /// scroll operators read as a glitch, and copy mode is a reading mode, not a game.
    pub fn move_cursor(
        &mut self,
        delta_lines: i64,
        delta_columns: i64,
        max_line: i64,
        max_column: u16,
    ) {
        self.cursor_line = self
            .cursor_line
            .saturating_add(delta_lines)
            .clamp(0, max_line.max(0));
        self.cursor_column =
            (i64::from(self.cursor_column) + delta_columns).clamp(0, i64::from(max_column)) as u16;
    }

    /// Begin or end visual mode at the cursor.
    pub fn toggle_visual(&mut self) {
        self.visual = !self.visual;
        self.anchor = self.visual.then(|| self.cursor());
    }

    /// Begin a `/` search.
    pub fn begin_search(&mut self) {
        self.prompt = CopyPrompt::Search;
        self.query.clear();
    }

    /// Abandon the `/` search.
    ///
    /// The query is discarded rather than kept: resuming a half-typed query after an
    /// `Esc` is a tmux behaviour, and tmux does it because tmux has a key table to
    /// resume. Here it would mean a later `/` starting from text the operator has
    /// already abandoned, and the search would then fail for a reason they cannot see.
    pub fn cancel_search(&mut self) {
        self.prompt = CopyPrompt::None;
        self.query.clear();
    }

    /// `n`: the next match after `from`.
    #[must_use]
    pub fn next_hit(
        &self,
        panes: &dyn crate::input::traits::ScrollbackPane,
        pane_id: &str,
    ) -> Option<SearchHit> {
        self.search_from(panes, pane_id, self.cursor_line + 1)
    }

    /// `N`: the previous match before `from`.
    #[must_use]
    pub fn previous_hit(
        &self,
        panes: &dyn crate::input::traits::ScrollbackPane,
        pane_id: &str,
    ) -> Option<SearchHit> {
        self.search_from(panes, pane_id, self.cursor_line - 1)
    }

    /// Commit the `/` prompt's query and search from the cursor.
    ///
    /// Returns the hit, or `None` with `message` set to say so. The message is the
    /// whole point: the caller shows it as a toast and copy mode STAYS OPEN, because
    /// a failed search is a normal outcome and exiting on one would make the operator
    /// press `Ctrl+B [` again to correct the typo.
    pub fn commit_search(
        &mut self,
        panes: &dyn crate::input::traits::ScrollbackPane,
        pane_id: &str,
    ) -> Option<SearchHit> {
        let query = std::mem::take(&mut self.query);
        self.prompt = CopyPrompt::None;
        if query.is_empty() {
            self.message = None;
            return None;
        }
        self.last_query = query.clone();
        let hit = find(panes, pane_id, &query, self.cursor_line, self.ignore_case);
        match hit {
            Some(hit) => {
                self.cursor_line = hit.line;
                self.last_hit = Some(hit);
                self.message = Some(format!("/{query}"));
                Some(hit)
            }
            None => {
                // The cursor does NOT move on failure. Moving it to the top of the
                // scrollback because the search failed would lose the operator's
                // place in a 200k-line log, which is the worst possible outcome of a
                // failed search.
                self.last_hit = None;
                self.message = Some(format!("pattern not found: {query}"));
                None
            }
        }
    }

    /// Shared body of `n` and `N`.
    fn search_from(
        &self,
        panes: &dyn crate::input::traits::ScrollbackPane,
        pane_id: &str,
        from: i64,
    ) -> Option<SearchHit> {
        if self.last_query.is_empty() {
            return None;
        }
        find(panes, pane_id, &self.last_query, from, self.ignore_case)
    }

    /// The search message, if there is one, for the status line.
    #[must_use]
    pub fn message(&self) -> Option<&str> {
        self.message.as_deref()
    }
}

/// Find `query` at or after `from`.
///
/// # Crossing line boundaries
///
/// The haystack is built by concatenating lines, separated by `\n` for a real line end
/// and by NOTHING for a soft wrap, and the search runs over that. So a query of
/// `deleteMany(); await` matches when the terminal wrapped between them, which is the
/// case an operator actually hits in an agent session where the interesting call spans
/// a row boundary.
///
/// Only `query.len() - 1` characters of the previous line are carried forward, so a
/// 200k-line scrollback search allocates the query length rather than the pane, and
/// every offset in the working buffer carries a parallel `(line, column)` origin.
/// That origin table is what makes the reported column exact -- reconstructing it by
/// arithmetic after the fact is the bug where a match is reported one column left of
/// where it is.
///
/// # Wrapping
///
/// A `from` at or past the last line searches from the top, so `n` at the bottom of the log
/// comes back round rather than appearing to stop working. A `from` inside the range does
/// NOT wrap -- a second scan of the whole log on every failed `n` would be the wrong cost.
/// `ignore_case` is compared per character rather than by lowercasing the haystack, so a
/// reported column is in the original text's coordinates.
#[must_use]
pub fn find(
    panes: &dyn crate::input::traits::ScrollbackPane,
    pane_id: &str,
    query: &str,
    from: i64,
    ignore_case: bool,
) -> Option<SearchHit> {
    if query.is_empty() {
        return None;
    }
    let total = panes.total_lines(pane_id).max(0);
    let needle: Vec<char> = query.chars().collect();
    let carry_limit = needle.len().saturating_sub(1);
    // WRAPPING, NOT STOPPING. `from` at or past the end restarts at line 0, which is what
    // makes `n` at the bottom of the log come back round instead of appearing to stop
    // working. Without it, `CopyMode::next_hit` at the last line would search nothing at all.
    let start = if from >= total {
        0
    } else {
        from.clamp(0, total)
    };

    // The carried tail of the previous line, and where each of its characters is.
    let mut buffer: Vec<char> = Vec::with_capacity(carry_limit + 128);
    let mut origins: Vec<(i64, u16)> = Vec::with_capacity(carry_limit + 128);

    for line in start..total {
        let text = panes.line(pane_id, line);
        let continued = panes.line_is_continuation(pane_id, line);

        if !continued {
            buffer.push('\n');
            // A newline between two lines belongs to no line's text. Pointing it at
            // the END of the previous line means a query spanning a line break is
            // reported at the character before the break, which is where the operator
            // would look for it.
            origins.push((line - 1, u16::MAX));
        }
        for (column, character) in text.chars().enumerate() {
            buffer.push(character);
            origins.push((line, column.min(usize::from(u16::MAX)) as u16));
        }

        if let Some(offset) = first_match(&buffer, &needle, ignore_case) {
            let (line, column) = origins.get(offset).copied().unwrap_or((line, 0));
            return Some(SearchHit { line, column });
        }

        let keep = carry_limit.min(buffer.len());
        buffer.drain(..buffer.len() - keep);
        origins.drain(..origins.len() - keep);
    }
    None
}

/// The first occurrence of `needle` in `haystack`, or `None`.
fn first_match(haystack: &[char], needle: &[char], ignore_case: bool) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|start| {
        haystack[*start..*start + needle.len()]
            .iter()
            .zip(needle)
            .all(|(found, wanted)| {
                if ignore_case {
                    found.to_lowercase().eq(wanted.to_lowercase())
                } else {
                    found == wanted
                }
            })
    })
}
