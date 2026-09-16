import { digest } from './crypto.js';
import { BDU_PER_BDTC } from './hybrid.js';

export const BDTC_ASSET = Object.freeze({
  symbol: 'BDTC',
  unit: 'BDU',
  decimals: 8,
  atomicUnitsPerCoin: BDU_PER_BDTC,
  chainId: 'iit-bdtc-testnet-1'
});

function withoutIntentId(value) {
  const { intentId: ignored, ...payload } = value;
  return payload;
}

export class BdtccBridge {
  constructor({ networkId = 'bdtcc' } = {}) {
    this.networkId = networkId;
  }

  assertAtomicAmount(amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('BDTC amount must be a positive safe integer in BDU');
    }
    return amount;
  }

  createDepositIntent({ externalTxId, vout, amount, recipient, confirmations = 0 }) {
    if (!externalTxId || typeof externalTxId !== 'string') throw new Error('Missing BDTCC transaction id');
    if (!Number.isInteger(vout) || vout < 0) throw new Error('Invalid BDTCC output index');
    if (!recipient || typeof recipient !== 'string') throw new Error('Missing BDTC recipient');
    this.assertAtomicAmount(amount);
    if (!Number.isInteger(confirmations) || confirmations < 0) throw new Error('Invalid confirmation count');

    const intent = {
      type: 'bdtcc-deposit',
      asset: BDTC_ASSET.symbol,
      sourceNetwork: this.networkId,
      externalTxId,
      vout,
      amount,
      recipient,
      confirmations
    };
    return { ...intent, intentId: digest(intent) };
  }

  createWithdrawalIntent({ recipient, amount, reference }) {
    if (!recipient || typeof recipient !== 'string') throw new Error('Missing BDTCC recipient');
    this.assertAtomicAmount(amount);
    if (!reference || typeof reference !== 'string') throw new Error('Missing withdrawal reference');

    const intent = {
      type: 'bdtcc-withdrawal',
      asset: BDTC_ASSET.symbol,
      destinationNetwork: this.networkId,
      recipient,
      amount,
      reference
    };
    return { ...intent, intentId: digest(intent) };
  }

  verifyDepositIntent(intent) {
    if (!intent || intent.type !== 'bdtcc-deposit') throw new Error('Invalid BDTCC deposit intent');
    if (intent.asset !== BDTC_ASSET.symbol) throw new Error('Unsupported asset');
    this.assertAtomicAmount(intent.amount);
    if (!intent.externalTxId || !Number.isInteger(intent.vout) || intent.vout < 0) throw new Error('Invalid external transaction reference');
    if (!intent.recipient) throw new Error('Missing BDTC recipient');
    if (!Number.isInteger(intent.confirmations) || intent.confirmations < 0) throw new Error('Invalid confirmation count');
    return digest(withoutIntentId(intent)) === intent.intentId;
  }
}
