import { useState } from 'react';
import { browser } from 'wxt/browser';
import { FIVERR_ORIGIN } from '../../lib/constants';
import { formatDiagnosticsLog } from '../../lib/diagnostics';
import { formatMine } from '../../lib/buyerTime';
import { formatAgo } from '../../lib/format';
import { myZone, zoneNote, type MyZone } from '../../lib/myZone';
import type { InboxSnapshot } from '../../lib/messages';
import { CAPTURE_TARGETS, type CaptureKind } from '../../lib/selectors';
import { isConfigured, labelOf, type LocalState, type RecentAlert, type SessionState } from '../../lib/storage';
import { Badge, Dot, Logo, Spinner, Switch } from '../../ui/components';
import { ask, useLocal, useNow, useSession } from '../../ui/hooks';
import { AlertIcon, GearIcon, RefreshIcon } from '../../ui/icons';
import { relayStatus, removedNotice, telegramStatus, topProblem, watchStatus } from '../../ui/status';

const openSettings = () => void browser.runtime.openOptionsPage();

export function Popup() {
  const local = useLocal();
  const session = useSession();
  if (!local || !session) return null;
  return (
    <div className="popup">
      <Header local={local} />
      {isConfigured(local) ? <Main local={local} session={session} /> : <FirstRun local={local} />}
    </div>
  );
}

function Header({ local }: { local: LocalState }) {
  const configured = isConfigured(local);
  return (
    <header className="popup-header">
      <Logo />
      <div className="grow">
        <div className="strong">Fiverr Telegram Alerts</div>
        <div className="small muted ellipsis">
          {configured ? labelOf(local) : 'Not set up'}
          {configured && !local.settings.sendAlerts && (
            <>
              {' '}
              <Badge tone="warn">Paused</Badge>
            </>
          )}
        </div>
      </div>
      <Switch
        label={local.settings.sendAlerts ? 'Alerts on' : 'Alerts paused'}
        checked={configured && local.settings.sendAlerts}
        disabled={!configured}
        onChange={(v) => void ask({ type: 'alerts:set', on: v })}
      />
    </header>
  );
}

function FirstRun({ local }: { local: LocalState }) {
  const steps = [
    ['Create a Telegram bot', 'Message @BotFather, send /newbot and copy the token it gives you.'],
    ['Connect and link', 'Paste the token, connect the relay, then send /start to your bot.'],
    ['Name this account', 'Pick the label your alerts show, then send a test alert.'],
  ];
  return (
    <div className="popup-body">
      <div className="card card-pad stack">
        {removedNotice(local) && (
          <div className="banner" role="status">
            {removedNotice(local)}
          </div>
        )}
        <div>
          <div className="strong">Get Fiverr messages in Telegram</div>
          <div className="small muted">Setup takes about two minutes. Your bot token stays in this browser.</div>
        </div>
        <ol className="steps">
          {steps.map(([title, text], i) => (
            <li key={title}>
              <span className="step-num">{i + 1}</span>
              <div>
                <div className="strong">{title}</div>
                <div className="small muted">{text}</div>
              </div>
            </li>
          ))}
        </ol>
        <button className="btn btn-primary btn-block" onClick={openSettings}>
          {local.token ? 'Continue setup' : 'Start setup'}
        </button>
      </div>
    </div>
  );
}

function Main({ local, session }: { local: LocalState; session: SessionState }) {
  const now = useNow();
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const problem = topProblem(local, session);
  const mine = myZone(local.settings);

  const checkNow = async () => {
    setChecking(true);
    setCheckResult(null);
    const res = await ask<{ snapshot: InboxSnapshot }>({ type: 'check:now' });
    setChecking(false);
    setCheckResult(res.ok && res.snapshot ? describeSnapshot(res.snapshot) : `Check failed: ${res.error ?? 'unknown error'}`);
  };

  const fix = async () => {
    if (!problem) return;
    setRetrying(true);
    if (problem.kind === 'relay') await ask({ type: 'relay:retry' });
    if (problem.kind === 'watch') await ask({ type: 'watch:ensure' });
    if (problem.kind === 'telegram') openSettings();
    setRetrying(false);
  };

  const rows = [
    ['Telegram', telegramStatus(local, session)],
    ['Relay', relayStatus(local, session, now)],
    ['Watch tab', watchStatus(local, session, now)],
  ] as const;

  return (
    <>
      <div className="popup-body">
        {problem && (
          <div className={`banner ${problem.tone === 'err' ? 'banner-err' : ''}`} role="alert">
            <AlertIcon />
            <div className="grow small">{problem.text}</div>
            <button className="btn btn-sm" onClick={fix} disabled={retrying}>
              {retrying ? <Spinner /> : problem.kind === 'telegram' ? 'Fix' : problem.kind === 'watch' ? 'Open' : 'Retry'}
            </button>
          </div>
        )}

        {!local.settings.sendAlerts && (
          <div className="banner" role="status">
            <AlertIcon />
            <div className="grow small">
              <b>Paused.</b> No alerts are sent for this account. Messages that arrive while paused are not sent later.
            </div>
            <button className="btn btn-sm" onClick={() => void ask({ type: 'alerts:set', on: true })}>
              Resume
            </button>
          </div>
        )}

        <section className="card card-pad" aria-label="Status">
          {rows.map(([name, st]) => (
            <div className="status-row" key={name}>
              <Dot tone={st.tone} />
              <span className="name">{name}</span>
              <span className="detail small ellipsis">{st.text}</span>
            </div>
          ))}
        </section>

        {checkResult && (
          <section className="card card-pad small check-result" aria-live="polite">
            {checkResult}
          </section>
        )}

        <section className="card card-pad">
          <h2 className="card-title">Recent alerts</h2>
          {!mine.set && (
            <div className="small muted" style={{ marginBottom: 6 }}>
              Times in {mine.zone} (browser zone, not set).{' '}
              <button className="link-btn small" onClick={openSettings}>
                Set My time zone
              </button>
            </div>
          )}
          {local.recentAlerts.length === 0 ? (
            <div className="small muted">No alerts yet. New Fiverr messages show up here.</div>
          ) : (
            local.recentAlerts.slice(0, 8).map((a) => <AlertRow key={`${a.at}-${a.displayName}`} alert={a} now={now} mine={mine} />)
          )}
        </section>

        {local.settings.debug && <Diagnostics local={local} session={session} mine={mine} />}
        {local.settings.debug && <DebugCapture local={local} mine={mine} />}
      </div>

      <footer className="popup-footer">
        <button className="btn btn-primary" onClick={checkNow} disabled={checking}>
          {checking ? <Spinner /> : <RefreshIcon />} Check now
        </button>
        <button className="btn" onClick={openSettings}>
          <GearIcon /> Settings
        </button>
      </footer>
    </>
  );
}

function AlertRow({ alert, now, mine }: { alert: RecentAlert; now: number; mine: MyZone }) {
  return (
    <div className="alert-item">
      <div className="avatar" aria-hidden>
        {(alert.displayName || alert.username).slice(0, 1).toUpperCase()}
      </div>
      <div className="grow">
        <div className="row" style={{ gap: 6 }}>
          <span className="strong ellipsis">{alert.displayName}</span>
          <span className="small muted ellipsis grow">{alert.username ? `@${alert.username}` : ''}</span>
          <span className="small muted" title={`${formatMine(alert.at, mine.zone)} (${zoneNote(mine)})`}>
            {formatAgo(alert.at, now, mine.zone)}
          </span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className="small ellipsis grow" style={{ color: 'var(--text-2)' }}>
            {alert.text}
          </span>
          {alert.status === 'failed' && <Badge tone="err">Not sent</Badge>}
          {alert.status === 'not-linked' && <Badge tone="warn">Not linked</Badge>}
        </div>
      </div>
    </div>
  );
}

function describeSnapshot(s: InboxSnapshot): string {
  const lines: string[] = [];
  if (s.unread.ok) {
    const n = s.unread.value;
    lines.push(n === 0 ? 'No unread conversations.' : `${n} unread ${n === 1 ? 'conversation' : 'conversations'}.`);
  } else lines.push(`Unread count: ${s.unread.error ?? s.unread.missing ?? 'not readable'}`);
  if (s.rows.ok) {
    for (const r of s.rows.value.filter((r) => r.unread > 0).slice(0, 20)) {
      lines.push(`• ${r.name}${r.username ? ` (@${r.username})` : ''}: ${r.unread}`);
    }
  } else lines.push(`List: ${s.rows.error ?? s.rows.missing ?? 'not readable'}`);
  return lines.join('\n');
}

/** Debug mode: collect HTML samples when Fiverr changes its markup. */
function DebugCapture({ local, mine }: { local: LocalState; mine: MyZone }) {
  const [hint, setHint] = useState<string | null>(null);
  const [copied, setCopied] = useState<CaptureKind | null>(null);

  const capture = async (kind: CaptureKind) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith(`${FIVERR_ORIGIN}/`)) {
      setHint(`Open this page first, then press Capture again: ${CAPTURE_TARGETS[kind].where}`);
      return;
    }
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'startCapture', kind });
      window.close(); // let the user point at the page
    } catch {
      setHint('Reload the Fiverr tab (the extension was updated after it opened), then try again.');
    }
  };

  const copy = async (kind: CaptureKind) => {
    const c = local.captures[kind];
    if (!c) return;
    await navigator.clipboard.writeText(c.html);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <section className="card card-pad">
      <h2 className="card-title">Debug capture</h2>
      <div className="small muted" style={{ marginBottom: 4 }}>
        Captures copy HTML that can contain buyer names and messages. Check before you share it.
      </div>
      {(Object.keys(CAPTURE_TARGETS) as CaptureKind[]).map((kind) => {
        const t = CAPTURE_TARGETS[kind];
        const saved = local.captures[kind];
        return (
          <div className="capture-row" key={kind}>
            <div className="grow">
              <div className="strong small">{t.title}</div>
              <div className="small muted ellipsis" title={t.where}>
                {saved ? `Saved ${formatAgo(saved.at, Date.now(), mine.zone)} · ${(saved.html.length / 1024).toFixed(1)} KB` : t.where}
              </div>
            </div>
            {saved && (
              <button className="btn btn-sm" onClick={() => void copy(kind)}>
                {copied === kind ? 'Copied' : 'Copy'}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void capture(kind)}>
              Capture
            </button>
          </div>
        );
      })}
      {hint && <div className="help">{hint}</div>}
    </section>
  );
}

/** Debug mode: the background diagnostics log recorded on Fiverr pages. */
function Diagnostics({ local, session, mine }: { local: LocalState; session: SessionState; mine: MyZone }) {
  const [copied, setCopied] = useState(false);
  const entries = local.diagnostics;
  const last = entries[entries.length - 1];
  const hiddenWatch = entries.filter((e) => e.watch && e.vis === 'hidden' && e.kind !== 'heartbeat' && e.kind !== 'visibility' && e.kind !== 'lifecycle').length;

  const copy = async () => {
    const text = formatDiagnosticsLog(entries, {
      version: browser.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      watchTabId: session.watchTabId,
      zone: mine,
    });
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="card card-pad">
      <h2 className="card-title">Background diagnostics</h2>
      <div className="small muted">
        Recording on every Fiverr page while debug mode is on. The log holds buyer names and message text. Check before you share it.
      </div>
      <div className="small" style={{ margin: '8px 0' }}>
        {entries.length === 0
          ? 'No entries yet. Reload your Fiverr tabs once after turning on debug mode.'
          : `${entries.length} of 300 entries · last ${formatAgo(last!.t, Date.now(), mine.zone)} · ${hiddenWatch} page changes in the hidden watch tab`}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm btn-primary" onClick={() => void copy()} disabled={entries.length === 0}>
          {copied ? 'Copied' : 'Copy diagnostics log'}
        </button>
        <button className="btn btn-sm" onClick={() => void ask({ type: 'diag:clear' })} disabled={entries.length === 0}>
          Clear
        </button>
      </div>
    </section>
  );
}
