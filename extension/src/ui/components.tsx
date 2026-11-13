import type { ReactNode } from 'react';
import { BellIcon } from './icons';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </label>
  );
}

export type Tone = 'ok' | 'warn' | 'err' | 'idle' | 'accent';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Dot({ tone }: { tone: Exclude<Tone, 'accent'> }) {
  return <span className={`dot dot-${tone}`} />;
}

export function Logo() {
  return (
    <div className="logo" aria-hidden>
      <BellIcon />
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Working" />;
}
