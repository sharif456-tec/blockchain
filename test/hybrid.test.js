import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '../src/crypto.js';
import { createTransaction, HybridNetwork, quorumFor } from '../src/hybrid.js';

function setup() {
  const validators = ['a', 'b', 'c', 'd'].map(createIdentity);
  const alice = createIdentity('alice');
  const bob = createIdentity('bob');
  return { validators, alice, bob, network: new HybridNetwork({ validators, initialBalances: { alice: 10_000 }, anchorInterval: 1 }) };
}

test('BFT quorum finalizes a private block and publishes a public anchor', () => {
  const { validators, alice, bob, network } = setup();
  network.submitTransaction(createTransaction({ from: 'alice', to: 'bob', amount: 1_000, fee: 10, nonce: 0, identity: alice }));
  const block = network.proposeBlock(validators[0].id);
  assert.equal(block.quorumCertificate.length, 4);
  assert.equal(network.balanceOf('alice'), 8_990);
  assert.equal(network.balanceOf('bob'), 1_000);
  assert.equal(network.anchors.length, 1);
  assert.equal(network.verifyAnchor(network.anchors[0]), true);
  assert.equal(quorumFor(4), 3);
});

test('wrong chain and replayed nonce are rejected', () => {
  const { validators, alice, bob, network } = setup();
  assert.throws(() => network.submitTransaction(createTransaction({ chainId: 'wrong-chain', from: 'alice', to: 'bob', amount: 1, nonce: 0, identity: alice })), /Wrong chain ID/);
  const transaction = createTransaction({ from: 'alice', to: 'bob', amount: 1, nonce: 0, identity: alice });
  network.submitTransaction(transaction);
  network.proposeBlock(validators[0].id);
  assert.throws(() => network.submitTransaction(transaction), /Invalid nonce/);
});

test('tampered block fields are rejected', () => {
  const { validators, alice, network } = setup();
  network.submitTransaction(createTransaction({ from: 'alice', to: 'bob', amount: 100, nonce: 0, identity: alice }));
  const block = network.proposeBlock(validators[0].id);
  const tampered = { ...block, proposer: validators[1].id };
  assert.equal(network.verifyBlock(tampered), false);
  const tamperedTransactions = { ...block, transactions: [] };
  assert.equal(network.verifyBlock(tamperedTransactions), false);
});

test('duplicate pending transactions and invalid signatures are rejected', () => {
  const { alice, bob, network } = setup();
  const transaction = createTransaction({ from: 'alice', to: 'bob', amount: 100, nonce: 0, identity: alice });
  network.submitTransaction(transaction);
  assert.throws(() => network.submitTransaction(transaction), /Duplicate pending transaction/);
  const forged = { ...createTransaction({ from: 'alice', to: 'bob', amount: 100, nonce: 1, identity: alice }), publicKey: bob.publicKey };
  assert.throws(() => network.submitTransaction(forged), /Invalid transaction signature/);
});

test('unknown proposers cannot create blocks', () => {
  const { alice, bob, network } = setup();
  network.submitTransaction(createTransaction({ from: 'alice', to: 'bob', amount: 100, nonce: 0, identity: alice }));
  assert.throws(() => network.proposeBlock('not-a-validator'), /Unknown proposer/);
});

test('conflicting pending nonces are rejected', () => {
  const { alice, bob, network } = setup();
  network.submitTransaction(createTransaction({ from: 'alice', to: 'bob', amount: 100, nonce: 0, identity: alice }));
  const conflicting = createTransaction({ from: 'alice', to: bob.id, amount: 200, nonce: 0, identity: alice });
  assert.throws(() => network.submitTransaction(conflicting), /Conflicting pending nonce/);
});
