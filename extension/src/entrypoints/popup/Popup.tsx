import { useState } from 'react';
import { browser } from 'wxt/browser';
import { FIVERR_ORIGIN } from '../../lib/constants';
import { formatAgo } from '../../lib/format';
import type { InboxSnapshot } from '../../lib/messages';
import { CAPTURE_TARGETS, type CaptureKind } from '../../lib/selectors';
import { isConfigured, labelOf, patchSettings, type LocalState, type RecentAlert, type SessionState } from '../../lib/storage';
import { Badge, Dot, Logo, Spinner, Switch } from '../../ui/components';
import { ask, useLocal, useNow, useSession } from '../../ui/hooks';
import { AlertIcon, GearIcon, RefreshIcon } from '../../ui/icons';
import { relayStatus, telegramStatus, topProblem, watchStatus } from '../../ui/status';

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
        <div className="small muted ellipsis">{configured ? labelOf(local) : 'Not set up'}</div>
      </div>
      <Switch
        label={local.settings.sendAlerts ? 'Alerts on' : 'Alerts paused'}
        checked={configured && local.settings.sendAlerts}
        disabled={!configured}
        onChange={(v) => void patchSettings({ sendAlerts: v })}
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
          {local.recentAlerts.length === 0 ? (
            <div className="small muted">No alerts yet. New Fiverr messages show up here.</div>
          ) : (
            local.recentAlerts.slice(0, 8).map((a) => <AlertRow key={`${a.at}-${a.username}`} alert={a} now={now} />)
          )}
        </section>

        {local.settings.debug && <DebugCapture local={local} />}
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

function AlertRow({ alert, now }: { alert: RecentAlert; now: number }) {
  return (
    <div className="alert-item">
      <div className="avatar" aria-hidden>
        {(alert.displayName || alert.username).slice(0, 1).toUpperCase()}
      </div>
      <div className="grow">
        <div className="row" style={{ gap: 6 }}>
          <span className="strong ellipsis">{alert.displayName}</span>
          <span className="small muted ellipsis grow">@{alert.username}</span>
          <span className="small muted">{formatAgo(alert.at, now)}</span>
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
  if (s.unread.ok) lines.push(s.unread.value === 0 ? 'No unread messages.' : `${s.unread.value} unread.`);
  else lines.push(s.unread.missing ? `Unread count: selector ${s.unread.missing} is not set up yet.` : `Unread count: ${s.unread.error}`);
  if (s.names.ok) lines.push(...s.names.value.map((n) => `• ${n}`));
  else if (s.names.missing) lines.push(`Names: selector ${s.names.missing} is not set up yet.`);
  return lines.join('\n');
}

/** Debug mode: collect HTML samples for the placeholder selectors. */
function DebugCapture({ local }: { local: LocalState }) {
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
                {saved ? `Saved ${formatAgo(saved.at)} · ${(saved.html.length / 1024).toFixed(1)} KB` : t.where}
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
