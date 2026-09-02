# Changelog

## 0.4.0 — Node-free Rust agent path

### Added

- Added a Node-free Rust member enrollment command that writes an owner-only
  identity file, emits only the public commitment for operator admission, and
  can opt into a local version-2 membership set for demos.
- Added a native `shade-tree run -- <command>` wrapper for process-scoped,
  fail-closed authenticated proxy routing without exposing the member identity
  or operator configuration to the child process.
- Added `shade-tree proxy-token` and mandatory loopback Proxy authentication so
  another local OS account cannot spend the member's RLN slots.
- Added the reusable `shade-tree-egress` Rust crate and a long-lived Proxy
  lifecycle that shares one bootstrapped Arti base while giving each CONNECT
  tunnel a separate circuit-isolation view.

### Changed

- Made the checksummed Rust `-live` binary the primary agent distribution; the
  JavaScript package remains the operator and contributor path.
- Expanded the native live-release matrix and kept every binary paired with a
  checksum, provenance attestation, and SBOM.

## 0.3.0 — Shade Tree research preview

### Changed

- Renamed the project, package, CLI, services, metrics, paths, Rust crates,
  JavaScript API, and configuration surface to Shade Tree.
- Introduced the `shade-tree run -- <command>` process wrapper for proxy-aware
  agents and local tools.
- Moved the protocol to explicit v4 and rotated every name-bearing signature
  domain.
- Reworked operator defaults for safer service isolation and clearer
  co-location guidance.
- Replaced the public README and research-note presentation with the minimal
  Shade Tree identity and banner.

### Compatibility

- v3 and unversioned envelopes are rejected.
- Old configuration names have no compatibility alias.
- Capability, operator, and receipt records must be re-signed.
- Exit and withdrawal paths require contracts deployed with the new contexts.
- The checked-in Sepolia records describe the earlier research deployment.

See [`docs/MIGRATING-TO-SHADE-TREE.md`](docs/MIGRATING-TO-SHADE-TREE.md) for
the rollout sequence.
