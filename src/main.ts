import { App, Notice, Plugin, PluginSettingTab, requestUrl, SecretComponent, Setting, TFile, TFolder } from 'obsidian';

import { applyInitialSnapshot, applyRemoteChanges } from './sync/apply';
import { assertCompatibleCapabilities } from './sync/capabilities';
import { assertNoCaseCollisions, assertNoFileDirectoryCollisions, planSync } from './sync/plan';
import { applyPacketToDigests, classifyUploadResponse, createPendingDownload, createPendingUpload, decodePacket, digestBytes, encodePacket, MAX_PACKET_BYTES, readPendingDownload, readPendingUpload, validateSyncPath, type FileChange } from './sync/packet';
import { advanceConfirmedRevision, assertRebaseLocalFiles, changesFromLocal, confirmedAfterInitialDownload, confirmedAfterPull, confirmedAfterUpload, createPendingPull, planFromConfirmed, queuedUploadDigests, readConfirmedState, readPendingPull } from './sync/state';

const MAX_PREVIEW_REVISIONS = 100;
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

class PreviewLimitError extends Error {}

type SyncStatus = 'setup' | 'syncing' | 'synced' | 'queued' | 'conflict' | 'error';

interface OwnSyncSettings {
  serverUrl: string;
  vaultId: string;
  tokenSecretId: string;
  automaticSync: boolean;
}

const DEFAULT_SETTINGS: OwnSyncSettings = {
  serverUrl: '',
  vaultId: '',
  tokenSecretId: '',
  automaticSync: false,
};

function serverBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl.trim());
  const isLocalHttp = url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Use HTTPS for a remote server.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter a server URL without credentials, query or fragment.');
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export default class OwnSyncPlugin extends Plugin {
  settings: OwnSyncSettings = DEFAULT_SETTINGS;
  private pendingUpload: unknown = null;
  private pendingDownload: unknown = null;
  private pendingPull: unknown = null;
  private confirmed: unknown = null;
  private mutationRunning = false;
  private saveChain: Promise<void> = Promise.resolve();
  private autoSyncTimer: number | null = null;
  private statusBarItem: HTMLElement | null = null;
  syncStatus: SyncStatus = 'setup';

  async onload(): Promise<void> {
    const saved = await this.loadData() as (Partial<OwnSyncSettings> & {
      pendingUpload?: unknown;
      pendingDownload?: unknown;
      pendingPull?: unknown;
      confirmed?: unknown;
    }) | null;
    this.settings = {
      serverUrl: typeof saved?.serverUrl === 'string' ? saved.serverUrl : '',
      vaultId: typeof saved?.vaultId === 'string' ? saved.vaultId : '',
      tokenSecretId: typeof saved?.tokenSecretId === 'string' ? saved.tokenSecretId : '',
      automaticSync: saved?.automaticSync === true,
    };
    this.pendingUpload = saved?.pendingUpload ?? null;
    this.pendingDownload = saved?.pendingDownload ?? null;
    this.pendingPull = saved?.pendingPull ?? null;
    this.confirmed = saved?.confirmed ?? null;

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatus('setup');

    this.addSettingTab(new OwnSyncSettingTab(this.app, this));
    this.addCommand({
      id: 'check-server-connection',
      name: 'Check server connection',
      callback: () => { void this.checkServerConnection(); },
    });
    this.addCommand({
      id: 'check-vault-access',
      name: 'Check vault access',
      callback: () => { void this.checkVaultAccess(); },
    });
    this.addCommand({
      id: 'preview-first-sync',
      name: 'Preview first sync',
      callback: () => { void this.previewFirstSync(); },
    });
    this.addCommand({
      id: 'preview-confirmed-changes',
      name: 'Preview changes since confirmed revision',
      callback: () => { void this.previewConfirmedChanges(); },
    });
    this.addCommand({
      id: 'upload-test-vault',
      name: 'Upload test vault to empty server',
      callback: () => { void this.uploadTestVault(); },
    });
    this.addCommand({
      id: 'download-test-vault',
      name: 'Download first test revision into empty vault',
      callback: () => { void this.downloadTestVault(); },
    });
    this.addCommand({
      id: 'push-local-changes',
      name: 'Push local test changes',
      callback: () => { void this.pushLocalChanges(); },
    });
    this.addCommand({
      id: 'pull-remote-changes',
      name: 'Pull remote test changes',
      callback: () => { void this.pullRemoteChanges(); },
    });
    this.addCommand({
      id: 'reconcile-pending-upload',
      name: 'Reconcile pending test upload',
      callback: () => { void this.reconcilePendingUpload(); },
    });
    this.addCommand({
      id: 'sync-now',
      name: 'Sync test vault now',
      callback: () => { void this.runAutoSync(); },
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', () => this.scheduleAutoSync(), this));
      this.registerEvent(this.app.vault.on('modify', () => this.scheduleAutoSync(), this));
      this.registerEvent(this.app.vault.on('delete', () => this.scheduleAutoSync(), this));
      this.registerEvent(this.app.vault.on('rename', () => this.scheduleAutoSync(), this));
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (!document.hidden) this.scheduleAutoSync(0);
      });
      this.registerDomEvent(window, 'online', () => this.scheduleAutoSync(0));
      this.registerInterval(window.setInterval(() => this.scheduleAutoSync(0), 30000));
      this.scheduleAutoSync(0);
    });
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  private updateStatus(status: SyncStatus): void {
    this.syncStatus = status;
    if (this.statusBarItem === null) return;
    this.statusBarItem.setText(this.statusText());
    this.statusBarItem.setAttr('aria-label', this.statusText());
  }

  statusText(): string {
    const labels: Record<SyncStatus, string> = {
      setup: 'Own Sync: setup required',
      syncing: 'Own Sync: syncing…',
      synced: 'Own Sync: synced',
      queued: 'Own Sync: changes queued',
      conflict: 'Own Sync: conflict needs review',
      error: 'Own Sync: sync error',
    };
    return labels[this.syncStatus];
  }

  async setAutomaticSync(enabled: boolean): Promise<void> {
    const previous = this.settings.automaticSync;
    this.settings.automaticSync = enabled;
    try {
      await this.saveSettings();
    } catch {
      this.settings.automaticSync = previous;
      throw new Error('Could not save automatic sync setting.');
    }
    if (enabled) this.scheduleAutoSync(0);
    else if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  async syncNow(): Promise<void> {
    await this.runAutoSync();
  }

  private scheduleAutoSync(delay = 1500): void {
    if (!this.settings.automaticSync || document.hidden) return;
    if (this.autoSyncTimer !== null) window.clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      void this.runAutoSync();
    }, delay);
  }

  private async runAutoSync(): Promise<void> {
    if (this.mutationRunning) {
      this.scheduleAutoSync();
      return;
    }
    this.mutationRunning = true;
    this.updateStatus('syncing');
    try {
      await this.runAutoSyncOnce();
    } catch {
      this.updateStatus('error');
      new Notice('Own Sync: sync stopped unexpectedly. Check the saved queue and retry.');
    } finally {
      this.mutationRunning = false;
      if (this.settings.automaticSync && this.syncStatus === 'error') this.scheduleAutoSync(15000);
    }
  }

  private async runAutoSyncOnce(): Promise<void> {
    if (this.pendingDownload !== null || this.confirmed === null) {
      this.updateStatus('setup');
      return;
    }
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch {
      this.updateStatus('setup');
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;

    if (this.pendingUpload !== null) {
      await this.reconcilePendingUploadOnce();
      if (this.pendingUpload !== null || this.pendingPull !== null || this.syncStatus === 'error' ||
        this.syncStatus === 'conflict') return;
    }
    await this.pullRemoteChangesOnce();
    if (this.syncStatus !== 'synced') return;
    if (this.pendingPull !== null || this.pendingUpload !== null) {
      this.updateStatus('queued');
      return;
    }
    this.updateStatus('syncing');
    await this.pushLocalChangesOnce();
    const status = this.syncStatus as SyncStatus;
    if (this.pendingUpload !== null && status === 'syncing') this.updateStatus('queued');
    else if (status === 'syncing') this.updateStatus('synced');
  }

  async saveSettings(): Promise<void> {
    const snapshot = {
      ...this.settings,
      pendingUpload: this.pendingUpload,
      pendingDownload: this.pendingDownload,
      pendingPull: this.pendingPull,
      confirmed: this.confirmed,
    };
    this.saveChain = this.saveChain.catch(() => {}).then(() => this.saveData(snapshot));
    await this.saveChain;
  }

  async checkServerConnection(): Promise<void> {
    if (!this.settings.serverUrl.trim()) {
      new Notice('Own Sync: enter your server URL in the plugin settings.');
      return;
    }

    let url: string;
    try {
      url = `${serverBaseUrl(this.settings.serverUrl)}/healthz`;
    } catch (error) {
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }

    try {
      const response = await requestUrl({ url, method: 'GET' });
      if (response.status === 200 && response.json?.status === 'ok') {
        new Notice('Own Sync: server is reachable.');
      } else {
        new Notice('Own Sync: server returned an unexpected health response.');
      }
    } catch {
      new Notice('Own Sync: could not reach the server.');
    }
  }

  async checkVaultAccess(): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch (error) {
      this.updateStatus('error');
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;

    try {
      const response = await requestUrl({
        url: `${connection.baseUrl}/api/v0/vaults/${connection.vaultId}/head`,
        method: 'GET',
        headers: { Authorization: `Bearer ${connection.token}` },
        throw: false,
      });
      if (response.status === 401) {
        new Notice('Own Sync: this device token has no access to the vault.');
      } else if (response.status === 200 &&
        Number.isSafeInteger(response.json?.current_revision) &&
        response.json.current_revision >= 0) {
        new Notice(`Own Sync: vault is accessible at revision ${response.json.current_revision}.`);
      } else {
        new Notice(`Own Sync: unexpected vault response (HTTP ${response.status}).`);
      }
    } catch {
      new Notice('Own Sync: could not check vault access.');
    }
  }

  private vaultConnection(): { baseUrl: string; vaultId: string; token: string } {
    const baseUrl = serverBaseUrl(this.settings.serverUrl);
    const vaultId = this.settings.vaultId.trim();
    if (!/^[0-9a-f]{32}$/i.test(vaultId)) {
      throw new Error('Enter a 32-character hexadecimal vault ID.');
    }
    if (!this.settings.tokenSecretId) {
      throw new Error('Select a device token secret in the plugin settings.');
    }
    const token = this.app.secretStorage.getSecret(this.settings.tokenSecretId)?.trim();
    if (!token || !/^[0-9a-f]{64}$/i.test(token)) {
      throw new Error('The selected secret needs a 64-character hexadecimal device token.');
    }
    return { baseUrl, vaultId, token };
  }

  private async requireServerCapabilities(baseUrl: string): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${baseUrl}/api/v0/capabilities`, method: 'GET', throw: false,
      });
      if (response.status !== 200) throw new Error('Server did not report protocol capabilities.');
      assertCompatibleCapabilities(response.json);
      return true;
    } catch (error) {
      this.updateStatus('error');
      new Notice(`Own Sync: ${(error as Error).message}`);
      return false;
    }
  }

  async previewFirstSync(): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch (error) {
      this.updateStatus('error');
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;

    const endpoint = `${connection.baseUrl}/api/v0/vaults/${connection.vaultId}`;
    const headers = { Authorization: `Bearer ${connection.token}` };
    try {
      const head = await requestUrl({ url: `${endpoint}/head`, method: 'GET', headers, throw: false });
      if (head.status !== 200 || !Number.isSafeInteger(head.json?.current_revision) ||
        head.json.current_revision < 0) {
        new Notice(`Own Sync: could not read vault head (HTTP ${head.status}).`);
        return;
      }
      const revision: number = head.json.current_revision;
      if (revision > MAX_PREVIEW_REVISIONS) {
        new Notice('Own Sync: test preview supports at most 100 revisions. No files changed.');
        return;
      }

      const remote = new Map<string, string>();
      let transferredBytes = 0;
      for (let current = 1; current <= revision; current += 1) {
        const response = await requestUrl({
          url: `${endpoint}/commits/${current}`, method: 'GET', headers, throw: false,
        });
        if (response.status !== 200) {
          throw new Error('Could not read a remote commit.');
        }
        transferredBytes += response.arrayBuffer.byteLength;
        if (transferredBytes > MAX_PREVIEW_BYTES) {
          throw new PreviewLimitError('Remote history exceeds the 32 MiB test preview limit.');
        }
        await applyPacketToDigests(remote, response.arrayBuffer);
      }

      const local = new Map<string, string>();
      let scannedBytes = 0;
      for (const file of this.app.vault.getFiles()) {
        validateSyncPath(file.path);
        scannedBytes += file.stat.size;
        if (scannedBytes > MAX_PREVIEW_BYTES) {
          throw new PreviewLimitError('Local vault exceeds the 32 MiB test preview limit.');
        }
        local.set(file.path, await digestBytes(new Uint8Array(await this.app.vault.readBinary(file))));
      }
      assertNoCaseCollisions(new Set([...local.keys(), ...remote.keys()]));
      const decisions = planSync(new Map(), local, remote);
      const uploads = decisions.filter((decision) => decision.action === 'push').length;
      const downloads = decisions.filter((decision) => decision.action === 'pull').length;
      const conflicts = decisions.filter((decision) => decision.action === 'conflict').length;
      new Notice(`Own Sync preview: ${uploads} uploads, ${downloads} downloads, ${conflicts} conflicts. No files changed.`, 15000);
    } catch (error) {
      new Notice(error instanceof PreviewLimitError
        ? `Own Sync: ${error.message} No files changed.`
        : 'Own Sync: preview failed or contains unsupported data. No files changed.');
    }
  }

  async previewConfirmedChanges(): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    let confirmed: ReturnType<typeof readConfirmedState>;
    try {
      connection = this.vaultConnection();
      confirmed = readConfirmedState(this.confirmed);
      if (confirmed.state.serverUrl !== connection.baseUrl ||
        confirmed.state.vaultId !== connection.vaultId.toLowerCase()) {
        throw new Error('Confirmed state belongs to another server or vault.');
      }
    } catch {
      this.updateStatus('setup');
      new Notice('Own Sync: no confirmed base for this vault. Complete the first test transfer.');
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;

    const endpoint = `${connection.baseUrl}/api/v0/vaults/${confirmed.state.vaultId}`;
    const headers = { Authorization: `Bearer ${connection.token}` };
    try {
      const head = await requestUrl({ url: `${endpoint}/head`, method: 'GET', headers, throw: false });
      if (head.status !== 200 || !Number.isSafeInteger(head.json?.current_revision) ||
        head.json.current_revision < 0) {
        throw new Error('Could not read the remote head.');
      }
      const revision: number = head.json.current_revision;
      if (revision < confirmed.state.revision) {
        new Notice('Own Sync: server is behind the confirmed revision. No files changed.');
        return;
      }
      if (revision - confirmed.state.revision > MAX_PREVIEW_REVISIONS) {
        throw new PreviewLimitError('More than 100 remote revisions since the confirmed base.');
      }

      const remote = new Map(confirmed.digests);
      let transferredBytes = 0;
      for (let current = confirmed.state.revision + 1; current <= revision; current += 1) {
        const response = await requestUrl({
          url: `${endpoint}/commits/${current}`, method: 'GET', headers, throw: false,
        });
        if (response.status !== 200) throw new Error('Could not read a remote commit.');
        transferredBytes += response.arrayBuffer.byteLength;
        if (transferredBytes > MAX_PREVIEW_BYTES) {
          throw new PreviewLimitError('Remote delta exceeds the 32 MiB test preview limit.');
        }
        await applyPacketToDigests(remote, response.arrayBuffer);
      }

      const local = new Map<string, string>();
      let scannedBytes = 0;
      for (const file of this.app.vault.getFiles()) {
        validateSyncPath(file.path);
        scannedBytes += file.stat.size;
        if (scannedBytes > MAX_PREVIEW_BYTES) {
          throw new PreviewLimitError('Local vault exceeds the 32 MiB test preview limit.');
        }
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        scannedBytes += bytes.byteLength - file.stat.size;
        if (scannedBytes > MAX_PREVIEW_BYTES) {
          throw new PreviewLimitError('Local vault exceeds the 32 MiB test preview limit.');
        }
        local.set(file.path, await digestBytes(bytes));
      }

      const decisions = planFromConfirmed(confirmed.digests, local, remote);
      const uploads = decisions.filter((decision) => decision.action === 'push').length;
      const downloads = decisions.filter((decision) => decision.action === 'pull').length;
      const conflicts = decisions.filter((decision) => decision.action === 'conflict').length;
      const paths = decisions.slice(0, 8).map((decision) => `${decision.action}: ${decision.path}`);
      const remainder = decisions.length > paths.length ? `\n…and ${decisions.length - paths.length} more` : '';
      const pending = this.pendingUpload === null ? '' : '\nPending upload remains queued.';
      new Notice(
        `Own Sync preview at revision ${revision}: ${uploads} uploads, ${downloads} downloads, ${conflicts} conflicts.` +
        `${paths.length ? `\n${paths.join('\n')}` : ''}${remainder}${pending}\nNo files changed.`,
        20000,
      );
    } catch (error) {
      new Notice(error instanceof PreviewLimitError
        ? `Own Sync: ${error.message} No files changed.`
        : 'Own Sync: preview failed or contains unsupported data. No files changed.');
    }
  }

  async uploadTestVault(): Promise<void> {
    if (this.mutationRunning) return;
    this.mutationRunning = true;
    try {
      await this.uploadTestVaultOnce();
    } finally {
      this.mutationRunning = false;
    }
  }

  private async uploadTestVaultOnce(): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch (error) {
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;
    const vaultId = connection.vaultId.toLowerCase();
    const endpoint = `${connection.baseUrl}/api/v0/vaults/${vaultId}`;
    if (this.pendingDownload !== null) {
      new Notice('Own Sync: finish the pending test download before uploading.');
      return;
    }
    if (this.pendingPull !== null) {
      new Notice('Own Sync: finish the pending remote pull before uploading.');
      return;
    }
    if (this.confirmed !== null && this.pendingUpload === null) {
      new Notice('Own Sync: initial upload is already confirmed. Use Push local test changes.');
      return;
    }
    if (this.pendingUpload === null) {
      try {
        const head = await requestUrl({
          url: `${endpoint}/head`, method: 'GET',
          headers: { Authorization: `Bearer ${connection.token}` }, throw: false,
        });
        if (head.status !== 200 || head.json?.current_revision !== 0) {
          new Notice('Own Sync: test upload needs an accessible empty server vault. No files sent.');
          return;
        }
        const files = this.app.vault.getFiles();
        if (files.length === 0) {
          new Notice('Own Sync: test vault has no visible files to upload.');
          return;
        }
        for (const file of files) validateSyncPath(file.path);
        assertNoCaseCollisions(files.map((file) => file.path));
        let totalBytes = 0;
        const changes: Array<{ path: string; kind: 'put'; bytes: Uint8Array }> = [];
        for (const file of files) {
          totalBytes += file.stat.size;
          if (totalBytes > MAX_PACKET_BYTES) {
            new Notice('Own Sync: test upload exceeds the 1 MiB packet limit. No files sent.');
            return;
          }
          changes.push({ path: file.path, kind: 'put', bytes: new Uint8Array(await this.app.vault.readBinary(file)) });
        }
        const packet = await encodePacket(changes);
        this.pendingUpload = createPendingUpload(connection.baseUrl, vaultId, packet);
        this.updateStatus('queued');
        try {
          await this.saveSettings();
        } catch {
          this.pendingUpload = null;
          throw new Error('Could not persist pending upload.');
        }
      } catch {
        this.updateStatus('error');
        new Notice('Own Sync: could not prepare or save test upload. No files sent.');
        return;
      }
    }

    await this.submitPendingUpload(connection);
  }

  async downloadTestVault(): Promise<void> {
    if (this.mutationRunning) return;
    this.mutationRunning = true;
    try {
      await this.downloadTestVaultOnce();
    } finally {
      this.mutationRunning = false;
    }
  }

  private async downloadTestVaultOnce(): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch (error) {
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;
    if (this.pendingUpload !== null) {
      new Notice('Own Sync: finish the pending test upload before downloading.');
      return;
    }
    if (this.pendingPull !== null) {
      new Notice('Own Sync: finish the pending remote pull before downloading.');
      return;
    }
    if (this.confirmed !== null && this.pendingDownload === null) {
      new Notice('Own Sync: this vault already has confirmed state. First download is complete.');
      return;
    }
    const vaultId = connection.vaultId.toLowerCase();
    const endpoint = `${connection.baseUrl}/api/v0/vaults/${vaultId}`;
    if (this.pendingDownload === null) {
      if (this.app.vault.getFiles().length !== 0) {
        new Notice('Own Sync: first download needs an empty local test vault. No files changed.');
        return;
      }
      try {
        const headers = { Authorization: `Bearer ${connection.token}` };
        const head = await requestUrl({ url: `${endpoint}/head`, method: 'GET', headers, throw: false });
        if (head.status !== 200 || head.json?.current_revision !== 1) {
          new Notice('Own Sync: first download needs exactly one server revision. No files changed.');
          return;
        }
        const response = await requestUrl({
          url: `${endpoint}/commits/1`, method: 'GET', headers, throw: false,
        });
        if (response.status !== 200) {
          new Notice(`Own Sync: could not read first revision (HTTP ${response.status}).`);
          return;
        }
        const pending = createPendingDownload(connection.baseUrl, vaultId, response.arrayBuffer);
        const { changes } = await readPendingDownload(pending);
        assertNoCaseCollisions(changes.map((change) => change.path));
        assertNoFileDirectoryCollisions(changes.map((change) => change.path));
        this.pendingDownload = pending;
        try {
          await this.saveSettings();
        } catch {
          this.pendingDownload = null;
          throw new Error('Could not persist pending download.');
        }
      } catch {
        this.updateStatus('error');
        new Notice('Own Sync: could not prepare or save first download. No files changed.');
        return;
      }
    }

    try {
      const { pending, changes } = await readPendingDownload(this.pendingDownload);
      if (pending.serverUrl !== connection.baseUrl || pending.vaultId !== vaultId) {
        new Notice('Own Sync: pending download belongs to another server or vault. Restore its settings before retrying.');
        return;
      }
      const paths = changes.map((change) => change.path);
      assertNoCaseCollisions(paths);
      assertNoFileDirectoryCollisions(paths);
      const vault = this.app.vault;
      await applyInitialSnapshot({
        listPaths: () => vault.getFiles().map((file) => file.path),
        read: async (path) => {
          const file = vault.getAbstractFileByPath(path);
          if (file === null) return null;
          if (!(file instanceof TFile)) throw new Error('Folder conflicts with a downloaded file.');
          return new Uint8Array(await vault.readBinary(file));
        },
        ensureFolder: async (path) => {
          const existing = vault.getAbstractFileByPath(path);
          if (existing === null) await vault.createFolder(path);
          else if (!(existing instanceof TFolder)) throw new Error('File conflicts with a downloaded folder.');
        },
        create: async (path, bytes) => {
          await vault.createBinary(path, new Uint8Array(bytes).buffer);
        },
      }, changes);
      const nextConfirmed = await confirmedAfterInitialDownload(pending);
      const previousConfirmed = this.confirmed;
      this.pendingDownload = null;
      this.confirmed = nextConfirmed;
      try {
        await this.saveSettings();
        this.updateStatus('synced');
        new Notice(`Own Sync: downloaded ${changes.length} test files. Later revisions are not synced.`);
      } catch {
        this.pendingDownload = pending;
        this.confirmed = previousConfirmed;
        new Notice('Own Sync: files were created, but local confirmation failed. An identical retry is safe.');
      }
    } catch {
      this.updateStatus('error');
      new Notice('Own Sync: download stopped. Pending packet kept; existing files were not overwritten.');
    }
  }

  async pushLocalChanges(): Promise<void> {
    if (this.mutationRunning) return;
    this.mutationRunning = true;
    try {
      await this.pushLocalChangesOnce();
    } finally {
      this.mutationRunning = false;
    }
  }

  private async pushLocalChangesOnce(): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch (error) {
      this.updateStatus('error');
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;
    if (this.pendingDownload !== null) {
      new Notice('Own Sync: finish the pending test download before pushing changes.');
      return;
    }
    if (this.pendingPull !== null) {
      this.updateStatus('queued');
      new Notice('Own Sync: finish the pending remote pull before pushing changes.');
      return;
    }
    if (this.pendingUpload !== null) {
      await this.submitPendingUpload(connection);
      return;
    }

    let confirmed: ReturnType<typeof readConfirmedState>;
    try {
      confirmed = readConfirmedState(this.confirmed);
      if (confirmed.state.serverUrl !== connection.baseUrl ||
        confirmed.state.vaultId !== connection.vaultId.toLowerCase()) {
        throw new Error('Confirmed state belongs to another server or vault.');
      }
    } catch {
      this.updateStatus('error');
      new Notice('Own Sync: no valid confirmed base for this vault. Complete the first test transfer.');
      return;
    }

    const endpoint = `${connection.baseUrl}/api/v0/vaults/${confirmed.state.vaultId}`;
    try {
      const head = await requestUrl({
        url: `${endpoint}/head`, method: 'GET',
        headers: { Authorization: `Bearer ${connection.token}` }, throw: false,
      });
      if (head.status !== 200 || head.json?.current_revision !== confirmed.state.revision) {
        this.updateStatus(head.status === 200 ? 'conflict' : 'error');
        new Notice('Own Sync: server revision differs from the confirmed base. Local files were not sent.');
        return;
      }
      const local = new Map<string, { digest: string; bytes: Uint8Array }>();
      let scannedBytes = 0;
      for (const file of this.app.vault.getFiles()) {
        validateSyncPath(file.path);
        scannedBytes += file.stat.size;
        if (scannedBytes > MAX_PREVIEW_BYTES) {
          this.updateStatus('error');
          new Notice('Own Sync: local test vault exceeds the 32 MiB scan limit. No files sent.');
          return;
        }
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        scannedBytes += bytes.byteLength - file.stat.size;
        if (scannedBytes > MAX_PREVIEW_BYTES) {
          this.updateStatus('error');
          new Notice('Own Sync: local test vault exceeds the 32 MiB scan limit. No files sent.');
          return;
        }
        local.set(file.path, { digest: await digestBytes(bytes), bytes });
      }
      assertNoCaseCollisions(new Set([...confirmed.digests.keys(), ...local.keys()]));
      assertNoFileDirectoryCollisions(local.keys());
      const changes = changesFromLocal(confirmed.digests, local);
      if (changes.length === 0) {
        new Notice(`Own Sync: local files match confirmed revision ${confirmed.state.revision}.`);
        return;
      }
      const packet = await encodePacket(changes);
      this.pendingUpload = createPendingUpload(
        connection.baseUrl, confirmed.state.vaultId, packet, confirmed.state.revision,
      );
      this.updateStatus('queued');
      try {
        await this.saveSettings();
      } catch {
        this.pendingUpload = null;
        throw new Error('Could not persist pending changes.');
      }
    } catch {
      this.updateStatus('error');
      new Notice('Own Sync: could not prepare or save local changes. No new request sent.');
      return;
    }
    await this.submitPendingUpload(connection);
  }

  private async submitPendingUpload(
    connection: { baseUrl: string; vaultId: string; token: string }, quietConflict = false,
  ): Promise<'confirmed' | 'conflict' | 'blocked'> {
    let pending: Awaited<ReturnType<typeof readPendingUpload>>['pending'];
    let body: ArrayBuffer;
    let nextConfirmed: Awaited<ReturnType<typeof confirmedAfterUpload>>;
    try {
      ({ pending, body } = await readPendingUpload(this.pendingUpload));
      if (pending.serverUrl !== connection.baseUrl || pending.vaultId !== connection.vaultId.toLowerCase()) {
        this.updateStatus('error');
        new Notice('Own Sync: pending upload belongs to another server or vault. Restore its settings before retrying.');
        return 'blocked';
      }
      nextConfirmed = await confirmedAfterUpload(this.confirmed, pending);
    } catch {
      this.updateStatus('error');
      new Notice('Own Sync: pending upload or confirmed base is invalid. No request sent.');
      return 'blocked';
    }

    const expectedRevision = pending.expectedRevision ?? 0;
    const endpoint = `${connection.baseUrl}/api/v0/vaults/${pending.vaultId}`;
    try {
      const response = await requestUrl({
        url: `${endpoint}/operations/${pending.operationId}`,
        method: 'POST',
        contentType: 'application/octet-stream',
        headers: {
          Authorization: `Bearer ${connection.token}`,
          'X-Expected-Revision': String(expectedRevision),
        },
        body,
        throw: false,
      });
      const result = classifyUploadResponse(response.status, response.json, expectedRevision);
      if (result === 'applied' || result === 'replayed') {
        const previousConfirmed = this.confirmed;
        this.confirmed = nextConfirmed;
        this.pendingUpload = null;
        try {
          await this.saveSettings();
          new Notice(`Own Sync: test changes confirmed at revision ${nextConfirmed.revision}.`);
          this.updateStatus('synced');
          return 'confirmed';
        } catch {
          this.confirmed = previousConfirmed;
          this.pendingUpload = pending;
          new Notice('Own Sync: server accepted changes, but local confirmation failed. Retry is safe.');
          this.updateStatus('error');
          return 'blocked';
        }
      } else if (result === 'conflict') {
        if (!quietConflict) {
          new Notice('Own Sync: server changed during upload. Pending operation kept; reconciliation is required.');
        }
        this.updateStatus('conflict');
        return 'conflict';
      } else {
        new Notice(`Own Sync: server did not accept changes (HTTP ${response.status}). Pending operation kept.`);
        this.updateStatus('error');
        return 'blocked';
      }
    } catch {
      new Notice('Own Sync: upload result unknown. Pending operation kept for an identical retry.');
      this.updateStatus('error');
      return 'blocked';
    }
  }

  async pullRemoteChanges(): Promise<void> {
    if (this.mutationRunning) return;
    this.mutationRunning = true;
    try {
      await this.pullRemoteChangesOnce();
    } finally {
      this.mutationRunning = false;
    }
  }

  async reconcilePendingUpload(): Promise<void> {
    if (this.mutationRunning) return;
    this.mutationRunning = true;
    try {
      await this.reconcilePendingUploadOnce();
    } finally {
      this.mutationRunning = false;
    }
  }

  private async reconcilePendingUploadOnce(): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch (error) {
      this.updateStatus('error');
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;
    if (this.pendingDownload !== null || this.pendingUpload === null) {
      this.updateStatus('queued');
      new Notice('Own Sync: reconciliation needs a pending test upload and no first download.');
      return;
    }
    if (this.pendingPull !== null) {
      try {
        const { pending } = await readPendingPull(this.pendingPull);
        if (pending.rebaseOperationId === undefined) throw new Error('Not a pending rebase.');
        await this.pullRemoteChangesOnce(pending.rebaseOperationId);
      } catch {
        this.updateStatus('error');
        new Notice('Own Sync: saved reconciliation is invalid. Pending operations were kept.');
      }
      return;
    }
    let operationId: string;
    try {
      const { pending } = await readPendingUpload(this.pendingUpload);
      const confirmed = readConfirmedState(this.confirmed);
      if (pending.serverUrl !== connection.baseUrl || pending.vaultId !== connection.vaultId.toLowerCase() ||
        (pending.expectedRevision ?? 0) !== confirmed.state.revision) {
        throw new Error('Pending upload does not match the confirmed vault.');
      }
      operationId = pending.operationId;
    } catch {
      this.updateStatus('error');
      new Notice('Own Sync: pending upload has no valid confirmed base for reconciliation.');
      return;
    }
    if (await this.submitPendingUpload(connection, true) === 'conflict') {
      await this.pullRemoteChangesOnce(operationId);
    }
  }

  private async scanLocalDigests(): Promise<Map<string, string>> {
    const local = new Map<string, string>();
    let scannedBytes = 0;
    for (const file of this.app.vault.getFiles()) {
      validateSyncPath(file.path);
      scannedBytes += file.stat.size;
      if (scannedBytes > MAX_PREVIEW_BYTES) throw new PreviewLimitError('Local vault exceeds 32 MiB.');
      const bytes = new Uint8Array(await this.app.vault.readBinary(file));
      scannedBytes += bytes.byteLength - file.stat.size;
      if (scannedBytes > MAX_PREVIEW_BYTES) throw new PreviewLimitError('Local vault exceeds 32 MiB.');
      local.set(file.path, await digestBytes(bytes));
    }
    return local;
  }

  private async pullRemoteChangesOnce(rebaseOperationId?: string): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    let confirmed: ReturnType<typeof readConfirmedState>;
    try {
      connection = this.vaultConnection();
      confirmed = readConfirmedState(this.confirmed);
      if (confirmed.state.serverUrl !== connection.baseUrl ||
        confirmed.state.vaultId !== connection.vaultId.toLowerCase()) {
        throw new Error('Confirmed state belongs to another server or vault.');
      }
    } catch {
      this.updateStatus('setup');
      new Notice('Own Sync: no confirmed base for this vault. Complete the first test transfer.');
      return;
    }
    if (!await this.requireServerCapabilities(connection.baseUrl)) return;
    if (this.pendingDownload !== null ||
      (rebaseOperationId === undefined && this.pendingUpload !== null) ||
      (rebaseOperationId !== undefined && this.pendingUpload === null)) {
      this.updateStatus('queued');
      new Notice('Own Sync: finish the pending upload or first download before pulling changes.');
      return;
    }

    if (this.pendingPull === null) {
      const endpoint = `${connection.baseUrl}/api/v0/vaults/${confirmed.state.vaultId}`;
      const headers = { Authorization: `Bearer ${connection.token}` };
      try {
        const head = await requestUrl({ url: `${endpoint}/head`, method: 'GET', headers, throw: false });
        if (head.status !== 200 || !Number.isSafeInteger(head.json?.current_revision) ||
          head.json.current_revision < confirmed.state.revision) {
          this.updateStatus('error');
          throw new Error('Invalid remote head.');
        }
        const revision: number = head.json.current_revision;
        if (revision === confirmed.state.revision) {
          this.updateStatus('synced');
          new Notice(`Own Sync: already at confirmed revision ${revision}.`);
          return;
        }
        if (revision - confirmed.state.revision > MAX_PREVIEW_REVISIONS) {
          throw new PreviewLimitError('More than 100 remote revisions.');
        }

        const local = await this.scanLocalDigests();
        if (rebaseOperationId !== undefined) {
          const { pending } = await readPendingUpload(this.pendingUpload);
          if (pending.operationId !== rebaseOperationId ||
            (pending.expectedRevision ?? 0) !== confirmed.state.revision) {
            throw new Error('Pending upload does not match the confirmed base.');
          }
          try {
            await queuedUploadDigests(this.confirmed, pending, local);
          } catch {
            this.updateStatus('conflict');
            new Notice('Own Sync: local files changed after the queued upload. Pending upload kept; no rebase started.');
            return;
          }
        }
        const remote = new Map(confirmed.digests);
        const remoteBytes = new Map<string, Uint8Array>();
        let transferredBytes = 0;
        for (let current = confirmed.state.revision + 1; current <= revision; current += 1) {
          const response = await requestUrl({
            url: `${endpoint}/commits/${current}`, method: 'GET', headers, throw: false,
          });
          if (response.status !== 200) throw new Error('Could not read a remote commit.');
          transferredBytes += response.arrayBuffer.byteLength;
          if (transferredBytes > MAX_PREVIEW_BYTES) {
            throw new PreviewLimitError('Remote delta exceeds 32 MiB.');
          }
          const changes = await decodePacket(response.arrayBuffer);
          await applyPacketToDigests(remote, response.arrayBuffer);
          for (const change of changes) {
            if (change.kind === 'put') remoteBytes.set(change.path, change.bytes);
            else remoteBytes.delete(change.path);
          }
        }
        assertNoCaseCollisions(remote.keys());
        assertNoFileDirectoryCollisions(remote.keys());
        const decisions = planFromConfirmed(confirmed.digests, local, remote);
        if (decisions.some((decision) => decision.action === 'conflict')) {
          this.updateStatus('conflict');
          new Notice('Own Sync: local and remote files conflict. Pull stopped; preview changes first.');
          return;
        }
        const delta: FileChange[] = [];
        for (const path of new Set([...confirmed.digests.keys(), ...remote.keys()])) {
          if (confirmed.digests.get(path) === remote.get(path)) continue;
          const digest = remote.get(path);
          if (digest === undefined) delta.push({ path, kind: 'delete' });
          else {
            const bytes = remoteBytes.get(path);
            if (bytes === undefined || await digestBytes(bytes) !== digest) {
              throw new Error('Remote packet history is incomplete.');
            }
            delta.push({ path, kind: 'put', bytes });
          }
        }
        if (delta.length === 0) {
          const previousConfirmed = this.confirmed;
          const previousUpload = this.pendingUpload;
          if (rebaseOperationId !== undefined) {
            const current = await this.scanLocalDigests();
            try {
              await queuedUploadDigests(this.confirmed, previousUpload, current);
            } catch {
              this.updateStatus('conflict');
              new Notice('Own Sync: local files changed during rebase. Pending upload kept.');
              return;
            }
          }
          const nextConfirmed = advanceConfirmedRevision(previousConfirmed, revision);
          this.confirmed = nextConfirmed;
          if (rebaseOperationId !== undefined) this.pendingUpload = null;
          try {
            await this.saveSettings();
          } catch {
            this.confirmed = previousConfirmed;
            this.pendingUpload = previousUpload;
            this.updateStatus('error');
            new Notice('Own Sync: could not save the confirmed revision. Files were not changed.');
            return;
          }
          this.updateStatus('synced');
          new Notice(`Own Sync: confirmed revision ${revision}; file contents already match.`);
          if (rebaseOperationId !== undefined) {
            try { await this.pushLocalChangesOnce(); }
            catch { new Notice('Own Sync: rebase saved. Retry Push local changes to send remaining edits.'); }
          }
          return;
        }
        const packet = await encodePacket(delta);
        this.pendingPull = createPendingPull(
          connection.baseUrl, confirmed.state.vaultId, confirmed.state.revision, revision, packet,
          rebaseOperationId,
        );
        try {
          await this.saveSettings();
        } catch {
          this.pendingPull = null;
          throw new Error('Could not save pending remote changes.');
        }
      } catch (error) {
        this.updateStatus('error');
        new Notice(error instanceof PreviewLimitError
          ? `Own Sync: ${error.message} No files changed.`
          : 'Own Sync: could not prepare the remote pull. No files changed.');
        return;
      }
    }

    try {
      const { pending, changes } = await readPendingPull(this.pendingPull);
      if (pending.serverUrl !== connection.baseUrl || pending.vaultId !== confirmed.state.vaultId) {
        this.updateStatus('error');
        new Notice('Own Sync: pending pull belongs to another server or vault. Restore its settings before retrying.');
        return;
      }
      if (pending.rebaseOperationId !== rebaseOperationId) {
        this.updateStatus('error');
        new Notice('Own Sync: pending pull belongs to a different operation. Use the matching retry command.');
        return;
      }
      const nextConfirmed = await confirmedAfterPull(this.confirmed, pending);
      let rebaseState: {
        desired: Map<string, string>;
        remote: Map<string, string>;
        decisions: ReturnType<typeof planFromConfirmed>;
      } | null = null;
      if (pending.rebaseOperationId !== undefined) {
        const { pending: upload } = await readPendingUpload(this.pendingUpload);
        if (upload.operationId !== pending.rebaseOperationId ||
          (upload.expectedRevision ?? 0) !== confirmed.state.revision) {
          throw new Error('Queued upload no longer matches the pending rebase.');
        }
        const desired = readConfirmedState(await confirmedAfterUpload(this.confirmed, upload)).digests;
        const remote = readConfirmedState(nextConfirmed).digests;
        const decisions = planFromConfirmed(confirmed.digests, desired, remote);
        assertRebaseLocalFiles(desired, remote, decisions, changes, await this.scanLocalDigests(), true);
        rebaseState = { desired, remote, decisions };
      }
      const vault = this.app.vault;
      await applyRemoteChanges({
        listPaths: () => vault.getFiles().map((file) => file.path),
        read: async (path) => {
          const file = vault.getAbstractFileByPath(path);
          if (file === null) return null;
          if (file instanceof TFolder) return null;
          if (!(file instanceof TFile)) throw new Error('Unsupported vault entry.');
          return new Uint8Array(await vault.readBinary(file));
        },
        ensureFolder: async (path) => {
          const existing = vault.getAbstractFileByPath(path);
          if (existing === null) await vault.createFolder(path);
          else if (!(existing instanceof TFolder)) throw new Error('File conflicts with a remote folder.');
        },
        put: async (path, bytes) => {
          const existing = vault.getAbstractFileByPath(path);
          const data = new Uint8Array(bytes).buffer;
          if (existing === null) await vault.createBinary(path, data);
          else if (existing instanceof TFile) await vault.modifyBinary(existing, data);
          else throw new Error('Folder conflicts with a remote file.');
        },
        remove: async (path) => {
          const existing = vault.getAbstractFileByPath(path);
          if (existing === null) return;
          if (!(existing instanceof TFile)) throw new Error('Folder conflicts with a remote deletion.');
          await this.app.fileManager.trashFile(existing);
        },
      }, confirmed.digests, changes);
      if (rebaseState !== null) {
        assertRebaseLocalFiles(rebaseState.desired, rebaseState.remote, rebaseState.decisions,
          changes, await this.scanLocalDigests(), false);
      }
      const previousConfirmed = this.confirmed;
      const previousUpload = this.pendingUpload;
      this.confirmed = nextConfirmed;
      this.pendingPull = null;
      if (pending.rebaseOperationId !== undefined) this.pendingUpload = null;
      try {
        await this.saveSettings();
      } catch {
        this.confirmed = previousConfirmed;
        this.pendingPull = pending;
        this.pendingUpload = previousUpload;
        this.updateStatus('error');
        new Notice('Own Sync: files changed, but confirmation could not be saved. Retry the pull.');
        return;
      }
      if (this.pendingUpload === null) this.updateStatus('synced');
      new Notice(`Own Sync: pulled test changes through revision ${nextConfirmed.revision}.`);
      if (pending.rebaseOperationId !== undefined) {
        try { await this.pushLocalChangesOnce(); }
        catch { new Notice('Own Sync: rebase saved. Retry Push local changes to send remaining edits.'); }
      }
    } catch {
      this.updateStatus('error');
      new Notice('Own Sync: remote pull stopped. Pending packet kept; retry after checking local files.');
    }
  }
}

class OwnSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: OwnSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Address of your own server. This development build supports only manual, unencrypted test transfers.')
      .addText((text) => text
        .setPlaceholder('https://sync.example.com')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc('The vault_id from the local server bootstrap file.')
      .addText((text) => text
        .setPlaceholder('32 hexadecimal characters')
        .setValue(this.plugin.settings.vaultId)
        .onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Device token')
      .setDesc('Select a secret containing the token from the local server bootstrap file. The plugin saves only the secret name in its settings.')
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(this.plugin.settings.tokenSecretId)
        .onChange(async (value) => {
          this.plugin.settings.tokenSecretId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Automatic test sync')
      .setDesc('After the first confirmed transfer, sync on vault changes, app return and network return. Transfers are unencrypted; use only disposable test vaults.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.automaticSync)
        .onChange(async (value) => {
          try {
            await this.plugin.setAutomaticSync(value);
          } catch (error) {
            toggle.setValue(this.plugin.settings.automaticSync);
            new Notice(`Own Sync: ${(error as Error).message}`);
          }
        }));

    new Setting(containerEl)
      .setName('Sync status')
      .setDesc(this.plugin.statusText())
      .addButton((button) => button
        .setButtonText('Sync now')
        .onClick(async () => {
          await this.plugin.syncNow();
          this.display();
        }));

    new Setting(containerEl)
      .setName('Connection')
      .setDesc('Check that the server responds to /healthz.')
      .addButton((button) => button
        .setButtonText('Check connection')
        .onClick(async () => {
          await this.plugin.checkServerConnection();
        }));

    new Setting(containerEl)
      .setName('Vault access')
      .setDesc('Check the token and vault ID against the experimental server API. No notes are transferred.')
      .addButton((button) => button
        .setButtonText('Check vault access')
        .onClick(async () => {
          await this.plugin.checkVaultAccess();
        }));

    new Setting(containerEl)
      .setName('First sync preview')
      .setDesc('Read the test server history and local files, then count proposed changes. This does not write files or send notes.')
      .addButton((button) => button
        .setButtonText('Preview first sync')
        .onClick(async () => {
          await this.plugin.previewFirstSync();
        }));

    new Setting(containerEl)
      .setName('Changes since confirmed revision')
      .setDesc('Compare local files with only the later server revisions and list proposed uploads, downloads and conflicts. Reads only; pending uploads remain queued.')
      .addButton((button) => button
        .setButtonText('Preview changes')
        .onClick(async () => {
          await this.plugin.previewConfirmedChanges();
        }));

    new Setting(containerEl)
      .setName('Test upload')
      .setDesc('Send all visible files as one unencrypted packet only if the server vault is empty. For disposable test data. A failed request keeps the exact packet for retry.')
      .addButton((button) => button
        .setButtonText('Upload test vault')
        .onClick(async () => {
          await this.plugin.uploadTestVault();
        }));

    new Setting(containerEl)
      .setName('First test download')
      .setDesc('Create files from server revision 1 in an empty disposable vault. Never overwrites an existing file; a partial download can be retried.')
      .addButton((button) => button
        .setButtonText('Download test vault')
        .onClick(async () => {
          await this.plugin.downloadTestVault();
        }));

    new Setting(containerEl)
      .setName('Push local test changes')
      .setDesc('After the first transfer, send local additions, edits and deletions only when the server revision still matches. This is a manual unencrypted test operation.')
      .addButton((button) => button
        .setButtonText('Push local changes')
        .onClick(async () => {
          await this.plugin.pushLocalChanges();
        }));

    new Setting(containerEl)
      .setName('Pull remote test changes')
      .setDesc('Apply later server changes while preserving independent local edits. Conflicting paths stop the pull. Deleted files follow your Obsidian trash preference; interrupted pulls can be retried.')
      .addButton((button) => button
        .setButtonText('Pull remote changes')
        .onClick(async () => {
          await this.plugin.pullRemoteChanges();
        }));

    new Setting(containerEl)
      .setName('Reconcile pending test upload')
      .setDesc('Retry a queued upload, then rebase it only if the server explicitly rejects the old revision and the local files still match the queued packet. Conflicting paths stay queued.')
      .addButton((button) => button
        .setButtonText('Reconcile upload')
        .onClick(async () => {
          await this.plugin.reconcilePendingUpload();
        }));
  }
}
