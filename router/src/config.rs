//! Configuration loading, and the structural rules that live beside it.
//!
//! The router reads the **same** `config.json` the engine reads
//! ([`config/dev-main.example.json`](../../config/dev-main.example.json)) rather
//! than a second file of its own. Two config files for one deployment is a second
//! place for `bridge.host` to disagree with itself, and ADR 0008 §8's application
//! layer exists precisely to catch configuration drift — which it cannot do if the
//! component it is gating is configured somewhere else.
//!
//! The parse target is `contracts::BridgeConfig`, the type generated from
//! `bridgeConfigSchema`. That means config drift is caught by the contract chain
//! rather than by a hand-written check here, and it means `deny_unknown_fields`
//! applies to `config.json` too. The consequence is recorded in
//! `Docs/implementation-reports/m7.3-progress.md`: M7.4's `ingress_mode` key will
//! stop this binary from starting until `contracts/` is regenerated, which is the
//! correct direction (the schema is the source of truth) but is not free.

use std::fmt;
use std::ops::Deref;
use std::path::{Path, PathBuf};

use crate::auth::{Bearer, BearerConfigError};
use crate::contracts::BridgeConfig;

/// The name of the config path environment variable.
///
/// Shared with the engine ([`src/index.ts:4`](../../src/index.ts)) on purpose;
/// see the module docs.
pub const CONFIG_PATH_ENV: &str = "AIBRIDGE_CONFIG";

/// The name of the bearer token environment variable.
///
/// Shared with the engine ([`src/index.ts:6`](../../src/index.ts)) on purpose.
pub const BEARER_TOKEN_ENV: &str = "AIBRIDGE_BEARER_TOKEN";

/// Everything the router needs from configuration, resolved once at startup.
///
/// `project_roots` is a derived, canonicalised field rather than something each
/// request recomputes: `realpath` is a syscall, the router handles every request
/// on the ingress path, and the set of configured project roots does not change
/// without a restart. See [`RouterConfig::project_roots`] for what is dropped and
/// why dropping it is not a policy decision.
pub struct RouterConfig {
    /// The parsed `config.json`, exactly as the engine would parse it.
    pub bridge: BridgeConfig,
    /// `realpath` of each `config.projects[].path`, minus any that do not resolve.
    pub project_roots: Vec<PathBuf>,
    /// The bearer verifier. Never logged, never serialised.
    pub bearer: Bearer,
}

/// Why a configuration could not be loaded.
///
/// Every variant's `Display` names a file path or an environment variable, both
/// operator-supplied and neither secret. None of them can contain the bearer
/// token: the token reaches [`RouterConfig::from_json`] as a separate `&str` and
/// this enum never holds it.
#[derive(Debug)]
pub enum ConfigError {
    /// `AIBRIDGE_CONFIG` was unset. Distinct from every other variant because it
    /// is the one an operator hits first and the one whose fix is not a file edit.
    MissingConfigPath,
    /// The config file could not be read.
    Unreadable {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The file was read but is not a `BridgeConfig`.
    ///
    /// The underlying serde message is deliberately **not** included. Serde's
    /// errors quote offending keys and, for `deny_unknown_fields`, name the
    /// unknown one — which is the right thing in a CLI aimed at whoever wrote the
    /// file, and the wrong thing if this string is ever going near a log that
    /// reaches somewhere the config's contents are not already visible. The
    /// operator re-runs with `jq . config.json` and gets everything.
    Invalid { path: PathBuf },
    /// `AIBRIDGE_BEARER_TOKEN` was unset or empty. See [`Bearer::new`].
    Bearer(BearerConfigError),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingConfigPath => write!(f, "{CONFIG_PATH_ENV} is required"),
            Self::Unreadable { path, source } => {
                write!(f, "cannot read {}: {source}", path.display())
            }
            Self::Invalid { path } => {
                write!(f, "{} is not a valid bridge configuration", path.display())
            }
            Self::Bearer(source) => write!(f, "{source}"),
        }
    }
}

impl std::error::Error for ConfigError {}

impl RouterConfig {
    /// Read and validate the configuration named by `AIBRIDGE_CONFIG`.
    pub fn from_env() -> Result<Self, ConfigError> {
        let path = std::env::var(CONFIG_PATH_ENV).map_err(|_| ConfigError::MissingConfigPath)?;
        let token = std::env::var(BEARER_TOKEN_ENV)
            .map_err(|_| ConfigError::Bearer(BearerConfigError::Missing))?;
        Self::from_file(Path::new(&path), &token)
    }

    /// Read `path` and pair it with `bearer_token`.
    pub fn from_file(path: &Path, bearer_token: &str) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Unreadable {
            path: path.to_path_buf(),
            source,
        })?;
        Self::from_json(&text, bearer_token, path)
    }

    /// Parse already-loaded config text.
    ///
    /// `origin` is used only to name the file in errors; it is not required to
    /// exist, which is what lets the tests exercise this without touching disk
    /// for the parse-failure cases.
    pub fn from_json(text: &str, bearer_token: &str, origin: &Path) -> Result<Self, ConfigError> {
        let bridge: BridgeConfig =
            serde_json::from_str(text).map_err(|_| ConfigError::Invalid {
                path: origin.to_path_buf(),
            })?;
        let project_roots = canonical_project_roots(&bridge);
        let bearer = Bearer::new(bearer_token).map_err(ConfigError::Bearer)?;
        Ok(Self {
            bridge,
            project_roots,
            bearer,
        })
    }

    /// The socket address this process is configured to listen on.
    ///
    /// Returned uncanonicalised on purpose: [`crate::bind::preflight`] is what
    /// decides whether this address is usable here, and passing it the configured
    /// string is the whole point of that check.
    ///
    /// An IPv6 host is bracketed. `format!("{}:{}", host, port)` produces `:::8787`
    /// for a v6 host, which is not a socket address at all and fails to parse at
    /// `TcpListener::bind` with an error that names neither the config key nor the
    /// bracket that is missing. Every target in M7.9's matrix can run an IPv6 tailnet
    /// address, so this is the shape a real deployment reaches.
    pub fn bind_address(&self) -> String {
        let host = self.bridge.bridge.host.deref();
        let port = self.bridge.bridge.port;

        match host.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V6(_)) => format!("[{host}]:{port}"),
            _ => format!("{host}:{port}"),
        }
    }
}

/// `realpath` each configured project root, dropping the ones that do not resolve.
///
/// Dropping rather than failing is not a policy decision, and it is provably
/// equivalent to keeping them. `realpath` on the *candidate* `project_dir` has to
/// succeed for the candidate to be accepted at all
/// ([`crate::validate::canonical_project_dir`]), and no path can canonicalise
/// successfully *through* a root that does not canonicalise itself. A root that
/// fails to resolve therefore rejects exactly the requests it would have rejected
/// had it been kept — the only difference is which of two identical refusals
/// produces it.
///
/// The alternative, refusing to start when a configured project is missing, was
/// rejected because it converts "one project directory was deleted from a
/// developer machine" into "the router does not start", on a machine that may
/// never have received a request for that project. A trust boundary should not
/// have its availability coupled to configuration it does not use.
fn canonical_project_roots(bridge: &BridgeConfig) -> Vec<PathBuf> {
    bridge
        .projects
        .iter()
        .map(|project| std::fs::canonicalize(project.path.deref()))
        .filter_map(Result::ok)
        .collect()
}
