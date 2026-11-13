/**
 * Debug capture: lets the user point at an area of the Fiverr page and copies
 * its outerHTML. Used to collect samples for the placeholder selectors.
 *
 * The user does the clicking. The picker swallows that click (and the
 * pointer events around it) in the capture phase, so Fiverr never sees it and
 * nothing on the page is activated.
 */
import { CAPTURE_TARGETS, type CaptureKind } from '../lib/selectors';

const Z = '2147483647';
let active: (() => void) | null = null;

export function startPicker(kind: CaptureKind, onCapture: (html: string) => Promise<void>): void {
  active?.();
  const target = CAPTURE_TARGETS[kind];

  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: Z, border: '2px solid #1D4ED8',
    background: 'rgba(29,78,216,0.08)', borderRadius: '4px', transition: 'all 60ms ease-out',
  });
  const bar = document.createElement('div');
  Object.assign(bar.style, {
    position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: Z,
    background: '#0F172A', color: '#fff', font: '13px/1.4 system-ui, sans-serif', padding: '10px 14px',
    borderRadius: '10px', boxShadow: '0 6px 24px rgba(0,0,0,.25)', maxWidth: '640px', pointerEvents: 'none',
  });
  const setBar = (msg: string) => (bar.textContent = msg);
  setBar(`Fiverr Telegram Alerts: click ${target.pick}. ↑ selects the parent, ↓ goes back, Enter captures, Esc cancels.`);
  document.documentElement.append(box, bar);

  let current: Element | null = null;
  const trail: Element[] = [];

  const show = (el: Element | null) => {
    current = el;
    if (!el) return void (box.style.display = 'none');
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
  };

  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const onMove = (e: MouseEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== box && el !== bar) {
      trail.length = 0;
      show(el);
    }
  };

  const capture = async () => {
    const el = current;
    if (!el) return;
    stop();
    const html = `<!-- ${kind} | ${location.href} | ${pathOf(el)} -->\n${el.outerHTML}`;
    await onCapture(html);
    let copied = false;
    try {
      await navigator.clipboard.writeText(html);
      copied = true;
    } catch {
      // Clipboard blocked; the capture is saved in the extension, copy it from the popup.
    }
    toast(copied ? `Copied ${(html.length / 1024).toFixed(1)} KB of HTML. Paste it in the chat.` : 'Saved. Open the extension popup and press Copy.');
  };

  const onClick = (e: MouseEvent) => {
    swallow(e);
    void capture();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      swallow(e);
      stop();
    } else if (e.key === 'ArrowUp' && current?.parentElement && current.parentElement !== document.documentElement) {
      swallow(e);
      trail.push(current);
      show(current.parentElement);
    } else if (e.key === 'ArrowDown' && trail.length) {
      swallow(e);
      show(trail.pop()!);
    } else if (e.key === 'Enter') {
      swallow(e);
      void capture();
    }
  };

  const blocked = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu'];
  const stop = () => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    for (const t of blocked) window.removeEventListener(t, swallow, true);
    box.remove();
    bar.remove();
    active = null;
  };

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  for (const t of blocked) window.addEventListener(t, swallow, true);
  active = stop;
}

/** "body > div#main > ul.list > li" style path, for context in the capture. */
function pathOf(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== document.body && parts.length < 12; e = e.parentElement) {
    const testid = e.getAttribute('data-testid');
    const cls = Array.from(e.classList).slice(0, 3).join('.');
    parts.unshift(`${e.tagName.toLowerCase()}${testid ? `[data-testid="${testid}"]` : ''}${cls ? `.${cls}` : ''}`);
  }
  return parts.join(' > ').replace(/--/g, '- -');
}

function toast(msg: string) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: Z,
    background: '#0F172A', color: '#fff', font: '13px/1.4 system-ui, sans-serif', padding: '10px 14px', borderRadius: '10px',
  });
  el.textContent = msg;
  document.documentElement.append(el);
  setTimeout(() => el.remove(), 4000);
}
