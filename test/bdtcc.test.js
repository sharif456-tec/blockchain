import test from 'node:test';
import assert from 'node:assert/strict';
import { BdtccBridge, BDTC_ASSET } from '../src/bdtcc.js';

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
