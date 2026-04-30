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

const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;
const SEMAPHORE_ADDRESS = process.env.SEMAPHORE_ADDRESS;

if (!REGISTRY_ADDRESS || !SEMAPHORE_ADDRESS) {
  throw new Error("Missing REGISTRY_ADDRESS or SEMAPHORE_ADDRESS in .env");
}

const REGISTRY_ABI = [
  "function stageAnonymousApply(uint256 trialId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof, uint256 commitment, address permitRecipient) external",
  "function finalizeAnonymousApply(uint256 trialId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof, uint256 commitment, address permitRecipient, bool decryptedEligible, bytes decryptSig) external",
  "function hasAppliedToTrial(uint256 trialId, uint256 nullifierHash) external view returns (bool)",
  "function patientGroupId() external view returns (uint256)",
  "function eligibilityEngine() external view returns (address)",
  "function semaphore() external view returns (address)"
];

const SEMAPHORE_ABI = [
  "function verifyProof(uint256 groupId, tuple(uint256 merkleTreeDepth, uint256 merkleTreeRoot, uint256 nullifier, uint256 message, uint256 scope, uint256[8] points) proof) external view returns (bool)",
  "function getMerkleTreeRoot(uint256 groupId) external view returns (uint256)",
];

const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, relayerWallet);

const semaphore = new ethers.Contract(SEMAPHORE_ADDRESS, SEMAPHORE_ABI, provider);

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

function findRevertData(err, depth = 0) {
  if (!err || depth > 10) return null;
  if (typeof err.data === "string" && err.data.startsWith("0x") && err.data.length > 10) {
    return err.data;
  }
  const fromNested =
    findRevertData(err.error, depth + 1) ||
    findRevertData(err.cause, depth + 1);
  if (fromNested) return fromNested;
  if (typeof err.info?.error?.data === "string" && err.info.error.data.startsWith("0x")) {
    return err.info.error.data;
  }
  return null;
}

const ERROR_STRING_IFACE = new ethers.Interface(["error Error(string)"]);

/** Attach decoded Error(string) or revert hex preview for CoFHE / custom errors. */
function formatContractRevert(err) {
  const base = extractErrorMessage(err);
  const data = findRevertData(err);
  if (!data) return base;
  try {
    const parsed = ERROR_STRING_IFACE.parseError(data);
    if (parsed && parsed.name === "Error") {
      return `${base} | Solidity Error(string): ${parsed.args[0]}`;
    }
  } catch {
    /* not Error(string) */
  }
  const byteLen = Math.floor((data.length - 2) / 2);
  return `${base} | revertData=${data.slice(0, 14)}… (${byteLen} bytes, likely CoFHE/TaskManager custom error — compare REGISTRY_ADDRESS + staged ctHash)`;
}

function normalizeDecryptSig(input) {
  if (input == null || input === "") throw new Error("decryptSignature is empty");
  if (typeof input === "string") {
    const t = input.trim();
    const s = t.startsWith("0x") ? t : "0x" + t;
    const bytes = ethers.getBytes(s);
    if (bytes.length === 0) throw new Error("decryptSignature decodes to 0 bytes");
    return ethers.hexlify(bytes);
  }
  if (Array.isArray(input)) {
    return ethers.hexlify(Uint8Array.from(input.map((n) => Number(n))));
  }
  throw new Error("decryptSignature must be hex string or numeric byte array");
}

function parseDecryptedEligible(val) {
  if (val === true) return true;
  if (val === false) return false;
  if (val === "true" || val === 1 || val === "1") return true;
  if (val === "false" || val === 0 || val === "0") return false;
  throw new Error("decryptedEligible must be JSON boolean true/false");
}

function parseProofFromBody(rawProof) {
  return {
    merkleTreeDepth: toBigInt(rawProof.merkleTreeDepth, "proof.merkleTreeDepth"),
    merkleTreeRoot: toBigInt(rawProof.merkleTreeRoot, "proof.merkleTreeRoot"),
    nullifier: toBigInt(rawProof.nullifier, "proof.nullifier"),
    message: toBigInt(rawProof.message, "proof.message"),
    scope: toBigInt(rawProof.scope, "proof.scope"),
    points: rawProof.points.map((p, idx) => toBigInt(p, `proof.points[${idx}]`))
  };
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

async function validateConsentAndSemaphoreProof(reqBody, preflightLabel) {
  const { trialId, proof: rawProof, commitment, permitRecipient } = reqBody;

  if (!trialId || !rawProof || !commitment || !permitRecipient) {
    return { error: "Missing required fields", status: 400 };
  }
  if (!ethers.isAddress(permitRecipient)) {
    return { error: "permitRecipient must be a valid address", status: 400 };
  }
  const permitRecipientAddr = ethers.getAddress(permitRecipient);

  const groupId = await registry.patientGroupId();

  let proofForContract;
  try {
    proofForContract = parseProofFromBody(rawProof);
  } catch (e) {
    return { error: "Malformed proof fields: " + e.message, status: 400 };
  }

  const expectedMessage = BigInt(
    ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "address", "string"],
      [BigInt(commitment), BigInt(trialId), permitRecipientAddr, "CONSENT"]
    )
  ).toString();

  const proofMessage = BigInt(rawProof.message).toString();

  if (expectedMessage !== proofMessage) {
    return { error: "Proof message does not encode consent for this trial", status: 400 };
  }

  try {
    const isValidProof = await semaphore.verifyProof(groupId, proofForContract);
    if (!isValidProof) {
      return {
        error: "Semaphore proof invalid (expired root, unknown root, nullifier reused, or malformed proof)",
        status: 400
      };
    }
  } catch (proofErr) {
    const reason = extractErrorMessage(proofErr);
    console.error(`❌ Semaphore verifyProof failed (${preflightLabel}):`, reason);
    return { error: "Semaphore proof verification failed: " + reason, status: 400 };
  }

  const alreadyApplied = await registry.hasAppliedToTrial(BigInt(trialId), BigInt(rawProof.nullifier));

  if (alreadyApplied) {
    return { error: "Already applied to this trial", status: 400 };
  }

  return {
    ok: true,
    trialIdBI: toBigInt(trialId, "trialId"),
    commitmentBI: toBigInt(commitment, "commitment"),
    permitRecipientAddr,
    proofForContract
  };
}

async function relayStage(req, res) {
  console.log("─────────────────────────────────────────");
  console.log("STAGE RAW PROOF:", JSON.stringify(req.body.proof, null, 2));

  try {
    const v = await validateConsentAndSemaphoreProof(req.body, "stage");
    if (v.error) return res.status(v.status).json({ error: v.error });

    try {
      await registry.stageAnonymousApply.staticCall(
        v.trialIdBI,
        v.proofForContract,
        v.commitmentBI,
        v.permitRecipientAddr
      );
      console.log("✅ stage staticCall passed");
    } catch (staticErr) {
      const reason = formatContractRevert(staticErr);
      console.error("❌ Stage static call revert:", reason);
      return res.status(400).json({ error: "Contract would revert: " + reason });
    }

    const estimatedGas = await registry.stageAnonymousApply.estimateGas(
      v.trialIdBI,
      v.proofForContract,
      v.commitmentBI,
      v.permitRecipientAddr
    );
    const gasLimit = (estimatedGas * 130n) / 100n;

    const tx = await registry.stageAnonymousApply(
      v.trialIdBI,
      v.proofForContract,
      v.commitmentBI,
      v.permitRecipientAddr,
      { gasLimit }
    );

    const receipt = await tx.wait();
    console.log(`✅ Stage TX confirmed: ${receipt.hash}`);

    res.json({ success: true, txHash: receipt.hash });
  } catch (err) {
    const reason = extractErrorMessage(err);
    console.error("❌ Stage relay error:", reason);
    res.status(500).json({ error: reason });
  }
}

async function relayFinalize(req, res) {
  console.log("─────────────────────────────────────────");
  console.log("FINALIZE RAW PROOF:", JSON.stringify(req.body.proof, null, 2));

  try {
    const { decryptedEligible, decryptSignature } = req.body;
    if (decryptedEligible === undefined || decryptSignature === undefined) {
      return res.status(400).json({ error: "Missing decryptedEligible or decryptSignature" });
    }

    let decElig;
    let sigBytes;
    try {
      decElig = parseDecryptedEligible(decryptedEligible);
      sigBytes = normalizeDecryptSig(decryptSignature);
    } catch (normErr) {
      return res.status(400).json({ error: normErr.message || String(normErr) });
    }

    console.log(
      `finalize meta: decryptedEligible=${decElig} sigBytes=${Math.floor((sigBytes.length - 2) / 2)} registry=${REGISTRY_ADDRESS}`
    );

    const v = await validateConsentAndSemaphoreProof(req.body, "finalize");
    if (v.error) return res.status(v.status).json({ error: v.error });

    try {
      await registry.finalizeAnonymousApply.staticCall(
        v.trialIdBI,
        v.proofForContract,
        v.commitmentBI,
        v.permitRecipientAddr,
        decElig,
        sigBytes
      );
      console.log("✅ finalize staticCall passed");
    } catch (staticErr) {
      const reason = formatContractRevert(staticErr);
      console.error("❌ Finalize static call revert:", reason);
      return res.status(400).json({ error: "Contract would revert: " + reason });
    }

    const estimatedGas = await registry.finalizeAnonymousApply.estimateGas(
      v.trialIdBI,
      v.proofForContract,
      v.commitmentBI,
      v.permitRecipientAddr,
      decElig,
      sigBytes
    );
    const gasLimit = (estimatedGas * 130n) / 100n;

    const tx = await registry.finalizeAnonymousApply(
      v.trialIdBI,
      v.proofForContract,
      v.commitmentBI,
      v.permitRecipientAddr,
      decElig,
      sigBytes,
      { gasLimit }
    );

    const receipt = await tx.wait();
    console.log(`✅ Finalize TX confirmed: ${receipt.hash}`);

    res.json({ success: true, txHash: receipt.hash });
  } catch (err) {
    const reason = extractErrorMessage(err);
    console.error("❌ Finalize relay error:", reason);
    res.status(500).json({ error: reason });
  }
}

app.post("/relay/apply-stage", limiter, relayStage);
app.post("/relay/apply-finalize", limiter, relayFinalize);

/** @deprecated Use /relay/apply-stage then /relay/apply-finalize */
app.post("/relay/apply", limiter, (_, res) => {
  res.status(410).json({
    error: "Deprecated: use POST /relay/apply-stage then POST /relay/apply-finalize (eligible-only CoFHE finalize gate)."
  });
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
