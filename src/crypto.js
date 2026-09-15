import crypto from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

export function createIdentity(id) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    id,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

export function sign(value, privateKey) {
  return crypto.sign(null, Buffer.from(canonical(value)), privateKey).toString('base64');
}

export function verify(value, signature, publicKey) {
  return crypto.verify(null, Buffer.from(canonical(value)), publicKey, Buffer.from(signature, 'base64'));
}
