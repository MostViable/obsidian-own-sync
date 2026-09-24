export const MAX_PACKET_BYTES = 1024 * 1024;

export type FileChange =
  | { path: string; kind: 'put'; bytes: Uint8Array }
  | { path: string; kind: 'delete' };

type EncodedChange =
  | { path: string; kind: 'put'; bytes: string; sha256: string }
  | { path: string; kind: 'delete' };

interface EncodedPacket {
  format_version: 1;
  changes: EncodedChange[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function validateSyncPath(path: string): void {
  if (!path || path.length > 1024 || path.startsWith('/') || path.startsWith('.obsidian/')) {
    throw new Error('Invalid sync path.');
  }
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.') ||
      segment.endsWith(' ') || segment.endsWith('.') ||
      /[<>:"\\|?*\x00-\x1f]/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      throw new Error('Invalid sync path.');
    }
  }
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const data = new Uint8Array(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data.buffer));
  return [...hash].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid packet encoding.');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64(bytes) !== value) {
    throw new Error('Non-canonical packet encoding.');
  }
  return bytes;
}

export async function encodePacket(changes: readonly FileChange[]): Promise<Uint8Array> {
  if (changes.length === 0) {
    throw new Error('A packet needs at least one change.');
  }
  const seen = new Set<string>();
  const encoded: EncodedChange[] = [];
  for (const change of changes) {
    validateSyncPath(change.path);
    if (seen.has(change.path)) {
      throw new Error('Duplicate path in packet.');
    }
    seen.add(change.path);
    encoded.push(change.kind === 'delete'
      ? { path: change.path, kind: 'delete' }
      : { path: change.path, kind: 'put', bytes: encodeBase64(change.bytes), sha256: await digestBytes(change.bytes) });
  }
  const packet: EncodedPacket = { format_version: 1, changes: encoded };
  const bytes = textEncoder.encode(JSON.stringify(packet));
  if (bytes.byteLength > MAX_PACKET_BYTES) {
    throw new Error('Packet exceeds the server limit.');
  }
  return bytes;
}

export async function decodePacket(bytes: ArrayBuffer): Promise<FileChange[]> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PACKET_BYTES) {
    throw new Error('Invalid packet size.');
  }
  const packet: unknown = JSON.parse(textDecoder.decode(bytes));
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new Error('Invalid packet.');
  }
  const candidate = packet as Record<string, unknown>;
  if (candidate.format_version !== 1 || Object.keys(candidate).length !== 2 ||
    !Array.isArray(candidate.changes) || candidate.changes.length === 0) {
    throw new Error('Unsupported or empty packet.');
  }
  const seen = new Set<string>();
  const changes: FileChange[] = [];
  for (const item of candidate.changes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid packet change.');
    }
    const change = item as Record<string, unknown>;
    if (typeof change.path !== 'string') {
      throw new Error('Invalid packet path.');
    }
    validateSyncPath(change.path);
    if (seen.has(change.path)) {
      throw new Error('Duplicate path in packet.');
    }
    seen.add(change.path);
    if (change.kind === 'delete') {
      if (Object.keys(change).length !== 2) {
        throw new Error('Invalid delete change.');
      }
      changes.push({ path: change.path, kind: 'delete' });
    } else if (change.kind === 'put' && typeof change.bytes === 'string' &&
      typeof change.sha256 === 'string' && /^[0-9a-f]{64}$/.test(change.sha256) &&
      Object.keys(change).length === 4) {
      const contents = decodeBase64(change.bytes);
      if (await digestBytes(contents) !== change.sha256) {
        throw new Error('Packet content digest mismatch.');
      }
      changes.push({ path: change.path, kind: 'put', bytes: contents });
    } else {
      throw new Error('Invalid put change.');
    }
  }
  return changes;
}

export async function applyPacketToDigests(state: Map<string, string>, packet: ArrayBuffer): Promise<void> {
  const changes = await decodePacket(packet);
  const updates: Array<{ path: string; digest?: string }> = [];
  for (const change of changes) {
    updates.push(change.kind === 'delete'
      ? { path: change.path }
      : { path: change.path, digest: await digestBytes(change.bytes) });
  }
  for (const update of updates) {
    if (update.digest === undefined) state.delete(update.path);
    else state.set(update.path, update.digest);
  }
}
