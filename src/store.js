import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function initialState() {
  return { version: 1, days: {}, positions: [], paused: null };
}

export class Store {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
  }

  load() {
    if (!fs.existsSync(this.file)) return initialState();
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (state.version !== 1 || !state.days || !Array.isArray(state.positions)) {
      throw new Error('Estado persistente invalido; revisar state.json antes de continuar');
    }
    return state;
  }

  botId() {
    const file = path.join(this.directory, 'bot-id');
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const id = fs.readFileSync(file, 'utf8').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('DATA_DIR/bot-id invalido; revisar sin regenerar la identidad de un bot activo');
      return id;
    }
    const id = randomUUID();
    try {
      fs.writeFileSync(fd, id);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return id;
  }

  save(state) {
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }

  lock() {
    const file = path.join(this.directory, 'process.lock');
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
      fs.closeSync(fd);
    } catch {
      throw new Error('Existe process.lock. Detener otras instancias y revisar README antes de retirarlo.');
    }
    return () => fs.unlinkSync(file);
  }
}
