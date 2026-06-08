// Crypto microbenchmark for the reputation-gated egress.
//
// Isolates the two Semaphore costs the system actually pays, with NO network in
// the path (so the numbers are the crypto, not Tor):
//   - generateProof  -> the CLIENT cost, paid once per epoch by a member's shim
//   - verifyProof    -> the GATEWAY cost, paid on EVERY request
//
// Run the SAME script on the laptop (client hardware) and on the droplet
// (gateway hardware, 2 vCPU) to compare both sides on both machines.
//
//   BENCH_LABEL=laptop  node experiments/bench-crypto.mjs
//   BENCH_LABEL=droplet node experiments/bench-crypto.mjs
//
// Tunables (env): BENCH_ACCOUNTS (distinct members, default 8),
//   BENCH_GEN (proofs generated per account, default 12),
//   BENCH_VERIFY (times each generated proof is re-verified, default 5).
//
// Proof timing is identity-independent by construction (fixed circuit + tree
// depth), so we use ephemeral identities sized to match the real set. That keeps
// the script portable (no secrets on the server) and still measures per-account
// spread, which is the honest answer to "does it vary across accounts".

import os from "node:os";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGE = 1n;
const SCOPE = 20612n; // fixed; the value does not affect timing

const N_ACCOUNTS = Number(process.env.BENCH_ACCOUNTS || 8);
const GEN_PER = Number(process.env.BENCH_GEN || 12);
const VERIFY_REPEAT = Number(process.env.BENCH_VERIFY || 5);
const LABEL = process.env.BENCH_LABEL || os.hostname();

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms, float

function stats(xs) {
  const a = [...xs].sort((p, q) => p - q);
  const n = a.length;
  if (!n) return { n: 0 };
  const mean = a.reduce((s, x) => s + x, 0) / n;
  const variance = a.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const q = (p) => a[Math.min(n - 1, Math.round(p * (n - 1)))];
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    n,
    min: r2(a[0]),
    p50: r2(q(0.5)),
    mean: r2(mean),
    p95: r2(q(0.95)),
    p99: r2(q(0.99)),
    max: r2(a[n - 1]),
    stdev: r2(Math.sqrt(variance)),
  };
}

function hostInfo() {
  const cpus = os.cpus() || [];
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpu_model: cpus[0]?.model?.trim() || "unknown",
    cpu_count: cpus.length,
    total_mem_gb: Math.round((os.totalmem() / 1e9) * 10) / 10,
    node: process.version,
  };
}

async function main() {
  console.log(`\n  rgoe crypto bench — label=${LABEL}`);
  const host = hostInfo();
  console.log(`  ${host.cpu_model}  (${host.cpu_count} vCPU, ${host.total_mem_gb}GB)  node ${host.node}\n`);

  // Build a group of N ephemeral "accounts".
  const accounts = Array.from({ length: N_ACCOUNTS }, (_, i) => new Identity(`rgoe-bench-acct-${i}`));
  const group = new Group(accounts.map((a) => a.commitment));

  // ---- generation (client side) ----
  // Cold start: first call loads the SNARK proving artifacts (wasm + zkey).
  let t0 = now();
  const warmup = await generateProof(accounts[0], group, MESSAGE, SCOPE);
  const coldGen = now() - t0;
  const depth = Number(warmup.merkleTreeDepth);
  console.log(`  group: ${N_ACCOUNTS} members, merkle depth ${depth}`);
  console.log(`  proof gen cold start: ${Math.round(coldGen)} ms (artifact load)\n`);

  const proofs = [];
  const genByAccount = Array.from({ length: N_ACCOUNTS }, () => []);
  const allGen = [];
  for (let r = 0; r < GEN_PER; r++) {
    for (let i = 0; i < N_ACCOUNTS; i++) {
      const s = now();
      const proof = await generateProof(accounts[i], group, MESSAGE, SCOPE);
      const dt = now() - s;
      genByAccount[i].push(dt);
      allGen.push(dt);
      proofs.push(proof);
    }
    process.stdout.write(`\r  generating proofs… ${allGen.length}/${GEN_PER * N_ACCOUNTS}`);
  }
  console.log("");

  // ---- verification (gateway side) ----
  t0 = now();
  await verifyProof(proofs[0]);
  const coldVerify = now() - t0;

  const verifyMs = [];
  for (let r = 0; r < VERIFY_REPEAT; r++) {
    for (const p of proofs) {
      const s = now();
      const ok = await verifyProof(p);
      verifyMs.push(now() - s);
      if (!ok) throw new Error("a proof failed to verify — benchmark invalid");
    }
    process.stdout.write(`\r  verifying proofs… ${verifyMs.length}/${VERIFY_REPEAT * proofs.length}`);
  }
  console.log("\n");

  const perAccount = {};
  genByAccount.forEach((xs, i) => { perAccount[`acct-${i}`] = stats(xs); });

  const result = {
    label: LABEL,
    at: Date.now(),
    host,
    params: {
      n_accounts: N_ACCOUNTS,
      gen_per_account: GEN_PER,
      verify_repeat: VERIFY_REPEAT,
      group_size: N_ACCOUNTS,
      merkle_depth: depth,
      scope: SCOPE.toString(),
    },
    generation: { cold_ms: Math.round(coldGen * 100) / 100, warm: stats(allGen), per_account: perAccount },
    verification: { cold_ms: Math.round(coldVerify * 100) / 100, warm: stats(verifyMs) },
  };

  const out = join(HERE, `crypto-bench.${LABEL}.json`);
  await writeFile(out, JSON.stringify(result, null, 2));

  const g = result.generation.warm, v = result.verification.warm;
  console.log(`  ── generation (client) ──  cold ${result.generation.cold_ms} ms`);
  console.log(`     warm  n=${g.n}  p50 ${g.p50}  mean ${g.mean}  p95 ${g.p95}  max ${g.max}  (±${g.stdev})  ms`);
  console.log(`  ── verification (gateway) ──  cold ${result.verification.cold_ms} ms`);
  console.log(`     warm  n=${v.n}  p50 ${v.p50}  mean ${v.mean}  p95 ${v.p95}  max ${v.max}  (±${v.stdev})  ms`);
  console.log(`\n  wrote ${out}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
