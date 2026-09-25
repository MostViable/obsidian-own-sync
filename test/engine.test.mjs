import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maxFileBytes, SyncEngine, SyncError } from '../src/sync/engine.ts';
import { decodePacket, digestBytes } from '../src/sync/packet.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VAULT_ID = 'a'.repeat(32);
const SMALL_LIMIT = 256 * 1024;

// Mirrors the server revision contract: operation IDs are checked before revisions.
class MemoryServer {
  constructor(maxPacketBytes = 1024 * 1024) {
    this.maxPacketBytes = maxPacketBytes;
    this.commits = [];
    this.operations = new Map();
    this.offline = false;
    this.unauthorized = false;
    this.loseNextReply = false;
    this.beforeUpload = null;
  }

  check() {
    if (this.offline) throw new SyncError('offline', 'Could not reach the server.');
    if (this.unauthorized) throw new SyncError('unauthorized', 'No access.');
  }

  port() {
    return {
      capabilities: async () => {
        if (this.offline) throw new SyncError('offline', 'Could not reach the server.');
        return { protocol_version: 0, packet_format_version: 1, max_packet_bytes: this.maxPacketBytes };
      },
      head: async () => {
        this.check();
        return this.commits.length;
      },
      commit: async (revision) => {
        this.check();
        const packet = this.commits[revision - 1];
        if (packet === undefined) throw new SyncError('server', 'Unknown revision.');
        return packet.slice().buffer;
      },
      upload: async (operationId, expectedRevision, body) => {
        if (this.offline) throw new SyncError('offline', 'Could not reach the server.');
        if (this.unauthorized) return { status: 401, json: { error: 'unauthorized' } };
        if (this.beforeUpload !== null) {
          const hook = this.beforeUpload;
          this.beforeUpload = null;
          await hook();
        }
        if (body.byteLength > this.maxPacketBytes) return { status: 413, json: { error: 'packet_too_large' } };
        const digest = await digestBytes(body);
        const previous = this.operations.get(operationId);
        let reply;
        if (previous !== undefined) {
          reply = previous.expectedRevision === expectedRevision && previous.digest === digest
            ? { status: 200, json: { result: 'replayed', revision: previous.revision } }
            : { status: 409, json: { error: 'operation_id_reused' } };
        } else if (expectedRevision !== this.commits.length) {
          reply = { status: 409, json: { result: 'conflict', current_revision: this.commits.length } };
        } else {
          this.commits.push(new Uint8Array(body));
          this.operations.set(operationId, { expectedRevision, digest, revision: this.commits.length });
          reply = { status: 201, json: { result: 'applied', revision: this.commits.length } };
        }
        if (this.loseNextReply) {
          this.loseNextReply = false;
          throw new SyncError('offline', 'Connection lost.');
        }
        return reply;
      },
    };
  }
}

class MemoryVault {
  constructor() {
    this.files = new Map();
    this.clock = 1;
    this.reads = 0;
    this.failWritesAfter = Infinity;
    this.beforeStat = null;
  }

  set(path, content) {
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    this.files.set(path, { bytes: new Uint8Array(bytes), mtime: this.clock++ });
  }

  text(path) {
    const file = this.files.get(path);
    return file === undefined ? undefined : decoder.decode(file.bytes);
  }

  paths() {
    return [...this.files.keys()].sort();
  }

  info(path) {
    const file = this.files.get(path);
    return file === undefined ? null : { path, mtime: file.mtime, size: file.bytes.byteLength };
  }

  port() {
    return {
      list: () => [...this.files.keys()].map((path) => this.info(path)),
      stat: (path) => {
        if (this.beforeStat !== null) {
          const hook = this.beforeStat;
          this.beforeStat = null;
          hook(path);
        }
        return this.info(path);
      },
      read: async (path) => {
        this.reads += 1;
        return this.files.get(path)?.bytes.slice() ?? null;
      },
      write: async (path, bytes) => {
        if (this.failWritesAfter <= 0) throw new Error('Device powered off.');
        this.failWritesAfter -= 1;
        this.set(path, bytes);
      },
      trash: async (path) => {
        this.files.delete(path);
      },
    };
  }
}

class MemoryStorage {
  constructor() {
    this.files = new Map();
  }

  port() {
    return {
      read: async (name) => this.files.get(name)?.slice() ?? null,
      write: async (name, bytes) => {
        this.files.set(name, new Uint8Array(bytes));
      },
      remove: async (name) => {
        this.files.delete(name);
      },
    };
  }
}

function device(server, second = 0) {
  const vault = new MemoryVault();
  const storage = new MemoryStorage();
  const engine = new SyncEngine({
    serverUrl: 'https://sync.example.com', vaultId: VAULT_ID,
    vault: vault.port(), server: server.port(), storage: storage.port(),
    now: () => new Date(2026, 8, 25, 14, 30, second),
  });
  return { vault, storage, engine, sync: (fullScan) => engine.sync(fullScan) };
}

function snapshot(vault) {
  return Object.fromEntries(vault.paths().map((path) => [path, vault.text(path)]));
}

test('propagates create, edit, rename and delete to a second device', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('Daily/2026-09-25.md', 'first');
  laptop.vault.set('Ideas.md', 'idea');
  await laptop.sync();
  await phone.sync();
  assert.deepEqual(snapshot(phone.vault), snapshot(laptop.vault));

  laptop.vault.set('Daily/2026-09-25.md', 'edited');
  laptop.vault.files.set('Projects/Ideas.md', laptop.vault.files.get('Ideas.md'));
  laptop.vault.files.delete('Ideas.md');
  await laptop.sync();
  await phone.sync();
  assert.deepEqual(snapshot(phone.vault), { 'Daily/2026-09-25.md': 'edited', 'Projects/Ideas.md': 'idea' });

  phone.vault.files.delete('Projects/Ideas.md');
  await phone.sync();
  await laptop.sync();
  assert.deepEqual(laptop.vault.paths(), ['Daily/2026-09-25.md']);
});

test('uploads a vault larger than one packet in several commits and keeps attachments byte for byte', async () => {
  const server = new MemoryServer(SMALL_LIMIT);
  const laptop = device(server);
  const phone = device(server);
  const image = new Uint8Array(100 * 1024).map((_, index) => (index * 31) % 256);
  for (let index = 0; index < 8; index += 1) laptop.vault.set(`Attachments/photo-${index}.png`, image);
  laptop.vault.set('Note with ссылка.md', '![[photo-0.png]]');
  const report = await laptop.sync();
  assert.ok(server.commits.length > 1, 'expected several commits');
  assert.equal(report.uploadedCommits, server.commits.length);
  for (const packet of server.commits) assert.ok(packet.byteLength <= SMALL_LIMIT);

  await phone.sync();
  assert.deepEqual(phone.vault.paths(), laptop.vault.paths());
  assert.deepEqual(phone.vault.files.get('Attachments/photo-7.png').bytes, image);
});

test('reports a file above the server limit and never deletes its synced version', async () => {
  const server = new MemoryServer(SMALL_LIMIT);
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('video.mp4', new Uint8Array(1000));
  await laptop.sync();
  await phone.sync();

  laptop.vault.set('video.mp4', new Uint8Array(maxFileBytes(SMALL_LIMIT) + 1));
  laptop.vault.set('huge.pdf', new Uint8Array(maxFileBytes(SMALL_LIMIT) + 1));
  const commits = server.commits.length;
  const report = await laptop.sync();
  assert.deepEqual(report.oversized, ['huge.pdf', 'video.mp4']);
  assert.equal(server.commits.length, commits);
  await phone.sync();
  assert.equal(phone.vault.files.get('video.mp4').bytes.byteLength, 1000);
  assert.ok(laptop.vault.files.has('video.mp4'));
});

test('keeps independent offline edits on different files', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('a.md', 'a0');
  laptop.vault.set('b.md', 'b0');
  await laptop.sync();
  await phone.sync();

  laptop.vault.set('a.md', 'a-laptop');
  phone.vault.set('b.md', 'b-phone');
  await laptop.sync();
  await phone.sync();
  await laptop.sync();
  const expected = { 'a.md': 'a-laptop', 'b.md': 'b-phone' };
  assert.deepEqual(snapshot(laptop.vault), expected);
  assert.deepEqual(snapshot(phone.vault), expected);
});

test('same file edited on two devices keeps both versions everywhere', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('Plan.md', 'base');
  await laptop.sync();
  await phone.sync();

  laptop.vault.set('Plan.md', 'laptop version');
  phone.vault.set('Plan.md', 'phone version');
  await laptop.sync();
  const report = await phone.sync();
  assert.deepEqual(report.conflictCopies, ['Plan (conflict 2026-09-25 14-30-00).md']);
  await laptop.sync();
  const expected = {
    'Plan (conflict 2026-09-25 14-30-00).md': 'laptop version',
    'Plan.md': 'phone version',
  };
  assert.deepEqual(snapshot(phone.vault), expected);
  assert.deepEqual(snapshot(laptop.vault), expected);
});

test('an offline edit survives a deletion from another device in both orders', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('keep.md', 'v0');
  laptop.vault.set('restore.md', 'v0');
  await laptop.sync();
  await phone.sync();

  laptop.vault.files.delete('keep.md');
  laptop.vault.set('restore.md', 'laptop edit');
  phone.vault.set('keep.md', 'phone edit');
  phone.vault.files.delete('restore.md');
  await laptop.sync();
  await phone.sync();
  await laptop.sync();
  const expected = { 'keep.md': 'phone edit', 'restore.md': 'laptop edit' };
  assert.deepEqual(snapshot(laptop.vault), expected);
  assert.deepEqual(snapshot(phone.vault), expected);
});

test('a lost upload reply is replayed without duplicate commits or conflict copies', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  laptop.vault.set('a.md', 'one');
  server.loseNextReply = true;
  await assert.rejects(laptop.sync(), (error) => error.kind === 'offline');
  assert.equal(server.commits.length, 1);
  const report = await laptop.sync();
  assert.equal(server.commits.length, 1);
  assert.deepEqual(report.conflictCopies, []);
  assert.equal(report.revision, 1);
});

test('an interrupted remote apply resumes without losing files or duplicating conflict copies', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server, 1);
  laptop.vault.set('shared.md', 'base');
  await laptop.sync();
  await phone.sync();

  laptop.vault.set('shared.md', 'laptop');
  for (let index = 0; index < 5; index += 1) laptop.vault.set(`new-${index}.md`, `n${index}`);
  await laptop.sync();
  phone.vault.set('shared.md', 'phone');
  phone.vault.failWritesAfter = 2;
  await assert.rejects(phone.sync(), /powered off/);
  phone.vault.failWritesAfter = Infinity;
  await phone.sync();
  await laptop.sync();

  const copies = phone.vault.paths().filter((path) => path.includes('(conflict'));
  assert.equal(copies.length, 1);
  assert.equal(phone.vault.text('shared.md'), 'phone');
  assert.equal(phone.vault.text(copies[0]), 'laptop');
  assert.deepEqual(snapshot(laptop.vault), snapshot(phone.vault));
});

test('joining a populated vault merges without replacing local files', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('same.md', 'identical');
  laptop.vault.set('clash.md', 'server text');
  laptop.vault.set('only-server.md', 'server');
  await laptop.sync();

  phone.vault.set('same.md', 'identical');
  phone.vault.set('clash.md', 'phone text');
  phone.vault.set('only-phone.md', 'phone');
  const report = await phone.sync();
  assert.deepEqual(report.conflictCopies, ['clash (conflict 2026-09-25 14-30-00).md']);
  await laptop.sync();
  const expected = {
    'clash (conflict 2026-09-25 14-30-00).md': 'server text',
    'clash.md': 'phone text',
    'only-phone.md': 'phone',
    'only-server.md': 'server',
    'same.md': 'identical',
  };
  assert.deepEqual(snapshot(phone.vault), expected);
  assert.deepEqual(snapshot(laptop.vault), expected);
});

test('offline server and revoked access keep local changes for a later sync', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('a.md', 'a');
  await laptop.sync();
  await phone.sync();

  laptop.vault.set('a.md', 'written offline');
  server.offline = true;
  await assert.rejects(laptop.sync(), (error) => error.kind === 'offline');
  server.offline = false;
  server.unauthorized = true;
  await assert.rejects(laptop.sync(), (error) => error.kind === 'unauthorized');
  server.unauthorized = false;
  await laptop.sync();
  await phone.sync();
  assert.equal(phone.vault.text('a.md'), 'written offline');
});

test('parallel uploads from two devices both land after one conflict', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('base.md', 'base');
  await laptop.sync();
  await phone.sync();

  laptop.vault.set('laptop.md', 'from laptop');
  phone.vault.set('phone.md', 'from phone');
  server.beforeUpload = () => laptop.sync();
  await phone.sync();
  await laptop.sync();
  const expected = { 'base.md': 'base', 'laptop.md': 'from laptop', 'phone.md': 'from phone' };
  assert.deepEqual(snapshot(laptop.vault), expected);
  assert.deepEqual(snapshot(phone.vault), expected);
  assert.equal(server.commits.length, 3);
});

test('a server restored from an older backup merges again without deleting files', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  laptop.vault.set('old.md', 'old');
  await laptop.sync();
  laptop.vault.set('newer.md', 'newer');
  await laptop.sync();
  server.commits.length = 1;
  server.operations.clear();

  const report = await laptop.sync();
  assert.equal(report.serverReset, true);
  assert.deepEqual(laptop.vault.paths(), ['newer.md', 'old.md']);
  const fresh = device(server);
  await fresh.sync();
  assert.deepEqual(snapshot(fresh.vault), { 'newer.md': 'newer', 'old.md': 'old' });
});

test('a local edit made during a remote apply is never overwritten', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('note.md', 'v0');
  await laptop.sync();
  await phone.sync();

  laptop.vault.set('note.md', 'remote v1');
  await laptop.sync();
  phone.vault.beforeStat = () => phone.vault.set('note.md', 'typed just now');
  await assert.rejects(phone.sync(), (error) => error.kind === 'busy');
  await phone.sync();
  assert.equal(phone.vault.text('note.md'), 'typed just now');
  await laptop.sync();
  assert.equal(laptop.vault.text('note.md'), 'typed just now');
  assert.ok(laptop.vault.paths().some((path) => path.startsWith('note (conflict')));
});

test('syncs Cyrillic names with spaces and stops on names that differ only by case', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  const phone = device(server);
  laptop.vault.set('Заметки/Список покупок.md', 'молоко');
  await laptop.sync();
  await phone.sync();
  assert.equal(phone.vault.text('Заметки/Список покупок.md'), 'молоко');

  laptop.vault.set('Заметки/список покупок.md', 'другой');
  await assert.rejects(laptop.sync(), (error) => error.kind === 'local');
});

test('skips unsupported file names without blocking other files', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  laptop.vault.set('README', 'no extension');
  laptop.vault.set('note.md', 'ok');
  const report = await laptop.sync();
  assert.deepEqual(report.invalidPaths, ['README']);
  const changes = await decodePacket(server.commits[0].slice().buffer);
  assert.deepEqual(changes.map((change) => change.path), ['note.md']);
});

test('reuses cached digests for unchanged files between syncs', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  for (let index = 0; index < 20; index += 1) laptop.vault.set(`n${index}.md`, `note ${index}`);
  await laptop.sync();
  laptop.vault.reads = 0;
  await laptop.sync();
  assert.equal(laptop.vault.reads, 0);
  laptop.vault.set('n3.md', 'changed');
  await laptop.sync();
  assert.ok(laptop.vault.reads >= 1 && laptop.vault.reads <= 3);
});

test('a damaged sync state starts a safe merge instead of deleting files', async () => {
  const server = new MemoryServer();
  const laptop = device(server);
  laptop.vault.set('a.md', 'a');
  await laptop.sync();
  laptop.storage.files.set('sync-state.json', encoder.encode('{broken'));
  laptop.vault.set('b.md', 'b');
  await laptop.sync();
  const fresh = device(server);
  await fresh.sync();
  assert.deepEqual(snapshot(fresh.vault), { 'a.md': 'a', 'b.md': 'b' });
});
