# Proxy modes: local process or library

A proxy runs beside the agent. A node accepts the proof and provides egress. The Elder Tree serves the signed Canopy. The implementation and environment variables still use `client`, `gateway`, and `bootnode` in places. Those names remain compatible.

> **v4 status.** The current client speaks envelope v4 only. Obtain a v4 gateway onion or a
> signed directory and pinned signer from the fleet operator. The legacy Sepolia contract and
> directory files are incompatible pre-v4 history and must not be used as the current client's
> connection profile. The public aggregate map observes a separate disposable v4 research Grove,
> but it does not publish the invited membership inputs required to connect.

The node needs a **fresh RLN proof per tunnel**. That is what makes the nullifier,
the per-epoch rate cap, and the slashing work, so *something* client-side must mint it. What
varies is where that "something" lives. There are two shipped shapes and one planned.

## The irreducible part

Every CONNECT tunnel carries one Groth16 proof bound to a fresh `(epoch, slot)` nullifier. You
cannot set it once and reuse it: reusing a nullifier with a different signal is exactly the
over-spend the gateway slashes on. So every proxy, library, or CLI client regenerates the
proof per tunnel. Both shapes below share the same hardened core (`client/shade-tree-client.mjs`):
one proof per logical tunnel, deterministic across gateway failover (same signal → same
share), plus slot + gateway rotation.

## Option A: library (`ShadeTreeClient`)

Use this when the client is **your own code** (e.g. an agent doing many queries). No local
proxy; just call a function. `client/shade-tree-client.mjs`:

```js
import { ShadeTreeClient, cleanUp } from "./client/shade-tree-client.mjs";

const shadeTree = new ShadeTreeClient({
  secret,                                   // enrolled member secret (or SHADE_TREE_SECRET)
  directory: "./fleet/directory.json",       // signed export supplied by the v4 operator
  dirSigner: process.env.SHADE_TREE_DIR_SIGNER, // pinned signer supplied out of band
  torPort: 9260,                            // client Tor SOCKS
  // or: onion: "…"  to pin a single gateway instead of fleet rotation
});

const res = await shadeTree.fetch("https://api.ipify.org");    // { status, headers, body }
// lower level; bring your own TLS/protocol over the raw tunnel:
const sock = await shadeTree.connect("api.ipify.org:443");     // duplex, tunneled via a gateway
// sock.shadeTree = { onion, slot, nullifier, receipt, artifact, leafSource }

cleanUp();  // terminate snarkjs workers so the process can exit
```

- `fetch(url, { method, headers, body })` → HTTPS over the tunnel; **TLS is end-to-end** to
  the target (the gateway relays ciphertext only). `https://` only (the gateway egresses :443).
- `connect("host:443")` → the raw duplex tunnel, if you want your own protocol.
- Each call rotates gateway + slot and reuses one proof across failover.

For dynamic discovery, set `SHADE_TREE_BOOTNODE_ONION` and `SHADE_TREE_DIR_SIGNER` to the
operator-supplied v4 values, then construct `new ShadeTreeClient({ secret, torPort })`.
For a single node, set `SHADE_TREE_ONION` or pass `{ onion }`. There is currently no
repo-maintained public v4 network profile to select by name.

Runnable example: `examples/agent-fetch.mjs`. Point it at your local fleet or an operator's
v4 configuration before running it.

## Leaf source + admission filtering + `--max-anon` (T-FEAT-9, both options)

Your leaf lives in one set: `members.json` (**invited**), a `StakedReputationSet` (**staked**), or
the `PaidAccessSet` (**paid**). Each gateway advertises which of those it admits as signed caps
(`admits`, in the anonymity order invited > staked > paid; `docs/adr/0008`). The client:

- discovers your **leaf source** (`makeLeafSourceLoader`: members.json first, then the staked sets,
  then the paid set; `SHADE_TREE_LEAF_SOURCE=invited|staked|paid` / `{ leafSource }` / `--leaf-source`
  pins the set if your leaf is in several), and
- routes ONLY to gateways whose `admits` include it (`selectCandidates(req, { leafSource, maxAnon })`
  → `filterByAdmission`). A gateway that advertises no policy is assumed to admit any path during
  the rollout (logged once); if NO gateway admits your leaf source the client fails closed:
  `no gateway admits a paid leaf (your leaf source); fleet: abcd..=[invited,staked] efgh..=[invited] …`.
- `--max-anon` / `SHADE_TREE_MAX_ANON=1` / `{ maxAnon: true }`: the maximum-anonymity mode. Only gateways
  whose `admits` is EXACTLY `["invited"]` (their whole population is invited; a policy-less gateway
  cannot prove it and is excluded), and the client REFUSES to run with a staked/paid leaf before any
  proof or dial; `--max-anon: your leaf is in the paid set (the buyer address -> operator transfer
  and tier bucket are public); an invited-only gateway would reject it (wrong-group-root)…`. No
  invited-only gateway in the directory: `--max-anon: no invited-only gateway in the directory …
  fleet: …` (if no node in an operator's v4 directory is invited-only, this refusal is the
  correct outcome).
- A pinned `onion` is honoured as-is (its policy is unknown to the client; a mismatch surfaces as
  the gateway's `wrong-group-root`), except that `--max-anon` still refuses a staked/paid leaf.
- Events: a live Elder refresh emits the local `canopy` phase with `query`, then `verified`, `cache`, or `error`. It contains only the signed issue time and node count when available. No event is sent to another service. Selection then emits `select` as before.

```bash
shade-tree proxy --bootnode <v4-elder.onion> \
  --dir-signer <v4-directory-signer-hex> --max-anon

shade-tree proxy --bootnode <v4-elder.onion> \
  --dir-signer <v4-directory-signer-hex> --leaf-source paid --limit 32 \
  --paid-access-contract <v4-paid-set-address>
```

## Option B: local proxy (`client/shim.mjs`)

Use this when the client is a **stock tool** you can't change (browser, curl, any
`http_proxy`-aware app). The shim is now a thin HTTP-CONNECT front-end over the same
`ShadeTreeClient`. Load `SHADE_TREE_SECRET` with the hidden prompt in the
[agent guide](AGENT.md), then run:

```bash
SHADE_TREE_TOR_PORT=9260 shade-tree proxy \
  --bootnode <v4-elder.onion> --dir-signer <v4-directory-signer-hex>
# then: curl -x http://127.0.0.1:8888 https://api.ipify.org
```

The bootnode onion and signer are a pair: copy both from the v4 operator and pin the signer
out of band. Add `SHADE_TREE_LIMIT=32` (`--limit 32`) if your leaf is a tier-32 one, plus the
v4 paid-set address if it is a paid leaf (`docs/PAYMENTS.md`).

Env, if you want to set the pieces yourself: `SHADE_TREE_SECRET`, then one discovery source:
`SHADE_TREE_BOOTNODE_ONION`+`SHADE_TREE_DIR_SIGNER` (operator's v4 fleet),
`SHADE_TREE_DIRECTORY`+`SHADE_TREE_DIR_SIGNER` (an operator-supplied static signed directory), or
`SHADE_TREE_ONION` (pin one gateway); plus `SHADE_TREE_TOR_HOST`/`SHADE_TREE_TOR_PORT`. The routed
`shade-tree proxy` command fails before startup when a directory or Elder Tree is configured without
its pinned signer. A direct SDK import or `node client/shim.mjs` bypasses that router validation and
can reach the local-development `tor/hs/hostname` fallback, so treat a missing signer there as a
configuration error too.

## Planned: stock HTTP CONNECT + `Proxy-Authorization`

Teach the gateway to also speak a standard HTTP CONNECT proxy and read the proof from a
`Proxy-Authorization: RLN <base64>` header, so plain `curl -x http://<onion>:80` works with
no shim and no library; you just need a one-shot `shade-tree-prove <target>` to mint the header:

```bash
curl -x http://<onion>:80 \
  --proxy-header "Proxy-Authorization: RLN $(shade-tree-prove example.com:443)" \
  https://example.com
```

This removes the client software **for scripted one-shot requests**. It does **not** serve
multi-request clients (a browser/agent that sets the proxy once) safely: `Proxy-Authorization`
is static, but the proof must be fresh per tunnel; reusing it across targets either breaks
the rate cap or self-slashes. So B is a great gateway interface + a clean one-shot path, but
multi-request clients still need A (library) or the shim. Not built yet.

Note: the proof (~400+ bytes) does **not** fit SOCKS5 username/password (RFC 1929 caps each
at 255 bytes), which is why B rides on HTTP CONNECT, not SOCKS auth.
