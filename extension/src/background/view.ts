/**
 * Is the user looking at a conversation right now? Then an alert for a
 * message in it is noise. "Looking" = some tab on /inbox/{username} is the
 * active tab of a window that has focus and is not minimized. Uses only
 * tab and window state (no page access).
 */
import { browser } from 'wxt/browser';
import { FIVERR_ORIGIN } from '../lib/constants';

export async function conversationInView(username: string): Promise<boolean> {
  if (!username) return false;
  const want = `/inbox/${username.toLowerCase()}`;
  const tabs = await browser.tabs.query({ active: true, url: `${FIVERR_ORIGIN}/inbox/*` }).catch(() => []);
  for (const tab of tabs) {
    if (!tab.url || new URL(tab.url).pathname.replace(/\/$/, '').toLowerCase() !== want) continue;
    const win = await browser.windows.get(tab.windowId).catch(() => null);
    if (win?.focused && win.state !== 'minimized') return true;
  }
  return false;
}
