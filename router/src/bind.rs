//! ADR 0008 §8 layer 1: the application-layer bind preflight.
//!
//! # The control
//!
//! `bridge.host` in `config.json` names the address this process is allowed to
//! listen on — a CGNAT (`100.64.0.0/10`) tailnet address. Layer 1's whole content
//! is: **if that address is not present on this host, exit `78` rather than bind
//! anything at all.** In particular it must not fall back to `0.0.0.0`.
//!
//! The failure it guards is mundane and total. Tailscale is not up, or the node's
//! address changed, and the router either binds a wildcard and serves the whole
//! LAN — turning a two-node tailnet bridge into a network-exposed one — or exits,
//! which is a supervisor restart loop an operator will notice. The first outcome
//! is a silent compromise; the second is a noisy outage.
//!
//! `EX_CONFIG` (78) is chosen over a generic failure because it is what a
//! supervisor reads as "this will not fix itself on restart" and it is the
//! conventional code for "the configuration is wrong".
//!
//! # Why enumerate interfaces rather than probe-bind
//!
//! `TcpListener::bind(host, port)` answers "can I bind *right now*", which is a
//! strictly weaker and differently-scoped question:
//!
//!   * It has a TOCTOU window. The check passes, Tailscale goes down, and the real
//!     bind four lines later is the one that decides — and that one cannot be
//!     preflighted at all.
//!   * Its failure modes are not distinguishable. `EADDRNOTAVAIL` means "no such
//!     local address", but `EACCES` on a privileged port and `EADDRINUSE` on a
//!     busy one arrive on the same code path, and an operator debugging "the
//!     router will not start" should not have to guess which of three unrelated
//!     causes applies.
//!   * It is the operation §8 forbids. A process that has to bind in order to
//!     learn whether it may bind has, briefly, bound.
//!
//! `if_addrs` reads the same table `ip addr` shows. It cannot race with the
//! listener, and it answers exactly the question the layer is asking.
//!
//! # What layer 1 is NOT here
//!
//! §8's table says layer 1 verifies "the address is on `tailscale0`". The
//! *interface-name* half of that is **M7.11, not M7.3**, and is deliberately
//! absent:
//!
//!   * The reference host has no `tailscale0` interface at all, so implementing it
//!     here would make the router impossible to start — and therefore impossible
//!     to test — on the only machine this milestone can be verified on.
//!   * Enumerating the interface name when none exists would force every developer
//!     to invent a dummy interface to run the router, which is how a control ends
//!     up disabled in the environments that need it least.
//!
//! So M7.3 implements the *address-presence* half and records the interface-name
//! half as outstanding. That is a deliberate gap in a defence-in-depth chain whose
//! remaining three layers (`nft`, `IPAddressAllow`, Tailscale ACL) are M7.11's as
//! well, and it is stated in `Docs/implementation-reports/m7.3-progress.md` rather
//! than left to be discovered.

use std::fmt;
use std::net::IpAddr;

/// `EX_CONFIG` from `sysexits.h`.
///
/// The process exits with this when the configured bind address cannot be used, so
/// a supervisor reads "configuration is wrong" instead of "the binary crashed".
/// Named as a constant rather than inlined because the value is part of this
/// module's contract with M7.10's units and with M7.11's negative test, and because
/// `std::process::ExitCode` takes a `u8`.
pub const EX_CONFIG: u8 = 78;

/// The interface `config.json` must name for the bind to be legitimate on a
/// deployed node, per ADR 0008 §8.
///
/// Present as a constant, and used in error text, but **not enforced by
/// `preflight`**. See the module docs: the interface-name check is M7.11's, and
/// this host has no `tailscale0` to check against. Exposing the name here means
/// M7.11 has one string to wire rather than one to invent, and means the error an
/// operator reads on the one host that *does* have the interface already names it.
pub const TAILSCALE_INTERFACE: &str = "tailscale0";

/// Why the configured bind address is unusable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreflightError {
    /// `bridge.host` is not a literal IP address.
    ///
    /// Refused rather than resolved. A hostname is resolved at connect time by
    /// whatever resolver happens to be configured, so the address this process
    /// binds can differ between the preflight and the bind, between a restart and
    /// a DNS change, and between two hosts reading the same `config.json`. ADR
    /// §8 layer 1 exists to eliminate exactly this class of drift, and a DNS name
    /// reintroduces it inside the layer meant to remove it.
    NotAnAddress {
        /// The configured value, echoed back. Operator configuration, not a secret,
        /// and the operator cannot see it in the error otherwise.
        configured: String,
    },

    /// `bridge.host` is a wildcard (`0.0.0.0` or `::`).
    ///
    /// Its own variant rather than falling out of the address-presence check,
    /// because a wildcard is *always* present (every host has it, implicitly) and
    /// so would otherwise be reported as a puzzling success. It is the single most
    /// important input this function refuses, because it is the one that produces
    /// the compromised outcome described in the module docs, and an operator
    /// deserves to be told that specifically.
    WildcardAddress {
        /// The configured value, echoed back.
        configured: String,
    },

    /// The address is well-formed, not a wildcard, and is not configured on any
    /// interface on this host.
    AddressAbsent {
        /// The configured address, echoed back.
        address: IpAddr,
        /// Every address this host does have, on every interface. Including them
        /// turns "not found" into an actionable message — the operator can see at
        /// a glance that they configured `100.64.0.1` on a host that has only
        /// `192.168.x.x` — and leaks nothing to an attacker, because this string is
        /// printed by the process at startup and never reaches a socket.
        present: Vec<IpAddr>,
    },

    /// The interface table could not be read.
    ///
    /// Distinct from `AddressAbsent` and **not** treated as success. "I could not
    /// check" and "the check passed" are different answers, and collapsing them is
    /// how a preflight becomes decorative: a permission error on
    /// `getifaddrs` must stop the process, not wave it through.
    InterfacesUnreadable {
        /// The underlying error. From `getifaddrs(3)`, not from caller input.
        source: String,
    },
}

impl fmt::Display for PreflightError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAnAddress { configured } => write!(
                f,
                "bridge.host is {configured:?}, which is not a literal IP address.\n\
                 Refusing to resolve it: a name can resolve differently between \
                 this check and the bind (ADR 0008 §8 layer 1)."
            ),
            Self::WildcardAddress { configured } => write!(
                f,
                "bridge.host is {configured:?}, a wildcard address.\n\
                 A wildcard bind would serve every interface on this host, including \
                 the LAN. Bind the configured tailnet address or do not bind."
            ),
            Self::AddressAbsent { address, present } => {
                writeln!(f, "bridge.host {address} is not configured on this host.")?;
                if present.is_empty() {
                    f.write_str("This host reports no interface addresses at all.")
                } else {
                    f.write_str("Addresses present on this host: ")?;
                    let rendered: Vec<String> = present.iter().map(ToString::to_string).collect();
                    f.write_str(&rendered.join(", "))?;
                    f.write_str(
                        ".\nIs Tailscale up? A CGNAT bridge address only exists once \
                         the node has joined the tailnet.",
                    )
                }
            }
            Self::InterfacesUnreadable { source } => write!(
                f,
                "cannot enumerate local interface addresses: {source}.\n\
                 Refusing to start rather than bind without checking."
            ),
        }
    }
}

impl std::error::Error for PreflightError {}

/// Verify that `configured_host` may be bound on this host, or explain why not.
///
/// Never binds anything, by construction: the only syscall this function makes is
/// `getifaddrs`/`freeifaddrs`.
///
/// The decision itself is factored into the pure [`check`] so it is testable
/// without a network stack. That matters more than usual here: the address that
/// *must* be refused (`100.64.0.1`) is precisely the address this host does not
/// have, so a test driven by real interface state would be asserting the shape of
/// the machine rather than the shape of the decision.
pub fn preflight(configured_host: &str) -> Result<(), PreflightError> {
    check(configured_host, &interface_addresses()?)
}

/// The decision, over already-collected facts.
fn check(host: &str, present: &[IpAddr]) -> Result<(), PreflightError> {
    let trimmed = host.trim();

    let Ok(address) = trimmed.parse::<IpAddr>() else {
        return Err(PreflightError::NotAnAddress {
            configured: trimmed.to_owned(),
        });
    };

    if address.is_unspecified() {
        return Err(PreflightError::WildcardAddress {
            configured: trimmed.to_owned(),
        });
    }

    if present.contains(&address) {
        return Ok(());
    }

    Err(PreflightError::AddressAbsent {
        address,
        present: present.to_vec(),
    })
}

/// Every address configured on every interface of this host.
fn interface_addresses() -> Result<Vec<IpAddr>, PreflightError> {
    let interfaces =
        if_addrs::get_if_addrs().map_err(|error| PreflightError::InterfacesUnreadable {
            source: error.to_string(),
        })?;
    Ok(interfaces
        .into_iter()
        .map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(v4) => IpAddr::V4(v4.ip),
            if_addrs::IfAddr::V6(v6) => IpAddr::V6(v6.ip),
        })
        .collect())
}

/// Every interface name on this host.
///
/// Not called by [`check`] in M7.3. It exists so that the missing §8 layer-1
/// interface-name gate is a visible, named hole rather than an absence nobody can
/// find: M7.11 turns this into a check without having to rediscover that
/// `if_addrs` already hands over `Interface::name`.
#[cfg(test)]
fn interface_names() -> Vec<String> {
    if_addrs::get_if_addrs()
        .map(|interfaces| interfaces.into_iter().map(|i| i.name).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv6Addr};

    use super::{check, interface_names, PreflightError, TAILSCALE_INTERFACE};

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("a literal IP in the test table")
    }

    #[test]
    fn a_configured_address_that_is_present_passes() {
        let present = [ip("100.64.0.1")];
        assert_eq!(check("100.64.0.1", &present), Ok(()));
    }

    #[test]
    fn an_absent_address_is_refused_and_lists_what_is_present() {
        let present = [ip("127.0.0.1"), ip("192.168.1.5")];
        let error = check("100.64.0.1", &present).expect_err("100.64.0.1 is not here");
        assert_eq!(
            error,
            PreflightError::AddressAbsent {
                address: ip("100.64.0.1"),
                present: present.to_vec(),
            }
        );
    }

    #[test]
    fn a_wildcard_v4_address_is_refused_as_a_wildcard() {
        // The load-bearing case. If this returned Ok, the router would serve the
        // LAN, which is the exact outcome ADR 0008 §8 exists to prevent.
        assert_eq!(
            check("0.0.0.0", &[]),
            Err(PreflightError::WildcardAddress {
                configured: "0.0.0.0".to_owned()
            })
        );
    }

    #[test]
    fn a_wildcard_v6_address_is_refused_as_a_wildcard() {
        assert_eq!(
            check("::", &[]),
            Err(PreflightError::WildcardAddress {
                configured: "::".to_owned()
            })
        );
    }

    #[test]
    fn a_hostname_is_refused_rather_than_resolved() {
        assert_eq!(
            check("dev-main.tailnet", &[]),
            Err(PreflightError::NotAnAddress {
                configured: "dev-main.tailnet".to_owned()
            })
        );
    }

    #[test]
    fn surrounding_whitespace_does_not_rescue_a_bad_address() {
        // `config.json` is hand-edited. Trimming means a trailing newline does not
        // turn a valid address into a "not an address" failure, but it must not
        // become a way to smuggle anything either.
        assert_eq!(check(" 100.64.0.1 ", &[ip("100.64.0.1")]), Ok(()));
    }

    #[test]
    fn loopback_is_a_present_address_and_passes() {
        // So the router can be run on a developer machine at all. Documented as a
        // deliberate concession: layer 1 is an anti-wildcard control, and M7.11
        // adds the `tailscale0` restriction that closes this.
        assert_eq!(check("127.0.0.1", &[ip("127.0.0.1")]), Ok(()));
    }

    #[test]
    fn ipv6_addresses_are_matched_too() {
        let present = [IpAddr::V6(Ipv6Addr::LOCALHOST)];
        assert_eq!(check("::1", &present), Ok(()));
    }

    #[test]
    fn v4_and_v6_forms_of_the_same_number_are_different_addresses() {
        // A caller must not be able to satisfy a v4 configuration with a v6
        // interface, or the other way round.
        let present = [IpAddr::V6(Ipv6Addr::LOCALHOST)];
        assert!(check("127.0.0.1", &present).is_err());
    }

    #[test]
    fn the_interface_name_layer_is_not_enforced_here_and_the_constant_exists() {
        // M7.11 wires this. Until it does, `check` must not consult names, so this
        // test asserts the constant is present and the decision function ignores
        // its input — if someone starts enforcing it in `check`, this fails and the
        // milestone that should have done it becomes visible.
        assert_eq!(TAILSCALE_INTERFACE, "tailscale0");
        assert_eq!(
            check("127.0.0.1", &[ip("127.0.0.1")]),
            Ok(()),
            "check must not consult interface names in M7.3"
        );
        // The data M7.11 needs is already reachable, so that task does not have to
        // rediscover the dependency or re-derive the interface list.
        assert!(
            !interface_names().is_empty(),
            "every host has at least one named network interface; if this fails, \
             M7.11's interface-name check has nothing to compare against"
        );
    }

    #[test]
    fn an_ipv4_mapped_form_does_not_satisfy_a_plain_v4_configuration() {
        // Guards a real bypass shape: `::ffff:127.0.0.1` is the same address as
        // `127.0.0.1` to a socket, and a `contains` on the raw parsed form would
        // accept it for a configuration that asked for something else entirely.
        let present = [IpAddr::V6("::ffff:127.0.0.1".parse().unwrap())];
        assert!(check("127.0.0.1", &present).is_err());
        assert!(check("::ffff:127.0.0.1", &present).is_ok());
        assert!(check("0.0.0.0", &present).is_err());
    }
}
