import { assertNoCaseCollisions, assertNoFileDirectoryCollisions, planSync } from './plan.ts';
import {
  applyPacketToDigests, digestBytes, readPendingDownload, readPendingUpload, validateSyncPath,
  type FileChange,
} from './packet.ts';

export interface ConfirmedState {
  formatVersion: 1;
  serverUrl: string;
  vaultId: string;
  revision: number;
  digests: Record<string, string>;
}

export function readConfirmedState(value: unknown): { state: ConfirmedState; digests: Map<string, string> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Missing confirmed state.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.formatVersion !== 1 || typeof candidate.serverUrl !== 'string' ||
    typeof candidate.vaultId !== 'string' || !/^[0-9a-f]{32}$/i.test(candidate.vaultId) ||
    typeof candidate.revision !== 'number' || !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 1 || !candidate.digests || typeof candidate.digests !== 'object' ||
    Array.isArray(candidate.digests) || Object.keys(candidate).length !== 5) {
    throw new Error('Invalid confirmed state.');
  }
  const digests = new Map<string, string>();
  for (const [path, digest] of Object.entries(candidate.digests)) {
    validateSyncPath(path);
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error('Invalid confirmed file digest.');
    }
    digests.set(path, digest);
  }
  assertNoCaseCollisions(digests.keys());
  assertNoFileDirectoryCollisions(digests.keys());
  return { state: candidate as unknown as ConfirmedState, digests };
}

function makeConfirmedState(serverUrl: string, vaultId: string, revision: number, digests: Map<string, string>): ConfirmedState {
  return {
    formatVersion: 1,
    serverUrl,
    vaultId,
    revision,
    digests: Object.fromEntries([...digests].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
  };
}

export async function confirmedAfterUpload(previous: unknown, pendingValue: unknown): Promise<ConfirmedState> {
  const { pending, body } = await readPendingUpload(pendingValue);
  const expectedRevision = pending.expectedRevision ?? 0;
  let digests = new Map<string, string>();
  if (expectedRevision === 0) {
    if (previous !== null) throw new Error('Initial upload already has confirmed state.');
  } else {
    const confirmed = readConfirmedState(previous);
    if (confirmed.state.serverUrl !== pending.serverUrl || confirmed.state.vaultId !== pending.vaultId ||
      confirmed.state.revision !== expectedRevision) {
      throw new Error('Pending upload does not match confirmed state.');
    }
    digests = confirmed.digests;
  }
  await applyPacketToDigests(digests, body);
  assertNoCaseCollisions(digests.keys());
  assertNoFileDirectoryCollisions(digests.keys());
  return makeConfirmedState(pending.serverUrl, pending.vaultId, expectedRevision + 1, digests);
}

export async function confirmedAfterInitialDownload(pendingValue: unknown): Promise<ConfirmedState> {
  const { pending, changes } = await readPendingDownload(pendingValue);
  const digests = new Map<string, string>();
  for (const change of changes) {
    if (change.kind !== 'put') throw new Error('Invalid initial download.');
    digests.set(change.path, await digestBytes(change.bytes));
  }
  assertNoCaseCollisions(digests.keys());
  assertNoFileDirectoryCollisions(digests.keys());
  return makeConfirmedState(pending.serverUrl, pending.vaultId, 1, digests);
}

export interface LocalFile {
  digest: string;
  bytes: Uint8Array;
}

export function changesFromLocal(base: ReadonlyMap<string, string>, local: ReadonlyMap<string, LocalFile>): FileChange[] {
  const localDigests = new Map([...local].map(([path, file]) => [path, file.digest]));
  return planSync(base, localDigests, base).map(({ path }) => {
    const file = local.get(path);
    return file ? { path, kind: 'put' as const, bytes: file.bytes } : { path, kind: 'delete' as const };
  });
}
