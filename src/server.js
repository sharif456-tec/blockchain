import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createIdentity } from './crypto.js';
import { CHAIN_ID, HybridNetwork, quorumFor } from './hybrid.js';
import { BdtccBridge, BdtccRpcClient } from './bdtcc.js';
import { BdtccSettlement } from './bdtcc_settlement.js';
import { JsonSettlementStore } from './bdtcc_store.js';

const port = Number(process.env.PORT || 8787);
const dataFile = path.resolve(process.env.DATA_FILE || 'data/node.json');
const settlementFile = path.resolve(process.env.BDTCC_SETTLEMENT_FILE || 'data/bdtcc-settlement.json');
const apiToken = process.env.NODE_API_TOKEN || '';
const peerToken = process.env.PEER_API_TOKEN || apiToken;
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 1_048_576);
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);
const peerTimeoutMs = Number(process.env.PEER_TIMEOUT_MS || 5_000);
const production = process.env.NODE_ENV === 'production';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadPrivateKey(file) { return fs.readFileSync(path.resolve(file), 'utf8'); }

function loadValidators() {
  if (production) {
    const registryPath = required('VALIDATOR_REGISTRY_FILE');
    const registry = JSON.parse(fs.readFileSync(path.resolve(registryPath), 'utf8'));
    if (!Array.isArray(registry) || registry.length < 3) throw new Error('VALIDATOR_REGISTRY_FILE must contain at least 3 public validator identities');
    const localId = required('NODE_VALIDATOR_ID');
    const local = registry.find(identity => identity.id === localId);
    if (!local?.publicKey) throw new Error(`Validator ${localId} is missing from the public validator registry`);
    const privateKeyFile = required('NODE_VALIDATOR_PRIVATE_KEY_FILE');
    return registry.map(identity => ({
      id: identity.id,
      publicKey: identity.publicKey,
      ...(identity.id === localId ? { privateKey: loadPrivateKey(privateKeyFile) } : {})
    }));
  }
  const validatorsFile = process.env.VALIDATORS_FILE;
  if (validatorsFile) {
    const file = JSON.parse(fs.readFileSync(path.resolve(validatorsFile), 'utf8'));
    if (!Array.isArray(file) || file.length < 3) throw new Error('VALIDATORS_FILE must contain at least 3 validator identities');
    return file.map(identity => {
      if (!identity.id || !identity.publicKey || !identity.privateKey) throw new Error('Each validator must contain id, publicKey and privateKey');
      return identity;
    });
  }
  return ['validator-a', 'validator-b', 'validator-c'].map(createIdentity);
}

const validators = loadValidators();
const localValidatorId = production ? required('NODE_VALIDATOR_ID') : (process.env.NODE_VALIDATOR_ID || validators.find(v => v.privateKey)?.id || validators[0].id);
const localValidator = validators.find(v => v.id === localValidatorId);
if (!localValidator?.privateKey) throw new Error(`Local validator ${localValidatorId} has no private key`);

function createNetwork() {
  if (fs.existsSync(dataFile)) {
    const snapshot = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return HybridNetwork.fromSnapshot(snapshot, validators);
  }
  const network = new HybridNetwork({ validators, initialBalances: { treasury: 21_000_000 * 100_000_000 }, anchorInterval: 10 });
  persist(network);
  return network;
}

function persist(network) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(network.snapshot(), null, 2), { mode: 0o600 });
  fs.renameSync(temporary, dataFile);
}

function loadPeers() {
  const peersFile = process.env.PEERS_FILE;
  if (!peersFile) return [];
  const peers = JSON.parse(fs.readFileSync(path.resolve(peersFile), 'utf8'));
  if (!Array.isArray(peers)) throw new Error('PEERS_FILE must contain an array');
  return peers.filter(peer => peer.id && peer.url && peer.validatorId);
}

const peers = loadPeers();
if (production && peers.length < quorumFor(validators.length) - 1) throw new Error('PEERS_FILE must contain enough independent peers to reach validator quorum');

const treasuryValidatorId = process.env.TREASURY_VALIDATOR_ID || (production ? required('TREASURY_VALIDATOR_ID') : localValidatorId);
const treasuryIdentity = networkIdentity => networkIdentity.validators.get(treasuryValidatorId);

const network = createNetwork();
const treasury = treasuryIdentity(network);
if (!treasury) throw new Error(`Treasury validator ${treasuryValidatorId} is not configured`);

const rpcUrl = process.env.BDTCC_RPC_URL;
const rpc = rpcUrl ? new BdtccRpcClient({ url: rpcUrl, username: process.env.BDTCC_RPC_USERNAME, password: process.env.BDTCC_RPC_PASSWORD }) : null;
const bdtccNetworkId = process.env.BDTCC_NETWORK_ID || '';
const depositAddress = process.env.BDTCC_DEPOSIT_ADDRESS || '';
const bdtcTreasuryAddress = process.env.BDTC_TREASURY_ADDRESS || '';
const bdtcReserveAddress = process.env.BDTC_RESERVE_ADDRESS || '';

if (production) {
  if (!rpcUrl) throw new Error('BDTCC_RPC_URL is required in production');
  required('BDTCC_RPC_USERNAME');
  required('BDTCC_RPC_PASSWORD');
  required('BDTCC_NETWORK_ID');
  required('BDTCC_DEPOSIT_ADDRESS');
  required('BDTC_TREASURY_ADDRESS');
  required('BDTC_RESERVE_ADDRESS');
  required('NODE_API_TOKEN');
  required('PEER_API_TOKEN');
}

const bridge = new BdtccBridge({ networkId: bdtccNetworkId, minConfirmations: Number(process.env.BDTCC_MIN_CONFIRMATIONS || 6), rpc });
const settlement = new BdtccSettlement({
  bridge,
  network,
  treasuryAddress: bdtcTreasuryAddress || 'treasury',
  treasuryIdentity: treasury,
  reserveAddress: bdtcReserveAddress || 'bdtc-reserve',
  store: new JsonSettlementStore({ filePath: settlementFile })
});

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value, null, 2));
}

function authorized(request, token = apiToken) {
  if (!token) return !production;
  const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : request.headers['x-api-key'];
  return supplied === token;
}

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  try { return JSON.parse(text || '{}'); } catch { throw new Error('Invalid JSON body'); }
}

function requireAuth(request, response, token = apiToken) {
  if (authorized(request, token)) return true;
  json(response, 401, { error: 'Authentication required' });
  return false;
}

async function peerPost(peer, pathname, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), peerTimeoutMs);
  try {
    const response = await fetch(new URL(pathname, peer.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${peerToken}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Peer ${peer.id} returned HTTP ${response.status}`);
    return payload;
  } finally { clearTimeout(timer); }
}

async function collectDistributedVotes(block) {
  const votes = [network.voteForBlock(block, localValidatorId)];
  const errors = [];
  for (const peer of peers) {
    if (peer.validatorId === localValidatorId) continue;
    try {
      const vote = await peerPost(peer, '/consensus/vote', { block });
      if (vote.validator !== peer.validatorId) throw new Error(`Peer ${peer.id} returned an unexpected validator identity`);
      votes.push(vote);
    } catch (error) { errors.push({ peer: peer.id, error: error.message }); }
  }
  if (votes.length < quorumFor(validators.length)) throw new Error(`Validator quorum not reached: ${votes.length}/${quorumFor(validators.length)}; ${JSON.stringify(errors)}`);
  return { votes, errors };
}

await settlement.init();

const server = http.createServer(async (request, response) => {
  response.setTimeout(requestTimeoutMs, () => response.destroy());
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, { ok: true, chainId: CHAIN_ID, height: network.blocks.length, anchors: network.anchors.length, validator: localValidatorId, validators: validators.length, peers: peers.length, quorum: quorumFor(validators.length), bdtcc: { configured: Boolean(rpc), networkId: bridge.networkId || null, minConfirmations: bridge.minConfirmations } });
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      if (!requireAuth(request, response)) return;
      return json(response, 200, { chainId: CHAIN_ID, height: network.blocks.length, pending: network.pending.length, balances: Object.fromEntries(network.state), nonces: Object.fromEntries(network.nonces) });
    }
    if (request.method === 'GET' && url.pathname === '/blocks') {
      if (!requireAuth(request, response)) return;
      return json(response, 200, network.blocks);
    }
    if (request.method === 'GET' && url.pathname === '/anchors') {
      if (!requireAuth(request, response)) return;
      return json(response, 200, network.anchors);
    }
    if (request.method === 'GET' && url.pathname === '/bdtcc/status') {
      if (!requireAuth(request, response)) return;
      const chain = rpc ? await rpc.getBlockchainInfo() : null;
      return json(response, 200, { configured: Boolean(rpc), networkId: bridge.networkId || null, minConfirmations: bridge.minConfirmations, chain });
    }
    if (request.method === 'GET' && url.pathname === '/bdtcc/withdrawals') {
      if (!requireAuth(request, response)) return;
      return json(response, 200, [...settlement.withdrawals.entries()].map(([intentId, record]) => ({ intentId, ...record })));
    }
    if (request.method === 'POST' && url.pathname === '/transactions') {
      if (!requireAuth(request, response)) return;
      const transaction = network.submitTransaction(await readBody(request));
      persist(network);
      return json(response, 201, transaction);
    }
    if (request.method === 'POST' && url.pathname === '/blocks/propose') {
      if (!requireAuth(request, response)) return;
      const proposer = (await readBody(request)).proposer || localValidatorId;
      if (production && proposer !== localValidatorId) return json(response, 403, { error: 'Production nodes may only propose with their local validator identity' });
      const block = production ? network.buildBlock(proposer) : network.proposeBlock(proposer);
      if (!production) { persist(network); return json(response, 201, block); }
      const { votes, errors } = await collectDistributedVotes(block);
      const finalized = network.finalizeWithVotes(block, votes);
      persist(network);
      return json(response, 201, { block: finalized, quorum: votes.length, peerErrors: errors });
    }
    if (request.method === 'POST' && url.pathname === '/consensus/vote') {
      if (!requireAuth(request, response, peerToken)) return;
      if (!production) return json(response, 403, { error: 'Peer voting endpoint is production-only' });
      const body = await readBody(request);
      const block = body.block;
      if (!block) return json(response, 400, { error: 'block is required' });
      const vote = network.voteForBlock(block, localValidatorId);
      return json(response, 200, vote);
    }
    if (request.method === 'POST' && url.pathname === '/anchors/verify') {
      if (!requireAuth(request, response)) return;
      return json(response, 200, { valid: network.verifyAnchor(await readBody(request)) });
    }
    if (request.method === 'POST' && url.pathname === '/bdtcc/deposits/settle') {
      if (!requireAuth(request, response)) return;
      if (!rpc) return json(response, 503, { error: 'BDTCC RPC is not configured' });
      const body = await readBody(request);
      const result = await settlement.settleDeposit({ txid: body.txid, vout: body.vout, recipient: body.recipient, expectedAmount: body.expectedAmount, expectedAddress: body.expectedAddress || depositAddress, proposerId: body.proposerId || localValidatorId });
      persist(network);
      return json(response, 201, result);
    }
    if (request.method === 'POST' && url.pathname === '/bdtcc/withdrawals/mark-broadcast') {
      if (!requireAuth(request, response)) return;
      const body = await readBody(request);
      return json(response, 200, await settlement.markWithdrawalBroadcast(body.intentId, body.externalTxId));
    }
    if (request.method === 'POST' && url.pathname === '/bdtcc/withdrawals/mark-settled') {
      if (!requireAuth(request, response)) return;
      const body = await readBody(request);
      return json(response, 200, await settlement.markWithdrawalSettled(body.intentId, body.externalTxId));
    }
    if (request.method === 'POST' && url.pathname === '/bdtcc/withdrawals/broadcast') {
      if (!requireAuth(request, response)) return;
      if (!rpc) return json(response, 503, { error: 'BDTCC RPC is not configured' });
      const body = await readBody(request);
      return json(response, 200, await settlement.broadcastWithdrawal(body.intentId, body.rawTransaction, body.maxFeeRate));
    }
    if (request.method === 'POST' && url.pathname === '/bdtcc/withdrawals/confirm') {
      if (!requireAuth(request, response)) return;
      if (!rpc) return json(response, 503, { error: 'BDTCC RPC is not configured' });
      const body = await readBody(request);
      return json(response, 200, await settlement.confirmWithdrawal(body.intentId));
    }
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    const status = /authentication required/i.test(error.message) ? 401 : 400;
    return json(response, status, { error: error.message });
  }
});

server.listen(port, () => console.log(`IIT-NETWORK node listening on http://localhost:${port}`));
