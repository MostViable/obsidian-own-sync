export type FileDigests = ReadonlyMap<string, string>;

export interface SyncDecision {
  path: string;
  action: 'push' | 'pull' | 'conflict';
}

export function assertNoCaseCollisions(paths: Iterable<string>): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const portable = path.toLowerCase();
    if (seen.has(portable)) {
      throw new Error('Paths collide on case-insensitive devices.');
    }
    seen.add(portable);
  }
}

// Absence in a map is a deletion. Equal digests represent equal file bytes.
export function planSync(base: FileDigests, local: FileDigests, remote: FileDigests): SyncDecision[] {
  const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const decisions: SyncDecision[] = [];

  for (const path of [...paths].sort()) {
    const previous = base.get(path);
    const currentLocal = local.get(path);
    const currentRemote = remote.get(path);

    if (currentLocal === currentRemote) {
      continue;
    }
    if (currentLocal === previous) {
      decisions.push({ path, action: 'pull' });
    } else if (currentRemote === previous) {
      decisions.push({ path, action: 'push' });
    } else {
      decisions.push({ path, action: 'conflict' });
    }
  }

  return decisions;
}
