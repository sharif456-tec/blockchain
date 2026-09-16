import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createIdentity } from './crypto.js';
import { CHAIN_ID, HybridNetwork } from './hybrid.js';
import { BdtccBridge, BdtccRpcClient } from './bdtcc.js';
import { BdtccSettlement } from './bdtcc_settlement.js';
import { JsonSettlementStore } from './bdtcc_store.js';

const port = Number(process.env.PORT || 8787);
const dataFile = path.resolve(process.env.DATA_FILE || 'data/node.json');
const settlementFile = path.resolve(process.env.BDTCC_SETTLEMENT_FILE || 'data/bdtcc-settlement.json');
const apiToken = process.env.NODE_API_TOKEN || '';
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 1_048_576);
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);

function createNetwork() {
  if (fs.existsSync(dataFile)) return HybridNetwork.fromSnapshot(JSON.parse(fs.readFileSync(dataFile, 'utf8')));
  const validators = ['validator-a', 'validator-b', 'validator-c'].map(createIdentity);
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

const network = createNetwork();
const treasuryIdentity = network.validators.get('validator-a');
const rpcUrl = process.env.BDTCC_RPC_URL;
const rpc = rpcUrl ? new BdtccRpcClient({
  url: rpcUrl,
  username: process.env.BDTCC_RPC_USERNAME,
  password: process.env.BDTCC_RPC_PASSWORD
}) : null;
const bridge = new BdtccBridge({
  networkId: process.env.BDTCC_NETWORK_ID || 'bdtcc',
  minConfirmations: Number(process.env.BDTCC_MIN_CONFIRMATIONS || 6),
  rpc
});
const settlement = new BdtccSettlement({
  bridge,
  network,
  treasuryAddress: process.env.BDTC_TREASURY_ADDRESS || 'treasury',
  treasuryIdentity,
  reserveAddress: process.env.BDTC_RESERVE_ADDRESS || 'bdtc-reserve',
  store: new JsonSettlementStore({ filePath: settlementFile })
});

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value, null, 2));
}

function authorized(request) {
  if (!apiToken) return true;
  const supplied = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : request.headers['x-api-key'];
  return supplied === apiToken;
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

function requireAuth(request, response) {
  if (authorized(request)) return true;
  json(response, 401, { error: 'Authentication required' });
  return false;
}

await settlement.init();

const server = http.createServer(async (request, response) => {
  response.setTimeout(requestTimeoutMs, () => response.destroy());
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, {
        ok: true,
        chainId: CHAIN_ID,
        height: network.blocks.length,
        anchors: network.anchors.length,
        bdtcc: { configured: Boolean(rpc), networkId: bridge.networkId, minConfirmations: bridge.minConfirmations }
      });
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
      return json(response, 200, { configured: Boolean(rpc), networkId: bridge.networkId, minConfirmations: bridge.minConfirmations, chain });
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
      const block = network.proposeBlock((await readBody(request)).proposer || network.validators.keys().next().value);
      persist(network);
      return json(response, 201, block);
    }
    if (request.method === 'POST' && url.pathname === '/anchors/verify') {
      if (!requireAuth(request, response)) return;
      return json(response, 200, { valid: network.verifyAnchor(await readBody(request)) });
    }
    if (request.method === 'POST' && url.pathname === '/bdtcc/deposits/settle') {
      if (!requireAuth(request, response)) return;
      if (!rpc) return json(response, 503, { error: 'BDTCC RPC is not configured' });
      const body = await readBody(request);
      const result = await settlement.settleDeposit({
        txid: body.txid,
        vout: body.vout,
        recipient: body.recipient,
        expectedAmount: body.expectedAmount,
        expectedAddress: body.expectedAddress || process.env.BDTCC_DEPOSIT_ADDRESS,
        proposerId: body.proposerId || network.validators.keys().next().value
      });
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
