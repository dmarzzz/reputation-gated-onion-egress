/* global AbortController, atob, crypto, document, navigator, TextEncoder, window */

import { splitHistory, windowedHistory } from "./history.js";
import { nextAgeRefreshDelay, snapshotFreshness } from "./freshness.js";
import { grovePatchCount } from "./visual-model.js";
import { onchainSigningPayload, renderOnchainLedger, validPublicOnchain } from "./onchain.js";

const LIVE_URL = "/api/v2/data/grove/sepolia/head";
const FALLBACK_URL = "/grove/network.fallback.json";
const NETWORK = "sepolia";
const FETCH_TIMEOUT_MS = 9_000;
const POLL_INTERVAL_MS = 5 * 60 * 1_000;
const PUBLIC_KEY_RAW = "377fAP+xg5aKu7AzQa7yB3NMpFpquPSIgs3TcQtVSYI=";
const KEY_ID = "grove-2026-08";
const stage = document.getElementById("network-stage");
const canvas = document.getElementById("network-canvas");
const fallback = document.getElementById("canopy-fallback");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let mounted = false;
let sceneController = null;
let sceneSeed = null;
let publicKeyPromise = null;
let lastLiveObservedAt = null;
let loadActive = false;
let pollTimer = 0;
let ageTimer = 0;
let lastLoadFinishedAt = 0;
let currentSnapshot = null;
let currentView = { bundled: false, refreshFailed: false };

const exactKeys = (value, keys) => value && typeof value === "object"
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const safeCount = (value) => Number.isInteger(value) && value >= 0 && value <= 100_000;
const decimalU64 = (value) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  try { const parsed = BigInt(value); return parsed <= (1n << 64n) - 1n ? parsed : null; } catch { return null; }
};
const isoMillis = (value) => {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
};

function validRelayWindow(value, hours, relay) {
  const available = value?.status === "available";
  const start = isoMillis(value?.windowStart);
  const end = isoMillis(value?.windowEnd);
  const base = exactKeys(value, available
    ? ["status", "windowHours", "windowStart", "windowEnd", "reportingNodes", "roundedBytes"]
    : ["status", "windowHours", "windowStart", "windowEnd", "reportingNodes", "suppressionReason"])
    && value.windowHours === hours
    && Number.isFinite(start) && Number.isFinite(end)
    && end - start === hours * 60 * 60_000
    && end <= isoMillis(relay.generatedAt) - relay.delayHours * 60 * 60_000
    && safeCount(value.reportingNodes);
  if (!base) return false;
  if (available) {
    const rounded = decimalU64(value.roundedBytes);
    const bucket = decimalU64(relay.rounding.bucketBytes);
    return value.reportingNodes >= relay.minimumCohort && rounded !== null && bucket !== null
      && rounded > 0n && rounded % bucket === 0n;
  }
  return value.status === "suppressed"
    && ["minimum-cohort", "unavailable"].includes(value.suppressionReason)
    && value.roundedBytes === undefined;
}

function validRelay(value, observedAt) {
  const generatedAt = isoMillis(value?.generatedAt);
  return exactKeys(value, ["definition", "unit", "generatedAt", "delayHours", "minimumCohort", "rounding", "windows"])
    && value.definition === "payload-bytes-relayed"
    && value.unit === "bytes"
    && Number.isFinite(generatedAt)
    && generatedAt >= observedAt - 60 * 60_000
    && generatedAt <= observedAt + 5 * 60_000
    && value.delayHours >= 6
    && Number.isInteger(value.minimumCohort) && value.minimumCohort >= 5
    && exactKeys(value.rounding, ["method", "bucketBytes"])
    && value.rounding.method === "ceiling" && decimalU64(value.rounding.bucketBytes) > 0n
    && exactKeys(value.windows, ["sixHour", "twentyFourHour"])
    && validRelayWindow(value.windows.sixHour, 6, value)
    && validRelayWindow(value.windows.twentyFourHour, 24, value);
}

function validSnapshot(value) {
  const observedAt = isoMillis(value?.observedAt);
  const v2 = value?.schema === "shade-tree-public-grove-v2";
  const hasOnchain = v2 && value?.onchain !== undefined;
  const history = value?.history;
  const historyValid = Array.isArray(history)
    && history.length >= 1
    && history.length <= 97
    && history.every((sample, index) => {
      const at = isoMillis(sample?.at);
      const prior = index > 0 ? isoMillis(history[index - 1].at) : -Infinity;
      return exactKeys(sample, ["at", "announced"])
        && Number.isFinite(at)
        && at > prior
        && at <= observedAt
        && safeCount(sample.announced);
    });
  return value
    && exactKeys(value, v2
      ? (hasOnchain
        ? ["schema", "network", "observedAt", "source", "nodes", "growth", "privacy", "history", "relay", "onchain", "attestation"]
        : ["schema", "network", "observedAt", "source", "nodes", "growth", "privacy", "history", "relay", "attestation"])
      : ["schema", "network", "observedAt", "source", "nodes", "growth", "privacy", "history", "attestation"])
    && (value.schema === "shade-tree-public-grove-v1" || v2)
    && value.network === NETWORK
    && Number.isFinite(observedAt)
    && observedAt <= Date.now() + 5 * 60_000
    && exactKeys(value.source, ["bootnodeReachable", "directoryVerified", "definition", "cadenceMinutes"])
    && value.source?.bootnodeReachable === true
    && value.source?.directoryVerified === true
    && value.source?.definition === "announced-within-ttl"
    && value.source?.cadenceMinutes === 15
    && exactKeys(value.nodes, ["announced"])
    && safeCount(value.nodes.announced)
    && exactKeys(value.growth, ["windowHours", "announcedNodeHours", "samples"])
    && value.growth.windowHours === 24
    && (value.growth.announcedNodeHours === null || (Number.isInteger(value.growth.announcedNodeHours) && value.growth.announcedNodeHours >= 0 && value.growth.announcedNodeHours <= 2_400_000))
    && Number.isInteger(value.growth.samples)
    && value.growth.samples === history?.length
    && exactKeys(value.privacy, ["identities", "locations", "traffic", "stablePositions", "futureSharedStatsMinReportingNodes"])
    && value.privacy.identities === false
    && value.privacy.locations === false
    && value.privacy.traffic === false
    && value.privacy.stablePositions === false
    && value.privacy.futureSharedStatsMinReportingNodes === 5
    && historyValid
    && isoMillis(history.at(-1).at) === observedAt
    && (!v2 || validRelay(value.relay, observedAt))
    && (!hasOnchain || validPublicOnchain(value.onchain, observedAt))
    && exactKeys(value.attestation, ["algorithm", "keyId", "signature"])
    && value.attestation.algorithm === "Ed25519"
    && value.attestation.keyId === KEY_ID
    && /^[A-Za-z0-9+/]{86}==$/.test(value.attestation.signature);
}

function signingPayload(snapshot) {
  const payload = {
    schema: snapshot.schema,
    network: snapshot.network,
    observedAt: snapshot.observedAt,
    source: {
      bootnodeReachable: snapshot.source.bootnodeReachable,
      directoryVerified: snapshot.source.directoryVerified,
      definition: snapshot.source.definition,
      cadenceMinutes: snapshot.source.cadenceMinutes,
    },
    nodes: { announced: snapshot.nodes.announced },
    growth: {
      windowHours: snapshot.growth.windowHours,
      announcedNodeHours: snapshot.growth.announcedNodeHours,
      samples: snapshot.growth.samples,
    },
    privacy: {
      identities: snapshot.privacy.identities,
      locations: snapshot.privacy.locations,
      traffic: snapshot.privacy.traffic,
      stablePositions: snapshot.privacy.stablePositions,
      futureSharedStatsMinReportingNodes: snapshot.privacy.futureSharedStatsMinReportingNodes,
    },
    history: snapshot.history.map((sample) => ({ at: sample.at, announced: sample.announced })),
  };
  if (snapshot.schema === "shade-tree-public-grove-v2") {
    payload.relay = {
      definition: snapshot.relay.definition,
      unit: snapshot.relay.unit,
      generatedAt: snapshot.relay.generatedAt,
      delayHours: snapshot.relay.delayHours,
      minimumCohort: snapshot.relay.minimumCohort,
      rounding: {
        method: snapshot.relay.rounding.method,
        bucketBytes: snapshot.relay.rounding.bucketBytes,
      },
      windows: {
        sixHour: { ...snapshot.relay.windows.sixHour },
        twentyFourHour: { ...snapshot.relay.windows.twentyFourHour },
      },
    };
    if (snapshot.onchain !== undefined) payload.onchain = onchainSigningPayload(snapshot.onchain);
  }
  return payload;
}

function base64Bytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function verifyAttestation(snapshot) {
  try {
    publicKeyPromise ||= crypto.subtle.importKey(
      "raw",
      base64Bytes(PUBLIC_KEY_RAW),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "Ed25519" },
      await publicKeyPromise,
      base64Bytes(snapshot.attestation.signature),
      new TextEncoder().encode(JSON.stringify(signingPayload(snapshot))),
    );
  } catch {
    return false;
  }
}

async function fetchSnapshot(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "default",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
    const value = await response.json();
    if (!validSnapshot(value) || !await verifyAttestation(value)) throw new Error("invalid public snapshot");
    return value;
  } finally {
    window.clearTimeout(timeout);
  }
}

function hashSeed(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFrom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function drawFallback(snapshot) {
  fallback.querySelectorAll(".fallback-grove").forEach((element) => element.remove());
  const count = snapshot.nodes.announced;
  const patchCount = grovePatchCount(count, "high");
  const random = randomFrom(hashSeed(`${snapshot.observedAt}:${count}`));
  const trees = document.createDocumentFragment();
  for (let index = 0; index < patchCount; index += 1) {
    const vertical = 1 - (2 * (index + 0.5)) / patchCount;
    const radius = Math.sqrt(1 - vertical * vertical);
    const angle = index * 2.399963 + random() * 0.22;
    const horizontal = Math.cos(angle) * radius;
    const depth = Math.sin(angle) * radius;
    const grove = document.createElement("span");
    grove.className = "fallback-grove";
    grove.dataset.announcedIdentity = "";
    grove.style.setProperty("--x", `${50 + horizontal * 39}%`);
    grove.style.setProperty("--y", `${50 - vertical * 39}%`);
    grove.style.setProperty("--scale", (0.58 + (depth + 1) * 0.32).toFixed(2));
    grove.style.setProperty("--alpha", (0.34 + (depth + 1) * 0.31).toFixed(2));
    grove.style.setProperty("--depth", String(Math.round(2 + (depth + 1) * 4)));
    grove.style.setProperty("--turn", `${Math.round((random() - 0.5) * 13)}deg`);
    trees.append(grove);
  }
  fallback.append(trees);
}

function setText(selector, value) {
  document.querySelectorAll(selector).forEach((element) => { element.textContent = value; });
}

function observationLabel(iso) {
  const date = new Date(iso);
  const month = date.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const day = date.getUTCDate();
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day} · ${hour}:${minute} UTC`;
}

function formatPayloadBytes(value) {
  const bytes = BigInt(value);
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let scale = 1n, unit = 0;
  while (bytes >= scale * 1024n && unit < units.length - 1) { scale *= 1024n; unit += 1; }
  const whole = bytes / scale;
  if (unit === 0 || whole >= 10n) return `${(bytes + scale / 2n) / scale} ${units[unit]}`;
  const tenths = (bytes * 10n + scale / 2n) / scale;
  return `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
}

function renderRelay(snapshot) {
  const row = document.querySelector("[data-relay-row]");
  const window24 = snapshot.relay?.windows?.twentyFourHour;
  const visible = snapshot.schema === "shade-tree-public-grove-v2" && window24?.status === "available";
  if (!row) return;
  row.hidden = !visible;
  if (!visible) return;
  setText("[data-relay-value]", formatPayloadBytes(window24.roundedBytes));
  setText("[data-relay-coverage]", `${window24.reportingNodes} reporting nodes · ≥${snapshot.relay.minimumCohort} required`);
}

function updateFreshness() {
  if (!currentSnapshot) return;
  const status = snapshotFreshness(currentSnapshot, currentView);
  document.body.classList.toggle("is-stale", status.stale);
  document.body.classList.toggle("is-unavailable", currentView.refreshFailed);
  setText("[data-view-age]", status.age.short);
  setText("[data-snapshot-state]", status.snapshotState);
  setText("[data-view-state]", status.viewState);
}

function scheduleAgeRefresh() {
  window.clearTimeout(ageTimer);
  if (!currentSnapshot) return;
  ageTimer = window.setTimeout(() => {
    updateFreshness();
    scheduleAgeRefresh();
  }, nextAgeRefreshDelay(currentSnapshot.observedAt));
}

function showUnavailable() {
  currentSnapshot = null;
  currentView = { bundled: false, refreshFailed: true };
  window.clearTimeout(ageTimer);
  document.body.classList.remove("is-stale");
  document.body.classList.add("is-unavailable");
  setText("[data-view-state]", "Public view unavailable");
  setText("[data-view-age]", "Unavailable");
  setText("[data-snapshot-state]", "Unavailable");
  setText("[data-view-time]", "Unavailable");
  setText("[data-network]", "Unavailable");
  renderOnchainLedger(document, {});
}

function drawHistory(snapshot) {
  const chart = document.querySelector("[data-history-chart]");
  const line = document.querySelector("[data-history-line]");
  const area = document.querySelector("[data-history-area]");
  const pointGroup = document.querySelector("[data-history-points]");
  if (!chart || !line || !area || !pointGroup) return;

  const observedAt = Date.parse(snapshot.observedAt);
  const startAt = observedAt - 24 * 60 * 60_000;
  const samplesInWindow = windowedHistory(snapshot.history, snapshot.observedAt);
  const samples = samplesInWindow.length ? samplesInWindow : [snapshot.history.at(-1)];
  const counts = samples.map((sample) => sample.announced);
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  const chartTop = 32;
  const chartBottom = 220;
  const spread = Math.max(1, high - low);
  const yLow = Math.max(0, low - spread * 0.18);
  const yHigh = high + spread * 0.18;
  const x = (sample) => Math.max(0, Math.min(960, ((Date.parse(sample.at) - startAt) / (24 * 60 * 60_000)) * 960));
  const y = (sample) => chartBottom - ((sample.announced - yLow) / Math.max(1, yHigh - yLow)) * (chartBottom - chartTop);
  const segments = splitHistory(samples, snapshot.source.cadenceMinutes);
  const expectedSamples = Math.floor((24 * 60) / snapshot.source.cadenceMinutes) + 1;
  const coverage = Math.min(100, Math.round((samples.length / expectedSamples) * 100));
  const lineParts = [];
  const areaParts = [];

  segments.forEach((segment) => {
    if (segment.length === 1) {
      const pointX = x(segment[0]);
      lineParts.push(`M${Math.max(0, pointX - 5).toFixed(1)} ${y(segment[0]).toFixed(1)}H${Math.min(960, pointX + 5).toFixed(1)}`);
      return;
    }
    const points = segment.map((sample) => `${x(sample).toFixed(1)} ${y(sample).toFixed(1)}`);
    lineParts.push(`M${points.join("L")}`);
    areaParts.push(`M${x(segment[0]).toFixed(1)} ${chartBottom}L${points.join("L")}L${x(segment.at(-1)).toFixed(1)} ${chartBottom}Z`);
  });

  line.setAttribute("d", lineParts.join(""));
  area.setAttribute("d", areaParts.join(""));
  pointGroup.replaceChildren();
  const stride = Math.max(1, Math.ceil(samples.length / 18));
  samples.forEach((sample, index) => {
    if (index !== samples.length - 1 && index % stride !== 0) return;
    const point = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    point.setAttribute("class", "history-point");
    point.setAttribute("cx", x(sample).toFixed(1));
    point.setAttribute("cy", y(sample).toFixed(1));
    point.setAttribute("r", index === samples.length - 1 ? "4" : "2.5");
    pointGroup.append(point);
  });

  setText("[data-history-low]", String(low));
  setText("[data-history-high]", String(high));
  setText("[data-history-samples]", String(samples.length));
  setText("[data-history-coverage]", `${coverage}%`);
  chart.setAttribute(
    "aria-label",
    `${samples.length} signed aggregate ${samples.length === 1 ? "sample" : "samples"} in the 24-hour window, ${coverage}% coverage. Low ${low}, high ${high}, latest ${samples.at(-1).announced}.`,
  );
}

async function renderSnapshot(snapshot, { bundled = false } = {}) {
  const count = snapshot.nodes.announced;
  const cadence = Number(snapshot.source.cadenceMinutes) || 15;
  currentSnapshot = snapshot;
  currentView = { bundled, refreshFailed: false };
  updateFreshness();
  scheduleAgeRefresh();
  setText("[data-node-count]", String(count));
  setText("[data-node-hours]", snapshot.growth?.announcedNodeHours == null ? "n/a" : String(snapshot.growth.announcedNodeHours));
  setText("[data-view-time]", observationLabel(snapshot.observedAt));
  setText("[data-network]", snapshot.network);
  setText("[data-snapshot-cadence]", `${cadence} min`);
  drawHistory(snapshot);
  renderRelay(snapshot);
  renderOnchainLedger(document, snapshot);
  drawFallback(snapshot);

  if (!mounted) {
    mounted = true;
    try {
      await mountScene(snapshot);
    } catch {
      stage.classList.remove("is-live");
    }
  } else if (sceneController && sceneSeed !== `${snapshot.observedAt}:${count}`) {
    sceneController.updateSnapshot(snapshot);
    sceneSeed = `${snapshot.observedAt}:${count}`;
  }
}

async function mountScene(snapshot) {
  if (navigator.connection?.saveData) return;
  const lowQuality = window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
  const probe = document.createElement("canvas");
  const context = probe.getContext("webgl2", { failIfMajorPerformanceCaveat: true })
    || probe.getContext("webgl", { failIfMajorPerformanceCaveat: true });
  if (!context) return;
  context.getExtension("WEBGL_lose_context")?.loseContext();
  const { mountNetworkGrove } = await import("./scene.js");
  sceneController = mountNetworkGrove({
    stage,
    canvas,
    snapshot,
    reducedMotion,
    quality: lowQuality ? "low" : "high",
  });
  sceneSeed = `${snapshot.observedAt}:${snapshot.nodes.announced}`;
}

function scheduleNextLoad() {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => {
    if (document.hidden) {
      scheduleNextLoad();
      return;
    }
    load();
  }, POLL_INTERVAL_MS);
}

async function load() {
  if (loadActive) return;
  loadActive = true;
  // This pulse represents the browser checking the same-origin signed aggregate. The browser
  // never contacts the onion bootnode. A separate pulse is used when observedAt proves that the
  // upstream observer published a new census.
  document.body.classList.add("is-checking");
  stage.classList.add("is-querying");
  sceneController?.beginQuery();
  try {
    const snapshot = await fetchSnapshot(LIVE_URL);
    const freshCensus = lastLiveObservedAt !== null && lastLiveObservedAt !== snapshot.observedAt;
    await renderSnapshot(snapshot);
    sceneController?.finishQuery(snapshot, { freshCensus });
    lastLiveObservedAt = snapshot.observedAt;
  } catch {
    sceneController?.failQuery();
    if (currentSnapshot && !currentView.bundled) {
      currentView = { bundled: false, refreshFailed: true };
      updateFreshness();
      scheduleAgeRefresh();
    } else {
      try {
        await renderSnapshot(await fetchSnapshot(FALLBACK_URL), { bundled: true });
      } catch {
        showUnavailable();
      }
    }
  } finally {
    loadActive = false;
    lastLoadFinishedAt = Date.now();
    document.body.classList.remove("is-checking");
    stage.classList.remove("is-querying");
    scheduleNextLoad();
  }
}

function onPageHide() {
  window.clearTimeout(pollTimer);
  window.clearTimeout(ageTimer);
}

function onPageShow(event) {
  if (!event.persisted) return;
  updateFreshness();
  load();
}

function onVisibilityChange() {
  if (document.hidden) return;
  updateFreshness();
  if (Date.now() - lastLoadFinishedAt >= POLL_INTERVAL_MS) load();
}

if (window.location.protocol !== "file:") {
  load();
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibilityChange);
}
