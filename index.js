const express = require("express");
const { ethers } = require("ethers");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many requests, slow down" }
});

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

// ✅ ENV-BASED ADDRESSES
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;
const SEMAPHORE_ADDRESS = process.env.SEMAPHORE_ADDRESS;

if (!REGISTRY_ADDRESS || !SEMAPHORE_ADDRESS) {
  throw new Error("Missing REGISTRY_ADDRESS or SEMAPHORE_ADDRESS in .env");
}

const REGISTRY_ABI = [
  "function applyToTrial(uint256 trialId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof, uint256 commitment, address permitRecipient) external",
  "function hasAppliedToTrial(uint256 trialId, uint256 nullifierHash) external view returns (bool)",
  "function patientGroupId() external view returns (uint256)",
  "function eligibilityEngine() external view returns (address)"
];

const SEMAPHORE_FULL_ABI = [
  "function getMerkleTreeRoot(uint256 groupId) external view returns (uint256)",
  "function groups(uint256 groupId) external view returns (uint256 merkleTreeDuration)",
  "function getMerkleTreeCreationDate(uint256 groupId, uint256 root) external view returns (uint256)"
];

const registry = new ethers.Contract(
  REGISTRY_ADDRESS,
  REGISTRY_ABI,
  relayerWallet
);

const semaphore = new ethers.Contract(
  SEMAPHORE_ADDRESS,
  SEMAPHORE_FULL_ABI,
  provider
);

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.post("/relay/apply", limiter, async (req, res) => {
  console.log("─────────────────────────────────────────");
  console.log("RAW PROOF RECEIVED:", JSON.stringify(req.body.proof, null, 2));

  try {
    const { trialId, proof: rawProof, commitment, permitRecipient } = req.body;

    if (!trialId || !rawProof || !commitment || !permitRecipient) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ── Fetch groupId ─────────────────────────────────────────────
    const groupId = await registry.patientGroupId();

    // ── 🚨 HARD EXPIRY CHECK (BEFORE EVERYTHING) ──────────────────
    try {
      const root = BigInt(rawProof.merkleTreeRoot);

      const rootCreatedAt = await semaphore.getMerkleTreeCreationDate(groupId, root);
      const duration = await semaphore.groups(groupId);

      const expiresAt = Number(rootCreatedAt) + Number(duration);
      const now = Math.floor(Date.now() / 1000);

      console.log("Root created at:", Number(rootCreatedAt));
      console.log("Duration:", Number(duration));
      console.log("Expires at:", expiresAt);
      console.log("Now:", now);

      if (now > expiresAt) {
        console.log("❌ ROOT EXPIRED - ABORTING EARLY");
        return res.status(400).json({
          error: "Merkle root expired",
          expiresAt,
          now
        });
      }

    } catch (e) {
      console.error("❌ Expiry check failed:", e.message);
      return res.status(400).json({ error: "Failed to validate merkle root expiry" });
    }

    console.log("─────────────────────────────────────────");

    // ── Parse proof ───────────────────────────────────────────────
    let proofForContract;
    try {
      proofForContract = {
        merkleTreeDepth: Number(rawProof.merkleTreeDepth),
        merkleTreeRoot: rawProof.merkleTreeRoot.toString(),
        nullifier: rawProof.nullifier.toString(),
        message: rawProof.message.toString(),
        scope: rawProof.scope.toString(),
        points: rawProof.points.map(p => p.toString())
      };
    } catch (e) {
      return res.status(400).json({ error: "Malformed proof fields: " + e.message });
    }

    // ── Verify consent signal ─────────────────────────────────────
    const expectedMessage = BigInt(
      ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "string"],
        [BigInt(commitment), BigInt(trialId), "CONSENT"]
      )
    ).toString();

    const proofMessage = BigInt(rawProof.message).toString();

    if (expectedMessage !== proofMessage) {
      return res.status(400).json({
        error: "Proof message does not encode consent for this trial"
      });
    }

    // ── Already applied check ─────────────────────────────────────
    const alreadyApplied = await registry.hasAppliedToTrial(
      BigInt(trialId),
      BigInt(rawProof.nullifier)
    );

    if (alreadyApplied) {
      return res.status(400).json({ error: "Already applied to this trial" });
    }

    // ── Static call ───────────────────────────────────────────────
    try {
      await registry.applyToTrial.staticCall(
        BigInt(trialId),
        proofForContract,
        BigInt(commitment),
        permitRecipient
      );
      console.log("✅ staticCall passed");
    } catch (staticErr) {
      const reason = staticErr.reason ?? staticErr.data ?? staticErr.message;
      console.error("❌ Static call revert:", reason);
      return res.status(400).json({ error: "Contract would revert: " + reason });
    }

    // ── Send TX ───────────────────────────────────────────────────
    console.log(`Relaying: trialId=${trialId}`);

    const tx = await registry.applyToTrial(
      BigInt(trialId),
      proofForContract,
      BigInt(commitment),
      permitRecipient,
      { gasLimit: 2_000_000 }
    );

    const receipt = await tx.wait();

    console.log(`✅ TX confirmed: ${receipt.hash}`);

    res.json({ success: true, txHash: receipt.hash });

  } catch (err) {
    console.error("❌ Relay error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Relayer running on port ${PORT}`));
