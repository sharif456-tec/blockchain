# IIT-NETWORK

IIT-NETWORK is a hybrid blockchain concept using a permissioned BFT execution layer and a public cryptographic anchor layer, with BDTC as the native settlement coin.

Read the full architecture in [HYBRID-BLOCKCHAIN-DESIGN.md](HYBRID-BLOCKCHAIN-DESIGN.md).

## Runnable prototype

This repository includes a dependency-free hybrid model with signed BDTC transactions, permissioned validator quorum certificates, deterministic state roots, and a mock public anchor layer.

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

The node exposes `GET /health`, `GET /state`, `GET /blocks`, `GET /anchors`, `POST /transactions`, `POST /blocks/propose`, and `POST /anchors/verify`.

### Node security

Set `NODE_API_TOKEN` to require `Authorization: Bearer <token>` (or `X-API-Key`) on protected endpoints. `MAX_BODY_BYTES` and `REQUEST_TIMEOUT_MS` can limit request size and duration.

For production, `NODE_API_TOKEN` is mandatory. Production mode also refuses to generate ephemeral validator keys.

## Real BDTC / BDTCC bridge runtime

The bridge is fail-closed for production. It does **not** invent a BDTCC network ID, genesis hash, network magic, address prefix, wallet identity, treasury address, or credentials.

The current `sharif456-tec/bdtcc` repository identifies itself as a Bitcoin Core integration/staging tree and does not contain verified BDTCC-specific network parameters. Those values must therefore come from the actual BDTCC network implementation/operator, not from this repository.

For a production node, set:

```bash
NODE_ENV=production
NODE_API_TOKEN=<real-secret>
BDTCC_RPC_URL=<real-bdtcc-rpc-url>
BDTCC_RPC_USERNAME=<real-rpc-username>
BDTCC_RPC_PASSWORD=<real-rpc-password>
BDTCC_NETWORK_ID=<real-network-id-from-bdtcc>
BDTCC_MIN_CONFIRMATIONS=<operator-defined-confirmation-policy>
BDTCC_DEPOSIT_ADDRESS=<real-bdtcc-deposit-address>
BDTC_TREASURY_ADDRESS=<real-iit-bdtc-treasury-account>
BDTC_RESERVE_ADDRESS=<real-iit-bdtc-reserve-account>
VALIDATORS_FILE=<absolute-or-deployment-relative-path-to-secure-validator-json>
TREASURY_VALIDATOR_ID=<real-validator-id>
BDTCC_SETTLEMENT_FILE=<secure-persistent-path>
```

`VALIDATORS_FILE` must contain at least three independently provisioned validator identities with their real public/private signing keys. The server refuses to generate temporary validator keys in production. Keep the file outside the public repository and protect it with the deployment's secret/key-management system.

Example structure only (values intentionally omitted):

```json
[
  {"id":"<validator-1-id>","publicKey":"<real-public-key>","privateKey":"<real-private-key>"},
  {"id":"<validator-2-id>","publicKey":"<real-public-key>","privateKey":"<real-private-key>"},
  {"id":"<validator-3-id>","publicKey":"<real-public-key>","privateKey":"<real-private-key>"}
]
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

## Important production boundary

This repository now refuses fake BDTCC production configuration, but that does not by itself make the consensus layer a production blockchain. Independent validator processes, authenticated peer-to-peer networking, real quorum verification across nodes, deterministic proposer rotation, HSM/KMS-backed signing, distributed durable storage, monitoring, backups, key rotation, and security auditing are still required before handling real funds.

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

Function routes: `/network-status`, `/network-status/blocks`, `/network-status/anchors`, and `/network-status/accounts`. Keep the service role key server-side; never put it in the Pages frontend.
