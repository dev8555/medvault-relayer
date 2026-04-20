const express = require("express");
const { ethers } = require("ethers");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { verifyProof } = require("@semaphore-protocol/proof");
require("dotenv").config();

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many requests, slow down" }
});

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

const REGISTRY_ABI = [
  "function applyToTrial(uint256 trialId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof, uint256 commitment, address permitRecipient) external",
  "function hasAppliedToTrial(uint256 trialId, uint256 nullifierHash) external view returns (bool)",
  "function patientGroupId() external view returns (uint256)"
];

const SEMAPHORE_ABI = [
  "function getMerkleTreeDuration(uint256 groupId) external view returns (uint256)",
  "function getMerkleTreeRoot(uint256 groupId) external view returns (uint256)"
];

const registry = new ethers.Contract(
  process.env.REGISTRY_ADDRESS,
  REGISTRY_ABI,
  relayerWallet
);

const semaphore = new ethers.Contract(
  "0x8A1fd199516489B0Fb7153EB5f075cDAC83c693D",
  SEMAPHORE_ABI,
  relayerWallet
);

app.get("/health", (_, res) => res.json({ status: "ok" }));

app.post("/relay/apply", limiter, async (req, res) => {
  console.log("─────────────────────────────────────────");
  console.log("RAW PROOF RECEIVED:", JSON.stringify(req.body.proof, null, 2));
  console.log("merkleTreeRoot type:", typeof req.body.proof?.merkleTreeRoot);

  try {
    const { trialId, proof: rawProof, commitment, permitRecipient } = req.body;

    if (!trialId || !rawProof || !commitment || !permitRecipient) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ── Group + Merkle root debug ─────────────────────────────────────────────
    const groupId = await registry.patientGroupId();
    const merkleRoot = await semaphore.getMerkleTreeRoot(groupId);
    const duration = await semaphore.getMerkleTreeDuration(groupId);

    console.log("CONTRACT patientGroupId:  ", groupId.toString());
    console.log("PROOF scope:              ", rawProof.scope.toString());
    console.log("scope == groupId:         ", groupId.toString() === rawProof.scope.toString());
    console.log("─────────────────────────────────────────");
    console.log("ON-CHAIN merkle root:     ", merkleRoot.toString());
    console.log("PROOF merkle root:        ", rawProof.merkleTreeRoot.toString());
    console.log("roots match:              ", merkleRoot.toString() === rawProof.merkleTreeRoot.toString());
    console.log("merkle root duration(s):  ", duration.toString());
    console.log("─────────────────────────────────────────");
    // ─────────────────────────────────────────────────────────────────────────

    let proofForVerify;
    try {
      proofForVerify = {
        merkleTreeDepth: Number(rawProof.merkleTreeDepth),
        merkleTreeRoot:  BigInt(rawProof.merkleTreeRoot),
        nullifier:       BigInt(rawProof.nullifier),
        message:         BigInt(rawProof.message),
        scope:           BigInt(rawProof.scope),
        points:          rawProof.points.map(p => BigInt(p))
      };
    } catch (e) {
      return res.status(400).json({ error: "Malformed proof fields: " + e.message });
    }

    const proofForContract = {
      merkleTreeDepth: Number(rawProof.merkleTreeDepth),
      merkleTreeRoot:  rawProof.merkleTreeRoot.toString(),
      nullifier:       rawProof.nullifier.toString(),
      message:         rawProof.message.toString(),
      scope:           rawProof.scope.toString(),
      points:          rawProof.points.map(p => p.toString())
    };

    // TEMP: skipping verifyProof to isolate the error source
    // const isValid = await verifyProof(proofForVerify);
    // if (!isValid) {
    //   return res.status(400).json({ error: "Invalid ZK proof" });
    // }
    console.log("Skipping verifyProof for debug");

    const alreadyApplied = await registry.hasAppliedToTrial(
      BigInt(trialId),
      BigInt(rawProof.nullifier)
    );
    if (alreadyApplied) {
      return res.status(400).json({ error: "Already applied to this trial" });
    }

    console.log("trialId:        ", trialId);
    console.log("commitment:     ", commitment);
    console.log("permitRecipient:", permitRecipient);

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

    console.log(`Relaying: trialId=${trialId}, nullifier=${rawProof.nullifier}`);

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
