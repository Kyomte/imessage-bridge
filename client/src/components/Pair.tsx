import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';

const defaultDeviceName = () => (navigator.userAgent.includes('Windows') ? 'Windows laptop' : 'Browser');

export function Pair({ onPaired }: { onPaired: (token: string) => void }) {
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.pair(password, deviceName);
      onPaired(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('Wrong password.');
      else if (err instanceof ApiError && err.status === 429) setError('Too many attempts. Wait a few minutes.');
      else setError("Couldn't reach the Mac. Is the bridge running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pair">
      <form className="pair-card" onSubmit={submit}>
        <h1>Messages Bridge</h1>
        <p className="muted">Pair this device with your Mac. The password is in this file on the Mac:</p>
        <code className="pair-path">~/Library/Application Support/imessage-bridge/pairing-password.txt</code>
        <label>
          Pairing password
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Device name
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !password}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </div>
  );
}
