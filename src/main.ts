import { App, Notice, Plugin, PluginSettingTab, requestUrl, Setting } from 'obsidian';

interface OwnSyncSettings {
  serverUrl: string;
}

const DEFAULT_SETTINGS: OwnSyncSettings = {
  serverUrl: '',
};

function healthUrl(serverUrl: string): string {
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
  return `${url.origin}${path}/healthz`;
}

export default class OwnSyncPlugin extends Plugin {
  settings: OwnSyncSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<OwnSyncSettings> | null;
    this.settings = {
      serverUrl: typeof saved?.serverUrl === 'string' ? saved.serverUrl : '',
    };

    this.addSettingTab(new OwnSyncSettingTab(this.app, this));
    this.addCommand({
      id: 'check-server-connection',
      name: 'Check server connection',
      callback: () => { void this.checkServerConnection(); },
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
      url = healthUrl(this.settings.serverUrl);
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
      .setDesc('Address of your own server. This development build only checks connectivity; it does not sync files.')
      .addText((text) => text
        .setPlaceholder('https://sync.example.com')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.settings.serverUrl = value.trim();
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
  }
}
