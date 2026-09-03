#!/usr/bin/env node
// Fail-closed validation for the public, secret-free Protocol v4 deployment record.
// This runs on the controller before Ansible is allowed to touch a target. It deliberately
// validates only public deployment identity: onions, signer pins, roots, artifact hashes,
// protocol range, and immutable source commits. Secret/operator checks remain in the role.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { isOnion, isEd25519PubHex, isEthAddress } from "../../lib/config.mjs";
import { isNetworkName } from "../../lib/network-record.mjs";
import { artifactIdOf, isArtifactId } from "../../lib/zk-artifacts.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SERVICE_NAMES = ["elder", "node", "heartbeat"];
const ADMISSION_PATHS = ["invited", "staked", "paid"];

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function safeRepository(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function validateDeploymentRecord(record, { requireLive = true, repoRoot = null } = {}) {
  const errors = [];
  const bad = (field, problem) => errors.push({ field, problem });
  if (!isObject(record)) return { ok: false, errors: [{ field: "$", problem: "record must be a JSON object" }] };

  if (record.schemaVersion !== 1) bad("schemaVersion", "must be 1");
  if (!isNetworkName(record.network)) bad("network", "must be a lowercase network name");
  if (!["pending", "live"].includes(record.status)) bad("status", "must be pending or live");
  if (requireLive && record.status !== "live") bad("status", "must be live before any target is changed");

  if (!isObject(record.protocol)) bad("protocol", "must be { min, max }");
  else {
    const { min, max } = record.protocol;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min !== 4 || max < min || max > 255) {
      bad("protocol", "must be an integer v4 range with min=4 and 4 <= max <= 255");
    }
  }

  if (!isObject(record.elder)) bad("elder", "must be an object");
  else {
    if (record.elder.onion !== null && !isOnion(record.elder.onion)) bad("elder.onion", "must be a v3 .onion or null while pending");
    if (record.elder.canopySigner !== null && !isEd25519PubHex(record.elder.canopySigner)) bad("elder.canopySigner", "must be a 64-hex Ed25519 public key or null while pending");
    if (!["open", "stake"].includes(record.elder.admission)) bad("elder.admission", "must be open or stake");
    if (record.elder.gatewayRegistry !== null && !isEthAddress(record.elder.gatewayRegistry)) bad("elder.gatewayRegistry", "must be a contract address or null");
    if (requireLive && !isOnion(record.elder.onion)) bad("elder.onion", "is required for a live record");
    if (requireLive && !isEd25519PubHex(record.elder.canopySigner)) bad("elder.canopySigner", "is required for a live record");
    if (record.elder.admission === "stake" && !isEthAddress(record.elder.gatewayRegistry)) bad("elder.gatewayRegistry", "is required when Elder admission is stake");
  }

  if (!isObject(record.security)) bad("security", "must record proof-artifact trust, rollout scope, and decision reference");
  else {
    const trust = record.security.proofArtifacts;
    const scope = record.security.scope;
    if (trust !== null && !["trusted-ceremony", "untrusted-testnet"].includes(trust)) bad("security.proofArtifacts", "must be trusted-ceremony, untrusted-testnet, or null while pending");
    if (scope !== null && !["production", "disposable-research"].includes(scope)) bad("security.scope", "must be production, disposable-research, or null while pending");
    if (record.security.decisionRef !== null && (typeof record.security.decisionRef !== "string" || !record.security.decisionRef.trim())) bad("security.decisionRef", "must be a non-empty string or null while pending");
    if (requireLive && !trust) bad("security.proofArtifacts", "is required for a live record");
    if (requireLive && !scope) bad("security.scope", "is required for a live record");
    if (requireLive && !(typeof record.security.decisionRef === "string" && record.security.decisionRef.trim())) bad("security.decisionRef", "is required for a live record");
    if (trust === "untrusted-testnet" && scope !== "disposable-research") bad("security", "untrusted proof artifacts are allowed only in a disposable-research fleet");
    if (scope === "production" && trust !== "trusted-ceremony") bad("security", "production requires trusted-ceremony proof artifacts");
  }

  const servicePins = [];
  if (!isObject(record.services)) bad("services", "must pin elder, node, and heartbeat");
  else for (const name of SERVICE_NAMES) {
    const service = record.services[name];
    if (!isObject(service)) { bad(`services.${name}`, "must be { repository, commit }"); continue; }
    if (service.repository !== null && !safeRepository(service.repository)) bad(`services.${name}.repository`, "must be a credential-free https URL or null while pending");
    if (service.commit !== null && !(typeof service.commit === "string" && COMMIT_RE.test(service.commit))) bad(`services.${name}.commit`, "must be a full lowercase 40-hex commit or null while pending");
    if (requireLive && !safeRepository(service.repository)) bad(`services.${name}.repository`, "is required for a live record");
    if (requireLive && !(typeof service.commit === "string" && COMMIT_RE.test(service.commit))) bad(`services.${name}.commit`, "is required for a live record");
    if (service.repository && service.commit) servicePins.push(`${service.repository}\n${service.commit}`);
  }
  if (servicePins.length > 1 && new Set(servicePins).size !== 1) {
    bad("services", "elder, node, and heartbeat must share one repository and commit in the current single-checkout deployer");
  }

  if (!isObject(record.admission)) bad("admission", "must be an object");
  else {
    const paths = record.admission.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => !ADMISSION_PATHS.includes(p)) || new Set(paths).size !== paths.length) {
      bad("admission.paths", "must be a non-empty unique subset of invited, staked, paid");
    } else {
      const canonical = ADMISSION_PATHS.filter((p) => paths.includes(p));
      if (paths.join(",") !== canonical.join(",")) bad("admission.paths", "must use canonical order: invited, staked, paid");
    }
    if (!isObject(record.admission.roots)) bad("admission.roots", "must name invited, staked, and paid roots");
    else {
      const roots = record.admission.roots;
      if (roots.invited !== null) {
        if (!isObject(roots.invited) || !(typeof roots.invited.membersSha256 === "string" && SHA256_RE.test(roots.invited.membersSha256))) bad("admission.roots.invited.membersSha256", "must be a lowercase sha256 or null while pending");
      }
      for (const path of ["staked", "paid"]) if (roots[path] !== null) {
        if (!isObject(roots[path]) || !isEthAddress(roots[path].contract)) bad(`admission.roots.${path}.contract`, "must be a contract address or null");
        if (roots[path].rpcUrl !== undefined && !safeRepository(roots[path].rpcUrl)) bad(`admission.roots.${path}.rpcUrl`, "must be a credential-free HTTPS URL when present");
        if (roots[path].deployBlock !== undefined && (!Number.isInteger(roots[path].deployBlock) || roots[path].deployBlock < 0)) bad(`admission.roots.${path}.deployBlock`, "must be a non-negative integer when present");
      }
      if (Array.isArray(paths)) for (const path of paths) {
        const root = roots[path];
        if (requireLive && root === null) bad(`admission.roots.${path}`, `is required because ${path} is admitted`);
      }
    }
    const onchain = Array.isArray(paths) && paths.some((p) => p === "staked" || p === "paid");
    const auth = record.admission.operatorAuthorization;
    if (auth !== null && (!isObject(auth) || auth.approved !== true || typeof auth.decisionRef !== "string" || !auth.decisionRef.trim())) {
      bad("admission.operatorAuthorization", "must be { approved: true, decisionRef } or null");
    }
    if (onchain && (!isObject(auth) || auth.approved !== true || typeof auth.decisionRef !== "string" || !auth.decisionRef.trim())) {
      bad("admission.operatorAuthorization", "is required before staked or paid admission can deploy");
    }
  }

  if (!isObject(record.artifacts)) bad("artifacts", "must be { accepted, legacy }");
  else {
    const accepted = record.artifacts.accepted;
    if (!Array.isArray(accepted)) bad("artifacts.accepted", "must be an array");
    else {
      if (requireLive && accepted.length === 0) bad("artifacts.accepted", "must contain at least one accepted RLN verification key");
      if (accepted.length > 4) bad("artifacts.accepted", "must contain at most four rollout keys");
      const ids = new Set();
      for (let i = 0; i < accepted.length; i++) {
        const artifact = accepted[i];
        const base = `artifacts.accepted[${i}]`;
        if (!isObject(artifact)) { bad(base, "must be { id, verificationKeyPath, sha256 }"); continue; }
        if (!isArtifactId(artifact.id) || !artifact.id.startsWith("rln-")) bad(`${base}.id`, "must be a bounded rln artifact id");
        else if (ids.has(artifact.id)) bad(`${base}.id`, "must be unique");
        else ids.add(artifact.id);
        if (!safeRelativePath(artifact.verificationKeyPath)) bad(`${base}.verificationKeyPath`, "must be a relative path without . or .. segments");
        if (!(typeof artifact.sha256 === "string" && SHA256_RE.test(artifact.sha256))) bad(`${base}.sha256`, "must be a lowercase sha256");
        if (repoRoot && safeRelativePath(artifact.verificationKeyPath)) {
          const root = resolve(repoRoot);
          const path = resolve(root, artifact.verificationKeyPath);
          if (path !== root && !path.startsWith(root + sep)) bad(`${base}.verificationKeyPath`, "escapes the repository root");
          else if (!existsSync(path)) bad(`${base}.verificationKeyPath`, `not found under repository root: ${artifact.verificationKeyPath}`);
          else {
            const bytes = readFileSync(path);
            const digest = createHash("sha256").update(bytes).digest("hex");
            if (artifact.sha256 !== digest) bad(`${base}.sha256`, `does not match ${artifact.verificationKeyPath}`);
            const derived = artifactIdOf("rln", bytes);
            if (artifact.id !== derived) bad(`${base}.id`, `does not match verification-key content id ${derived}`);
          }
        }
      }
      if (record.artifacts.legacy !== null && !isArtifactId(record.artifacts.legacy)) bad("artifacts.legacy", "must be a bounded artifact id or null");
    }
    if (requireLive && !repoRoot) bad("artifacts", "live preflight requires --repo-root so hashes and content-derived ids are verified");
    if (repoRoot && record.security?.proofArtifacts === "trusted-ceremony") {
      const lockPath = resolve(repoRoot, "testdata/zk-artifacts.lock.json");
      let lock = null;
      try { lock = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* diagnosed below */ }
      if (lock?.trust !== "TRUSTED-CEREMONY" || lock?.ceremony?.status !== "complete") {
        bad("security.proofArtifacts", "claims trusted-ceremony but the pinned artifact lock does not record a completed trusted ceremony");
      }
    }
  }

  for (const field of ["created", "note"]) {
    if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") bad(field, "must be a string or null");
  }
  return { ok: errors.length === 0, errors };
}

export function loadDeploymentRecord(path) {
  let record;
  try { record = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${path}: invalid JSON (${error.message})`); }
  return record;
}

// Verify that the public pins describe bytes which actually exist at the immutable commit, not
// merely whatever happens to be in the controller's working tree today.
export function validatePinnedCheckout(record, { repoRoot }) {
  const errors = [];
  const bad = (field, problem) => errors.push({ field, problem });
  if (!repoRoot || !isObject(record?.services?.node) || !COMMIT_RE.test(record.services.node.commit || "")) return { ok: false, errors: [{ field: "services.node.commit", problem: "cannot verify an absent immutable commit" }] };
  const root = resolve(repoRoot);
  const commit = record.services.node.commit;
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: null });
  const commitCheck = git("cat-file", "-e", `${commit}^{commit}`);
  if (commitCheck.status !== 0) return { ok: false, errors: [{ field: "services.node.commit", problem: "is not a commit available in the controller checkout" }] };

  for (const path of ["bootnode/server.mjs", "gateway/gateway.mjs", "bootnode/heartbeat.mjs", "bootnode/deploy/bootstrap.sh"]) {
    if (git("cat-file", "-e", `${commit}:${path}`).status !== 0) bad("services", `pinned commit does not contain ${path}`);
  }
  if (record.security?.proofArtifacts === "trusted-ceremony") {
    const lockBytes = git("show", `${commit}:testdata/zk-artifacts.lock.json`);
    let lock = null;
    try { if (lockBytes.status === 0) lock = JSON.parse(lockBytes.stdout.toString("utf8")); } catch { /* diagnosed below */ }
    if (lock?.trust !== "TRUSTED-CEREMONY" || lock?.ceremony?.status !== "complete") {
      bad("security.proofArtifacts", "is not backed by a completed trusted ceremony in the pinned commit's artifact lock");
    }
  }
  for (let i = 0; i < (record.artifacts?.accepted || []).length; i++) {
    const artifact = record.artifacts.accepted[i];
    if (!safeRelativePath(artifact?.verificationKeyPath)) continue;
    const shown = git("show", `${commit}:${artifact.verificationKeyPath}`);
    const base = `artifacts.accepted[${i}]`;
    if (shown.status !== 0) { bad(`${base}.verificationKeyPath`, "is absent from the pinned service commit"); continue; }
    const digest = createHash("sha256").update(shown.stdout).digest("hex");
    if (artifact.sha256 !== digest) bad(`${base}.sha256`, "does not match the verification key at the pinned service commit");
    const derived = artifactIdOf("rln", shown.stdout);
    if (artifact.id !== derived) bad(`${base}.id`, `does not match pinned verification-key content id ${derived}`);
  }
  return { ok: errors.length === 0, errors };
}

function parseArgs(argv) {
  const flags = { requireLive: true, repoRoot: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--record") flags.record = argv[++i];
    else if (arg.startsWith("--record=")) flags.record = arg.slice(9);
    else if (arg === "--repo-root") flags.repoRoot = argv[++i];
    else if (arg.startsWith("--repo-root=")) flags.repoRoot = arg.slice(12);
    else if (arg === "--allow-pending") flags.requireLive = false;
    else if (arg === "--quiet") flags.quiet = true;
    else if (arg === "--help") flags.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return flags;
}

function main() {
  try {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) {
      console.log("usage: node deploy/v4/preflight.mjs --record <deployment.json> --repo-root <checkout> [--allow-pending] [--quiet]");
      return;
    }
    if (!flags.record) throw new Error("--record <deployment.json> is required");
    const record = loadDeploymentRecord(flags.record);
    const shape = validateDeploymentRecord(record, flags);
    const pin = shape.ok && flags.requireLive ? validatePinnedCheckout(record, flags) : { ok: true, errors: [] };
    const result = { ok: shape.ok && pin.ok, errors: [...shape.errors, ...pin.errors] };
    if (!result.ok) {
      const lines = result.errors.map((e) => `  ${e.field}: ${e.problem}`).join("\n");
      throw new Error(`${flags.record}: deployment preflight failed\n${lines}`);
    }
    if (!flags.quiet) console.log(`${flags.record}: ${flags.requireLive ? "deployable v4 record" : "valid v4 record"}`);
  } catch (error) {
    console.error(`v4-preflight: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
