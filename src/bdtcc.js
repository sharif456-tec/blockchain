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

function decimalToAtomic(value, decimals = 8) {
  const text = typeof value === 'number' ? value.toFixed(decimals) : String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Invalid BDTCC amount');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error('BDTCC amount has too many decimals');
  const atomic = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
  if (atomic <= 0n || atomic > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('BDTC amount exceeds safe integer range');
  return Number(atomic);
}

export class BdtccRpcClient {
  constructor({ url, username, password, fetchImpl = globalThis.fetch } = {}) {
    if (!url || typeof url !== 'string') throw new Error('Missing BDTCC RPC URL');
    if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is required');
    this.url = url;
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.nextId = 1;
  }

  async call(method, params = []) {
    const headers = { 'content-type': 'application/json' };
    if (this.username !== undefined || this.password !== undefined) {
      const token = Buffer.from(`${this.username ?? ''}:${this.password ?? ''}`).toString('base64');
      headers.authorization = `Basic ${token}`;
    }
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: this.nextId++, method, params })
    });
    if (!response.ok) throw new Error(`BDTCC RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`BDTCC RPC ${body.error.message || 'unknown error'}`);
    return body.result;
  }

  getRawTransaction(txid, verbose = true) {
    return this.call('getrawtransaction', [txid, verbose]);
  }

  getTxOut(txid, vout, includeMempool = true) {
    return this.call('gettxout', [txid, vout, includeMempool]);
  }

  getBlockchainInfo() {
    return this.call('getblockchaininfo');
  }

  sendRawTransaction(rawTransaction, maxFeeRate) {
    if (!rawTransaction || typeof rawTransaction !== 'string') throw new Error('Missing BDTCC raw transaction');
    const params = maxFeeRate === undefined ? [rawTransaction] : [rawTransaction, maxFeeRate];
    return this.call('sendrawtransaction', params);
  }

  getTransaction(txid, includeWatchOnly = false) {
    if (!txid || typeof txid !== 'string') throw new Error('Missing BDTCC transaction id');
    return this.call('gettransaction', [txid, includeWatchOnly]);
  }
}

export class BdtccBridge {
  constructor({ networkId = 'bdtcc', minConfirmations = 6, rpc = null } = {}) {
    this.networkId = networkId;
    this.minConfirmations = minConfirmations;
    this.rpc = rpc;
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

  async verifyExternalDeposit({ txid, vout, expectedAmount, expectedAddress, minConfirmations = this.minConfirmations }) {
    if (!this.rpc) throw new Error('BDTCC RPC client is not configured');
    if (!txid || !Number.isInteger(vout) || vout < 0) throw new Error('Invalid external transaction reference');
    this.assertAtomicAmount(expectedAmount);
    const tx = await this.rpc.getRawTransaction(txid, true);
    const output = tx?.vout?.[vout];
    if (!output) throw new Error('BDTCC transaction output not found');
    const actualAmount = decimalToAtomic(output.value, BDTC_ASSET.decimals);
    if (actualAmount !== expectedAmount) throw new Error('BDTCC output amount mismatch');
    if (expectedAddress) {
      const addresses = output.scriptPubKey?.addresses || [];
      if (!addresses.includes(expectedAddress)) throw new Error('BDTCC output address mismatch');
    }
    const txOut = await this.rpc.getTxOut(txid, vout, true);
    if (!txOut) throw new Error('BDTCC output is spent or unavailable');
    const confirmations = Number(txOut.confirmations ?? tx.confirmations ?? 0);
    if (!Number.isInteger(confirmations) || confirmations < minConfirmations) {
      throw new Error(`Insufficient BDTCC confirmations: ${confirmations}`);
    }
    return {
      verified: true,
      txid,
      vout,
      amount: actualAmount,
      confirmations,
      address: expectedAddress || null
    };
  }

  async broadcastWithdrawal(rawTransaction, maxFeeRate) {
    if (!this.rpc) throw new Error('BDTCC RPC client is not configured');
    const txid = await this.rpc.sendRawTransaction(rawTransaction, maxFeeRate);
    if (!txid || typeof txid !== 'string') throw new Error('BDTCC RPC returned an invalid transaction id');
    return { txid, broadcast: true };
  }

  async getWithdrawalStatus(txid, minConfirmations = this.minConfirmations) {
    if (!this.rpc) throw new Error('BDTCC RPC client is not configured');
    const tx = await this.rpc.getTransaction(txid);
    const confirmations = Number(tx?.confirmations ?? 0);
    if (!Number.isInteger(confirmations) || confirmations < 0) throw new Error('Invalid BDTCC confirmation count');
    return {
      txid,
      confirmations,
      settled: confirmations >= minConfirmations,
      blockHash: tx?.blockhash || null,
      raw: tx
    };
  }
}
