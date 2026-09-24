import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyInitialSnapshot, applyRemoteChanges } from '../src/sync/apply.ts';
import { assertCompatibleCapabilities } from '../src/sync/capabilities.ts';
import { assertNoCaseCollisions, assertNoFileDirectoryCollisions, planSync } from '../src/sync/plan.ts';
import { applyPacketToDigests, classifyUploadResponse, createPendingDownload, createPendingUpload, decodePacket, digestBytes, encodePacket, readPendingDownload, readPendingUpload, validateSyncPath } from '../src/sync/packet.ts';
import { advanceConfirmedRevision, assertRebaseLocalFiles, changesFromLocal, confirmedAfterInitialDownload, confirmedAfterPull, confirmedAfterUpload, createPendingPull, planFromConfirmed, queuedUploadDigests, readConfirmedState, readPendingPull } from '../src/sync/state.ts';

const map = (entries) => new Map(entries);

test('rejects incompatible server capabilities before sync', () => {
  assert.doesNotThrow(() => assertCompatibleCapabilities({
    protocol_version: 0, packet_format_version: 1, max_packet_bytes: 1024 * 1024,
  }));
  assert.throws(() => assertCompatibleCapabilities({
    protocol_version: 1, packet_format_version: 1, max_packet_bytes: 1024 * 1024,
  }));
  assert.throws(() => assertCompatibleCapabilities({
    protocol_version: 0, packet_format_version: 2, max_packet_bytes: 1024 * 1024,
  }));
  assert.throws(() => assertCompatibleCapabilities({
    protocol_version: 0, packet_format_version: 1, max_packet_bytes: 1024,
  }));
});

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

test('confirmed preview accepts a remote file becoming a folder', () => {
  assert.deepEqual(planFromConfirmed(map([['parent.md', 'old']]),
    map([['parent.md', 'old']]), map([['parent.md/child.md', 'new']])), [
    { path: 'parent.md', action: 'pull' },
    { path: 'parent.md/child.md', action: 'pull' },
  ]);
});

test('pending remote pull advances the confirmed base only after validated changes', async () => {
  const first = await encodePacket([
    { path: 'a.md', kind: 'put', bytes: new Uint8Array([1]) },
    { path: 'b.md', kind: 'put', bytes: new Uint8Array([2]) },
  ]);
  const confirmed = await confirmedAfterUpload(null, createPendingUpload('https://sync.example.com', 'd'.repeat(32), first));
  const packet = await encodePacket([
    { path: 'a.md', kind: 'put', bytes: new Uint8Array([3]) },
    { path: 'b.md', kind: 'delete' },
  ]);
  const pending = createPendingPull(confirmed.serverUrl, confirmed.vaultId, 1, 3, packet);
  assert.deepEqual((await readPendingPull(JSON.parse(JSON.stringify(pending)))).changes,
    await decodePacket(packet.buffer));
  const next = await confirmedAfterPull(confirmed, pending);
  assert.equal(next.revision, 3);
  assert.deepEqual(Object.keys(next.digests), ['a.md']);
  assert.equal(confirmed.revision, 1);
  await assert.rejects(confirmedAfterPull(confirmed, { ...pending, fromRevision: 2 }));
  assert.equal(advanceConfirmedRevision(confirmed, 2).revision, 2);
});

test('remote pull resumes after an interrupted deletion and preserves unrelated files', async () => {
  const files = map([
    ['old.md', new Uint8Array([1])],
    ['edit.md', new Uint8Array([1])],
    ['untouched.md', new Uint8Array([9])],
  ]);
  const removed = [];
  let interrupt = true;
  const store = {
    listPaths: () => [...files.keys()],
    read: async (path) => files.get(path) ?? null,
    ensureFolder: async () => {},
    put: async (path, bytes) => { files.set(path, new Uint8Array(bytes)); },
    remove: async (path) => {
      removed.push(path);
      files.delete(path);
      if (interrupt) {
        interrupt = false;
        throw new Error('simulated interruption');
      }
    },
  };
  const old = await digestBytes(new Uint8Array([1]));
  const base = map([['old.md', old], ['edit.md', old],
    ['untouched.md', await digestBytes(new Uint8Array([9]))]]);
  const changes = [
    { path: 'old.md', kind: 'delete' },
    { path: 'edit.md', kind: 'put', bytes: new Uint8Array([2]) },
    { path: 'new.md', kind: 'put', bytes: new Uint8Array([3]) },
  ];
  await assert.rejects(applyRemoteChanges(store, base, changes));
  assert.equal(files.has('old.md'), false);
  await applyRemoteChanges(store, base, changes);
  assert.deepEqual(removed, ['old.md']);
  assert.deepEqual(files.get('edit.md'), new Uint8Array([2]));
  assert.deepEqual(files.get('new.md'), new Uint8Array([3]));
  assert.deepEqual(files.get('untouched.md'), new Uint8Array([9]));
  await applyRemoteChanges(store, base, changes);
  assert.deepEqual(removed, ['old.md']);
});

test('remote pull rejects a local edit before any file is changed', async () => {
  const files = map([['a.md', new Uint8Array([7])], ['b.md', new Uint8Array([1])]]);
  let writes = 0;
  const store = {
    listPaths: () => [...files.keys()],
    read: async (path) => files.get(path) ?? null,
    ensureFolder: async () => {},
    put: async () => { writes += 1; },
    remove: async () => { writes += 1; },
  };
  const base = map([['a.md', await digestBytes(new Uint8Array([1]))],
    ['b.md', await digestBytes(new Uint8Array([1]))]]);
  await assert.rejects(applyRemoteChanges(store, base, [
    { path: 'b.md', kind: 'delete' },
    { path: 'a.md', kind: 'put', bytes: new Uint8Array([2]) },
  ]));
  assert.equal(writes, 0);
  assert.deepEqual(files.get('b.md'), new Uint8Array([1]));
});

test('remote pull can replace a file with a folder and resume', async () => {
  const files = map([['parent.md', new Uint8Array([1])]]);
  const folders = new Set();
  const store = {
    listPaths: () => [...files.keys()],
    read: async (path) => files.get(path) ?? null,
    ensureFolder: async (path) => {
      if (files.has(path)) throw new Error('parent is a file');
      folders.add(path);
    },
    put: async (path, bytes) => { files.set(path, new Uint8Array(bytes)); },
    remove: async (path) => { files.delete(path); },
  };
  const base = map([['parent.md', await digestBytes(new Uint8Array([1]))]]);
  const changes = [
    { path: 'parent.md', kind: 'delete' },
    { path: 'parent.md/child.md', kind: 'put', bytes: new Uint8Array([2]) },
  ];
  await applyRemoteChanges(store, base, changes);
  await applyRemoteChanges(store, base, changes);
  assert.ok(folders.has('parent.md'));
  assert.deepEqual(files.get('parent.md/child.md'), new Uint8Array([2]));
});

test('remote pull keeps an independent offline edit for a later push', async () => {
  const old = await digestBytes(new Uint8Array([1]));
  const localEdit = new Uint8Array([2]);
  const remoteEdit = new Uint8Array([3]);
  const base = map([['local.md', old], ['remote.md', old]]);
  const files = map([['local.md', localEdit], ['remote.md', new Uint8Array([1])]]);
  const remote = map([['local.md', old], ['remote.md', await digestBytes(remoteEdit)]]);
  const localDigests = map([['local.md', await digestBytes(localEdit)], ['remote.md', old]]);
  assert.deepEqual(planFromConfirmed(base, localDigests, remote), [
    { path: 'local.md', action: 'push' },
    { path: 'remote.md', action: 'pull' },
  ]);
  const store = {
    listPaths: () => [...files.keys()],
    read: async (path) => files.get(path) ?? null,
    ensureFolder: async () => {},
    put: async (path, bytes) => { files.set(path, new Uint8Array(bytes)); },
    remove: async (path) => { files.delete(path); },
  };
  await applyRemoteChanges(store, base, [{ path: 'remote.md', kind: 'put', bytes: remoteEdit }]);
  assert.deepEqual(files.get('local.md'), localEdit);
  assert.deepEqual(files.get('remote.md'), remoteEdit);
  assert.deepEqual(changesFromLocal(remote, map([
    ['local.md', { digest: await digestBytes(files.get('local.md')), bytes: files.get('local.md') }],
    ['remote.md', { digest: await digestBytes(files.get('remote.md')), bytes: files.get('remote.md') }],
  ])), [{ path: 'local.md', kind: 'put', bytes: localEdit }]);
});

test('only a confirmed revision conflict allows rebasing a queued upload', () => {
  assert.equal(classifyUploadResponse(201, { result: 'applied', revision: 2 }, 1), 'applied');
  assert.equal(classifyUploadResponse(200, { result: 'replayed', revision: 2 }, 1), 'replayed');
  assert.equal(classifyUploadResponse(409, { result: 'conflict', current_revision: 3 }, 1), 'conflict');
  assert.equal(classifyUploadResponse(409, { error: 'operation_id_reused' }, 1), 'blocked');
  assert.equal(classifyUploadResponse(409, { error: 'revision_exhausted' }, 1), 'blocked');
  assert.equal(classifyUploadResponse(409, { result: 'conflict', current_revision: 1 }, 1), 'blocked');
  assert.equal(classifyUploadResponse(200, { result: 'replayed', revision: 3 }, 1), 'blocked');
  assert.equal(classifyUploadResponse(409, { result: 'conflict', current_revision: '3' }, 1), 'blocked');
});

test('queued upload rebase preserves independent edits and rejects changed local bytes', async () => {
  const initial = await encodePacket([
    { path: 'local.md', kind: 'put', bytes: new Uint8Array([1]) },
    { path: 'remote.md', kind: 'put', bytes: new Uint8Array([1]) },
  ]);
  const base = await confirmedAfterUpload(null, createPendingUpload('https://sync.example.com', 'e'.repeat(32), initial));
  const localEdit = new Uint8Array([2]);
  const remoteEdit = new Uint8Array([3]);
  const queued = createPendingUpload(base.serverUrl, base.vaultId,
    await encodePacket([{ path: 'local.md', kind: 'put', bytes: localEdit }]), 1);
  const desired = readConfirmedState(await confirmedAfterUpload(base, queued)).digests;
  const local = new Map(desired);
  assert.deepEqual(await queuedUploadDigests(base, queued, local), desired);
  local.set('local.md', await digestBytes(new Uint8Array([9])));
  await assert.rejects(queuedUploadDigests(base, queued, local));
  const remote = map([
    ['local.md', base.digests['local.md']],
    ['remote.md', await digestBytes(remoteEdit)],
  ]);
  assert.deepEqual(planFromConfirmed(readConfirmedState(base).digests, desired, remote), [
    { path: 'local.md', action: 'push' },
    { path: 'remote.md', action: 'pull' },
  ]);
  const staged = createPendingPull(base.serverUrl, base.vaultId, 1, 2,
    await encodePacket([{ path: 'remote.md', kind: 'put', bytes: remoteEdit }]), queued.operationId);
  assert.equal((await readPendingPull(JSON.parse(JSON.stringify(staged)))).pending.rebaseOperationId,
    queued.operationId);
  assert.equal((await confirmedAfterPull(base, staged)).revision, 2);
  await assert.rejects(readPendingPull({ ...staged, rebaseOperationId: 'invalid' }));
  assert.deepEqual(planFromConfirmed(readConfirmedState(base).digests, desired,
    map([['local.md', await digestBytes(new Uint8Array([4]))], ['remote.md', base.digests['remote.md']]])), [
    { path: 'local.md', action: 'conflict' },
  ]);
});

test('resumed rebase validates queued files before applying more remote changes', async () => {
  const old = await digestBytes(new Uint8Array([1]));
  const localEdit = await digestBytes(new Uint8Array([2]));
  const remoteEdit = await digestBytes(new Uint8Array([3]));
  const base = map([['local.md', old], ['remote.md', old]]);
  const desired = map([['local.md', localEdit], ['remote.md', old]]);
  const remote = map([['local.md', old], ['remote.md', remoteEdit]]);
  const decisions = planFromConfirmed(base, desired, remote);
  const changes = [{ path: 'remote.md', kind: 'put', bytes: new Uint8Array([3]) }];
  const changed = await digestBytes(new Uint8Array([9]));

  assert.doesNotThrow(() => assertRebaseLocalFiles(desired, remote, decisions, changes,
    map([['local.md', localEdit], ['remote.md', old]]), true));
  assert.doesNotThrow(() => assertRebaseLocalFiles(desired, remote, decisions, changes,
    map([['local.md', localEdit], ['remote.md', remoteEdit]]), true));
  assert.doesNotThrow(() => assertRebaseLocalFiles(desired, remote, decisions, changes,
    map([['local.md', localEdit], ['remote.md', remoteEdit]]), false));
  assert.throws(() => assertRebaseLocalFiles(desired, remote, decisions, changes,
    map([['local.md', changed], ['remote.md', old]]), true));
  assert.throws(() => assertRebaseLocalFiles(desired, remote, decisions, changes,
    map([['local.md', localEdit], ['remote.md', old], ['new.md', localEdit]]), true));
  assert.throws(() => assertRebaseLocalFiles(desired, remote, decisions, changes,
    map([['local.md', localEdit], ['remote.md', old]]), false));
});
