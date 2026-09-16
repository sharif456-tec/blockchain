import test from 'node:test';
import assert from 'node:assert/strict';
import { BdtccBridge, BdtccRpcClient, BDTC_ASSET } from '../src/bdtcc.js';

test('BDTC asset is fixed to 8 decimal atomic units', () => {
  assert.equal(BDTC_ASSET.symbol, 'BDTC');
  assert.equal(BDTC_ASSET.unit, 'BDU');
  assert.equal(BDTC_ASSET.decimals, 8);
  assert.equal(BDTC_ASSET.atomicUnitsPerCoin, 100_000_000);
  assert.equal(BDTC_ASSET.chainId, 'iit-bdtc-testnet-1');
});

test('BDTCC deposit intent is deterministic and verifiable', () => {
  const bridge = new BdtccBridge({ networkId: 'bdtcc' });
  const intent = bridge.createDepositIntent({
    externalTxId: 'external-tx-001',
    vout: 1,
    amount: 125_000_000,
    recipient: 'iit:alice',
    confirmations: 6
  });

  assert.match(intent.intentId, /^[0-9a-f]{64}$/);
  assert.equal(bridge.verifyDepositIntent(intent), true);
});

test('BDTCC withdrawal intent rejects invalid amounts', () => {
  const bridge = new BdtccBridge();
  assert.throws(
    () => bridge.createWithdrawalIntent({ recipient: 'bdtcc:alice', amount: 0, reference: 'w-1' }),
    /positive safe integer/
  );
});

test('BDTCC RPC client verifies an unspent confirmed output', async () => {
  const calls = [];
  const rpc = new BdtccRpcClient({
    url: 'http://127.0.0.1:8332',
    username: 'user',
    password: 'pass',
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      const method = calls.at(-1).method;
      if (method === 'getrawtransaction') {
        return { ok: true, status: 200, json: async () => ({ result: {
          txid: 'tx-1',
          confirmations: 8,
          vout: [{ value: 1.25, scriptPubKey: { addresses: ['bdtc-address-1'] } }]
        } }) };
      }
      if (method === 'gettxout') {
        return { ok: true, status: 200, json: async () => ({ result: { confirmations: 8 } }) };
      }
      throw new Error(`unexpected method ${method}`);
    }
  });

  const bridge = new BdtccBridge({ rpc, minConfirmations: 6 });
  const result = await bridge.verifyExternalDeposit({
    txid: 'tx-1',
    vout: 0,
    expectedAmount: 125_000_000,
    expectedAddress: 'bdtc-address-1'
  });

  assert.deepEqual(result, {
    verified: true,
    txid: 'tx-1',
    vout: 0,
    amount: 125_000_000,
    confirmations: 8,
    address: 'bdtc-address-1'
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'getrawtransaction');
  assert.equal(calls[1].method, 'gettxout');
});

test('BDTCC RPC verification rejects a spent output', async () => {
  const rpc = new BdtccRpcClient({
    url: 'http://127.0.0.1:8332',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === 'getrawtransaction') {
        return { ok: true, status: 200, json: async () => ({ result: {
          vout: [{ value: 1, scriptPubKey: { addresses: ['bdtc-address-1'] } }]
        } }) };
      }
      return { ok: true, status: 200, json: async () => ({ result: null }) };
    }
  });

  const bridge = new BdtccBridge({ rpc, minConfirmations: 1 });
  await assert.rejects(
    () => bridge.verifyExternalDeposit({ txid: 'tx-spent', vout: 0, expectedAmount: 100_000_000 }),
    /spent or unavailable/
  );
});
