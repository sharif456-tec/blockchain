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

Set `NODE_API_TOKEN` to require `Authorization: Bearer <token>` (or `X-API-Key`) on state, block, transaction, proposal, anchor, and BDTCC settlement endpoints. `MAX_BODY_BYTES` and `REQUEST_TIMEOUT_MS` can limit request size and duration.

Example:

```bash
NODE_API_TOKEN=change-me PORT=8787 npm run node
```

Without `NODE_API_TOKEN`, the local dev node keeps its previous open-local behavior. Do not expose that configuration directly to the public internet.

## BDTC / BDTCC bridge runtime

The bridge supports BDTC settlement against a BDTCC-compatible JSON-RPC node. The repository deliberately does **not** invent BDTCC network parameters, genesis data, address prefixes, or credentials.

Configure a real RPC node with environment variables:

```bash
BDTCC_RPC_URL=http://127.0.0.1:8332
BDTCC_RPC_USERNAME=rpc-user
BDTCC_RPC_PASSWORD=rpc-password
BDTCC_NETWORK_ID=bdtcc
BDTCC_MIN_CONFIRMATIONS=6
BDTCC_DEPOSIT_ADDRESS=your-real-bdtcc-deposit-address
BDTC_TREASURY_ADDRESS=treasury
BDTC_RESERVE_ADDRESS=bdtc-reserve
BDTCC_SETTLEMENT_FILE=data/bdtcc-settlement.json
NODE_API_TOKEN=change-me
npm run node
```

RPC credentials remain server-side and are never returned by the API. The runtime endpoints are:

- `GET /bdtcc/status` — RPC/configuration and chain status
- `GET /bdtcc/withdrawals` — persisted withdrawal lifecycle records
- `POST /bdtcc/deposits/settle` — verify a BDTCC UTXO and credit BDTC on IIT-NETWORK
- `POST /bdtcc/withdrawals/broadcast` — broadcast a signed raw BDTCC transaction
- `POST /bdtcc/withdrawals/confirm` — refresh BDTCC confirmations and settle when the threshold is met
- `POST /bdtcc/withdrawals/mark-broadcast` — record an externally broadcast withdrawal
- `POST /bdtcc/withdrawals/mark-settled` — record an externally confirmed withdrawal

A deposit is accepted only after transaction-output, amount, address (when configured), unspent-output, and confirmation checks. Settlement state is persisted atomically so consumed deposits and withdrawal lifecycle records survive a node restart.

The bridge still requires a real BDTCC node and a valid signed raw transaction for live withdrawals. It cannot create a real external BDTCC transaction without the external chain's actual wallet/signing implementation.

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
