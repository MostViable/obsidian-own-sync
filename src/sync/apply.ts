import { assertNoCaseCollisions, assertNoFileDirectoryCollisions } from './plan.ts';
import { digestBytes, type FileChange } from './packet.ts';

export interface InitialFileStore {
  listPaths(): string[];
  read(path: string): Promise<Uint8Array | null>;
  ensureFolder(path: string): Promise<void>;
  create(path: string, bytes: Uint8Array): Promise<void>;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export async function applyInitialSnapshot(store: InitialFileStore, changes: readonly FileChange[]): Promise<void> {
  if (changes.length === 0 || changes.some((change) => change.kind !== 'put')) {
    throw new Error('Initial snapshot must contain file creations only.');
  }
  const expected = new Set(changes.map((change) => change.path));
  if (store.listPaths().some((path) => !expected.has(path))) {
    throw new Error('Local vault contains unrelated files.');
  }

  for (const change of changes) {
    if (change.kind !== 'put') throw new Error('Invalid initial snapshot.');
    const existing = await store.read(change.path);
    if (existing !== null && !sameBytes(existing, change.bytes)) {
      throw new Error('Local file differs from the pending snapshot.');
    }
  }

  for (const change of changes) {
    if (change.kind !== 'put') throw new Error('Invalid initial snapshot.');
    const segments = change.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      await store.ensureFolder(segments.slice(0, index).join('/'));
    }
    const existing = await store.read(change.path);
    if (existing === null) {
      await store.create(change.path, change.bytes);
    } else if (!sameBytes(existing, change.bytes)) {
      throw new Error('Local file changed during the download.');
    }
  }

  if (store.listPaths().some((path) => !expected.has(path))) {
    throw new Error('Local vault changed during the download.');
  }
  for (const change of changes) {
    if (change.kind !== 'put') throw new Error('Invalid initial snapshot.');
    const saved = await store.read(change.path);
    if (saved === null || !sameBytes(saved, change.bytes)) {
      throw new Error('Downloaded file differs from the pending snapshot.');
    }
  }
}

export interface RemoteFileStore {
  listPaths(): string[];
  read(path: string): Promise<Uint8Array | null>;
  ensureFolder(path: string): Promise<void>;
  put(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

async function currentDigest(store: RemoteFileStore, path: string): Promise<string | null> {
  const bytes = await store.read(path);
  return bytes === null ? null : digestBytes(bytes);
}

export async function applyRemoteChanges(
  store: RemoteFileStore, base: ReadonlyMap<string, string>, changes: readonly FileChange[],
): Promise<void> {
  if (changes.length === 0 || new Set(changes.map((change) => change.path)).size !== changes.length) {
    throw new Error('Invalid remote changes.');
  }
  const targets = new Map<string, string | null>();
  const finalPaths = new Set(store.listPaths());
  for (const change of changes) {
    if (change.kind === 'delete') {
      targets.set(change.path, null);
      finalPaths.delete(change.path);
    } else {
      targets.set(change.path, await digestBytes(change.bytes));
      finalPaths.add(change.path);
    }
  }
  assertNoCaseCollisions(finalPaths);
  assertNoFileDirectoryCollisions(finalPaths);

  for (const change of changes) {
    const current = await currentDigest(store, change.path);
    const expected = base.get(change.path) ?? null;
    const target = targets.get(change.path) ?? null;
    if (current !== expected && current !== target) {
      throw new Error('Local file differs from the confirmed or pending remote version.');
    }
  }

  for (const change of [...changes.filter((item) => item.kind === 'delete'),
    ...changes.filter((item) => item.kind === 'put')]) {
    const current = await currentDigest(store, change.path);
    const target = targets.get(change.path) ?? null;
    if (current === target) continue;
    if (current !== (base.get(change.path) ?? null)) {
      throw new Error('Local file changed during remote apply.');
    }
    if (change.kind === 'delete') {
      await store.remove(change.path);
    } else {
      const segments = change.path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        await store.ensureFolder(segments.slice(0, index).join('/'));
      }
      await store.put(change.path, change.bytes);
    }
    if (await currentDigest(store, change.path) !== target) {
      throw new Error('Remote change was not saved as expected.');
    }
  }
}
