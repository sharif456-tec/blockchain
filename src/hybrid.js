import { digest, sign, verify } from './crypto.js';

export const CHAIN_ID = 'iit-bdtc-testnet-1';
export const BDU_PER_BDTC = 100_000_000;

function merkleRoot(items) {
  if (items.length === 0) return digest('empty');
  let layer = items.map(item => digest(item));
  while (layer.length > 1) {
    const next = [];
    for (let index = 0; index < layer.length; index += 2) next.push(digest(layer[index] + (layer[index + 1] || layer[index])));
    layer = next;
  }
  return layer[0];
}

function transactionPayload(transaction) {
  const { signature: ignored, ...payload } = transaction;
  return payload;
}

function stateRoot(state) { return digest(Object.fromEntries([...state].sort())); }

function blockHeader(block) {
  return { chainId: block.chainId, height: block.height, previousHash: block.previousHash, transactionsRoot: block.transactionsRoot, stateRoot: block.stateRoot, proposer: block.proposer };
}

export function quorumFor(validatorCount) { return Math.floor((validatorCount * 2) / 3) + 1; }

export class HybridNetwork {
  constructor({ validators, initialBalances = {}, anchorInterval = 2 }) {
    if (!validators?.length || validators.length < 3) throw new Error('At least 3 validators are required');
    this.validators = new Map(validators.map(validator => [validator.id, validator]));
    if (this.validators.size !== validators.length) throw new Error('Validator IDs must be unique');
    this.anchorInterval = anchorInterval;
    this.state = new Map(Object.entries(initialBalances));
    this.nonces = new Map();
    this.blocks = [];
    this.anchors = [];
    this.pending = [];
  }

  balanceOf(address) { return this.state.get(address) || 0; }
  nonceOf(address) { return this.nonces.get(address) || 0; }

  submitTransaction(transaction) {
    if (transaction.chainId !== CHAIN_ID) throw new Error('Wrong chain ID');
    if (!transaction.from || !transaction.to || transaction.from === transaction.to) throw new Error('Invalid account pair');
    if (!Number.isSafeInteger(transaction.amount) || transaction.amount <= 0) throw new Error('Amount must be a positive integer');
    if (!Number.isSafeInteger(transaction.fee) || transaction.fee < 0) throw new Error('Invalid fee');
    if (transaction.nonce !== this.nonceOf(transaction.from)) throw new Error('Invalid nonce');
    if (!transaction.publicKey || !verify(transactionPayload(transaction), transaction.signature, transaction.publicKey)) throw new Error('Invalid transaction signature');
    if (this.balanceOf(transaction.from) < transaction.amount + transaction.fee) throw new Error('Insufficient balance');
    if (this.pending.some(candidate => digest(candidate) === digest(transaction))) throw new Error('Duplicate pending transaction');
    if (this.pending.some(candidate => candidate.from === transaction.from && candidate.nonce === transaction.nonce)) throw new Error('Conflicting pending nonce');
    this.pending.push(transaction);
    return transaction;
  }

  buildBlock(proposerId) {
    const proposer = this.validators.get(proposerId);
    if (!proposer) throw new Error('Unknown proposer');
    const transactions = [...this.pending];
    const workingState = new Map(this.state);
    const workingNonces = new Map(this.nonces);
    for (const transaction of transactions) this.applyTransaction(transaction, workingState, workingNonces);
    const header = {
      chainId: CHAIN_ID,
      height: this.blocks.length + 1,
      previousHash: this.blocks.at(-1)?.hash || digest('genesis'),
      transactionsRoot: merkleRoot(transactions),
      stateRoot: stateRoot(workingState),
      proposer: proposerId
    };
    return { ...header, transactions, hash: digest(header) };
  }

  voteForBlock(block, validatorId) {
    const validator = this.validators.get(validatorId);
    if (!validator?.privateKey) throw new Error(`Private key unavailable for validator ${validatorId}`);
    if (!this.verifyBlockProposal(block)) throw new Error('Invalid block proposal');
    return { validator: validatorId, signature: sign(block.hash, validator.privateKey) };
  }

  verifyBlockProposal(block) {
    if (block.chainId !== CHAIN_ID || block.height !== this.blocks.length + 1) return false;
    if (!this.validators.has(block.proposer)) return false;
    if (block.previousHash !== (this.blocks.at(-1)?.hash || digest('genesis'))) return false;
    if (!Array.isArray(block.transactions) || block.transactionsRoot !== merkleRoot(block.transactions)) return false;
    if (digest(blockHeader(block)) !== block.hash) return false;
    const workingState = new Map(this.state);
    const workingNonces = new Map(this.nonces);
    try { for (const transaction of block.transactions) this.applyTransaction(transaction, workingState, workingNonces); } catch { return false; }
    return stateRoot(workingState) === block.stateRoot;
  }

  finalizeWithVotes(block, votes) {
    if (!Array.isArray(votes) || votes.length < quorumFor(this.validators.size)) throw new Error('Insufficient validator quorum');
    const unique = new Map();
    for (const vote of votes) {
      const validator = this.validators.get(vote.validator);
      if (!validator || unique.has(vote.validator) || !verify(block.hash, vote.signature, validator.publicKey)) throw new Error('Invalid validator vote');
      unique.set(vote.validator, vote);
    }
    if (unique.size < quorumFor(this.validators.size)) throw new Error('Insufficient validator quorum');
    const workingState = new Map(this.state);
    const workingNonces = new Map(this.nonces);
    for (const transaction of block.transactions) this.applyTransaction(transaction, workingState, workingNonces);
    return this.finalizeBlock({ ...block, quorumCertificate: [...unique.values()] }, workingState, workingNonces);
  }

  proposeBlock(proposerId) {
    const block = this.buildBlock(proposerId);
    const votes = [...this.validators.values()].map(validator => this.voteForBlock(block, validator.id));
    return this.finalizeWithVotes(block, votes);
  }

  applyTransaction(transaction, state = this.state, nonces = this.nonces) {
    if (!transaction.publicKey || !verify(transactionPayload(transaction), transaction.signature, transaction.publicKey)) throw new Error('Invalid transaction signature');
    const required = transaction.amount + transaction.fee;
    const balance = state.get(transaction.from) || 0;
    if (nonces.get(transaction.from) !== undefined && transaction.nonce !== nonces.get(transaction.from)) throw new Error('Transaction sequence conflict');
    if (balance < required) throw new Error('Insufficient balance');
    state.set(transaction.from, balance - required);
    state.set(transaction.to, (state.get(transaction.to) || 0) + transaction.amount);
    nonces.set(transaction.from, transaction.nonce + 1);
  }

  finalizeBlock(block, nextState, nextNonces) {
    if (!this.verifyBlock(block, nextState, nextNonces)) throw new Error('Invalid block or quorum certificate');
    this.state = nextState;
    this.nonces = nextNonces;
    this.blocks.push(block);
    this.pending = this.pending.filter(transaction => !block.transactions.includes(transaction));
    if (block.height % this.anchorInterval === 0) this.publishAnchor(block);
    return block;
  }

  verifyBlock(block, expectedState = null, expectedNonces = null) {
    if (!this.verifyBlockProposal(block)) return false;
    if (!block.quorumCertificate || block.quorumCertificate.length < quorumFor(this.validators.size)) return false;
    const seen = new Set();
    for (const vote of block.quorumCertificate) {
      const validator = this.validators.get(vote.validator);
      if (!validator || seen.has(vote.validator) || !verify(block.hash, vote.signature, validator.publicKey)) return false;
      seen.add(vote.validator);
    }
    if (seen.size < quorumFor(this.validators.size)) return false;
    const workingState = new Map(this.state);
    const workingNonces = new Map(this.nonces);
    try { for (const transaction of block.transactions) this.applyTransaction(transaction, workingState, workingNonces); } catch { return false; }
    if (stateRoot(workingState) !== block.stateRoot) return false;
    if (expectedState && stateRoot(expectedState) !== block.stateRoot) return false;
    if (expectedNonces) {
      const actual = JSON.stringify(Object.fromEntries([...workingNonces].sort()));
      const expected = JSON.stringify(Object.fromEntries([...expectedNonces].sort()));
      if (actual !== expected) return false;
    }
    return true;
  }

  publishAnchor(block) {
    const anchor = { chainId: CHAIN_ID, height: block.height, checkpointRoot: digest(this.blocks.map(candidate => candidate.hash)), timestamp: Date.now() };
    anchor.anchorId = digest(anchor);
    this.anchors.push(anchor);
    return anchor;
  }

  verifyAnchor(anchor) { return this.anchors.some(candidate => candidate.anchorId === anchor.anchorId && candidate.checkpointRoot === anchor.checkpointRoot && candidate.height === anchor.height); }

  snapshot() {
    return {
      validators: [...this.validators.values()].map(({ privateKey, ...publicIdentity }) => publicIdentity),
      anchorInterval: this.anchorInterval,
      state: Object.fromEntries(this.state),
      nonces: Object.fromEntries(this.nonces),
      blocks: this.blocks,
      anchors: this.anchors,
      pending: this.pending
    };
  }

  static fromSnapshot(snapshot, validators = snapshot.validators) {
    const network = new HybridNetwork({ validators, anchorInterval: snapshot.anchorInterval, initialBalances: snapshot.state });
    network.nonces = new Map(Object.entries(snapshot.nonces || {}).map(([address, nonce]) => [address, Number(nonce)]));
    network.blocks = snapshot.blocks || [];
    network.anchors = snapshot.anchors || [];
    network.pending = snapshot.pending || [];
    return network;
  }
}

export function createTransaction({ chainId = CHAIN_ID, from, to, amount, fee = 0, nonce, identity }) {
  const transaction = { chainId, version: 1, from, to, amount, fee, nonce, publicKey: identity.publicKey };
  return { ...transaction, signature: sign(transaction, identity.privateKey) };
}
