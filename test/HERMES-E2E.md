# Hermes end-to-end integration

`test/hermes-e2e.sh` is the gated, live integration for the documented
`shade-tree run -- hermes` path. It creates a disposable single-node Grove,
starts the Rust CONNECT Proxy with embedded Arti, launches a real Hermes
one-shot through the native Rust `run` wrapper, and asks the agent to make one
public HTTPS request with its terminal tool. It then makes a second scoped
request through the same Proxy. System Tor is present only to publish the temporary server-side onion;
the Proxy does not use its SOCKS port.

A pass requires all of these independent observations:

1. Hermes reports `HERMES_SHADE_TREE_OK` with the HTTPS response.
2. The node pass counter advances during that same Hermes attempt, so a tool
   result that bypassed or outlived the scoped Proxy cannot satisfy the test.
3. The ephemeral Shade Tree node exposes at least two
   `shade_tree_gateway_tunnels_total{result="pass"}` tunnels.
4. The Proxy records exactly one completed embedded-Arti bootstrap across both
   tunnels.

Fresh onion descriptors are intentionally unreliable for a short window. The
harness gives each of the two required requests three bounded attempts through
the same long-lived Proxy (`HERMES_E2E_RUN_ATTEMPTS` overrides this), while
crash-safe slot allocation ensures a failed attempt never reuses a nullifier.

The model endpoint may bypass the Grove. This is intentional for a local model
such as Ollama: the assertion is about the agent's public tool traffic. Loopback
hosts are always in `NO_PROXY`; add a private model hostname with
`HERMES_E2E_NO_PROXY` when needed.

## Local Hermes

Prerequisites are Node.js 20+, a Rust toolchain, Tor for the disposable onion
service, dependencies from `npm ci`, and a configured `hermes` command:

```bash
SHADE_TREE_HERMES_E2E=1 bash test/hermes-e2e.sh
```

The harness uses high, overridable loopback ports and removes its temporary
member file, onion keys, logs, and child processes on exit.
It builds `shade-tree-client --features live` by default. Set
`HERMES_E2E_RUST_BIN` to reuse an existing live binary.

## Hermes on another host

The proxy and ephemeral Grove can remain on the test machine while Hermes runs
on a server. The harness opens a loopback-only SSH reverse tunnel for the life of
the one-shot:

```bash
SHADE_TREE_HERMES_E2E=1 \
HERMES_E2E_SSH_TARGET=orbital-one \
HERMES_E2E_REMOTE_USER=mindagent \
HERMES_E2E_REMOTE_HOME=/home/mindagent \
HERMES_E2E_REMOTE_PATH=/home/mindagent/.local/bin:/usr/local/bin:/usr/bin:/bin \
bash test/hermes-e2e.sh
```

`HERMES_E2E_REMOTE_USER` is optional. When set, the SSH login must be allowed to
run `sudo -u <user>` non-interactively. `ExitOnForwardFailure` is enabled and the
remote listener binds only to `127.0.0.1`.

## Recurring use

This is deliberately not in `npm test`: it needs Hermes, Tor, and a real public
HTTPS request. [`.github/workflows/hermes-e2e.yml`](../.github/workflows/hermes-e2e.yml)
runs it every Monday at 07:23 UTC and on manual dispatch. The GitHub-hosted
runner is the disposable server; it installs server-side Tor and a commit-pinned
Hermes, builds the Rust Proxy with embedded Arti, then removes the whole machine
after the job.

CI uses `test/hermes-openai-stub.mjs`, a deterministic loopback-only
OpenAI-compatible model. The real Hermes binary still builds the terminal tool
schema, executes the model's `curl`, returns the tool result, and consumes the
final model response. The stub returns the success marker only after seeing an
`ip` field, while the harness independently requires an accepted node tunnel.
This keeps the recurring test credential-free and deterministic without
reducing the Rust proxy/Arti/proof path to a mock.
