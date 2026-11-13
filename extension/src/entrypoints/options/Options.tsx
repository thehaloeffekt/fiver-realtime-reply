import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_RELAY_URL } from '../../lib/constants';
import { formatAgo } from '../../lib/format';
import { deriveRelayKeys } from '../../lib/keys';
import {
  isConfigured,
  labelOf,
  patchSettings,
  removeLocal,
  setLocal,
  type LocalState,
  type SessionState,
  type Settings,
} from '../../lib/storage';
import { TelegramError, getMe } from '../../lib/telegram';
import { Badge, Logo, Spinner, Switch, type Tone } from '../../ui/components';
import { ask, minutesUntil, useLocal, useNow, useSession } from '../../ui/hooks';
import { CheckIcon } from '../../ui/icons';
import { relayStatus } from '../../ui/status';

type Tab = 'setup' | 'settings';

export function Options() {
  const local = useLocal();
  const session = useSession();
  const [tab, setTab] = useState<Tab>(() => (location.hash === '#settings' ? 'settings' : 'setup'));
  const [picked, setPicked] = useState(false);

  // First open: show Settings when setup is already done.
  useEffect(() => {
    if (local && !picked && !location.hash) {
      setPicked(true);
      if (isConfigured(local)) setTab('settings');
    }
  }, [local, picked]);

  const choose = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };

  if (!local || !session) return null;
  return (
    <div className="page">
      <header className="page-header">
        <Logo />
        <div className="grow">
          <h1>Fiverr Telegram Alerts</h1>
          <div className="small muted">{isConfigured(local) ? labelOf(local) : 'Setup'}</div>
        </div>
      </header>
      <nav className="tabs" role="tablist">
        {(['setup', 'settings'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => choose(t)}>
            {t === 'setup' ? 'Setup' : 'Settings'}
          </button>
        ))}
      </nav>
      {tab === 'setup' ? <Setup local={local} session={session} /> : <SettingsTab local={local} session={session} />}
    </div>
  );
}

// ---------------------------------------------------------------- setup

type StepState = { tone: Tone; text: string };
const DONE: StepState = { tone: 'ok', text: 'Done' };
const TODO: StepState = { tone: 'idle', text: 'To do' };
const LOCKED: StepState = { tone: 'idle', text: 'Locked' };

function StepCard({ n, title, state, locked, children }: { n: number; title: string; state: StepState; locked?: boolean; children: ReactNode }) {
  return (
    <section className={`card step ${locked ? 'locked' : ''}`} aria-disabled={locked}>
      <div className="step-head">
        <span className={`step-num ${state === DONE ? 'done' : ''}`}>{state === DONE ? <CheckIcon /> : n}</span>
        <h2 className="grow">{title}</h2>
        <Badge tone={state.tone}>{state.text}</Badge>
      </div>
      {!locked && <div className="step-body">{children}</div>}
    </section>
  );
}

function Setup({ local, session }: { local: LocalState; session: SessionState }) {
  const now = useNow(5_000);
  const step1Done = Boolean(local.token && local.bot);
  const relay = relayStatus(local, session, now);
  const step2Done = step1Done && Boolean(local.webhookUrl) && session.relay.phase === 'connected';
  const step3Done = Boolean(local.chatId);
  const waiting = !step3Done && Boolean(local.linkWaitUntil && local.linkWaitUntil > now);

  const s2: StepState = !step1Done
    ? LOCKED
    : step2Done
      ? DONE
      : session.relay.phase === 'offline' && local.webhookUrl
        ? { tone: 'err', text: 'Relay offline' }
        : TODO;
  const s3: StepState = !local.webhookUrl ? LOCKED : step3Done ? DONE : waiting ? { tone: 'accent', text: 'Waiting for /start' } : TODO;
  const s4: StepState = !step3Done ? LOCKED : local.label ? DONE : TODO;

  return (
    <div className="stack">
      <StepCard n={1} title="Connect your bot" state={step1Done ? DONE : TODO}>
        <TokenStep local={local} />
      </StepCard>
      <StepCard n={2} title="Connect the relay" state={s2} locked={!step1Done}>
        <RelayStep local={local} relayText={relay.text} />
      </StepCard>
      <StepCard n={3} title="Link your Telegram chat" state={s3} locked={!local.webhookUrl}>
        <LinkStep local={local} waiting={waiting} />
      </StepCard>
      <StepCard n={4} title="Name this account" state={s4} locked={!step3Done}>
        <LabelStep local={local} />
      </StepCard>
    </div>
  );
}

const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

function TokenStep({ local }: { local: LocalState }) {
  const [token, setToken] = useState(local.token ?? '');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    const value = token.trim();
    setError(null);
    if (!TOKEN_SHAPE.test(value)) {
      setError('That does not look like a bot token. It looks like 123456789:AA… and comes from @BotFather.');
      return;
    }
    setBusy(true);
    try {
      const bot = await getMe(value);
      const keys = await deriveRelayKeys(value);
      const changed = value !== local.token;
      await setLocal({ token: value, bot: { id: bot.id, username: bot.username, firstName: bot.first_name }, ...keys });
      // A new bot means a new chat and a new webhook.
      if (changed) await removeLocal(['chatId', 'webhookUrl', 'linkWaitUntil', 'lastUnread', 'pendingClaims']);
    } catch (e) {
      setError(e instanceof TelegramError && e.status === 401 ? 'Telegram does not know this token. Copy it again from @BotFather.' : `Could not check the token: ${String((e as Error).message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="small muted">
        In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, and paste the token here. It stays in this browser and is only sent to api.telegram.org.
      </p>
      <label className="label" htmlFor="token">
        Bot token
      </label>
      <div className="row">
        <input
          id="token"
          className="input mono"
          type={show ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder="123456789:AA…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button className="btn" onClick={() => setShow(!show)}>
          {show ? 'Hide' : 'Show'}
        </button>
        <button className="btn btn-primary" onClick={check} disabled={busy || !token.trim()}>
          {busy ? <Spinner /> : 'Check token'}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {local.bot && !error && (
        <div className="result">
          <Badge tone="ok">Valid</Badge> <b>{local.bot.firstName}</b> <span className="muted">@{local.bot.username}</span>
        </div>
      )}
    </>
  );
}

function validRelayUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

function RelayStep({ local, relayText }: { local: LocalState; relayText: string }) {
  const [url, setUrl] = useState(local.relayUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    const value = url.trim().replace(/\/+$/, '');
    setError(null);
    if (!validRelayUrl(value)) {
      setError('Enter an https:// address.');
      return;
    }
    setBusy(true);
    if (value !== local.relayUrl) await setLocal({ relayUrl: value, webhookUrl: undefined });
    const res = await ask({ type: 'setup:webhook' });
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'Could not connect.');
  };

  return (
    <>
      <p className="small muted">
        The relay passes button presses and commands from Telegram to this browser. It never sees your bot token, and alerts do not depend on it. The extension
        connects to it first, then tells Telegram to send updates there.
      </p>
      <label className="label" htmlFor="relay">
        Relay URL
      </label>
      <div className="row">
        <input id="relay" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        <button className="btn btn-primary" onClick={connect} disabled={busy}>
          {busy ? <Spinner /> : local.webhookUrl ? 'Reconnect' : 'Connect relay'}
        </button>
      </div>
      {url.trim() !== DEFAULT_RELAY_URL && (
        <button className="link-btn small" onClick={() => setUrl(DEFAULT_RELAY_URL)}>
          Use the default relay
        </button>
      )}
      {error && <div className="error-text">{error}</div>}
      {local.webhookUrl && !error && (
        <p className="small" style={{ margin: '10px 0 0' }}>
          Relay: <b>{relayText}</b>. Webhook set.
        </p>
      )}
    </>
  );
}

function LinkStep({ local, waiting }: { local: LocalState; waiting: boolean }) {
  const bot = local.bot?.username;
  if (local.chatId) {
    return (
      <p className="small">
        Linked to chat <code>{local.chatId}</code>. Updates from any other chat are ignored.
      </p>
    );
  }
  return (
    <>
      <p className="small muted">
        Open your bot in Telegram and send <code>/start</code>. This page updates when the message arrives.
      </p>
      <div className="row">
        {bot && (
          <a className="btn btn-primary" href={`https://t.me/${bot}?start=link`} target="_blank" rel="noreferrer">
            Open @{bot}
          </a>
        )}
        {waiting ? (
          <span className="row small muted">
            <Spinner /> Waiting for /start…
          </span>
        ) : (
          <button className="btn" onClick={() => void ask({ type: 'setup:waitForStart' })}>
            Wait for /start
          </button>
        )}
      </div>
    </>
  );
}

function LabelStep({ local }: { local: LocalState }) {
  const [label, setLabel] = useState(local.label ?? local.detectedUsername ?? '');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ busy: boolean; result?: string; ok?: boolean }>({ busy: false });

  const save = async () => {
    await setLocal({ label: label.trim().slice(0, 64) || undefined });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const sendTest = async () => {
    setTest({ busy: true });
    const res = await ask({ type: 'alert:test' });
    setTest({ busy: false, ok: res.ok, result: res.ok ? 'Sent. Check Telegram.' : res.error });
  };

  return (
    <>
      <p className="small muted">
        Alerts start with this name, so you can tell your Fiverr accounts apart. Each Chrome profile has its own.
        {!local.detectedUsername && ' (Reading your Fiverr username from the page is not set up yet, so type it.)'}
      </p>
      <label className="label" htmlFor="label">
        Account label
      </label>
      <div className="row">
        <input id="label" className="input" maxLength={64} placeholder={local.detectedUsername ?? 'e.g. my_fiverr_name'} value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn btn-primary" onClick={save} disabled={!label.trim()}>
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
      <div className="help">
        Account id <code>{local.accountId}</code> (random, made once; the relay routes button presses with it)
      </div>
      <hr className="sep" style={{ margin: '14px 0' }} />
      <div className="row">
        <button className="btn" onClick={sendTest} disabled={test.busy}>
          {test.busy ? <Spinner /> : 'Send test alert'}
        </button>
        {test.result && <span className={`small ${test.ok ? '' : 'error-text'}`}>{test.result}</span>}
      </div>
    </>
  );
}

// ------------------------------------------------------------- settings

const SWITCHES: Array<[keyof Settings, string, string]> = [
  ['sendAlerts', 'Send alerts', 'Send a Telegram message for each new Fiverr message.'],
  ['attachmentAlerts', 'Attachment alerts', 'Also alert for messages that contain only files ("Sent 2 files").'],
  ['unreadCheck', 'Unread check after reload', 'After each watch-tab reload, alert if the unread count went up.'],
  ['keepWatchTab', 'Keep the watch tab open', 'Open the pinned Fiverr inbox tab again if it is closed.'],
  ['debug', 'Debug mode', 'Show the Debug capture tools in the popup.'],
];

function SettingsTab({ local, session }: { local: LocalState; session: SessionState }) {
  const now = useNow();
  const s = local.settings;
  return (
    <div className="stack">
      <section className="card">
        {SWITCHES.map(([key, title, help]) => (
          <div className="switch-row" key={key}>
            <div className="grow">
              <div className="strong">{title}</div>
              <div className="small muted">{help}</div>
            </div>
            <Switch label={title} checked={Boolean(s[key])} onChange={(v) => void patchSettings({ [key]: v })} />
          </div>
        ))}
      </section>

      <ReloadInterval settings={s} nextReloadAt={session.nextReloadAt} now={now} />

      <section className="card card-pad">
        <h2 className="card-title">Alert preview</h2>
        <div className="tg">
          <div className="tg-bubble">
            <b>{labelOf(local)}</b>
            {'\n'}Message from <b>Miracle R</b> (@m_rohn){'\n'}Later today
          </div>
          <div className="tg-buttons">
            <div className="tg-btn wide">Open inbox ↗</div>
            <div className="tg-btn">Full message</div>
            <div className="tg-btn">Check now</div>
          </div>
        </div>
      </section>

      <Connection local={local} session={session} now={now} />
    </div>
  );
}

function ReloadInterval({ settings, nextReloadAt, now }: { settings: Settings; nextReloadAt?: number; now: number }) {
  const [min, setMin] = useState(String(settings.reloadMinMinutes));
  const [max, setMax] = useState(String(settings.reloadMaxMinutes));
  const lo = Number(min);
  const hi = Number(max);
  const valid = Number.isInteger(lo) && Number.isInteger(hi) && lo >= 5 && hi <= 240 && lo <= hi;
  const dirty = lo !== settings.reloadMinMinutes || hi !== settings.reloadMaxMinutes;

  return (
    <section className="card card-pad">
      <h2 className="card-title">Watch tab reload</h2>
      <div className="row">
        <span>Reload every</span>
        <input className="input input-num" type="number" min={5} max={240} value={min} onChange={(e) => setMin(e.target.value)} aria-label="Minimum minutes" />
        <span>to</span>
        <input className="input input-num" type="number" min={5} max={240} value={max} onChange={(e) => setMax(e.target.value)} aria-label="Maximum minutes" />
        <span>minutes</span>
        <span className="grow" />
        <button className="btn btn-primary" disabled={!valid || !dirty} onClick={() => void patchSettings({ reloadMinMinutes: lo, reloadMaxMinutes: hi })}>
          Save
        </button>
      </div>
      <div className="help">
        A random time in this range, so the reloads do not follow a fixed pattern. Next reload in {minutesUntil(nextReloadAt, now)}.
        {!valid && ' Use whole minutes from 5 to 240, minimum first.'}
      </div>
    </section>
  );
}

function Connection({ local, session, now }: { local: LocalState; session: SessionState; now: number }) {
  const [busy, setBusy] = useState(false);
  const relay = relayStatus(local, session, now);
  const others = session.presence.filter((a) => a.accountId !== local.accountId);

  const disconnect = async () => {
    if (!confirm('Disconnect this profile? It forgets the bot token and the chat. Other profiles on the same bot keep working.')) return;
    setBusy(true);
    await ask({ type: 'profile:disconnect' });
    setBusy(false);
  };

  const rows: Array<[string, ReactNode]> = [
    ['Bot', local.bot ? `@${local.bot.username}` : '—'],
    ['Chat id', local.chatId ?? '—'],
    ['Account id', <code key="a">{local.accountId}</code>],
    ['Relay', <span key="r">{relay.text}</span>],
    ['Relay URL', <code key="u">{local.relayUrl}</code>],
    ['Bot key', local.botKey ? <code key="k">{local.botKey.slice(0, 16)}…</code> : '—'],
    ['Other profiles', others.length ? others.map((a) => `${a.label || a.accountId} (${a.online ? 'online' : `seen ${formatAgo(a.lastSeen, now)}`})`).join(', ') : 'none'],
  ];

  return (
    <section className="card card-pad">
      <h2 className="card-title">Connection</h2>
      <dl className="details">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-danger" onClick={disconnect} disabled={busy || !local.token}>
          {busy ? <Spinner /> : 'Disconnect this profile'}
        </button>
        <span className="small muted">The webhook stays, so other profiles on this bot keep working.</span>
      </div>
    </section>
  );
}
