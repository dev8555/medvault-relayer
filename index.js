const express = require("express");
const { ethers } = require("ethers");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { verifyProof } = require("@semaphore-protocol/proof");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

// Rate limiting — 5 requests per IP per minute
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many requests, slow down" }
});

// Load relayer wallet from env (NEVER commit this)
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

// MedVaultRegistry ABI — only the function you need
const REGISTRY_ABI = [
  "function applyToTrial(uint256 trialId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof, uint256 commitment, address permitRecipient) external",
  "function hasAppliedToTrial(uint256 trialId, uint256 nullifierHash) external view returns (bool)"
];

const registry = new ethers.Contract(
  process.env.REGISTRY_ADDRESS,
  REGISTRY_ABI,
  relayerWallet
);

// ── Helper: deserialize proof fields from JSON strings → BigInt ──────────────
// Proof fields are serialized as strings over HTTP (JSON can't handle BigInt).
// @semaphore-protocol/proof and ethers both require BigInt internally.
function deserializeProof(raw) {
  return {
    merkleTreeDepth: Number(raw.merkleTreeDepth),
    merkleTreeRoot: BigInt(raw.merkleTreeRoot),
    nullifier:      BigInt(raw.nullifier),
    message:        BigInt(raw.message),
    scope:          BigInt(raw.scope),
    points:         raw.points.map(p => BigInt(p))
  };
}

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.post("/relay/apply", limiter, async (req, res) => {
  try {
    const { trialId, proof: rawProof, commitment, permitRecipient } = req.body;

    // ── 1. Basic input validation ────────────────────────────────────────────
    if (!trialId || !rawProof || !commitment || !permitRecipient) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ── 2. Deserialize BigInts before any proof work ─────────────────────────
    let proof;
    try {
      proof = deserializeProof(rawProof);
    } catch (e) {
      return res.status(400).json({ error: "Malformed proof fields: " + e.message });
    }

    // ── 3. ZK proof validation — reject invalid proofs before spending gas ───
    const isValid = await verifyProof(proof);
    if (!isValid) {
      console.warn(`Invalid proof rejected for trialId=${trialId}`);
      return res.status(400).json({ error: "Invalid ZK proof" });
    }

    // ── 4. Nullifier reuse check — give clean error instead of on-chain revert
    const alreadyApplied = await registry.hasAppliedToTrial(
      BigInt(trialId),
      proof.nullifier
    );
    if (alreadyApplied) {
      return res.status(400).json({ error: "Already applied to this trial" });
    }

    // ── 5. Dry-run staticCall — surfaces the exact revert reason if any ──────
    try {
      await registry.applyToTrial.staticCall(
        BigInt(trialId),
        proof,
        BigInt(commitment),
        permitRecipient
      );
    } catch (staticErr) {
      const reason = staticErr.reason ?? staticErr.data ?? staticErr.message;
      console.error("Static call revert:", reason);
      return res.status(400).json({ error: "Contract would revert: " + reason });
    }

    // ── 6. Broadcast the real transaction ────────────────────────────────────
    console.log(`Relaying application: trialId=${trialId}, nullifier=${proof.nullifier}`);

    const tx = await registry.applyToTrial(
      BigInt(trialId),
      proof,
      BigInt(commitment),
      permitRecipient,
      { gasLimit: 2_000_000 }
    );

    const receipt = await tx.wait();
    console.log(`TX confirmed: ${receipt.hash}`);

    res.json({ success: true, txHash: receipt.hash });

  } catch (err) {
    console.error("Relay error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Relayer running on port ${PORT}`));
