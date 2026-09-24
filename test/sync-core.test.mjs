import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyInitialSnapshot } from '../src/sync/apply.ts';
import { assertNoCaseCollisions, assertNoFileDirectoryCollisions, planSync } from '../src/sync/plan.ts';
import { applyPacketToDigests, createPendingDownload, createPendingUpload, decodePacket, digestBytes, encodePacket, readPendingDownload, readPendingUpload, validateSyncPath } from '../src/sync/packet.ts';
import { changesFromLocal, confirmedAfterInitialDownload, confirmedAfterUpload, planFromConfirmed, readConfirmedState } from '../src/sync/state.ts';

const map = (entries) => new Map(entries);

test('plans independent offline changes without conflict', () => {
  assert.deepEqual(planSync(map([['a.md', 'a0'], ['b.md', 'b0']]),
    map([['a.md', 'a1'], ['b.md', 'b0']]), map([['a.md', 'a0'], ['b.md', 'b1']])), [
    { path: 'a.md', action: 'push' },
    { path: 'b.md', action: 'pull' },
  ]);
});

test('detects edits on the same path and edit versus delete', () => {
  assert.deepEqual(planSync(map([['a.md', 'old'], ['b.md', 'old']]),
    map([['a.md', 'left']]), map([['a.md', 'right'], ['b.md', 'right']])), [
    { path: 'a.md', action: 'conflict' },
    { path: 'b.md', action: 'conflict' },
  ]);
});

test('preserves same edits and sends an uncontested deletion', () => {
  assert.deepEqual(planSync(map([['a.md', 'old'], ['b.md', 'old']]),
    map([['a.md', 'same']]), map([['a.md', 'same'], ['b.md', 'old']])), [
    { path: 'b.md', action: 'push' },
  ]);
});

test('pulls a remote deletion and ignores a deletion already made on both sides', () => {
  assert.deepEqual(planSync(map([['a.md', 'old'], ['b.md', 'old']]),
    map([['a.md', 'old']]), map([])), [
    { path: 'a.md', action: 'pull' },
  ]);
});

test('first sync does not overwrite differently populated paths', () => {
  assert.deepEqual(planSync(map([]), map([['same.md', 'local']]), map([['same.md', 'remote']])), [
    { path: 'same.md', action: 'conflict' },
  ]);
});

test('detects case collisions before applying remote paths', () => {
  assert.throws(() => assertNoCaseCollisions(['Notes/A.md', 'notes/a.md']));
  assert.throws(() => assertNoCaseCollisions(['Notes/A.md', 'notes/B.md']));
  assert.doesNotThrow(() => assertNoCaseCollisions(['A.md', 'B.md']));
  assert.doesNotThrow(() => assertNoCaseCollisions(['Notes/A.md', 'Notes/B.md']));
});

test('rejects remote file paths that are also parent directories', () => {
  assert.throws(() => assertNoFileDirectoryCollisions(['note.md', 'note.md/child.md']));
  assert.doesNotThrow(() => assertNoFileDirectoryCollisions(['folder/a.md', 'folder/b.md']));
});

test('binary packet round trips Cyrillic paths and deletion', async () => {
  const changes = [
    { path: 'Папка/заметка.md', kind: 'put', bytes: new Uint8Array([0, 255, 42]) },
    { path: 'old.png', kind: 'delete' },
  ];
  const packet = await encodePacket(changes);
  assert.deepEqual(await decodePacket(packet.buffer), changes);
});

test('replays remote create, update and delete in revision order', async () => {
  const remote = new Map();
  const first = await encodePacket([
    { path: 'a.md', kind: 'put', bytes: new Uint8Array([1]) },
    { path: 'b.md', kind: 'put', bytes: new Uint8Array([2]) },
  ]);
  const second = await encodePacket([
    { path: 'a.md', kind: 'put', bytes: new Uint8Array([3]) },
    { path: 'b.md', kind: 'delete' },
  ]);
  await applyPacketToDigests(remote, first.buffer);
  await applyPacketToDigests(remote, second.buffer);
  assert.deepEqual([...remote], [['a.md', await digestBytes(new Uint8Array([3]))]]);
});

test('rejects traversal and paths unsafe across platforms', () => {
  for (const path of ['../a.md', 'a/../b.md', '/a.md', 'a\\b.md', '.obsidian/data.json',
    'a/.hidden', 'CON.txt', 'a/file.', 'a//b', 'extensionless']) {
    assert.throws(() => validateSyncPath(path), undefined, path);
  }
});

test('rejects corrupted content and duplicate paths', async () => {
  const packet = await encodePacket([{ path: 'a.md', kind: 'put', bytes: new Uint8Array([1]) }]);
  const encoded = JSON.parse(new TextDecoder().decode(packet));
  encoded.changes[0].sha256 = '0'.repeat(64);
  await assert.rejects(decodePacket(new TextEncoder().encode(JSON.stringify(encoded)).buffer));
  await assert.rejects(encodePacket([
    { path: 'a.md', kind: 'delete' }, { path: 'a.md', kind: 'delete' },
  ]));
});

test('rejects unsupported versions, extra fields and oversized packets', async () => {
  const packet = await encodePacket([{ path: 'a.md', kind: 'delete' }]);
  const encoded = JSON.parse(new TextDecoder().decode(packet));
  encoded.format_version = 2;
  await assert.rejects(decodePacket(new TextEncoder().encode(JSON.stringify(encoded)).buffer));
  encoded.format_version = 1;
  encoded.extra = true;
  await assert.rejects(decodePacket(new TextEncoder().encode(JSON.stringify(encoded)).buffer));
  await assert.rejects(encodePacket([
    { path: 'large.bin', kind: 'put', bytes: new Uint8Array(800_000) },
  ]));
});

test('persists exact packet bytes and operation ID for retry', async () => {
  const packet = await encodePacket([{ path: 'test.md', kind: 'put', bytes: new Uint8Array([1, 2]) }]);
  const pending = createPendingUpload('https://sync.example.com', 'a'.repeat(32), packet);
  const restored = await readPendingUpload(JSON.parse(JSON.stringify(pending)));
  assert.equal(restored.pending.operationId, pending.operationId);
  assert.deepEqual(new Uint8Array(restored.body), packet);
  await assert.rejects(readPendingUpload({ ...pending, packetText: pending.packetText.replace('test.md', '../test.md') }));
});

test('persists an initial download and rejects deletions', async () => {
  const packet = await encodePacket([{ path: 'test.md', kind: 'put', bytes: new Uint8Array([1]) }]);
  const pending = createPendingDownload('https://sync.example.com', 'b'.repeat(32), packet.buffer);
  const restored = await readPendingDownload(JSON.parse(JSON.stringify(pending)));
  assert.deepEqual(restored.changes, [{ path: 'test.md', kind: 'put', bytes: new Uint8Array([1]) }]);
  const deletion = await encodePacket([{ path: 'test.md', kind: 'delete' }]);
  await assert.rejects(readPendingDownload(createPendingDownload('https://sync.example.com', 'b'.repeat(32), deletion.buffer)));
});

test('initial download creates nested binary files and resumes after an interrupted write', async () => {
  const files = new Map();
  const folders = new Set();
  let interruptAfterFirstCreate = true;
  const store = {
    listPaths: () => [...files.keys()],
    read: async (path) => files.get(path) ?? null,
    ensureFolder: async (path) => {
      if (files.has(path)) throw new Error('parent is a file');
      folders.add(path);
    },
    create: async (path, bytes) => {
      if (files.has(path)) throw new Error('would overwrite');
      files.set(path, new Uint8Array(bytes));
      if (interruptAfterFirstCreate) {
        interruptAfterFirstCreate = false;
        throw new Error('simulated interruption');
      }
    },
  };
  const changes = [
    { path: 'Notes/a.md', kind: 'put', bytes: new Uint8Array([1]) },
    { path: 'Notes/b.bin', kind: 'put', bytes: new Uint8Array([0, 255]) },
  ];
  await assert.rejects(applyInitialSnapshot(store, changes));
  assert.deepEqual([...files.keys()], ['Notes/a.md']);
  await applyInitialSnapshot(store, changes);
  assert.deepEqual([...files.keys()], ['Notes/a.md', 'Notes/b.bin']);
  assert.ok(folders.has('Notes'));
});

test('initial download refuses unrelated or modified files without overwriting them', async () => {
  const files = new Map([['note.md', new Uint8Array([9])]]);
  let created = false;
  const store = {
    listPaths: () => [...files.keys()],
    read: async (path) => files.get(path) ?? null,
    ensureFolder: async () => {},
    create: async () => { created = true; },
  };
  const changes = [{ path: 'note.md', kind: 'put', bytes: new Uint8Array([1]) }];
  await assert.rejects(applyInitialSnapshot(store, changes));
  assert.equal(created, false);
  assert.deepEqual(files.get('note.md'), new Uint8Array([9]));
  files.set('unrelated.md', new Uint8Array([2]));
  await assert.rejects(applyInitialSnapshot(store, changes));
  assert.equal(created, false);
});

test('persists a confirmed baseline after upload and advances it with edits and deletion', async () => {
  const first = await encodePacket([
    { path: 'a.md', kind: 'put', bytes: new Uint8Array([1]) },
    { path: 'b.md', kind: 'put', bytes: new Uint8Array([2]) },
  ]);
  const initial = createPendingUpload('https://sync.example.com', 'a'.repeat(32), first);
  const confirmed = await confirmedAfterUpload(null, initial);
  assert.equal(confirmed.revision, 1);
  assert.equal(readConfirmedState(JSON.parse(JSON.stringify(confirmed))).digests.size, 2);

  const next = await encodePacket([
    { path: 'a.md', kind: 'put', bytes: new Uint8Array([3]) },
    { path: 'b.md', kind: 'delete' },
  ]);
  const pending = createPendingUpload(confirmed.serverUrl, confirmed.vaultId, next, 1);
  const advanced = await confirmedAfterUpload(confirmed, pending);
  assert.equal(advanced.revision, 2);
  assert.deepEqual(Object.keys(advanced.digests), ['a.md']);
  assert.equal(advanced.digests['a.md'], await digestBytes(new Uint8Array([3])));
  await assert.rejects(confirmedAfterUpload(null, pending));
});

test('builds local put and delete changes from a confirmed baseline', async () => {
  const a = await digestBytes(new Uint8Array([1]));
  const b = await digestBytes(new Uint8Array([2]));
  const c = await digestBytes(new Uint8Array([3]));
  const changes = changesFromLocal(map([['a.md', a], ['b.md', b]]), map([
    ['a.md', { digest: a, bytes: new Uint8Array([1]) }],
    ['c.bin', { digest: c, bytes: new Uint8Array([3]) }],
  ]));
  assert.deepEqual(changes, [
    { path: 'b.md', kind: 'delete' },
    { path: 'c.bin', kind: 'put', bytes: new Uint8Array([3]) },
  ]);
});

test('initial download creates the same confirmed baseline', async () => {
  const packet = await encodePacket([{ path: 'x.md', kind: 'put', bytes: new Uint8Array([7]) }]);
  const pending = createPendingDownload('https://sync.example.com', 'b'.repeat(32), packet.buffer);
  const confirmed = await confirmedAfterInitialDownload(pending);
  assert.equal(confirmed.revision, 1);
  assert.equal(confirmed.digests['x.md'], await digestBytes(new Uint8Array([7])));
});

test('rejects corrupted confirmed digests and preserves old pending upload format', async () => {
  const packet = await encodePacket([{ path: 'x.md', kind: 'put', bytes: new Uint8Array([1]) }]);
  const pending = createPendingUpload('https://sync.example.com', 'c'.repeat(32), packet);
  delete pending.expectedRevision;
  const restored = await readPendingUpload(JSON.parse(JSON.stringify(pending)));
  assert.equal(restored.pending.expectedRevision ?? 0, 0);
  const confirmed = await confirmedAfterUpload(null, pending);
  confirmed.digests['x.md'] = 'bad';
  assert.throws(() => readConfirmedState(confirmed));
});

test('previews remote revisions against the confirmed base and local offline edits', async () => {
  const old = await digestBytes(new Uint8Array([1]));
  const localEdit = await digestBytes(new Uint8Array([2]));
  const remoteEdit = await digestBytes(new Uint8Array([3]));
  const base = map([['pull.md', old], ['conflict.md', old], ['deleted.md', old]]);
  const local = map([
    ['pull.md', old], ['conflict.md', localEdit], ['deleted.md', old], ['local.md', localEdit],
  ]);
  const remote = new Map(base);
  const packet = await encodePacket([
    { path: 'pull.md', kind: 'put', bytes: new Uint8Array([3]) },
    { path: 'conflict.md', kind: 'put', bytes: new Uint8Array([3]) },
    { path: 'deleted.md', kind: 'delete' },
  ]);
  await applyPacketToDigests(remote, packet.buffer);
  assert.equal(remote.get('pull.md'), remoteEdit);
  assert.deepEqual(planFromConfirmed(base, local, remote), [
    { path: 'conflict.md', action: 'conflict' },
    { path: 'deleted.md', action: 'pull' },
    { path: 'local.md', action: 'push' },
    { path: 'pull.md', action: 'pull' },
  ]);
  assert.equal(base.get('pull.md'), old);
});

test('confirmed preview rejects paths that cannot safely coexist', () => {
  assert.throws(() => planFromConfirmed(map([]), map([['Notes/a.md', 'local']]),
    map([['notes/b.md', 'remote']])));
  assert.throws(() => planFromConfirmed(map([]), map([['parent.md', 'local']]),
    map([['parent.md/child.md', 'remote']])));
});
