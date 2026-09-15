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

## Cloudflare Pages

The static network dashboard is in `public/` and is configured by `wrangler.toml`.

- Production URL: https://blockchain-567.pages.dev/
- Build command: none
- Output directory: `public`
- Git repository: https://github.com/sharif456-tec/blockchain

In Cloudflare Pages, connect the repository above and set the output directory to `public`. If the URL returns `404`, trigger a new deployment and confirm that the Pages project is using this repository and the `public` output directory.
