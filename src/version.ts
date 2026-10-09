/**
 * The application version, in one place.
 *
 * This exists because the version was previously written out by hand in four
 * places (`package.json`, the splash banner, `aibr update`'s fallback, and the
 * diagnostics bundle), and they drifted: a released 2.1.0 still advertised 2.0
 * on startup. `package.json` is the release authority; this must be bumped
 * alongside it, and the release gate (`publish.yml`) refuses a tag that does not
 * match `package.json`, which catches the mismatch in the one direction that
 * matters.
 */
export const CLI_VERSION = "2.1.2"
