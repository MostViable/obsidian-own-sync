export function isSyncableVaultPath(path: string): boolean {
  return path !== '.obsidian' && !path.startsWith('.obsidian/');
}
