# MedVault Relayer

A Node.js/Express relay service that accepts anonymous ZK proofs from the MedVault frontend, validates them, and submits `applyToTrial()` transactions to the MedVaultRegistry smart contract on Arbitrum Sepolia. This removes the gas burden from end users and enables truly gasless participation in medical research trials.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Deployment](#deployment)
  - [Railway](#railway)
  - [Manual VPS](#manual-vps)
- [Security](#security)
- [Monitoring](#monitoring)
- [License](#license)

---

## Overview

The MedVault Relayer sits between the zero-knowledge client application and the blockchain. Users generate ZK proofs (via Semaphore) locally in their browser, then send them to this relayer. The relayer:

1. Rate-limits requests (5 per minute per IP)
2. Validates the ZK proof off-chain before spending gas
3. Relays the transaction to the MedVaultRegistry contract
4. Returns the transaction hash to the client

---

## Features

| Feature | Description |
|---------|-------------|
| **ZK Proof Validation** | Validates Semaphore proofs off-chain using `@semaphore-protocol/proof` |
| **Rate Limiting** | 5 requests per IP per minute via `express-rate-limit` |
| **CORS Support** | Configurable origin restrictions |
| **Gasless UX** | End users never pay for gas |
| **Health Check** | `/health` endpoint for uptime monitoring |
| **Error Handling** | Structured error responses with HTTP status codes |

---

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js 5.x
- **Blockchain**: ethers.js 6.x
- **ZK**: @semaphore-protocol/proof 4.x
- **Rate Limiting**: express-rate-limit
- **Environment**: dotenv

---

## Prerequisites

- Node.js 18+ installed
- A funded wallet with ETH on Arbitrum Sepolia
- Alchemy or other Arbitrum Sepolia RPC access
- MedVaultRegistry contract address

---

## Local Development

### 1. Clone and install

```bash
git clone <repo-url>
cd medvault-relayer
npm install
```

### 2. Generate a relayer wallet

```node
const { ethers } = require("ethers");
const w = ethers.Wallet.createRandom();
console.log("address:", w.address);
console.log("privateKey:", w.privateKey);
```

### 3. Fund the wallet

Send Arbitrum Sepolia ETH to the generated address:
- [Alchemy Faucet](https://sepoliafaucet.com)
- [Triangle Platform Faucet](https://faucet.triangleplatform.com)

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env with your keys and addresses
```

### 5. Run

```bash
# Development
node index.js

# With auto-reload
npm install -g nodemon
nodemon index.js
```

Server runs on `http://localhost:8080` (or `PORT` from `.env`).

---

## Configuration

Environment variables (all required):

| Variable | Description | Example |
|----------|-------------|---------|
| `RELAYER_PRIVATE_KEY` | Hex private key of relayer wallet (keep secret!) | `0xabc123...` |
| `RPC_URL` | Arbitrum Sepolia RPC endpoint | `https://arb-sepolia.g.alchemy.com/v2/KEY` |
| `REGISTRY_ADDRESS` | MedVaultRegistry contract address | `0xdB1fC...` |
| `FRONTEND_URL` | Allowed CORS origin (`*` for any) | `https://medvault.io` or `*` |
| `PORT` | Server port (Railway overrides this) | `8080` |

### .env.example

```bash
# Relayer wallet - generate fresh, never reuse main wallet
RELAYER_PRIVATE_KEY=0x

# Arbitrum Sepolia RPC
RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY

# Contract address
REGISTRY_ADDRESS=0xdB1fC42e9E4e5afFcB12780C3201aFDCeab26FCA

# CORS origin
FRONTEND_URL=*

# Local port
PORT=8080
```

---

## API Reference

### Health Check

```http
GET /health
```

**Response:**
```json
{ "status": "ok" }
```

### Relay Apply

```http
POST /relay/apply
Content-Type: application/json
```

**Rate Limit:** 5 requests per minute per IP

**Request Body:**
```json
{
  "trialId": "1",
  "proof": {
    "merkleTreeDepth": 20,
    "merkleTreeRoot": "123456789...",
    "nullifier": "987654321...",
    "message": "0",
    "scope": "1",
    "points": ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]
  },
  "commitment": "123456789...",
  "permitRecipient": "0xRecipientAddress..."
}
```

**Success Response (200):**
```json
{
  "success": true,
  "txHash": "0xabc123..."
}
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| 400 | Missing required fields | trialId, proof, commitment, or permitRecipient missing |
| 400 | Invalid ZK proof | Off-chain proof verification failed |
| 429 | Too many requests | Rate limit exceeded (5 req/min) |
| 500 | Internal error | Blockchain or server error |

---

## Deployment

### Railway (Recommended)

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial relayer"
   git push origin main
   ```

2. **Create Railway project**
   - Go to [railway.app](https://railway.app)
   - New Project → Deploy from GitHub repo
   - Select your relayer repo

3. **Add environment variables**
   In Railway Dashboard → Variables:
   - `RELAYER_PRIVATE_KEY`
   - `RPC_URL`
   - `REGISTRY_ADDRESS`
   - `FRONTEND_URL`
   - `NODE_ENV=production`

4. **Deploy**
   - Railway auto-deploys on push
   - Default port is 8080
   - Public URL generated automatically

5. **Verify**
   ```bash
   curl https://your-app.up.railway.app/health
   ```

### Manual VPS (Ubuntu)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone <repo>
cd medvault-relayer
npm install --production

# Setup systemd service
sudo nano /etc/systemd/system/medvault-relayer.service
```

**Service file:**
```ini
[Unit]
Description=MedVault Relayer
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/medvault-relayer
ExecStart=/usr/bin/node index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable medvault-relayer
sudo systemctl start medvault-relayer
sudo systemctl status medvault-relayer
```

---

## Security

### Do's

- ✅ Generate a **fresh wallet** exclusively for relaying (never reuse personal wallets)
- ✅ Store `.env` file in Railway/GCP/AWS Secrets Manager, never in code
- ✅ Add rate limiting (already configured: 5 req/min per IP)
- ✅ Validate ZK proofs off-chain before spending gas
- ✅ Use HTTPS in production
- ✅ Restrict `FRONTEND_URL` to your domain in production

### Don'ts

- ❌ Never commit `.env` or private keys
- ❌ Never log private keys or full proofs in production
- ❌ Don't remove rate limiting on public endpoints
- ❌ Don't skip ZK proof validation (wastes gas on failed transactions)

### Key Management

For production, use a secrets manager instead of `.env`:

- **Railway**: Built-in variable encryption
- **AWS**: AWS Secrets Manager
- **GCP**: Secret Manager
- **Azure**: Key Vault

---

## Monitoring

### Uptime Check

Use UptimeRobot or Pingdom to monitor `/health`:
- URL: `https://your-app.up.railway.app/health`
- Expected: `{"status":"ok"}`
- Interval: 5 minutes

### Logs

**Railway:**
Dashboard → Deployments → View Logs

**VPS:**
```bash
sudo journalctl -u medvault-relayer -f
```

### Metrics to Watch

| Metric | Warning Threshold |
|--------|-------------------|
| Failed ZK validations | >10% of requests |
| 429 rate limit hits | >50% of requests |
| Relayer wallet balance | <0.001 ETH |

---

## Troubleshooting

### "Invalid ZK proof" errors

- Check proof format matches Semaphore v4 spec
- Verify `points` array has exactly 8 elements
- Ensure `merkleTreeRoot` is from current merkle tree

### "Insufficient funds" errors

- Fund relayer wallet with more Arbitrum Sepolia ETH
- Check balance: `https://sepolia.arbiscan.io/address/YOUR_ADDRESS`

### CORS errors from frontend

- Verify `FRONTEND_URL` matches your domain exactly
- Use `*` for development only

### Rate limit hit during testing

- Wait 60 seconds between requests
- Or whitelist your IP in `index.js`:
  ```js
  skip: (req) => req.ip === 'your.test.ip'
  ```

---

## License

MIT License — see [LICENSE](LICENSE) file.

---

## Related

- [MedVault Frontend](https://github.com/your-org/medvault-frontend)
- [MedVaultRegistry Contracts](https://github.com/your-org/medvault-contracts)
- [Semaphore Protocol](https://semaphore.pse.dev/)
