import assert from "node:assert/strict";
import { onchainSigningPayload, validPublicOnchain } from "../docs/post/grove/onchain.js";

const observedAt = Date.parse("2026-08-25T12:00:00.000Z");
const onchain = {
  definition: "finalized-v4-onchain-activity",
  generatedAt: "2026-08-25T12:00:00.000Z",
  delayHours: 6,
  minimumCohort: 5,
  source: {
    chainId: 11155111,
    finalizedBlock: "12345678",
    finalizedBlockHash: `0x${"ab".repeat(32)}`,
    finalizedBlockTime: "2026-08-25T06:00:00.000Z",
    finalityConfirmations: 64,
  },
  membership: {
    definition: "active-commitments-at-finalized-block",
    duplicatePolicy: "separate-contract-classes-no-cross-set-dedup",
    staked: { status: "available", activeCommitments: 12 },
    paid: { status: "suppressed", suppressionReason: "minimum-cohort" },
  },
  settlements: {
    definition: "finalized-settlement-linked-to-finalized-insert",
    attributionRule: "signed-registrar-chain-verified-v1",
    status: "unavailable",
    unavailableReason: "attribution-unavailable",
  },
  enforcement: {
    definition: "finalized-contract-slash-events",
    staked: { status: "suppressed", suppressionReason: "minimum-cohort" },
    paid: { status: "available", finalizedSlashes: 7 },
  },
};

assert.equal(validPublicOnchain(onchain, observedAt), true);
assert.deepEqual(onchainSigningPayload(onchain), onchain, "browser reconstructs the exact signed onchain fields");
assert.equal(validPublicOnchain({ ...onchain, delayHours: 5 }, observedAt), false, "browser rejects an unsafe delay");

console.log("PASS: Grove browser validates and reconstructs signed onchain aggregates");
