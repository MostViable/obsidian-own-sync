export type FileDigests = ReadonlyMap<string, string>;

export interface SyncDecision {
  path: string;
  action: 'push' | 'pull' | 'conflict';
}

export function assertNoCaseCollisions(paths: Iterable<string>): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/');
      const portable = prefix.toLowerCase();
      const existing = seen.get(portable);
      if (existing !== undefined && existing !== prefix) {
        throw new Error('Paths collide on case-insensitive devices.');
      }
      seen.set(portable, prefix);
    }
  }
}

export function assertNoFileDirectoryCollisions(paths: Iterable<string>): void {
  const files = new Set(paths);
  for (const path of files) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      if (files.has(segments.slice(0, index).join('/'))) {
        throw new Error('A file conflicts with a parent directory.');
      }
    }
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
