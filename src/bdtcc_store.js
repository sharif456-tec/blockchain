import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class JsonSettlementStore {
  constructor({ filePath = 'data/bdtcc-settlement.json' } = {}) {
    this.filePath = filePath;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        consumedDeposits: Array.isArray(parsed.consumedDeposits) ? parsed.consumedDeposits : [],
        withdrawals: Array.isArray(parsed.withdrawals) ? parsed.withdrawals : []
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { consumedDeposits: [], withdrawals: [] };
      }
      throw new Error(`Unable to load BDTCC settlement state: ${error.message}`);
    }
  }

  async save({ consumedDeposits, withdrawals }) {
    const payload = JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      consumedDeposits: [...consumedDeposits],
      withdrawals: [...withdrawals.entries()].map(([intentId, record]) => ({
        intentId,
        record: clone(record)
      }))
    }, null, 2);

    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}
