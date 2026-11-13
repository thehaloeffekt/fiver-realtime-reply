import type { CaptureKind } from './selectors';
import type { Toast } from './toast';

/** Result of reading something from a Fiverr page. `missing` names a placeholder selector. */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; missing?: string; error?: string };

export interface InboxSnapshot {
  unread: ReadResult<number>;
  names: ReadResult<string[]>;
}

export interface ConversationMessage {
  text: string;
}

/** Content script → background */
export type ContentToBackground =
  | { type: 'toast'; toast: Toast }
  | { type: 'username'; username: string }
  | { type: 'capture'; kind: CaptureKind; html: string; url: string };

/** Background → content script */
export type BackgroundToContent =
  | { type: 'ping' }
  | { type: 'readInbox' }
  | { type: 'readConversation'; limit: number }
  | { type: 'startCapture'; kind: CaptureKind };

/** Popup / options → background */
export type UiToBackground =
  | { type: 'relay:connect' }
  | { type: 'relay:retry' }
  | { type: 'setup:webhook' }
  | { type: 'setup:waitForStart' }
  | { type: 'alert:test' }
  | { type: 'check:now' }
  | { type: 'watch:ensure' }
  | { type: 'watch:reschedule' }
  | { type: 'profile:disconnect' };

export interface UiResponse {
  ok: boolean;
  error?: string;
  detail?: string;
}
