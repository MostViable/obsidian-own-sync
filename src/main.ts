import { App, Notice, Plugin, PluginSettingTab, requestUrl, SecretComponent, Setting } from 'obsidian';

import { assertNoCaseCollisions, planSync } from './sync/plan';
import { applyPacketToDigests, digestBytes, validateSyncPath } from './sync/packet';

const MAX_PREVIEW_REVISIONS = 100;
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

class PreviewLimitError extends Error {}

interface OwnSyncSettings {
  serverUrl: string;
  vaultId: string;
  tokenSecretId: string;
}

const DEFAULT_SETTINGS: OwnSyncSettings = {
  serverUrl: '',
  vaultId: '',
  tokenSecretId: '',
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

  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<OwnSyncSettings> | null;
    this.settings = {
      serverUrl: typeof saved?.serverUrl === 'string' ? saved.serverUrl : '',
      vaultId: typeof saved?.vaultId === 'string' ? saved.vaultId : '',
      tokenSecretId: typeof saved?.tokenSecretId === 'string' ? saved.tokenSecretId : '',
    };

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
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch (error) {
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }

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

  async previewFirstSync(): Promise<void> {
    let connection: { baseUrl: string; vaultId: string; token: string };
    try {
      connection = this.vaultConnection();
    } catch (error) {
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }

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
      .setDesc('Address of your own server. This development build only checks connectivity and vault access; it does not sync files.')
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
  }
}
