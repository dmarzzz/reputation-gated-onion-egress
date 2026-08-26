const U64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
const decimalU64 = (value) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  try { const parsed = BigInt(value); return parsed <= U64_MAX ? parsed : null; } catch { return null; }
};
const decimalUint256 = (value) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) return null;
  try { const parsed = BigInt(value); return parsed <= UINT256_MAX ? parsed : null; } catch { return null; }
};
const isoMillis = (value) => {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
};

function validMetric(value, key, minimumCohort) {
  if (value?.status === "available") {
    return exactKeys(value, ["status", key]) && safeCount(value[key]) && value[key] >= minimumCohort;
  }
  return exactKeys(value, ["status", "suppressionReason"])
    && value.status === "suppressed" && value.suppressionReason === "minimum-cohort";
}

export function validPublicOnchain(value, observedAt) {
  const generatedAt = isoMillis(value?.generatedAt);
  const finalizedAt = isoMillis(value?.source?.finalizedBlockTime);
  if (!exactKeys(value, ["definition", "generatedAt", "delayHours", "minimumCohort", "source", "membership", "settlements", "enforcement"])
    || value.definition !== "finalized-v4-onchain-activity"
    || !Number.isFinite(generatedAt) || generatedAt < observedAt - 60 * 60_000 || generatedAt > observedAt + 5 * 60_000
    || !Number.isInteger(value.delayHours) || value.delayHours < 6
    || !Number.isInteger(value.minimumCohort) || value.minimumCohort < 5
    || !exactKeys(value.source, ["chainId", "finalizedBlock", "finalizedBlockHash", "finalizedBlockTime", "finalityConfirmations"])
    || value.source.chainId !== 11155111 || decimalU64(value.source.finalizedBlock) === null
    || !/^0x[0-9a-f]{64}$/.test(value.source.finalizedBlockHash) || !Number.isFinite(finalizedAt)
    || finalizedAt > generatedAt - value.delayHours * 60 * 60_000
    || !Number.isInteger(value.source.finalityConfirmations) || value.source.finalityConfirmations < 1
    || !exactKeys(value.membership, ["definition", "duplicatePolicy", "staked", "paid"])
    || value.membership.definition !== "active-commitments-at-finalized-block"
    || value.membership.duplicatePolicy !== "separate-contract-classes-no-cross-set-dedup"
    || !validMetric(value.membership.staked, "activeCommitments", value.minimumCohort)
    || !validMetric(value.membership.paid, "activeCommitments", value.minimumCohort)
    || !exactKeys(value.enforcement, ["definition", "staked", "paid"])
    || value.enforcement.definition !== "finalized-contract-slash-events"
    || !validMetric(value.enforcement.staked, "finalizedSlashes", value.minimumCohort)
    || !validMetric(value.enforcement.paid, "finalizedSlashes", value.minimumCohort)) return false;
  const settlement = value.settlements;
  if (settlement?.definition !== "finalized-settlement-linked-to-finalized-insert"
    || settlement?.attributionRule !== "signed-registrar-chain-verified-v1") return false;
  if (settlement.status === "unavailable") {
    return exactKeys(settlement, ["definition", "attributionRule", "status", "unavailableReason"])
      && settlement.unavailableReason === "attribution-unavailable";
  }
  if (settlement.status === "suppressed") {
    return exactKeys(settlement, ["definition", "attributionRule", "status", "suppressionReason"])
      && settlement.suppressionReason === "minimum-cohort";
  }
  return settlement.status === "available"
    && exactKeys(settlement, ["definition", "attributionRule", "status", "completedAccesses", "atomicValue", "asset"])
    && safeCount(settlement.completedAccesses) && settlement.completedAccesses >= value.minimumCohort
    && decimalUint256(settlement.atomicValue) > 0n
    && exactKeys(settlement.asset, ["chainId", "address", "decimals", "symbol"])
    && settlement.asset.chainId === value.source.chainId && /^0x[0-9a-fA-F]{40}$/.test(settlement.asset.address)
    && Number.isInteger(settlement.asset.decimals) && settlement.asset.decimals >= 0 && settlement.asset.decimals <= 255
    && typeof settlement.asset.symbol === "string" && /^[A-Za-z0-9._-]{1,16}$/.test(settlement.asset.symbol);
}

export function onchainSigningPayload(value) {
  return {
    definition: value.definition,
    generatedAt: value.generatedAt,
    delayHours: value.delayHours,
    minimumCohort: value.minimumCohort,
    source: { ...value.source },
    membership: {
      definition: value.membership.definition,
      duplicatePolicy: value.membership.duplicatePolicy,
      staked: { ...value.membership.staked },
      paid: { ...value.membership.paid },
    },
    settlements: {
      definition: value.settlements.definition,
      attributionRule: value.settlements.attributionRule,
      status: value.settlements.status,
      ...(value.settlements.status === "available" ? {
        completedAccesses: value.settlements.completedAccesses,
        atomicValue: value.settlements.atomicValue,
        asset: { ...value.settlements.asset },
      } : value.settlements.status === "suppressed"
        ? { suppressionReason: value.settlements.suppressionReason }
        : { unavailableReason: value.settlements.unavailableReason }),
    },
    enforcement: {
      definition: value.enforcement.definition,
      staked: { ...value.enforcement.staked },
      paid: { ...value.enforcement.paid },
    },
  };
}
