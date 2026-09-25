import { packetLimitFromCapabilities } from './capabilities.ts';
import { isSyncableVaultPath } from './files.ts';
import { assertNoCaseCollisions, assertNoFileDirectoryCollisions, planSync } from './plan.ts';
import { applyPacketToDigests, classifyUploadResponse, decodePacket, digestBytes, encodePacket, validateSyncPath, type FileChange } from './packet.ts';

const STATE_FILE = 'sync-state.json';
const PENDING_FILE = 'pending-upload.json';
const CACHE_FILE = 'hash-cache.json';
const PULL_BATCH_BYTES = 16 * 1024 * 1024;
const PACKET_RESERVE_BYTES = 64 * 1024;
const MAX_ROUNDS = 8;

export type SyncErrorKind = 'offline' | 'unauthorized' | 'incompatible' | 'server' | 'busy' | 'local';

export class SyncError extends Error {
  readonly kind: SyncErrorKind;

  constructor(kind: SyncErrorKind, message: string) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
  }
}

export interface VaultFile {
  path: string;
  mtime: number;
  size: number;
}

// Vault access. Paths are vault-relative; write creates missing parent folders.
export interface VaultPort {
  list(): VaultFile[];
  stat(path: string): VaultFile | null;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  trash(path: string): Promise<void>;
}

export interface UploadReply {
  status: number;
  json: unknown;
}

// Server access. Read calls throw SyncError on failure; upload returns every HTTP reply.
export interface ServerPort {
  capabilities(): Promise<unknown>;
  head(): Promise<number>;
  commit(revision: number): Promise<ArrayBuffer>;
  upload(operationId: string, expectedRevision: number, body: Uint8Array): Promise<UploadReply>;
}

// Private plugin files that are never part of the synced vault.
export interface StoragePort {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface SyncReport {
  revision: number;
  pulledRevisions: number;
  uploadedCommits: number;
  conflictCopies: string[];
  oversized: string[];
  invalidPaths: string[];
  serverReset: boolean;
}

export interface SyncEngineOptions {
  serverUrl: string;
  vaultId: string;
  vault: VaultPort;
  server: ServerPort;
  storage: StoragePort;
  now?: () => Date;
}

interface PendingUpload {
  operationId: string;
  expectedRevision: number;
  sha256: string;
}

// The confirmed base: server contents at `revision`, already reflected in local files.
interface EngineState {
  formatVersion: 2;
  serverUrl: string;
  vaultId: string;
  revision: number;
  digests: Record<string, string>;
  pendingUpload: PendingUpload | null;
}

interface CachedDigest {
  mtime: number;
  size: number;
  digest: string;
}

interface Progress {
  report: SyncReport;
  oversized: Set<string>;
  invalidPaths: Set<string>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

// Largest file that always fits into one packet under `packetLimit`.
export function maxFileBytes(packetLimit: number): number {
  return Math.floor((packetLimit - PACKET_RESERVE_BYTES) / 4) * 3;
}

function oversizeDigest(file: VaultFile): string {
  return `oversize:${file.size}:${file.mtime}`;
}

function isOversizeDigest(digest: string): boolean {
  return digest.startsWith('oversize:');
}

function putCost(path: string, size: number): number {
  return Math.ceil(size / 3) * 4 + textEncoder.encode(path).byteLength + 160;
}

function deleteCost(path: string): number {
  return textEncoder.encode(path).byteLength + 48;
}

function sortedRecord(digests: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...digests].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function randomHex(bytes: number): string {
  const id = new Uint8Array(bytes);
  crypto.getRandomValues(id);
  return [...id].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function splitName(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) };
}

function conflictStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function assertPortablePaths(paths: Iterable<string>): void {
  const list = [...paths];
  try {
    assertNoCaseCollisions(list);
    assertNoFileDirectoryCollisions(list);
  } catch {
    throw new SyncError('local',
      'Some file names differ only by letter case or match a folder name. Rename them to continue syncing.');
  }
}

function readState(value: unknown, serverUrl: string, vaultId: string): EngineState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.formatVersion !== 2 || state.serverUrl !== serverUrl || state.vaultId !== vaultId ||
    typeof state.revision !== 'number' || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !state.digests || typeof state.digests !== 'object' || Array.isArray(state.digests)) return null;
  for (const [path, digest] of Object.entries(state.digests)) {
    try {
      validateSyncPath(path);
    } catch {
      return null;
    }
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return null;
  }
  const pending = state.pendingUpload;
  if (pending !== null) {
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return null;
    const upload = pending as Record<string, unknown>;
    if (typeof upload.operationId !== 'string' || !/^[0-9a-f]{32}$/.test(upload.operationId) ||
      upload.expectedRevision !== state.revision ||
      typeof upload.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(upload.sha256)) return null;
  }
  return state as unknown as EngineState;
}

/**
 * Three-way sync between the confirmed base, local files and the server history.
 * Every step can be interrupted: the base only advances after the server confirmed
 * a commit or all files of a pulled batch are in place, and replanning from the
 * base converges without losing local or remote edits.
 */
export class SyncEngine {
  private readonly options: SyncEngineOptions;
  private cache: Map<string, CachedDigest> | null = null;
  private cacheDirty = false;
  private running = false;

  constructor(options: SyncEngineOptions) {
    this.options = options;
  }

  async sync(fullScan = false): Promise<SyncReport> {
    if (this.running) throw new SyncError('busy', 'Sync is already running.');
    this.running = true;
    try {
      return await this.cycle(fullScan);
    } finally {
      this.running = false;
      await this.saveCache().catch(() => undefined);
    }
  }

  private async cycle(fullScan: boolean): Promise<SyncReport> {
    let limit: number;
    try {
      limit = packetLimitFromCapabilities(await this.options.server.capabilities());
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError('incompatible', (error as Error).message);
    }
    const state = await this.loadState();
    await this.loadCache(fullScan);
    const progress: Progress = {
      report: {
        revision: state.revision, pulledRevisions: 0, uploadedCommits: 0, conflictCopies: [],
        oversized: [], invalidPaths: [], serverReset: false,
      },
      oversized: new Set(),
      invalidPaths: new Set(),
    };

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (state.pendingUpload !== null) await this.submitPending(state, progress);
      await this.pull(state, limit, progress);
      if (await this.push(state, limit, progress)) {
        const { report } = progress;
        report.revision = state.revision;
        report.oversized = [...progress.oversized].sort();
        report.invalidPaths = [...progress.invalidPaths].sort();
        return report;
      }
    }
    throw new SyncError('busy', 'The server kept changing during sync.');
  }

  private async loadState(): Promise<EngineState> {
    const { serverUrl, vaultId, storage } = this.options;
    const bytes = await storage.read(STATE_FILE);
    if (bytes !== null) {
      try {
        const state = readState(JSON.parse(textDecoder.decode(bytes)), serverUrl, vaultId);
        if (state !== null) return state;
      } catch {
        // A damaged or foreign state starts a fresh merge, which never deletes files.
      }
    }
    return { formatVersion: 2, serverUrl, vaultId, revision: 0, digests: {}, pendingUpload: null };
  }

  private async saveState(state: EngineState): Promise<void> {
    await this.options.storage.write(STATE_FILE, textEncoder.encode(JSON.stringify(state)));
  }

  private async loadCache(fullScan: boolean): Promise<void> {
    if (fullScan) {
      this.cache = new Map();
      this.cacheDirty = true;
      return;
    }
    if (this.cache !== null) return;
    this.cache = new Map();
    const bytes = await this.options.storage.read(CACHE_FILE).catch(() => null);
    if (bytes === null) return;
    try {
      const saved = JSON.parse(textDecoder.decode(bytes)) as unknown;
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
      for (const [path, entry] of Object.entries(saved)) {
        if (Array.isArray(entry) && entry.length === 3 && typeof entry[0] === 'number' &&
          typeof entry[1] === 'number' && typeof entry[2] === 'string' && /^[0-9a-f]{64}$/.test(entry[2])) {
          this.cache.set(path, { mtime: entry[0], size: entry[1], digest: entry[2] });
        }
      }
    } catch {
      this.cache.clear();
    }
  }

  private async saveCache(): Promise<void> {
    if (this.cache === null || !this.cacheDirty) return;
    const entries = Object.fromEntries([...this.cache].map(([path, entry]) => [path, [entry.mtime, entry.size, entry.digest]]));
    await this.options.storage.write(CACHE_FILE, textEncoder.encode(JSON.stringify(entries)));
    this.cacheDirty = false;
  }

  private forget(path: string): void {
    if (this.cache?.delete(path)) this.cacheDirty = true;
  }

  private async scanLocal(limit: number, progress: Progress): Promise<Map<string, string>> {
    const cache = this.cache ?? new Map<string, CachedDigest>();
    this.cache = cache;
    const largest = maxFileBytes(limit);
    const local = new Map<string, string>();
    for (const file of this.options.vault.list()) {
      if (!isSyncableVaultPath(file.path)) continue;
      try {
        validateSyncPath(file.path);
      } catch {
        progress.invalidPaths.add(file.path);
        continue;
      }
      if (file.size > largest) {
        progress.oversized.add(file.path);
        local.set(file.path, oversizeDigest(file));
        continue;
      }
      const cached = cache.get(file.path);
      if (cached !== undefined && cached.mtime === file.mtime && cached.size === file.size) {
        local.set(file.path, cached.digest);
        continue;
      }
      const bytes = await this.options.vault.read(file.path);
      if (bytes === null) continue;
      const digest = await digestBytes(bytes);
      if (bytes.byteLength === file.size) {
        cache.set(file.path, { mtime: file.mtime, size: file.size, digest });
        this.cacheDirty = true;
      }
      local.set(file.path, digest);
    }
    for (const path of [...cache.keys()]) {
      if (!local.has(path)) this.forget(path);
    }
    return local;
  }

  private async currentDigest(path: string, limit: number): Promise<string | null> {
    const file = this.options.vault.stat(path);
    if (file === null) return null;
    if (file.size > maxFileBytes(limit)) return oversizeDigest(file);
    const bytes = await this.options.vault.read(path);
    return bytes === null ? null : digestBytes(bytes);
  }

  private async dropPending(state: EngineState): Promise<void> {
    state.pendingUpload = null;
    await this.saveState(state);
    await this.options.storage.remove(PENDING_FILE).catch(() => undefined);
  }

  // Sends the persisted packet. A confirmed conflict proves it was not applied, so it is dropped
  // and its changes are planned again from the local files after the next pull.
  private async submitPending(state: EngineState, progress: Progress): Promise<'confirmed' | 'dropped'> {
    const pending = state.pendingUpload;
    if (pending === null) return 'dropped';
    const body = await this.options.storage.read(PENDING_FILE);
    if (body === null || pending.expectedRevision !== state.revision || await digestBytes(body) !== pending.sha256) {
      await this.dropPending(state);
      return 'dropped';
    }
    const reply = await this.options.server.upload(pending.operationId, pending.expectedRevision, body);
    const result = classifyUploadResponse(reply.status, reply.json, pending.expectedRevision);
    if (result === 'applied' || result === 'replayed') {
      const digests = new Map(Object.entries(state.digests));
      await applyPacketToDigests(digests, exactBuffer(body));
      state.revision = pending.expectedRevision + 1;
      state.digests = sortedRecord(digests);
      state.pendingUpload = null;
      await this.saveState(state);
      await this.options.storage.remove(PENDING_FILE).catch(() => undefined);
      progress.report.uploadedCommits += 1;
      return 'confirmed';
    }
    if (result === 'conflict' || reply.status === 409 || reply.status === 413) {
      await this.dropPending(state);
      return 'dropped';
    }
    if (reply.status === 401 || reply.status === 403) {
      throw new SyncError('unauthorized', 'This device has no access to the vault.');
    }
    throw new SyncError('server', `The server rejected an upload (HTTP ${reply.status}).`);
  }

  private async pull(state: EngineState, limit: number, progress: Progress): Promise<void> {
    const { server } = this.options;
    for (;;) {
      const head = await server.head();
      if (!Number.isSafeInteger(head) || head < 0) throw new SyncError('server', 'The server reported an invalid revision.');
      if (head < state.revision) {
        // The server was restored from an older backup: merge again from an empty base.
        state.revision = 0;
        state.digests = {};
        await this.dropPending(state);
        progress.report.serverReset = true;
        continue;
      }
      if (head === state.revision) return;

      const base = new Map(Object.entries(state.digests));
      const remote = new Map(base);
      const remoteBytes = new Map<string, Uint8Array>();
      let end = state.revision;
      let fetched = 0;
      do {
        const packet = await server.commit(end + 1);
        fetched += packet.byteLength;
        let changes: FileChange[];
        try {
          changes = await decodePacket(packet);
        } catch {
          throw new SyncError('server', `Server revision ${end + 1} is damaged or unsupported.`);
        }
        for (const change of changes) {
          if (change.kind === 'put') {
            remote.set(change.path, await digestBytes(change.bytes));
            remoteBytes.set(change.path, change.bytes);
          } else {
            remote.delete(change.path);
            remoteBytes.delete(change.path);
          }
        }
        end += 1;
      } while (end < head && fetched < PULL_BATCH_BYTES);

      await this.applyRemote(base, remote, remoteBytes, limit, progress);
      progress.report.pulledRevisions += end - state.revision;
      state.revision = end;
      state.digests = sortedRecord(remote);
      await this.saveState(state);
    }
  }

  private async applyRemote(
    base: ReadonlyMap<string, string>, remote: ReadonlyMap<string, string>,
    remoteBytes: ReadonlyMap<string, Uint8Array>, limit: number, progress: Progress,
  ): Promise<void> {
    const { vault } = this.options;
    const local = await this.scanLocal(limit, progress);
    const finalPaths = new Set(local.keys());
    const deletes: Array<{ path: string; expected: string | undefined }> = [];
    const puts: Array<{ path: string; expected: string | undefined; bytes: Uint8Array }> = [];
    const conflicts: Array<{ path: string; digest: string; bytes: Uint8Array }> = [];
    const bytesFor = (path: string): Uint8Array => {
      const bytes = remoteBytes.get(path);
      if (bytes === undefined) throw new SyncError('server', 'Server history is incomplete.');
      return bytes;
    };

    for (const { path, action } of planSync(base, local, remote)) {
      if (action === 'push') continue;
      const localDigest = local.get(path);
      const remoteDigest = remote.get(path);
      if (action === 'conflict' && localDigest !== undefined) {
        // Both sides changed the path. The local file stays; a remote edit becomes a copy,
        // and a remote deletion loses to the local edit.
        if (remoteDigest !== undefined) conflicts.push({ path, digest: remoteDigest, bytes: bytesFor(path) });
        continue;
      }
      if (remoteDigest === undefined) {
        deletes.push({ path, expected: localDigest });
        finalPaths.delete(path);
      } else {
        puts.push({ path, expected: localDigest, bytes: bytesFor(path) });
        finalPaths.add(path);
      }
    }

    const copies: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const conflict of conflicts) {
      const { dir, stem, ext } = splitName(conflict.path);
      const prefix = `${dir}${stem} (conflict `;
      const suffix = `)${ext}`;
      const existing = [...local].find(([path, digest]) => digest === conflict.digest &&
        path.startsWith(prefix) && path.endsWith(suffix));
      if (existing !== undefined) continue;
      const taken = new Set([...finalPaths].map((path) => path.toLowerCase()));
      const stamp = conflictStamp(this.options.now?.() ?? new Date());
      let copy = `${prefix}${stamp}${suffix}`;
      for (let index = 2; taken.has(copy.toLowerCase()); index += 1) copy = `${prefix}${stamp} ${index}${suffix}`;
      try {
        validateSyncPath(copy);
      } catch {
        throw new SyncError('local', `Cannot name a conflict copy for ${conflict.path}.`);
      }
      finalPaths.add(copy);
      copies.push({ path: copy, bytes: conflict.bytes });
    }
    assertPortablePaths(finalPaths);

    for (const item of deletes) {
      const current = await this.currentDigest(item.path, limit);
      if (current === null) continue;
      if (current !== item.expected) throw new SyncError('busy', 'A file changed during sync.');
      await vault.trash(item.path);
      this.forget(item.path);
    }
    for (const item of copies) {
      if (vault.stat(item.path) !== null) throw new SyncError('busy', 'A file appeared during sync.');
      await vault.write(item.path, item.bytes);
      this.forget(item.path);
      progress.report.conflictCopies.push(item.path);
    }
    for (const item of puts) {
      const current = await this.currentDigest(item.path, limit);
      if (current === remote.get(item.path)) continue;
      if (current !== (item.expected ?? null)) throw new SyncError('busy', 'A file changed during sync.');
      await vault.write(item.path, item.bytes);
      this.forget(item.path);
    }
  }

  // Uploads local changes in packets that fit the server limit. Returns false after a
  // revision conflict, when the caller has to pull first.
  private async push(state: EngineState, limit: number, progress: Progress): Promise<boolean> {
    const local = await this.scanLocal(limit, progress);
    assertPortablePaths(local.keys());
    const base = new Map(Object.entries(state.digests));
    const changed = planSync(base, local, base).map(({ path }) => path);
    const deletes = changed.filter((path) => !local.has(path));
    const puts = changed.filter((path) => {
      const digest = local.get(path);
      return digest !== undefined && !isOversizeDigest(digest);
    });

    let batch: FileChange[] = [];
    let size = 64;
    const flush = async (): Promise<boolean> => {
      if (batch.length === 0) return true;
      const body = await encodePacket(batch, limit);
      batch = [];
      size = 64;
      return this.upload(state, body, progress);
    };
    for (const path of deletes) {
      const cost = deleteCost(path);
      if (size + cost > limit && !await flush()) return false;
      batch.push({ path, kind: 'delete' });
      size += cost;
    }
    for (const path of puts) {
      const bytes = await this.options.vault.read(path);
      if (bytes === null || await digestBytes(bytes) !== local.get(path)) {
        throw new SyncError('busy', 'A file changed during sync.');
      }
      const cost = putCost(path, bytes.byteLength);
      if (size + cost > limit && !await flush()) return false;
      batch.push({ path, kind: 'put', bytes });
      size += cost;
    }
    return flush();
  }

  private async upload(state: EngineState, body: Uint8Array, progress: Progress): Promise<boolean> {
    await this.options.storage.write(PENDING_FILE, body);
    state.pendingUpload = { operationId: randomHex(16), expectedRevision: state.revision, sha256: await digestBytes(body) };
    await this.saveState(state);
    return await this.submitPending(state, progress) === 'confirmed';
  }
}
