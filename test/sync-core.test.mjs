import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertNoCaseCollisions, planSync } from '../src/sync/plan.ts';
import { applyPacketToDigests, decodePacket, digestBytes, encodePacket, validateSyncPath } from '../src/sync/packet.ts';

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
  assert.doesNotThrow(() => assertNoCaseCollisions(['A.md', 'B.md']));
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
    'a/.hidden', 'CON.txt', 'a/file.', 'a//b']) {
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
