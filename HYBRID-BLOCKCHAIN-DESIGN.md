# IIT-NETWORK Hybrid Blockchain Design

## লক্ষ্য

IIT-NETWORK হবে একটি hybrid blockchain যেখানে ব্যবসায়িক transaction দ্রুত এবং privacy-aware permissioned network-এ execute হবে, কিন্তু public chain-এ নিয়মিত cryptographic anchor প্রকাশ করে যে কেউ integrity যাচাই করতে পারবে। Native coin: `BDTC`।

এই design enterprise payment, identity, supply-chain এবং public audit-এর জন্য তৈরি। এটি প্রথমে testnet হিসেবে চালু করা উচিত; production value ব্যবহারের আগে security audit এবং formal protocol review প্রয়োজন।

## মূল ধারণা

```text
Users / Wallets
      |
      v
API Gateway + Policy Layer
      |
      v
Private Execution Shards
(permissioned validators + BFT finality)
      |
      | Merkle state root + block commitment
      v
Anchor Relayers
      |
      v
Public Anchor Chain
(public timestamp + independent verification)
```

### Layer A: Private execution network

- পরিচিত validator organization-দের নিয়ে permissioned committee।
- HotStuff বা Tendermint-style BFT consensus।
- 2/3 voting quorum ছাড়া block final হবে না।
- 2-5 second target block time।
- প্রয়োজনে customer, institution বা region অনুযায়ী execution shard।
- transaction payload encrypted হতে পারে; hash, amount policy এবং state commitment validator-রা যাচাই করবে।

### Layer B: Public anchor network

- প্রতি নির্দিষ্ট সংখ্যক private block-এর `checkpointRoot` public chain-এ publish হবে।
- Public layer transaction execution করবে না; timestamp এবং tamper-evidence দেবে।
- Public verifier Merkle proof দিয়ে private block বা account state যাচাই করতে পারবে।
- Anchor relayer trusted হলেও chain history পরিবর্তন করতে পারবে না, কারণ root publicভাবে প্রকাশিত।

## Hybrid finality

Private block finality দুই ধাপে হবে:

1. **Soft finality**: validator quorum block-এ vote করে এবং committee certificate তৈরি করে।
2. **Hard audit finality**: checkpoint root public anchor chain-এ confirmed হলে সংশ্লিষ্ট private history-এর external timestamp স্থির হয়।

Public anchor unavailable হলেও private network transaction process চালাতে পারবে, তবে checkpoint backlog জমবে এবং operator alert তৈরি হবে। Public anchor আবার online হলে pending roots ordered batch হিসেবে publish হবে।

## BDTC ledger

- Symbol: `BDTC`
- Base unit: `bdu`
- `1 BDTC = 100,000,000 bdu`
- সব amount integer base unit-এ থাকবে।
- Account model: address, balance, nonce, permissions, optional compliance profile।
- Transaction fee BDTC-তে দিতে হবে। Fee-এর একটি অংশ validator reward pool-এ যাবে, বাকি অংশ burn করা যেতে পারে governance vote অনুযায়ী।
- Genesis allocation, validator set এবং chain ID immutable genesis file-এ থাকবে।

### Transaction envelope

```json
{
  "chainId": "iit-bdtc-testnet-1",
  "version": 1,
  "from": "bdtc:sender",
  "to": "bdtc:recipient",
  "amount": 125000000,
  "fee": 1000,
  "nonce": 4,
  "payloadHash": "sha256:...",
  "signature": "ed25519:..."
}
```

Private payload আলাদা encrypted object হিসেবে রাখা যাবে। Signature অবশ্যই canonical transaction fields-এর উপর হবে, transport metadata-এর উপর নয়।

## Block model

```json
{
  "chainId": "iit-bdtc-testnet-1",
  "height": 1204,
  "previousHash": "sha256:...",
  "transactionsRoot": "sha256:...",
  "stateRoot": "sha256:...",
  "checkpointRoot": "sha256:...",
  "timestamp": 1760000000,
  "proposer": "validator:...",
  "quorumCertificate": "bft:..."
}
```

Node block গ্রহণ করবে কেবল যখন:

1. chain ID এবং height সঠিক;
2. previous hash canonical tip-এর সাথে মিলে;
3. transaction signature, nonce, balance, fee এবং policy valid;
4. resulting state root পুনরায় হিসাব করে মেলে;
5. validator quorum certificate বৈধ;
6. proposer active validator set-এর সদস্য।

## Validator architecture

- **Validator**: transaction validate, block propose, vote এবং state replicate করে।
- **Observer**: full state read করে, vote করে না।
- **Anchor relayer**: checkpoint root public chain-এ publish করে।
- **Gateway**: rate limit, authentication, policy এবং wallet API দেয়; consensus trust boundary-এর বাইরে থাকবে।
- **Indexer**: finalized events থেকে search এবং explorer data তৈরি করে।

Validator committee stake, organization identity এবং governance approval-এর combination-এ নির্বাচিত হবে। একই validator দুই conflicting block-এ vote করলে evidence জমা করে stake slash করা যাবে।

## Cross-layer verification

Public verifier-এর কাছে এগুলো যথেষ্ট হবে:

- public anchor transaction;
- private checkpoint root;
- block header;
- Merkle proof;
- relevant transaction বা account state।

Verifier-কে private transaction contents বা validator database trust করতে হবে না। Cross-chain asset transfer হলে lock/mint বা burn/release proof ব্যবহার করতে হবে; সাধারণ message relay দিয়ে asset mint করা যাবে না।

## Security rules

- Production private key কখনও API server-এ রাখা যাবে না; HSM বা offline signer ব্যবহার করতে হবে।
- Chain ID এবং domain-separated signatures replay attack আটকাবে।
- Validator-to-validator channel mutual TLS বা signed peer identity দিয়ে সুরক্ষিত হবে।
- Mempool ও API-তে size limit, rate limit এবং nonce reservation থাকবে।
- Anchor relayer একা history rewrite করতে পারবে না।
- Private data-এর জন্য encryption key rotation, access log এবং deletion policy থাকতে হবে।
- Upgrade transaction-এ timelock, quorum vote এবং rollback plan থাকতে হবে।

## Suggested technology stack

- Execution node: Go
- Consensus: audited BFT implementation, নতুন consensus নিজে থেকে নয়
- Cryptography: Ed25519 বা network-approved audited signature library
- State database: RocksDB বা PostgreSQL-backed event/index layer
- Public anchor: EVM-compatible chain অথবা dedicated public notarization chain
- API: gRPC internally, REST externally
- Observability: Prometheus, Grafana, structured audit logs
- Deployment: Docker Compose for devnet, Kubernetes for testnet

## Development roadmap

### Phase 1: Local devnet

- single process বা 4 local validators;
- deterministic genesis;
- signed BDTC transfers;
- BFT simulator;
- state root এবং Merkle proof;
- mock public anchor.

### Phase 2: Private testnet

- 4-7 independent validators;
- real quorum certificate;
- encrypted payloads;
- validator rotation এবং slashing simulation;
- public anchor testnet integration;
- faucet এবং explorer.

### Phase 3: Public testnet

- documented genesis and chain ID;
- external validator onboarding;
- disaster recovery and snapshot restore;
- adversarial network tests;
- third-party security audit;
- bug bounty.

### Phase 4: Mainnet decision

Mainnet launch কেবল তখনই করা উচিত যখন protocol specification, implementation, key ceremony, economics, governance এবং audit report প্রকাশিত থাকবে। Testnet BDTC-এর monetary value থাকা উচিত নয়।

## প্রথম implementation priority

1. deterministic genesis এবং `chainId` যোগ করা;
2. current in-memory chain-এর বদলে state transition engine তৈরি করা;
3. Merkle `stateRoot` এবং `transactionsRoot` যোগ করা;
4. append-only peer block গ্রহণের বদলে BFT vote flow তৈরি করা;
5. mock anchor service দিয়ে checkpoint publish এবং proof verification করা;
6. integration tests: conflicting proposal, replay, validator loss, anchor outage এবং recovery।
