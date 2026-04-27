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
  "function eligibilityEngine() external view returns (address)",
  "function semaphore() external view returns (address)"
];

const SEMAPHORE_ABI = [
  "function verifyProof(uint256 groupId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof) external view returns (bool)",
  "function getMerkleTreeRoot(uint256 groupId) external view returns (uint256)",
];

const registry = new ethers.Contract(
  REGISTRY_ADDRESS,
  REGISTRY_ABI,
  relayerWallet
);

const semaphore = new ethers.Contract(
  SEMAPHORE_ADDRESS,
  SEMAPHORE_ABI,
  provider
);

app.get("/health", (_, res) => res.json({ status: "ok" }));

function toBigInt(value, fieldName) {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid ${fieldName}`);
  }
}

function extractErrorMessage(err) {
  if (!err) return "Unknown error";
  return err.shortMessage ?? err.reason ?? err.message ?? String(err);
}

async function runStartupChecks() {
  if (!ethers.isAddress(REGISTRY_ADDRESS) || !ethers.isAddress(SEMAPHORE_ADDRESS)) {
    throw new Error("REGISTRY_ADDRESS or SEMAPHORE_ADDRESS is not a valid address");
  }

  const network = await provider.getNetwork();
  if (network.chainId !== 421614n) {
    throw new Error(`Unexpected chainId ${network.chainId.toString()} (expected 421614)`);
  }

  const configuredSemaphore = await registry.semaphore();
  if (configuredSemaphore.toLowerCase() !== SEMAPHORE_ADDRESS.toLowerCase()) {
    throw new Error("SEMAPHORE_ADDRESS does not match registry.semaphore()");
  }

  const eligibilityEngine = await registry.eligibilityEngine();
  if (eligibilityEngine === ethers.ZeroAddress) {
    throw new Error("registry.eligibilityEngine() is zero address");
  }
}

app.post("/relay/apply", limiter, async (req, res) => {
  console.log("─────────────────────────────────────────");
  console.log("RAW PROOF RECEIVED:", JSON.stringify(req.body.proof, null, 2));

  try {
    const { trialId, proof: rawProof, commitment, permitRecipient } = req.body;

    if (!trialId || !rawProof || !commitment || !permitRecipient) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!ethers.isAddress(permitRecipient)) {
      return res.status(400).json({ error: "permitRecipient must be a valid address" });
    }
    const permitRecipientAddr = ethers.getAddress(permitRecipient);

    // ── Fetch groupId ─────────────────────────────────────────────
    const groupId = await registry.patientGroupId();

    // ── Parse proof ───────────────────────────────────────────────
    let proofForContract;
    try {
      proofForContract = {
        merkleTreeDepth: toBigInt(rawProof.merkleTreeDepth, "proof.merkleTreeDepth"),
        merkleTreeRoot: toBigInt(rawProof.merkleTreeRoot, "proof.merkleTreeRoot"),
        nullifier: toBigInt(rawProof.nullifier, "proof.nullifier"),
        message: toBigInt(rawProof.message, "proof.message"),
        scope: toBigInt(rawProof.scope, "proof.scope"),
        points: rawProof.points.map((p, idx) => toBigInt(p, `proof.points[${idx}]`))
      };
    } catch (e) {
      return res.status(400).json({ error: "Malformed proof fields: " + e.message });
    }

    // ── Verify consent signal (must match MedVaultRegistry + frontend semaphore.ts) ──
    // keccak256(abi.encodePacked(commitment, trialId, permitRecipient, "CONSENT"))
    const expectedMessage = BigInt(
      ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "address", "string"],
        [BigInt(commitment), BigInt(trialId), permitRecipientAddr, "CONSENT"]
      )
    ).toString();

    const proofMessage = BigInt(rawProof.message).toString();

    if (expectedMessage !== proofMessage) {
      return res.status(400).json({
        error: "Proof message does not encode consent for this trial"
      });
    }

    // ── Semaphore proof preflight (same core verification path) ──
    try {
      const isValidProof = await semaphore.verifyProof(groupId, proofForContract);
      if (!isValidProof) {
        return res.status(400).json({
          error: "Semaphore proof invalid (expired root, unknown root, nullifier reused, or malformed proof)"
        });
      }
    } catch (proofErr) {
      const reason = extractErrorMessage(proofErr);
      console.error("❌ Semaphore verifyProof failed:", reason);
      return res.status(400).json({ error: "Semaphore proof verification failed: " + reason });
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
        toBigInt(trialId, "trialId"),
        proofForContract,
        toBigInt(commitment, "commitment"),
        permitRecipientAddr
      );
      console.log("✅ staticCall passed");
    } catch (staticErr) {
      const reason = extractErrorMessage(staticErr);
      console.error("❌ Static call revert:", reason);
      return res.status(400).json({ error: "Contract would revert: " + reason });
    }

    // ── Send TX ───────────────────────────────────────────────────
    console.log(`Relaying: trialId=${trialId}`);
    const trialIdBI = toBigInt(trialId, "trialId");
    const commitmentBI = toBigInt(commitment, "commitment");
    const estimatedGas = await registry.applyToTrial.estimateGas(
      trialIdBI,
      proofForContract,
      commitmentBI,
      permitRecipientAddr
    );
    const gasLimit = (estimatedGas * 130n) / 100n;

    const tx = await registry.applyToTrial(
      trialIdBI,
      proofForContract,
      commitmentBI,
      permitRecipientAddr,
      { gasLimit }
    );

    const receipt = await tx.wait();

    console.log(`✅ TX confirmed: ${receipt.hash}`);

    res.json({ success: true, txHash: receipt.hash });

  } catch (err) {
    const reason = extractErrorMessage(err);
    console.error("❌ Relay error:", reason);
    res.status(500).json({ error: reason });
  }
});

const PORT = process.env.PORT || 3000;

runStartupChecks()
  .then(() => {
    app.listen(PORT, () => console.log(`Relayer running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Startup checks failed:", extractErrorMessage(err));
    process.exit(1);
  });
