//! Desktop side of the iroh P2P fallback transport.
//!
//! SSH stays the only first-contact channel (`ssh::rpc::SshRpcManager`).
//! This module only ever dials a host that has already been reached over
//! SSH at least once and had its iroh identity pinned via `iroh_confirm_pin`
//! (mirrors the SSH host-key TOFU flow, except Terax itself owns the pin -
//! there is no OS trust store for iroh identities the way `known_hosts`
//! exists for SSH). See `docs/architecture/iroh-fallback.md`.

pub mod commands;
pub mod config;
pub mod rpc;

pub use commands::{IrohShared, IROH_API_KEY_ACCOUNT, IROH_SECRET_SERVICE};
pub use config::IrohConfig;
