// Pure/controller-side tests for the Protocol v4 deployment record gate.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { artifactIdOf } from "../../lib/zk-artifacts.mjs";
import { loadDeploymentRecord, validateDeploymentRecord, validatePinnedCheckout } from "./preflight.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(HERE, "preflight.mjs");
const EXAMPLE = join(HERE, "deployment.example.json");
const VKEY_REL = "circuits/rln/verification_key.json";
const vkey = readFileSync(join(ROOT, VKEY_REL));
const ARTIFACT_ID = artifactIdOf("rln", vkey);
const ARTIFACT_SHA = createHash("sha256").update(vkey).digest("hex");
const ONION = "kssrk54kb5kngr4jjdzjouecwjh5ayzbzhamwmvju4kz63vno7hy4uyd.onion";
const SIGNER = "11".repeat(32);
const COMMIT = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const REPO = "https://github.com/example/shade-tree-node";
const CONTRACT = "0x" + "22".repeat(20);

let failures = 0;
const ok = (condition, message) => {
  if (condition) console.log(`  ok   ${message}`);
  else { console.log(`  FAIL ${message}`); failures++; }
};
const copy = (value) => JSON.parse(JSON.stringify(value));
const fields = (result) => result.errors.map((error) => error.field);

function liveRecord() {
  const service = { repository: REPO, commit: COMMIT };
  return {
    schemaVersion: 1,
    network: "research-v4",
    status: "live",
    protocol: { min: 4, max: 4 },
    security: { proofArtifacts: "untrusted-testnet", scope: "disposable-research", decisionRef: "fixture-only" },
    services: { elder: { ...service }, node: { ...service }, heartbeat: { ...service } },
    elder: { onion: ONION, canopySigner: SIGNER, admission: "open", gatewayRegistry: null },
    admission: {
      paths: ["invited"],
      roots: { invited: { membersSha256: "33".repeat(32) }, staked: null, paid: null },
      operatorAuthorization: null,
    },
    artifacts: {
      accepted: [{ id: ARTIFACT_ID, verificationKeyPath: VKEY_REL, sha256: ARTIFACT_SHA }],
      legacy: ARTIFACT_ID,
    },
    created: "2026-08-25",
    note: "fixture",
  };
}

console.log("live record:");
const live = liveRecord();
ok(validateDeploymentRecord(live, { repoRoot: ROOT }).ok, "complete invited-only v4 record is deployable");
ok(!validateDeploymentRecord(live).ok && fields(validateDeploymentRecord(live)).includes("artifacts"), "live preflight requires a repository root for byte verification");
ok(validatePinnedCheckout(live, { repoRoot: ROOT }).ok, "runtime files and artifact bytes exist at the immutable service commit");

console.log("pending template:");
const pending = loadDeploymentRecord(EXAMPLE);
ok(validateDeploymentRecord(pending, { requireLive: false, repoRoot: ROOT }).ok, "null placeholder template is structurally valid in review mode");
const pendingDeploy = validateDeploymentRecord(pending, { repoRoot: ROOT });
ok(!pendingDeploy.ok && fields(pendingDeploy).includes("status") && fields(pendingDeploy).includes("elder.onion") && fields(pendingDeploy).includes("artifacts.accepted"), "pending template fails closed as a deployment input");

console.log("identity and protocol pins:");
for (const [label, mutate, field] of [
  ["pre-v4 protocol", (r) => { r.protocol = { min: 3, max: 4 }; }, "protocol"],
  ["bad Elder onion", (r) => { r.elder.onion = "203.0.113.1"; }, "elder.onion"],
  ["bad signer", (r) => { r.elder.canopySigner = "abcd"; }, "elder.canopySigner"],
  ["floating ref", (r) => { r.services.node.commit = "main"; }, "services.node.commit"],
  ["credentialed repo", (r) => { r.services.node.repository = "https://token@example.com/repo"; }, "services.node.repository"],
]) {
  const rec = copy(live); mutate(rec);
  ok(!validateDeploymentRecord(rec, { repoRoot: ROOT }).ok && fields(validateDeploymentRecord(rec, { repoRoot: ROOT })).includes(field), `${label} is rejected`);
}
const drift = copy(live); drift.services.heartbeat.commit = "cd".repeat(20);
ok(fields(validateDeploymentRecord(drift, { repoRoot: ROOT })).includes("services"), "single-checkout deploy refuses per-service commit drift");
const unsafeProduction = copy(live); unsafeProduction.security.scope = "production";
ok(fields(validateDeploymentRecord(unsafeProduction, { repoRoot: ROOT })).includes("security"), "untrusted proof artifacts cannot be labeled production");
const falseTrust = copy(live); falseTrust.security = { proofArtifacts: "trusted-ceremony", scope: "production", decisionRef: "not-real" };
ok(fields(validateDeploymentRecord(falseTrust, { repoRoot: ROOT })).includes("security.proofArtifacts"), "production trust claim must match a completed trusted ceremony in the artifact lock");

console.log("admission fail-closed rules:");
const staked = copy(live);
staked.admission.paths = ["invited", "staked"];
staked.admission.roots.staked = { contract: CONTRACT, rpcUrl: "https://rpc.example.test", deployBlock: 42 };
staked.admission.operatorAuthorization = { approved: true, decisionRef: "operator-change-42" };
ok(validateDeploymentRecord(staked, { repoRoot: ROOT }).ok, "staked admission needs a contract root and explicit operator authorization reference");
const badRpc = copy(staked); badRpc.admission.roots.staked.rpcUrl = "https://token@example.test";
ok(fields(validateDeploymentRecord(badRpc, { repoRoot: ROOT })).includes("admission.roots.staked.rpcUrl"), "credentialed staking RPC URLs are rejected");
const badDeployBlock = copy(staked); badDeployBlock.admission.roots.staked.deployBlock = -1;
ok(fields(validateDeploymentRecord(badDeployBlock, { repoRoot: ROOT })).includes("admission.roots.staked.deployBlock"), "negative staking deploy blocks are rejected");
const noAuth = copy(staked); noAuth.admission.operatorAuthorization = null;
ok(fields(validateDeploymentRecord(noAuth, { repoRoot: ROOT })).includes("admission.operatorAuthorization"), "on-chain admission without operator authorization is rejected");
const noRoot = copy(staked); noRoot.admission.roots.staked = null;
ok(fields(validateDeploymentRecord(noRoot, { repoRoot: ROOT })).includes("admission.roots.staked"), "named admission path without its root is rejected");
const order = copy(staked); order.admission.paths = ["staked", "invited"];
ok(fields(validateDeploymentRecord(order, { repoRoot: ROOT })).includes("admission.paths"), "admission paths must use the canonical anonymity order");
const stakeElder = copy(live); stakeElder.elder.admission = "stake";
ok(fields(validateDeploymentRecord(stakeElder, { repoRoot: ROOT })).includes("elder.gatewayRegistry"), "stake-gated Elder needs a registry contract");

console.log("artifact integrity:");
for (const [label, mutate, field] of [
  ["wrong sha", (r) => { r.artifacts.accepted[0].sha256 = "44".repeat(32); }, "artifacts.accepted[0].sha256"],
  ["wrong content id", (r) => { r.artifacts.accepted[0].id = "rln-aaaaaaaaaaaaaaaa"; }, "artifacts.accepted[0].id"],
  ["path traversal", (r) => { r.artifacts.accepted[0].verificationKeyPath = "../verification_key.json"; }, "artifacts.accepted[0].verificationKeyPath"],
  ["missing file", (r) => { r.artifacts.accepted[0].verificationKeyPath = "circuits/rln/missing.json"; }, "artifacts.accepted[0].verificationKeyPath"],
  ["empty accepted set", (r) => { r.artifacts.accepted = []; }, "artifacts.accepted"],
]) {
  const rec = copy(live); mutate(rec);
  ok(!validateDeploymentRecord(rec, { repoRoot: ROOT }).ok && fields(validateDeploymentRecord(rec, { repoRoot: ROOT })).includes(field), `${label} is rejected`);
}

console.log("CLI:");
const work = mkdtempSync(join(tmpdir(), "shade-tree-v4-preflight-"));
try {
  const livePath = join(work, "deployment.json");
  writeFileSync(livePath, JSON.stringify(live));
  const good = spawnSync(process.execPath, [SCRIPT, "--record", livePath, "--repo-root", ROOT], { encoding: "utf8" });
  ok(good.status === 0 && /deployable v4 record/.test(good.stdout), "CLI accepts a complete live record");
  const review = spawnSync(process.execPath, [SCRIPT, "--record", EXAMPLE, "--repo-root", ROOT, "--allow-pending"], { encoding: "utf8" });
  ok(review.status === 0 && /valid v4 record/.test(review.stdout), "CLI reviews the pending template without declaring it deployable");
  const blocked = spawnSync(process.execPath, [SCRIPT, "--record", EXAMPLE, "--repo-root", ROOT], { encoding: "utf8" });
  ok(blocked.status === 1 && /deployment preflight failed/.test(blocked.stderr), "CLI blocks the pending template in deploy mode");
  const missingPin = copy(live); missingPin.services.elder.commit = missingPin.services.node.commit = missingPin.services.heartbeat.commit = "ff".repeat(20);
  writeFileSync(livePath, JSON.stringify(missingPin));
  const pinBlocked = spawnSync(process.execPath, [SCRIPT, "--record", livePath, "--repo-root", ROOT], { encoding: "utf8" });
  ok(pinBlocked.status === 1 && /not a commit available/.test(pinBlocked.stderr), "CLI refuses a syntactically valid commit that the controller cannot verify");
  const unknown = spawnSync(process.execPath, [SCRIPT, "--wat"], { encoding: "utf8" });
  ok(unknown.status === 1 && /unknown argument/.test(unknown.stderr), "CLI rejects unknown flags");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall v4 preflight checks passed");
process.exit(failures ? 1 : 0);
