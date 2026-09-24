import { assertNoCaseCollisions, assertNoFileDirectoryCollisions, planSync, type SyncDecision } from './plan.ts';
import {
  applyPacketToDigests, decodePacket, digestBytes, readPendingDownload, readPendingUpload, validateSyncPath,
  type FileChange,
} from './packet.ts';

export interface ConfirmedState {
  formatVersion: 1;
  serverUrl: string;
  vaultId: string;
  revision: number;
  digests: Record<string, string>;
}

export interface PendingPull {
  formatVersion: 1;
  serverUrl: string;
  vaultId: string;
  fromRevision: number;
  toRevision: number;
  packetText: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function createPendingPull(
  serverUrl: string, vaultId: string, fromRevision: number, toRevision: number, packet: Uint8Array,
): PendingPull {
  if (!Number.isSafeInteger(fromRevision) || fromRevision < 1 ||
    !Number.isSafeInteger(toRevision) || toRevision <= fromRevision) {
    throw new Error('Invalid pull revisions.');
  }
  return { formatVersion: 1, serverUrl, vaultId, fromRevision, toRevision, packetText: textDecoder.decode(packet) };
}

export async function readPendingPull(value: unknown): Promise<{ pending: PendingPull; changes: FileChange[]; body: ArrayBuffer }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pending pull.');
  const candidate = value as Record<string, unknown>;
  if (candidate.formatVersion !== 1 || typeof candidate.serverUrl !== 'string' ||
    typeof candidate.vaultId !== 'string' || !/^[0-9a-f]{32}$/i.test(candidate.vaultId) ||
    typeof candidate.fromRevision !== 'number' || !Number.isSafeInteger(candidate.fromRevision) ||
    candidate.fromRevision < 1 || typeof candidate.toRevision !== 'number' ||
    !Number.isSafeInteger(candidate.toRevision) || candidate.toRevision <= candidate.fromRevision ||
    typeof candidate.packetText !== 'string' || Object.keys(candidate).length !== 6) {
    throw new Error('Invalid pending pull.');
  }
  const body = textEncoder.encode(candidate.packetText).buffer;
  const changes = await decodePacket(body);
  return { pending: candidate as unknown as PendingPull, changes, body };
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

export async function confirmedAfterPull(previous: unknown, pendingValue: unknown): Promise<ConfirmedState> {
  const confirmed = readConfirmedState(previous);
  const { pending, body } = await readPendingPull(pendingValue);
  if (confirmed.state.serverUrl !== pending.serverUrl || confirmed.state.vaultId !== pending.vaultId ||
    confirmed.state.revision !== pending.fromRevision) {
    throw new Error('Pending pull does not match confirmed state.');
  }
  const digests = new Map(confirmed.digests);
  await applyPacketToDigests(digests, body);
  assertNoCaseCollisions(digests.keys());
  assertNoFileDirectoryCollisions(digests.keys());
  return makeConfirmedState(pending.serverUrl, pending.vaultId, pending.toRevision, digests);
}

export function advanceConfirmedRevision(previous: unknown, revision: number): ConfirmedState {
  const confirmed = readConfirmedState(previous);
  if (!Number.isSafeInteger(revision) || revision <= confirmed.state.revision) {
    throw new Error('Invalid next revision.');
  }
  return makeConfirmedState(confirmed.state.serverUrl, confirmed.state.vaultId, revision, confirmed.digests);
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

export function planFromConfirmed(
  base: ReadonlyMap<string, string>, local: ReadonlyMap<string, string>, remote: ReadonlyMap<string, string>,
): SyncDecision[] {
  const currentPaths = new Set([...local.keys(), ...remote.keys()]);
  assertNoCaseCollisions(currentPaths);
  assertNoFileDirectoryCollisions(currentPaths);
  return planSync(base, local, remote);
}
