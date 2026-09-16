import test from 'node:test';
import assert from 'node:assert/strict';
import { BdtccBridge, BdtccRpcClient, BDTC_ASSET } from '../src/bdtcc.js';
import { BdtccSettlement } from '../src/bdtcc_settlement.js';
import { HybridNetwork } from '../src/hybrid.js';
import { createIdentity } from '../src/crypto.js';

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

test('BDTCC RPC client broadcasts raw transaction and reads confirmation status', async () => {
  const calls = [];
  const rpc = new BdtccRpcClient({
    url: 'http://127.0.0.1:8332',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      if (request.method === 'sendrawtransaction') {
        assert.deepEqual(request.params, ['02000000deadbeef']);
        return { ok: true, status: 200, json: async () => ({ result: 'external-tx-99' }) };
      }
      if (request.method === 'gettransaction') {
        assert.deepEqual(request.params, ['external-tx-99', false]);
        return { ok: true, status: 200, json: async () => ({ result: {
          confirmations: 7,
          blockhash: 'block-99'
        } }) };
      }
      throw new Error(`unexpected method ${request.method}`);
    }
  });

  const bridge = new BdtccBridge({ rpc, minConfirmations: 6 });
  const broadcast = await bridge.broadcastWithdrawal('02000000deadbeef');
  assert.deepEqual(broadcast, { txid: 'external-tx-99', broadcast: true });

  const status = await bridge.getWithdrawalStatus('external-tx-99');
  assert.deepEqual(status, {
    txid: 'external-tx-99',
    confirmations: 7,
    settled: true,
    blockHash: 'block-99',
    raw: { confirmations: 7, blockhash: 'block-99' }
  });
  assert.equal(calls.length, 2);
});

test('BDTCC withdrawal confirmation remains unsettled below threshold', async () => {
  const rpc = new BdtccRpcClient({
    url: 'http://127.0.0.1:8332',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'gettransaction');
      return { ok: true, status: 200, json: async () => ({ result: { confirmations: 2 } }) };
    }
  });
  const bridge = new BdtccBridge({ rpc, minConfirmations: 6 });
  const status = await bridge.getWithdrawalStatus('external-tx-pending');
  assert.equal(status.settled, false);
  assert.equal(status.confirmations, 2);
});

test('verified BDTCC deposit credits BDTC once and rejects replay', async () => {
  const validators = [createIdentity('v1'), createIdentity('v2'), createIdentity('v3')];
  const treasury = createIdentity('treasury');
  const network = new HybridNetwork({
    validators,
    initialBalances: { [treasury.id]: 1_000_000_000 }
  });
  const bridge = new BdtccBridge({ minConfirmations: 1 });
  bridge.verifyExternalDeposit = async () => ({
    verified: true,
    txid: 'external-1',
    vout: 0,
    amount: 125_000_000,
    confirmations: 8,
    address: 'bdtc-deposit-address'
  });
  const settlement = new BdtccSettlement({
    bridge,
    network,
    treasuryAddress: treasury.id,
    treasuryIdentity: treasury,
    reserveAddress: 'reserve'
  });

  const first = await settlement.settleDeposit({
    txid: 'external-1',
    vout: 0,
    recipient: 'alice',
    expectedAmount: 125_000_000,
    expectedAddress: 'bdtc-deposit-address',
    proposerId: validators[0].id
  });

  assert.equal(first.external.amount, 125_000_000);
  assert.equal(network.balanceOf('alice'), 125_000_000);
  await assert.rejects(
    () => settlement.settleDeposit({
      txid: 'external-1',
      vout: 0,
      recipient: 'alice',
      expectedAmount: 125_000_000,
      expectedAddress: 'bdtc-deposit-address',
      proposerId: validators[0].id
    }),
    /already settled/
  );
});

test('withdrawal locks BDTC in reserve and is replay protected', () => {
  const validators = [createIdentity('v1'), createIdentity('v2'), createIdentity('v3')];
  const alice = createIdentity('alice');
  const bridge = new BdtccBridge();
  const network = new HybridNetwork({
    validators,
    initialBalances: { [alice.id]: 200_000_000 }
  });
  const settlement = new BdtccSettlement({
    bridge,
    network,
    treasuryAddress: 'treasury',
    treasuryIdentity: createIdentity('treasury'),
    reserveAddress: 'reserve'
  });

  const record = settlement.createWithdrawal({
    recipient: alice.id,
    amount: 75_000_000,
    reference: 'withdrawal-1',
    identity: alice,
    proposerId: validators[0].id
  });

  assert.equal(record.status, 'locked');
  assert.equal(network.balanceOf(alice.id), 125_000_000);
  assert.equal(network.balanceOf('reserve'), 75_000_000);
  assert.throws(
    () => settlement.createWithdrawal({
      recipient: alice.id,
      amount: 75_000_000,
      reference: 'withdrawal-1',
      identity: alice,
      proposerId: validators[0].id
    }),
    /already exists/
  );
});

test('withdrawal lifecycle tracks broadcast and settlement exactly once', () => {
  const validators = [createIdentity('v1'), createIdentity('v2'), createIdentity('v3')];
  const alice = createIdentity('alice');
  const network = new HybridNetwork({ validators, initialBalances: { [alice.id]: 100_000_000 } });
  const settlement = new BdtccSettlement({
    bridge: new BdtccBridge(),
    network,
    treasuryAddress: 'treasury',
    treasuryIdentity: createIdentity('treasury'),
    reserveAddress: 'reserve'
  });
  const record = settlement.createWithdrawal({
    recipient: alice.id,
    amount: 10_000_000,
    reference: 'withdrawal-2',
    identity: alice,
    proposerId: validators[0].id
  });

  settlement.markWithdrawalBroadcast(record.intent.intentId, 'bdtcc-tx-22');
  const settled = settlement.markWithdrawalSettled(record.intent.intentId, 'bdtcc-tx-22');
  assert.equal(settled.status, 'settled');
  assert.throws(
    () => settlement.markWithdrawalSettled(record.intent.intentId, 'bdtcc-tx-22'),
    /already settled/
  );
});
