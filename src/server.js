import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createIdentity } from './crypto.js';
import { CHAIN_ID, HybridNetwork } from './hybrid.js';

const port = Number(process.env.PORT || 8787);
const dataFile = path.resolve(process.env.DATA_FILE || 'data/node.json');

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

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value, null, 2));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true, chainId: CHAIN_ID, height: network.blocks.length, anchors: network.anchors.length });
    if (request.method === 'GET' && request.url === '/state') return json(response, 200, { chainId: CHAIN_ID, height: network.blocks.length, pending: network.pending.length, balances: Object.fromEntries(network.state), nonces: Object.fromEntries(network.nonces) });
    if (request.method === 'GET' && request.url === '/blocks') return json(response, 200, network.blocks);
    if (request.method === 'GET' && request.url === '/anchors') return json(response, 200, network.anchors);
    if (request.method === 'POST' && request.url === '/transactions') {
      const transaction = network.submitTransaction(await readBody(request));
      persist(network);
      return json(response, 201, transaction);
    }
    if (request.method === 'POST' && request.url === '/blocks/propose') {
      const block = network.proposeBlock((await readBody(request)).proposer || network.validators.keys().next().value);
      persist(network);
      return json(response, 201, block);
    }
    if (request.method === 'POST' && request.url === '/anchors/verify') return json(response, 200, { valid: network.verifyAnchor(await readBody(request)) });
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    return json(response, 400, { error: error.message });
  }
});

server.listen(port, () => console.log(`IIT-NETWORK node listening on http://localhost:${port}`));