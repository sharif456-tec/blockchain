# IIT-NETWORK

IIT-NETWORK is a hybrid blockchain concept using a permissioned BFT execution layer and a public cryptographic anchor layer, with BDTC as the native settlement coin.

Read the full architecture in [HYBRID-BLOCKCHAIN-DESIGN.md](HYBRID-BLOCKCHAIN-DESIGN.md).

## Runnable prototype

This repository includes a dependency-free hybrid model with signed BDTC transactions, validator quorum certificates, deterministic state roots, and a mock public anchor layer.

```bash
npm test
npm run demo
```

The prototype is for devnet learning and integration tests. It is not production consensus software and does not handle real funds.

## Persistent node

Run a local node with durable JSON state:

```bash
npm run node
```

The node exposes `GET /health`, `GET /state`, `GET /blocks`, `GET /anchors`, `POST /transactions`, `POST /blocks/propose`, `POST /consensus/vote`, and the BDTCC settlement endpoints.

### Node security

Set `NODE_API_TOKEN` to require `Authorization: Bearer <token>` (or `X-API-Key`) on protected endpoints. `MAX_BODY_BYTES`, `REQUEST_TIMEOUT_MS`, and `PEER_TIMEOUT_MS` limit request sizes and request duration.

Production nodes require a real local validator identity and never generate or store the private keys of other validators.

## Independent validator consensus

The production node now separates the validator public registry from the local validator private key. Each validator process has:

- the public keys of the complete validator set;
- exactly one local validator private key;
- authenticated peer URLs for the other validators;
- the ability to sign only its own validator vote.

A proposer builds a block without manufacturing votes. It asks independent validator peers to verify and sign that exact block. The block is finalized only after a `2/3 + 1` validator quorum is collected and cryptographically verified.

Production environment requirements:

```bash
NODE_ENV=production
NODE_API_TOKEN=<real-secret>
PEER_API_TOKEN=<separate-real-peer-secret>
VALIDATOR_REGISTRY_FILE=<public-validator-registry-file>
NODE_VALIDATOR_ID=<this-node-validator-id>
NODE_VALIDATOR_PRIVATE_KEY_FILE=<this-node-private-key-file>
PEERS_FILE=<authenticated-validator-peer-file>
TREASURY_VALIDATOR_ID=<validator-id-authorized-for-settlement>
BDTCC_SETTLEMENT_FILE=<secure-persistent-path>
```

Public validator registry example (no private keys):

```json
[
  {"id":"validator-1","publicKey":"<real-public-key>"},
  {"id":"validator-2","publicKey":"<real-public-key>"},
  {"id":"validator-3","publicKey":"<real-public-key>"}
]
```

Peer file example (deployment configuration, not repository data):

```json
[
  {"id":"node-2","url":"https://validator-2.example","validatorId":"validator-2"},
  {"id":"node-3","url":"https://validator-3.example","validatorId":"validator-3"}
]
```

The `/consensus/vote` endpoint is authenticated with `PEER_API_TOKEN`. A production proposer rejects a non-local proposer identity, collects independent peer votes, verifies the quorum, and only then finalizes the block.

### Important limitation

This is a real multi-process validator-voting foundation, but it is **not yet a complete production BFT protocol**. It still needs durable distributed storage/replication, deterministic proposer rotation and view changes, equivocation detection/slashing policy, network-level replay protection, peer identity certificates/mTLS, crash recovery, state synchronization, mempool synchronization, monitoring, and a security audit before real funds are handled.

## Real BDTC / BDTCC bridge runtime

The bridge is fail-closed for production. It does **not** invent a BDTCC network ID, genesis hash, network magic, address prefix, wallet identity, treasury address, or credentials.

The current `sharif456-tec/bdtcc` repository identifies itself as a Bitcoin Core integration/staging tree and does not contain verified BDTCC-specific network parameters. Those values must therefore come from the actual BDTCC network implementation/operator, not from this repository.

For a production node, set:

```bash
BDTCC_RPC_URL=<real-bdtcc-rpc-url>
BDTCC_RPC_USERNAME=<real-rpc-username>
BDTCC_RPC_PASSWORD=<real-rpc-password>
BDTCC_NETWORK_ID=<real-network-id-from-bdtcc>
BDTCC_MIN_CONFIRMATIONS=<operator-defined-confirmation-policy>
BDTCC_DEPOSIT_ADDRESS=<real-bdtcc-deposit-address>
BDTC_TREASURY_ADDRESS=<real-iit-bdtc-treasury-account>
BDTC_RESERVE_ADDRESS=<real-iit-bdtc-reserve-account>
```

Do not commit real RPC passwords, private keys, deposit addresses, treasury credentials, or production `.env` files.

### Live settlement endpoints

- `GET /bdtcc/status` — BDTCC RPC and chain status
- `GET /bdtcc/withdrawals` — persisted withdrawal lifecycle records
- `POST /bdtcc/deposits/settle` — verify a real BDTCC UTXO and credit BDTC on IIT-NETWORK
- `POST /bdtcc/withdrawals/broadcast` — broadcast a real, already-signed BDTCC raw transaction
- `POST /bdtcc/withdrawals/confirm` — refresh real BDTCC confirmations
- `POST /bdtcc/withdrawals/mark-broadcast` — record an externally broadcast withdrawal
- `POST /bdtcc/withdrawals/mark-settled` — record an externally confirmed withdrawal

A deposit is accepted only after transaction-output, amount, address, unspent-output, and confirmation checks. Settlement state is persisted atomically so consumed deposits and withdrawal lifecycle records survive a restart.

The bridge does not manufacture external-chain transactions. A real BDTCC wallet/signing implementation must create and sign the withdrawal transaction before the broadcast endpoint is used.

## Cloudflare Pages

The static network dashboard is in `public/` and is configured by `wrangler.toml`.

- Production URL: https://blockchain-567.pages.dev/
- Build command: none
- Output directory: `public`
- Git repository: https://github.com/sharif456-tec/blockchain

In Cloudflare Pages, connect the repository above and set the output directory to `public`. If the URL returns `404`, trigger a new deployment and confirm that the Pages project is using this repository and the `public` output directory.

## Supabase integration

Supabase schema and a read-only Edge Function are included in `supabase/`.

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
supabase functions deploy network-status --no-verify-jwt
```

Function routes: `/network-status`, `/network-status/blocks`, `/network-status/anchors`, and `/network-status/accounts`. Keep the service role key server-side; never put the service role key in the Pages frontend.
