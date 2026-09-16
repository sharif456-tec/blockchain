import { digest } from './crypto.js';
import { CHAIN_ID, createTransaction } from './hybrid.js';

function depositKey(txid, vout) {
  return `${txid}:${vout}`;
}

export class BdtccSettlement {
  constructor({ bridge, network, treasuryAddress, treasuryIdentity, reserveAddress } = {}) {
    if (!bridge) throw new Error('BDTCC bridge is required');
    if (!network) throw new Error('Hybrid network is required');
    if (!treasuryAddress || !treasuryIdentity) throw new Error('Treasury identity is required');
    if (!reserveAddress) throw new Error('Reserve address is required');
    this.bridge = bridge;
    this.network = network;
    this.treasuryAddress = treasuryAddress;
    this.treasuryIdentity = treasuryIdentity;
    this.reserveAddress = reserveAddress;
    this.consumedDeposits = new Set();
    this.withdrawals = new Map();
  }

  settleDeposit({ txid, vout, recipient, expectedAmount, expectedAddress, proposerId }) {
    const key = depositKey(txid, vout);
    if (this.consumedDeposits.has(key)) throw new Error('BDTCC deposit output already settled');
    if (!recipient || !proposerId) throw new Error('Recipient and proposer are required');

    const verification = this.bridge.verifyExternalDeposit;
    if (typeof verification !== 'function') throw new Error('BDTCC external verification is unavailable');

    return verification.call(this.bridge, {
      txid,
      vout,
      expectedAmount,
      expectedAddress
    }).then(result => {
      const transaction = createTransaction({
        chainId: CHAIN_ID,
        from: this.treasuryAddress,
        to: recipient,
        amount: result.amount,
        fee: 0,
        nonce: this.network.nonceOf(this.treasuryAddress),
        identity: this.treasuryIdentity
      });
      this.network.submitTransaction(transaction);
      const block = this.network.proposeBlock(proposerId);
      this.consumedDeposits.add(key);
      return {
        type: 'bdtcc-deposit-settlement',
        settlementId: digest({ txid, vout, recipient, amount: result.amount, block: block.hash }),
        external: result,
        transaction,
        block
      };
    });
  }

  createWithdrawal({ recipient, amount, reference, identity, proposerId }) {
    if (!identity || !proposerId) throw new Error('Withdrawal identity and proposer are required');
    const intent = this.bridge.createWithdrawalIntent({ recipient, amount, reference });
    if (this.withdrawals.has(intent.intentId)) throw new Error('Withdrawal intent already exists');

    const transaction = createTransaction({
      chainId: CHAIN_ID,
      from: recipient,
      to: this.reserveAddress,
      amount,
      fee: 0,
      nonce: this.network.nonceOf(recipient),
      identity
    });
    this.network.submitTransaction(transaction);
    const block = this.network.proposeBlock(proposerId);
    const record = {
      status: 'locked',
      intent,
      transaction,
      blockHash: block.hash,
      externalTxId: null
    };
    this.withdrawals.set(intent.intentId, record);
    return record;
  }

  async broadcastWithdrawal(intentId, rawTransaction, maxFeeRate) {
    const record = this.withdrawals.get(intentId);
    if (!record) throw new Error('Unknown withdrawal intent');
    if (record.status === 'settled') throw new Error('Withdrawal already settled');
    if (record.status === 'broadcast') throw new Error('Withdrawal already broadcast');

    const result = await this.bridge.broadcastWithdrawal(rawTransaction, maxFeeRate);
    record.status = 'broadcast';
    record.externalTxId = result.txid;
    record.externalRawTransaction = rawTransaction;
    return record;
  }

  async confirmWithdrawal(intentId) {
    const record = this.withdrawals.get(intentId);
    if (!record) throw new Error('Unknown withdrawal intent');
    if (!record.externalTxId) throw new Error('Withdrawal has not been broadcast');
    if (record.status === 'settled') return record;

    const status = await this.bridge.getWithdrawalStatus(record.externalTxId);
    if (!status.settled) return { ...record, confirmationStatus: status };

    record.status = 'settled';
    record.confirmationStatus = status;
    return record;
  }

  markWithdrawalBroadcast(intentId, externalTxId) {
    if (!externalTxId || typeof externalTxId !== 'string') throw new Error('Missing BDTCC transaction id');
    const record = this.withdrawals.get(intentId);
    if (!record) throw new Error('Unknown withdrawal intent');
    if (record.status === 'settled') throw new Error('Withdrawal already settled');
    record.status = 'broadcast';
    record.externalTxId = externalTxId;
    return record;
  }

  markWithdrawalSettled(intentId, externalTxId) {
    const record = this.withdrawals.get(intentId);
    if (!record) throw new Error('Unknown withdrawal intent');
    if (record.status === 'settled') throw new Error('Withdrawal already settled');
    if (record.externalTxId && record.externalTxId !== externalTxId) throw new Error('Withdrawal transaction id mismatch');
    record.status = 'settled';
    record.externalTxId = externalTxId;
    return record;
  }
}
