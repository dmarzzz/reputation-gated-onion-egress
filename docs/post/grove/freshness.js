export function ageParts(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return { short: "now", long: "just now", minutes };
  if (minutes < 60) return { short: `${minutes}m`, long: `${minutes} min ago`, minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { short: `${hours}h`, long: `${hours} hr ago`, minutes };
  const days = Math.floor(hours / 24);
  return { short: `${days}d`, long: `${days} days ago`, minutes };
}

export function snapshotFreshness(snapshot, {
  now = Date.now(),
  bundled = false,
  refreshFailed = false,
} = {}) {
  const age = ageParts(snapshot.observedAt, now);
  const cadence = Number(snapshot.source?.cadenceMinutes) || 15;
  const stale = bundled || age.minutes > cadence * 3;

  if (bundled) {
    return {
      age,
      stale,
      snapshotState: "Reference",
    };
  }

  if (refreshFailed) {
    return {
      age,
      stale,
      snapshotState: stale ? "Stale" : "Update delayed",
    };
  }

  return {
    age,
    stale,
    snapshotState: stale ? "Stale" : "Verified",
  };
}

export function nextAgeRefreshDelay(iso, now = Date.now()) {
  const observedAt = Date.parse(iso);
  if (!Number.isFinite(observedAt)) return 60_000;
  const elapsed = now - observedAt;
  if (elapsed < 0) return Math.max(1_000, Math.min(60_000, -elapsed + 25));
  return Math.max(1_000, 60_000 - (elapsed % 60_000) + 25);
}
