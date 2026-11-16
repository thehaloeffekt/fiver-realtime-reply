import type { InboxRow, ListMessage } from './inboxRow';
import type { RowState } from './listState';
import type { DiagEntry } from './diagnostics';
import type { CaptureKind } from './selectors';
import type { Toast } from './toast';

/** Result of reading something from a Fiverr page. `missing` names a selector that is not set up. */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; missing?: string; error?: string };

export interface InboxSnapshot {
  /** Id of the page that was read (its load time), to tell reloads apart. */
  page: string;
  /** Count on the "Unread" chip: unread conversations. */
  unread: ReadResult<number>;
  /** Every row of the conversation list, top first. */
  rows: ReadResult<InboxRow[]>;
}

export interface ConversationMessage {
  /** Fiverr's message id (the div.message id). */
  id: string;
  /** As shown, e.g. "Nov 15, 9:51 PM". */
  time: string;
  /** Body text; '' for a message that has only files. */
  text: string;
  /** File names. Only the names are ever sent, never the files. */
  files: string[];
}

/** The conversation header: the buyer's local time, as a UTC offset. */
export interface BuyerHeader {
  username: string;
  /** Minutes east of UTC, computed when the header was read. */
  offset: number;
  /** The clock as shown, e.g. "2:57 AM". */
  clock: string;
  /** From the About panel, when shown. */
  country?: string;
}

/** "Full message": the buyer's messages and the header, read together. */
export interface ConversationRead {
  messages: ConversationMessage[];
  header: BuyerHeader | null;
}

/** Why a page asks to be reloaded. */
export type StaleReason = 'resume' | 'no-list';

export interface ListStatus {
  /** The conversation list is on the page. */
  present: boolean;
  /** Since when it has been missing (page time), or null. */
  missingSince: number | null;
  path: string;
  /** Id of this page (its load time). */
  page: string;
  /** The live watcher's state per conversation. */
  rows: Record<string, RowState>;
  /** The Unread chip count now, or null when it is not on the page. */
  unread: number | null;
}

/** Content script → background */
export type ContentToBackground =
  | { type: 'toast'; toast: Toast }
  | { type: 'username'; username: string }
  | { type: 'capture'; kind: CaptureKind; html: string; url: string }
  | { type: 'diag'; entries: DiagEntry[] }
  | { type: 'listMessage'; message: ListMessage }
  | { type: 'listState'; page: string; rows: Record<string, RowState> }
  | { type: 'stale'; reason: StaleReason }
  | { type: 'buyerHeader'; header: BuyerHeader };

/** Background → content script */
export type BackgroundToContent =
  | { type: 'ping' }
  | { type: 'readInbox' }
  | { type: 'readConversation'; limit: number; myUsername?: string }
  | { type: 'listStatus' }
  | { type: 'startCapture'; kind: CaptureKind };

/** Popup / options → background */
export type UiToBackground =
  | { type: 'relay:connect' }
  | { type: 'relay:retry' }
  | { type: 'setup:webhook' }
  | { type: 'setup:waitForStart' }
  | { type: 'alert:test' }
  | { type: 'check:now' }
  | { type: 'alerts:set'; on: boolean }
  | { type: 'watch:ensure' }
  | { type: 'watch:reschedule' }
  | { type: 'profile:disconnect' }
  | { type: 'diag:clear' };

export interface UiResponse {
  ok: boolean;
  error?: string;
  detail?: string;
}
