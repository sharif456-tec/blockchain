import { createIdentity } from './crypto.js';
import { createTransaction, HybridNetwork } from './hybrid.js';

const validators = ['validator-a', 'validator-b', 'validator-c'].map(createIdentity);
const alice = createIdentity('alice');
const bob = createIdentity('bob');
const network = new HybridNetwork({ validators, anchorInterval: 1, initialBalances: { [alice.id]: 10_000 } });

network.submitTransaction(createTransaction({ from: alice.id, to: bob.id, amount: 2_500, nonce: 0, identity: alice }));
const block = network.proposeBlock(validators[0].id);
console.log(JSON.stringify({ blockHeight: block.height, validatorVotes: block.quorumCertificate.length, aliceBalance: network.balanceOf(alice.id), bobBalance: network.balanceOf(bob.id), publicAnchor: network.anchors[0] }, null, 2));
