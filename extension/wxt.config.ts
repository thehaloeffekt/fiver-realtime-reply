import { defineConfig } from 'wxt';

export const DEFAULT_RELAY_URL = 'https://fta-relay.fiverelay.workers.dev';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  // Keep imports explicit; every file says where its helpers come from.
  imports: false,
  manifest: {
    name: 'Fiverr Telegram Alerts',
    description: 'Sends a Telegram alert when a new Fiverr inbox message arrives.',
    permissions: ['storage', 'tabs', 'alarms'],
    host_permissions: [
      'https://www.fiverr.com/*',
      'https://api.telegram.org/*',
      `${DEFAULT_RELAY_URL}/*`,
    ],
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    action: { default_title: 'Fiverr Telegram Alerts' },
  },
});
