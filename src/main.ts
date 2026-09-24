import { App, Notice, Plugin, PluginSettingTab, requestUrl, SecretComponent, Setting } from 'obsidian';

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
    let baseUrl: string;
    try {
      baseUrl = serverBaseUrl(this.settings.serverUrl);
    } catch (error) {
      new Notice(`Own Sync: ${(error as Error).message}`);
      return;
    }

    const vaultId = this.settings.vaultId.trim();
    if (!/^[0-9a-f]{32}$/i.test(vaultId)) {
      new Notice('Own Sync: enter a 32-character hexadecimal vault ID.');
      return;
    }
    if (!this.settings.tokenSecretId) {
      new Notice('Own Sync: select a device token secret in the plugin settings.');
      return;
    }

    const token = this.app.secretStorage.getSecret(this.settings.tokenSecretId)?.trim();
    if (!token || !/^[0-9a-f]{64}$/i.test(token)) {
      new Notice('Own Sync: the selected secret needs a 64-character hexadecimal device token.');
      return;
    }

    try {
      const response = await requestUrl({
        url: `${baseUrl}/api/v0/vaults/${vaultId}/head`,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
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
  }
}
