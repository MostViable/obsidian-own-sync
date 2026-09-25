import { App, Notice, Plugin, PluginSettingTab, requestUrl, SecretComponent, Setting, TFile, TFolder, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

import { packetLimitFromCapabilities } from './sync/capabilities';
import { SyncEngine, SyncError, type ServerPort, type StoragePort, type SyncReport, type VaultFile, type VaultPort } from './sync/engine';

const AUTO_SYNC_DELAY = 1500;
const POLL_INTERVAL = 30000;
const BUSY_RETRY_DELAY = 3000;
const OFFLINE_RETRY_DELAY = 15000;
const ERROR_RETRY_DELAY = 60000;

type SyncStatus = 'setup' | 'syncing' | 'synced' | 'offline' | 'error';

interface OwnSyncSettings {
  serverUrl: string;
  vaultId: string;
  tokenSecretId: string;
  automaticSync: boolean;
}

interface Connection {
  baseUrl: string;
  vaultId: string;
  token: string;
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

function responseJson(response: RequestUrlResponse): unknown {
  try {
    return response.json;
  } catch {
    return null;
  }
}

function serverPort(connection: Connection): ServerPort {
  const endpoint = `${connection.baseUrl}/api/v0/vaults/${connection.vaultId}`;
  const authorization = { Authorization: `Bearer ${connection.token}` };
  const send = async (request: RequestUrlParam): Promise<RequestUrlResponse> => {
    try {
      return await requestUrl({ ...request, throw: false });
    } catch {
      throw new SyncError('offline', 'Could not reach the server.');
    }
  };
  const failure = (status: number): SyncError => {
    if (status === 401 || status === 403) return new SyncError('unauthorized', 'This device has no access to the vault.');
    if (status === 404) return new SyncError('server', 'The server does not know this vault or its sync API is disabled.');
    return new SyncError('server', `The server returned HTTP ${status}.`);
  };
  return {
    capabilities: async () => {
      const response = await send({ url: `${connection.baseUrl}/api/v0/capabilities`, method: 'GET' });
      if (response.status !== 200) throw failure(response.status);
      return responseJson(response);
    },
    head: async () => {
      const response = await send({ url: `${endpoint}/head`, method: 'GET', headers: authorization });
      if (response.status !== 200) throw failure(response.status);
      const value = responseJson(response) as { current_revision?: unknown } | null;
      return typeof value?.current_revision === 'number' ? value.current_revision : -1;
    },
    commit: async (revision) => {
      const response = await send({ url: `${endpoint}/commits/${revision}`, method: 'GET', headers: authorization });
      if (response.status !== 200) throw failure(response.status);
      return response.arrayBuffer;
    },
    upload: async (operationId, expectedRevision, body) => {
      const response = await send({
        url: `${endpoint}/operations/${operationId}`,
        method: 'POST',
        contentType: 'application/octet-stream',
        headers: { ...authorization, 'X-Expected-Revision': String(expectedRevision) },
        body: body.slice().buffer,
      });
      return { status: response.status, json: responseJson(response) };
    },
  };
}

export default class OwnSyncPlugin extends Plugin {
  settings: OwnSyncSettings = DEFAULT_SETTINGS;
  syncStatus: SyncStatus = 'setup';
  private statusDetail = '';
  private engine: SyncEngine | null = null;
  private engineKey = '';
  private syncRunning = false;
  private syncRequested = false;
  private lastErrorMessage = '';
  private autoSyncTimer: number | null = null;
  private statusBarItem: HTMLElement | null = null;

  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<OwnSyncSettings> | null;
    this.settings = {
      serverUrl: typeof saved?.serverUrl === 'string' ? saved.serverUrl : '',
      vaultId: typeof saved?.vaultId === 'string' ? saved.vaultId : '',
      tokenSecretId: typeof saved?.tokenSecretId === 'string' ? saved.tokenSecretId : '',
      automaticSync: saved?.automaticSync === true,
    };

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatus('setup');

    this.addSettingTab(new OwnSyncSettingTab(this.app, this));
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: 'check-server-connection',
      name: 'Check server connection',
      callback: () => void this.checkServerConnection(),
    });
    this.addCommand({
      id: 'check-vault-access',
      name: 'Check vault access',
      callback: () => void this.checkVaultAccess(),
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
      this.registerInterval(window.setInterval(() => this.scheduleAutoSync(0), POLL_INTERVAL));
      this.scheduleAutoSync(0);
    });
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  private updateStatus(status: SyncStatus, detail = ''): void {
    this.syncStatus = status;
    this.statusDetail = detail;
    if (this.statusBarItem === null) return;
    this.statusBarItem.setText(this.statusText());
    this.statusBarItem.setAttr('aria-label', this.statusText());
  }

  statusText(): string {
    const labels: Record<SyncStatus, string> = {
      setup: 'Own Sync: setup required',
      syncing: 'Own Sync: syncing…',
      synced: 'Own Sync: synced',
      offline: 'Own Sync: offline, changes kept',
      error: 'Own Sync: sync error',
    };
    return this.statusDetail ? `${labels[this.syncStatus]} · ${this.statusDetail}` : labels[this.syncStatus];
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
    await this.runSync(true);
  }

  private scheduleAutoSync(delay = AUTO_SYNC_DELAY): void {
    if (!this.settings.automaticSync || document.hidden) return;
    if (this.autoSyncTimer !== null) window.clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      void this.runSync(false);
    }, delay);
  }

  private syncEngine(): SyncEngine {
    const connection = this.vaultConnection();
    const key = `${connection.baseUrl}\n${connection.vaultId}\n${connection.token}`;
    if (this.engine === null || this.engineKey !== key) {
      this.engine = new SyncEngine({
        serverUrl: connection.baseUrl,
        vaultId: connection.vaultId,
        vault: this.vaultPort(),
        server: serverPort(connection),
        storage: this.storagePort(),
      });
      this.engineKey = key;
    }
    return this.engine;
  }

  private async runSync(manual: boolean): Promise<void> {
    if (this.syncRunning) {
      this.syncRequested = true;
      return;
    }
    let engine: SyncEngine;
    try {
      engine = this.syncEngine();
    } catch (error) {
      this.updateStatus('setup');
      if (manual) new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }
    this.syncRunning = true;
    this.updateStatus('syncing');
    let retryDelay: number | null = null;
    try {
      this.showReport(await engine.sync(manual), manual);
    } catch (error) {
      retryDelay = this.showError(error, manual);
    } finally {
      this.syncRunning = false;
    }
    if (this.syncRequested) {
      this.syncRequested = false;
      this.scheduleAutoSync();
    } else if (retryDelay !== null) {
      this.scheduleAutoSync(retryDelay);
    }
  }

  private showReport(report: SyncReport, manual: boolean): void {
    this.lastErrorMessage = '';
    const skipped: string[] = [];
    if (report.oversized.length > 0) skipped.push(`${report.oversized.length} too large`);
    if (report.invalidPaths.length > 0) skipped.push(`${report.invalidPaths.length} unsupported names`);
    this.updateStatus('synced', skipped.length > 0 ? `not synced: ${skipped.join(', ')}` : '');
    if (report.serverReset) {
      new Notice('Own Sync: the server was restored from an older backup. Files were merged again; nothing was deleted.', 15000);
    }
    if (report.conflictCopies.length > 0) {
      const shown = report.conflictCopies.slice(0, 3).join(', ');
      const more = report.conflictCopies.length > 3 ? ` and ${report.conflictCopies.length - 3} more` : '';
      new Notice(`Own Sync: files were edited on two devices. Both versions kept: ${shown}${more}.`, 15000);
    }
    if (manual) {
      const lists = [
        report.oversized.length > 0 ? `Too large for the server: ${report.oversized.slice(0, 5).join(', ')}.` : '',
        report.invalidPaths.length > 0 ? `Unsupported names: ${report.invalidPaths.slice(0, 5).join(', ')}.` : '',
      ].filter(Boolean).join(' ');
      new Notice(`Own Sync: synced at revision ${report.revision}.${lists ? ` ${lists}` : ''}`);
    }
  }

  // Shows an error once per distinct message and returns the automatic retry delay.
  private showError(error: unknown, manual: boolean): number {
    const syncError = error instanceof SyncError
      ? error
      : new SyncError('local', 'Sync stopped unexpectedly. Local files are unchanged and will be checked again.');
    if (syncError.kind === 'busy') {
      this.updateStatus('syncing');
      return BUSY_RETRY_DELAY;
    }
    if (syncError.kind === 'offline') {
      this.updateStatus('offline');
      if (manual) new Notice('Own Sync: the server is unreachable. Changes stay on this device until it is back.');
      return OFFLINE_RETRY_DELAY;
    }
    this.updateStatus('error', syncError.message);
    if (manual || syncError.message !== this.lastErrorMessage) new Notice(`Own Sync: ${syncError.message}`);
    this.lastErrorMessage = syncError.message;
    return ERROR_RETRY_DELAY;
  }

  private vaultPort(): VaultPort {
    const vault = this.app.vault;
    const info = (file: TFile): VaultFile => ({ path: file.path, mtime: file.stat.mtime, size: file.stat.size });
    const ensureFolders = async (path: string): Promise<void> => {
      const segments = path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        const folder = segments.slice(0, index).join('/');
        const existing = vault.getAbstractFileByPath(folder);
        if (existing === null) await vault.createFolder(folder);
        else if (!(existing instanceof TFolder)) throw new SyncError('local', `A file blocks the folder ${folder}.`);
      }
    };
    return {
      list: () => vault.getFiles().map(info),
      stat: (path) => {
        const file = vault.getAbstractFileByPath(path);
        return file instanceof TFile ? info(file) : null;
      },
      read: async (path) => {
        const file = vault.getAbstractFileByPath(path);
        return file instanceof TFile ? new Uint8Array(await vault.readBinary(file)) : null;
      },
      write: async (path, bytes) => {
        const data = bytes.slice().buffer;
        const existing = vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          await vault.modifyBinary(existing, data);
        } else if (existing === null) {
          await ensureFolders(path);
          await vault.createBinary(path, data);
        } else {
          throw new SyncError('local', `A folder blocks the file ${path}.`);
        }
      },
      trash: async (path) => {
        const existing = vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) await this.app.fileManager.trashFile(existing);
      },
    };
  }

  private storagePort(): StoragePort {
    const adapter = this.app.vault.adapter;
    const directory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const location = (name: string) => `${directory}/${name}`;
    return {
      read: async (name) => await adapter.exists(location(name))
        ? new Uint8Array(await adapter.readBinary(location(name)))
        : null,
      write: async (name, bytes) => {
        await adapter.writeBinary(location(name), bytes.slice().buffer);
      },
      remove: async (name) => {
        if (await adapter.exists(location(name))) await adapter.remove(location(name));
      },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
    let connection: Connection;
    try {
      connection = this.vaultConnection();
    } catch (error) {
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }
    const server = serverPort(connection);
    try {
      packetLimitFromCapabilities(await server.capabilities());
      const revision = await server.head();
      new Notice(`Own Sync: vault is accessible at revision ${revision}.`);
    } catch (error) {
      new Notice(`Own Sync: ${(error as Error).message}`);
    }
  }

  private vaultConnection(): Connection {
    const baseUrl = serverBaseUrl(this.settings.serverUrl);
    const vaultId = this.settings.vaultId.trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(vaultId)) {
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
}

class OwnSyncSettingTab extends PluginSettingTab {
  private readonly plugin: OwnSyncPlugin;

  constructor(app: App, plugin: OwnSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Address of your own server. This development build sends files unencrypted; use disposable test vaults only.')
      .addText((text) => text
        .setPlaceholder('https://sync.example.com')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc('The vault_id from the server credentials file.')
      .addText((text) => text
        .setPlaceholder('32 hexadecimal characters')
        .setValue(this.plugin.settings.vaultId)
        .onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Device token')
      .setDesc('Select a secret containing the token from the server credentials file. The plugin saves only the secret name in its settings.')
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(this.plugin.settings.tokenSecretId)
        .onChange(async (value) => {
          this.plugin.settings.tokenSecretId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Automatic sync')
      .setDesc('Sync after vault changes, when the app returns, when the network returns and every 30 seconds. Files that exist on both sides with different contents are kept as conflict copies.')
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
      .setDesc('Check the token and vault ID against the server. No notes are transferred.')
      .addButton((button) => button
        .setButtonText('Check vault access')
        .onClick(async () => {
          await this.plugin.checkVaultAccess();
        }));
  }
}
