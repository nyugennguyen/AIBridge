use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::widgets::Widget;

use aibr_tui::state::UiState;
use aibr_tui::widgets::{
    logo_mark_spans, TopHeaderBarWidget, WindowHeader, LOGO_ELECTRIC_CYAN, LOGO_MESH_EMERALD,
    LOGO_NEURAL_VIOLET,
};

#[test]
fn test_logo_mark_spans_colors_and_glyphs() {
    let spans = logo_mark_spans();
    assert!(!spans.is_empty());

    // Color definitions per vector design system:
    // Cyan: RGB(0, 240, 255)
    // Violet: RGB(168, 85, 247)
    // Emerald: RGB(16, 185, 129)
    assert_eq!(LOGO_ELECTRIC_CYAN, Color::Rgb(0, 240, 255));
    assert_eq!(LOGO_NEURAL_VIOLET, Color::Rgb(168, 85, 247));
    assert_eq!(LOGO_MESH_EMERALD, Color::Rgb(16, 185, 129));

    // Concatenate text
    let full_text: String = spans.iter().map(|s| s.content.as_ref()).collect();
    assert_eq!(full_text, "╭─▲─╮ ◈ AIBridge ");

    // Verify first span is Neural Violet
    assert_eq!(spans[0].style.fg, Some(LOGO_NEURAL_VIOLET));
    // Verify peak glyph is Electric Cyan
    assert_eq!(spans[1].style.fg, Some(LOGO_ELECTRIC_CYAN));
    // Verify pulse glyph is Mesh Emerald
    assert_eq!(spans[3].style.fg, Some(LOGO_MESH_EMERALD));
}

#[test]
fn test_window_header_render_dimensions() {
    let header = WindowHeader::new("Setup Wizard", Some("v2.0"));
    let area = Rect::new(0, 0, 60, 1);
    let mut buffer = Buffer::empty(area);

    header.render(area, &mut buffer);

    let rendered: String = (0..area.width)
        .map(|x| buffer[(x, 0)].symbol().to_string())
        .collect();

    assert!(rendered.contains("╭─▲─╮ ◈ AIBridge"));
    assert!(rendered.contains("Setup Wizard"));
    assert!(rendered.contains("[v2.0]"));
}

#[test]
fn test_top_header_bar_renders_cyber_mesh_logo() {
    let state = UiState::default();
    let header = TopHeaderBarWidget::new(&state);
    let area = Rect::new(0, 0, 120, 2);
    let mut buffer = Buffer::empty(area);

    header.render(area, &mut buffer);

    let row0: String = (0..area.width)
        .map(|x| buffer[(x, 0)].symbol().to_string())
        .collect();

    assert!(row0.contains("╭─▲─╮ ◈ AIBridge"));
}
