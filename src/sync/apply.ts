import type { FileChange } from './packet.ts';

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
