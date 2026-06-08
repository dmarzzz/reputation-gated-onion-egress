# Benchmarking the crypto in a reputation-gated Tor egress

[reputation-gated-onion-egress](https://github.com/dmarzzz/reputation-gated-onion-egress) is a Tor onion service that egresses to the clearnet only for clients who present a zero-knowledge proof of membership in a curated set. No login, no account, and the gateway never learns who you are. The proof is a Semaphore membership proof, scoped to a daily epoch so the same member produces the same nullifier within a day (that is the rate limit) and a fresh one across days (that is the unlinkability).

Two cryptographic costs run in that system, and they sit on opposite sides:

- **Proof generation** runs on the **client**. The shim mints one proof per epoch and reuses it, so a member pays this once a day, not once a request.
- **Proof verification** runs on the **gateway**, on **every single request**, before any bytes egress.

I wanted the real numbers for both, isolated from the network. So this benchmark calls `generateProof` and `verifyProof` directly. No Tor, no sockets. Just the crypto.

## Method

- Semaphore v4.14.2 (`@semaphore-protocol/{identity,group,proof}`), groth16 over snarkjs.
- A group of 8 members, Merkle depth 3, matching the live reputation set.
- 96 proofs generated per machine (8 accounts x 12), then each proof verified 5 times (480 verifications).
- Timed with `process.hrtime.bigint()`. Cold start (first call, which loads the SNARK artifacts) reported separately from the warm steady state.
- Run unchanged on two machines: the client laptop and the actual gateway box.

Proof timing is identity-independent by construction, so the accounts are ephemeral identities sized to match the real set. That keeps the script portable and still measures per-account spread, which is the honest way to answer "does it vary by member."

Script: [`experiments/bench-crypto.mjs`](https://github.com/dmarzzz/reputation-gated-onion-egress/blob/main/experiments/bench-crypto.mjs). Raw results are attached as JSON.

## Results

| | proof gen, cold | proof gen, warm p50 | proof gen, warm p95 | verify, cold | verify, warm p50 | verify, warm p95 |
|---|---|---|---|---|---|---|
| **laptop** (Apple M1 Max, 10 core) | 410 ms | 243 ms | 267 ms | 12 ms | 9.8 ms | 10.3 ms |
| **gateway** (DigitalOcean, 2 vCPU, 2 GB) | 2241 ms | 779 ms | 927 ms | 31 ms | 32.5 ms | 71.9 ms |

n = 96 generations, 480 verifications per machine.

## What the numbers say

**Verification is cheap, and verification is the part that matters.** The gateway pays it on every request. On the small 2 vCPU box it is 32.5 ms at the median. `verifyProof` is CPU work on the event loop, so serialized that is a ceiling of roughly 27 to 31 proof checks per second per core before the gate itself becomes the bottleneck. For a private egress that already rides a Tor circuit, that headroom is plenty.

**Generation is the expensive half, and generation is the part you almost never pay.** Hundreds of milliseconds on a laptop, about 0.8 s on the small box. But the client mints one proof per daily epoch and reuses it all day. Amortized across a day of requests, the per-request proving cost rounds to zero.

So the cost asymmetry is exactly backwards from the naive read, and exactly right for the design. The patient side (a client, once a day) carries the heavy proving. The hot path (the server, every request) carries only a 32 ms check.

**Cold start is a one-time artifact load.** 410 ms on the laptop, 2.2 s on the box, the first time a process ever generates a proof. It loads the wasm and proving key, then every later proof is warm. The gateway only ever verifies, so it never pays the generation cold start at all.

**It does not vary by member.** Across the 8 accounts, the spread in generation p50 was 9.5% on the laptop and 2.0% on the gateway, i.e. noise. The proving cost is a property of the circuit and the tree depth, not of which secret you hold. That is good for throughput planning, and good for privacy: the time a proof takes does not leak which member made it.

**Hardware scales it about how you would expect.** Going from an M1 Max to a 2 vCPU droplet cost roughly 3.2x on generation and 3.3x on verification. The crypto is CPU-bound and tracks single-core performance.

## Honest scope

- One group, depth 3. Proving and verifying cost grows with tree depth, so a much larger reputation set will read higher. This is the cost at PoC size.
- The ~30 checks/sec/core figure is the serial CPU ceiling for the verify step alone, not a full-system load test. Real throughput also depends on the Tor rendezvous and the egress connection, which this benchmark deliberately excludes.
- These are groth16 numbers on these two machines. They are directional, not a claim about every host.

## Reproduce

```bash
git clone https://github.com/dmarzzz/reputation-gated-onion-egress
cd reputation-gated-onion-egress && npm install
BENCH_LABEL=mybox node experiments/bench-crypto.mjs
# tune: BENCH_ACCOUNTS, BENCH_GEN (proofs per account), BENCH_VERIFY (re-verifies per proof)
```
