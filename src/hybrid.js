import { digest, sign, verify } from './crypto.js';

export const CHAIN_ID = 'iit-bdtc-testnet-1';
export const BDU_PER_BDTC = 100_000_000;

function merkleRoot(items) {
  if (items.length === 0) return digest('empty');
  let layer = items.map(item => digest(item));
  while (layer.length > 1) {
    const next = [];
    for (let index = 0; index < layer.length; index += 2) {
      next.push(digest(layer[index] + (layer[index + 1] || layer[index])));
    }
    layer = next;
  }
  return layer[0];
}

function transactionPayload(transaction) {
  const { signature: ignored, ...payload } = transaction;
  return payload;
}

export function quorumFor(validatorCount) {
  return Math.floor((validatorCount * 2) / 3) + 1;
}

export class HybridNetwork {
  constructor({ validators, initialBalances = {}, anchorInterval = 2 }) {
    if (!validators?.length || validators.length < 3) throw new Error('At least 3 validators are required');
    this.validators = new Map(validators.map(validator => [validator.id, validator]));
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
    this.pending.push(transaction);
    return transaction;
  }

  proposeBlock(proposerId) {
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
      stateRoot: digest(Object.fromEntries([...workingState].sort())),
      proposer: proposerId
    };
    const blockHash = digest(header);
    const votes = [...this.validators.values()].map(validator => ({ validator: validator.id, signature: sign(blockHash, validator.privateKey) }));
    const block = { ...header, transactions, hash: blockHash, quorumCertificate: votes };
    this.finalizeBlock(block, workingState, workingNonces);
    return block;
  }

  applyTransaction(transaction, state = this.state, nonces = this.nonces) {
    const required = transaction.amount + transaction.fee;
    const balance = state.get(transaction.from) || 0;
    if (nonces.get(transaction.from) !== undefined && transaction.nonce !== nonces.get(transaction.from)) throw new Error('Transaction sequence conflict');
    if (balance < required) throw new Error('Insufficient balance');
    state.set(transaction.from, balance - required);
    state.set(transaction.to, (state.get(transaction.to) || 0) + transaction.amount);
    nonces.set(transaction.from, transaction.nonce + 1);
  }

  finalizeBlock(block, nextState, nextNonces) {
    if (!this.verifyBlock(block)) throw new Error('Invalid quorum certificate');
    this.state = nextState;
    this.nonces = nextNonces;
    this.blocks.push(block);
    this.pending = this.pending.filter(transaction => !block.transactions.includes(transaction));
    if (block.height % this.anchorInterval === 0) this.publishAnchor(block);
    return block;
  }

  verifyBlock(block) {
    if (block.chainId !== CHAIN_ID || block.height !== this.blocks.length + 1) return false;
    if (block.previousHash !== (this.blocks.at(-1)?.hash || digest('genesis'))) return false;
    if (!block.quorumCertificate || block.quorumCertificate.length < quorumFor(this.validators.size)) return false;
    const seen = new Set();
    for (const vote of block.quorumCertificate) {
      const validator = this.validators.get(vote.validator);
      if (!validator || seen.has(vote.validator) || !verify(block.hash, vote.signature, validator.publicKey)) return false;
      seen.add(vote.validator);
    }
    return true;
  }

  publishAnchor(block) {
    const anchor = { chainId: CHAIN_ID, height: block.height, checkpointRoot: digest(this.blocks.map(candidate => candidate.hash)), timestamp: Date.now() };
    anchor.anchorId = digest(anchor);
    this.anchors.push(anchor);
    return anchor;
  }

  verifyAnchor(anchor) {
    return this.anchors.some(candidate => candidate.anchorId === anchor.anchorId && candidate.checkpointRoot === anchor.checkpointRoot && candidate.height === anchor.height);
  }

  snapshot() {
    return {
      validators: [...this.validators.values()],
      anchorInterval: this.anchorInterval,
      state: Object.fromEntries(this.state),
      nonces: Object.fromEntries(this.nonces),
      blocks: this.blocks,
      anchors: this.anchors,
      pending: this.pending
    };
  }

  static fromSnapshot(snapshot) {
    const network = new HybridNetwork({ validators: snapshot.validators, anchorInterval: snapshot.anchorInterval, initialBalances: snapshot.state });
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
