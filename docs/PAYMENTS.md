# Payments: anonymous, cheap, ergonomic access funding

**Status: design, not built.** Nothing in this document is implemented yet. It is the output of four adversarially-verified research passes (June 2026) on how to add paid access to the reputation-gated egress without breaking its anonymity. The access layer it builds on (Semaphore membership proof + epoch nullifiers) is live; everything about payment below is a plan.

## What we are solving

Today membership is granted by a local `enroll` command. We want access to be **purchased**, under three requirements:

1. **Anonymous.** Cryptographic unlinkability between who paid and who used the service. Not "no-KYC." Actual unlinkability.
2. **Cheap**, in dollars (fees) and in resources (per-message verify cost, server-side double-spend state).
3. **Extremely ergonomic.** Hard constraint: no expensive operation per message. A fresh zk proof, an on-chain transaction, or a Lightning payment on every request is disqualified. We already pay this lesson: a Semaphore proof is 240ms on a laptop and 800ms on the 2 vCPU gateway (see `experiments/`), so anything per-message must be a cheap token check, not a proof.

## The architecture: two layers at different frequencies

The whole design rests on splitting payment frequency from message frequency.

- **Funding layer (infrequent, may be heavy, anonymity is won here).** You top up once per period. This is the only place a chain, a Lightning hop, or a mixer appears.
- **Access layer (per message, near-free).** You redeem a pre-authorized credential. No proof generation, no network round trip to a chain.

We already built the access layer for the reputation dimension: the shim caches one Semaphore proof per daily epoch and the gateway meters per nullifier (`N/100`). Payment is isomorphic to that. We are gating issuance, not adding a per-message cost.

## Access layer (settled)

| Option | Per-message cost | Multi-show budget | Maturity (Node) | Use it when |
|---|---|---|---|---|
| **Cached Semaphore epoch-proof** (current) | ~10-32ms verify, cached client-side | yes, via the nullifier budget | live in this repo | default; already shipped |
| **ARC** (Anonymous Rate-limited Credentials) | ~740µs verify, 288-byte presentation | yes, budget N baked in at issuance | IETF draft, Go ref impl only, **no Node lib** | you need a finer metered budget than membership gives |
| Cashu ecash token | curve-mult + set lookup | no, one token one use | cashu-ts (client), CDK/Nutshell (mint) | the token also carries the payment (Bucket B) |

ARC is the architecturally ideal credential (a single purchase becomes N unlinkable presentations, with the rate budget committed at issuance and the server keeping a tag set that is the direct analog of our nullifier map). But it is a moving IETF Privacy Pass draft with only a Go reference implementation, so adopting it means a Go verifier sidecar or a from-spec build. **Recommendation: do not gate v1 on ARC.** The existing cached Semaphore proof already gives multi-show access with show-time anonymity. Add ARC later only if you need sub-membership metered budgets.

## Funding layer: two buckets

### Bucket A: Ethereum L1

**Complete the RLN design rather than bolt on a second system.** RLN (the rate-limiting nullifier construction we already use the access half of) was born as an economic anti-spam primitive: stake to join, get a rate budget, exceed it and your key is recoverable and slashable. Its registration half lives on Ethereum.

End to end:

1. Deposit a fixed denomination into a **large, shared** Privacy Pools deployment (0xbow). Not your own pool. See the sizing note below for why.
2. Withdraw via a **relayer**, over Tor, to a fresh address. The withdrawal emits a zk proof of membership in the deposit set plus a valid association-set (ASP) root, spends a single-use nullifier, and is submitted by the relayer (`processooor` field / `Entrypoint.relay`), so the registration transaction is not your funding address.
3. That same withdrawal proof gates insertion of your Poseidon commitment into the on-chain RLN/Semaphore membership tree. Batch insertions into daily-epoch windows.
4. Per message: unchanged. Your cached Semaphore epoch-proof is the access token. Nothing on chain per message.

Cost is confined to the infrequent layer. Semaphore v4's LeanIMT insertion is ~213,820 gas (about $3.70 at benchmark prices, a 43% cut over the old fixed-depth tree), and a Hash-Map Merkle Tree stores ~0.097 MB for 1,000 members instead of 67 MB for a full depth-20 tree.

Why pick it: reuses the entire Semaphore/zk stack, ETH-native, and you finally get the auditable on-chain stake and slashing that RLN was designed around.

### Bucket B: non-Ethereum

**Cashu over Lightning.** Pay one Lightning invoice, receive blind-signed ecash. The blind signature (BDHKE) means the mint never sees the token secret or the unblinded signature, so funding and use are cryptographically unlinkable. The tokens are the access credential. Redeem them over the existing onion. The mint's only state is a spent-secret set, prunable by keyset rotation, which lines up with our epoch sweep.

The Node gateway uses `cashu-ts` (client only). The mint runs as a sidecar: CDK (Rust, `cdk-mintd`) or Nutshell (Python). There is no native Node mint.

Why pick it: native cryptographic anonymity out of the box, fewer moving parts, and the most mature self-hostable tooling. It abandons L1 settlement entirely and shifts trust to the mint operator and Lightning routing.

## The binding: how a payment authorizes issuance

This was the open question across the first two passes. The answer: **it is a composition of shipping primitives, not a new construction.**

- **Non-Ethereum: Cashu is the binding.** There is nothing to add. The ecash token is the credential, the blind signature breaks the funding-to-use link information-theoretically (the blinding factor `r` is never transmitted), and the spent-secret set is the nullifier that prevents double-issue.
- **Ethereum L1: the Privacy Pools withdrawal proof is the proof-of-payment.** It already proves deposit-set membership plus a valid ASP root without revealing which deposit, spends a single-use nullifier, and is relayer-submittable. The withdrawal-note secret becomes the issuance-authorization token, gating the Poseidon insertion.
- **The pattern has a name:** zk-creds, "insertion equals issuance" (Rosenberg, White, Garman, Miers, IEEE S&P 2023). A credential is issued by becoming a leaf in a public Merkle list, gated on a zk proof of a qualifying fact, with no issuer signing key. The paper explicitly describes Sybil-resistant tokens issued by making a blockchain payment. That is this design, already in the literature.

### The one hard part is systems, not cryptography

Every credential primitive surveyed (ARC, Cashu, Taler, Coconut, zk-creds) explicitly scopes transport and timing metadata out of its guarantees. So the **singleton problem** is real: if one payment triggers one issuance session 1:1, network metadata re-links payer to user no matter how sound the blind signature is. Defeating it is an integration task, not a missing primitive:

- **Batch / epoch issuance** so K payers' insertions share a time window. We already run daily epochs.
- **Issue and register over Tor** to break IP linkage. We already operate the onion.
- **Relayer / ERC-4337** so the registration transaction is not the payer's address. Privacy Pools gives this natively.

The minimum batch size K is a deployment parameter, not a proven anonymity bound.

## Leak ledger: where the who-paid to who-used link actually breaks or leaks

| Rail | Where the link breaks | Residual leaks to mitigate |
|---|---|---|
| Cashu / Lightning | blind signature (native, cryptographic) | denomination/amount correlation, timing, IP to mint (run over Tor), mint can ID the token receiver not the payer, DLEQ disclosure in a dispute |
| RLN stake on L1 (alone) | nowhere by default: the wallet signs to derive the commitment, so payer to commitment is linked at registration | the entire link, unless a decorrelation hop is added |
| RLN stake + Privacy Pools | deposit-to-withdrawal link, bounded by anonymity-set size and the ASP set | thin sets, timing, unique amounts; legal posture of the pool |
| ARC issuance | issuer-client unlinkable, but only within the anonymity set | a per-payer singleton issuance context defeats it via metadata; needs batching |

Mixer unlinkability is anonymity-set-bounded, not absolute. The claim that a mixer yields a "brand-new fully unlinkable address" was explicitly refuted in research. zk-nym (Nym/Coconut) issuance-to-use unlinkability was also refuted; do not rely on it.

### Anonymity-set sizing for a low-volume service

In an ideal mixer the chance of linking your withdrawal to your deposit is about **1/k**, where k counts indistinguishable deposits of the same denomination in the relevant window. Effective k collapses below nominal from three things: unique amounts (fix with fixed denominations), timing (fix with a minimum dwell time plus random delay), and thin low-volume sets (the death spiral that hollowed out Tornado).

The trap specific to a small service: **running your own pool is the worst case**, because k is tiny and everyone in it is self-evidently your user. The guidance is therefore counterintuitive. Ride a large shared public pool so your users hide in unrelated traffic, use a fixed denomination, hold a dwell time that spans many other deposits, and batch the second hop (clean address into your RLN contract) into epoch windows over Tor. At tens of users you cannot manufacture a meaningful set yourself. Negligible linkage (k in the hundreds) only comes from a big external pool.

## Rejected, and why

- **GNU Taler.** Income-transparent by design ("customers stay anonymous, merchants cannot hide income"), the exchange identifies the receiving operator at deposit, and running an exchange "will most likely need a bank license." Wrong for a solo Tor operator.
- **L402 (Lightning + macaroons).** Capable, and one macaroon can carry a reusable attenuable budget. But the macaroon embeds the invoice `payment_hash` plus a persistent 32-byte `user_id`, and since the operator is both invoice issuer and verifier it can trivially link payment to use and track a stable identity. Wins only in its agent-to-agent micropayment niche.
- **Base Privacy Pass (RFC 9578).** One token one use, no budget semantics. ARC is the extension that fixes this.
- **Tornado Cash.** Legally fraught (delisted March 2025 but the developer was not, volumes never recovered) and a self-degrading anonymity set. Use Privacy Pools, whose association-set design gives an operator-viable compliance posture.

## Buildable today vs open

**Buildable now from shipping primitives:** Semaphore v4, Privacy Pools (0xbow v1), Cashu (CDK / Nutshell mint + cashu-ts client), Lightning, relayers, and the Tor onion we already run.

**Open engineering decisions (not blockers):**

1. Whether to verify the Privacy Pools withdrawal proof inside the same circuit that authorizes the RLN insertion (one combined proof) or as a two-step verify-then-insert. Undemonstrated anywhere; an optimization.
2. The minimum batch size K for issuance to defeat the singleton.
3. ARC has no Node library, so adopting it needs a Go sidecar or a from-spec build. Avoidable by staying on the cached Semaphore proof.
4. Cashu denomination fingerprinting at low volume may be the dominant practical leak; quantify before relying on it.

## Recommendation

- **If Ethereum L1 is a hard requirement:** Bucket A. Complete RLN on chain, decorrelate through a large shared Privacy Pools via a relayer over Tor, and keep ARC out of v1.
- **If Ethereum is negotiable:** Bucket B. Cashu over Lightning is fewer moving parts and stronger native anonymity. Ship it first as the demo, then add the L1 stake path later for the auditable-stake story.

The cryptography is all shipping primitives. The only real work left is the systems integration of the singleton defense (batch plus Tor plus relayer), and on the ETH path, the combined-circuit decision.

## Sources

Primary sources behind the claims above (all verified 3-0 or 2-1 in adversarial review unless noted):

- Cashu protocol and BDHKE: cashubtc NUT-00, docs.cashu.space/protocol; CDK and Nutshell repos; cashu-ts.
- ARC: IETF Privacy Pass `draft-ietf-privacypass-arc-protocol` and `-crypto`; Cloudflare "private rate limiting" benchmark.
- Privacy Pass base: RFC 9578. Architecture caveats: RFC 9576.
- RLN and on-chain membership: rln.waku.org, rate-limiting-nullifier docs, Logos research; Semaphore v4.0.0 release notes; Vac storage evaluation.
- Privacy Pools: Buterin/Soleimani et al. (SSRN 4563364), docs.privacypools.com (contracts, ASP); 0xbow deployment.
- zk-creds: Rosenberg, White, Garman, Miers, IEEE S&P 2023 (eprint 2022/878).
- GNU Taler: docs.taler.net exchange manual and features; lsd0009.
- L402: docs.lightning.engineering (macaroons, protocol spec), Aperture; Macaroons NDSS 2014.
- Tornado status: Treasury press release SB0057 (March 2025 delisting); arXiv 2510.09443.
