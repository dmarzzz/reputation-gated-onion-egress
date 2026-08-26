import assert from "node:assert/strict";
import {
  ageParts,
  nextAgeRefreshDelay,
  snapshotFreshness,
} from "../docs/post/grove/freshness.js";

const OBSERVED_AT = "2026-08-25T16:15:00.000Z";
const observedMs = Date.parse(OBSERVED_AT);
const snapshot = {
  network: "sepolia",
  observedAt: OBSERVED_AT,
  source: { cadenceMinutes: 15 },
};
const checks = [];

function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
  console.log(`  ok   ${name}`);
}

check("relative age begins at just now", ageParts(OBSERVED_AT, observedMs + 59_999).long === "just now");
check("relative age advances at the next minute without a network fetch", ageParts(OBSERVED_AT, observedMs + 12 * 60_000 + 59_999).long === "12 min ago" && ageParts(OBSERVED_AT, observedMs + 13 * 60_000).long === "13 min ago");
check("relative age has bounded hour and day forms", ageParts(OBSERVED_AT, observedMs + 90 * 60_000).long === "1 hr ago" && ageParts(OBSERVED_AT, observedMs + 49 * 60 * 60_000).long === "2 days ago");
check("minute-boundary timer wakes just after the label changes", nextAgeRefreshDelay(OBSERVED_AT, observedMs + 12 * 60_000 + 59_000) === 1_025);

const fresh = snapshotFreshness(snapshot, { now: observedMs + 12 * 60_000 });
check("fresh signed snapshots expose a verified state and relative age", fresh.snapshotState === "Verified" && fresh.age.long === "12 min ago" && !fresh.stale);
check("three cadence intervals remain the explicit freshness boundary", !snapshotFreshness(snapshot, { now: observedMs + 45 * 60_000 }).stale && snapshotFreshness(snapshot, { now: observedMs + 46 * 60_000 }).stale);

const delayed = snapshotFreshness(snapshot, { now: observedMs + 12 * 60_000, refreshFailed: true });
check("refresh errors preserve and label the last verified live view", delayed.snapshotState === "Update delayed" && delayed.age.long === "12 min ago" && !delayed.stale);
const delayedStale = snapshotFreshness(snapshot, { now: observedMs + 46 * 60_000, refreshFailed: true });
check("a delayed live view becomes stale as its clock advances", delayedStale.snapshotState === "Stale" && delayedStale.stale);

const reference = snapshotFreshness(snapshot, { now: observedMs + 12 * 60_000, bundled: true });
check("the deploy-bundled fallback is always labeled as a reference", reference.snapshotState === "Reference" && reference.age.long === "12 min ago" && reference.stale);

console.log(`PASS: Grove freshness selftest (${checks.length} checks)`);
