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
  "function applyToTrial(uint256 trialId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof, uint256 commitment, address permitRecipient) external"
];

const registry = new ethers.Contract(
  process.env.REGISTRY_ADDRESS,
  REGISTRY_ABI,
  relayerWallet
);

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.post("/relay/apply", limiter, async (req, res) => {
  try {
    const { trialId, proof, commitment, permitRecipient } = req.body;

    // Basic input validation
    if (!trialId || !proof || !commitment || !permitRecipient) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ZK proof validation — reject invalid proofs before spending any gas
    const isValid = await verifyProof(proof);
    if (!isValid) {
      console.warn(`Invalid proof rejected for trialId=${trialId}`);
      return res.status(400).json({ error: "Invalid ZK proof" });
    }

    console.log(`Relaying application: trialId=${trialId}, nullifier=${proof.nullifier}`);

    const tx = await registry.applyToTrial(
      trialId,
      proof,
      commitment,
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
