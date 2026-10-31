import { useState } from 'react';
import { errorText } from './bookkeeping-api';

export default function MutationLogin({ confirm, busy }: {
  confirm: (username: string, password: string) => Promise<void>; busy: boolean;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const disabled = busy || submitting;
  async function submit() {
    if (disabled) return;
    setError('');
    if (!username.trim() || !password) { setError('请填写账号和密码'); return; }
    setSubmitting(true);
    try { await confirm(username.trim(), password); }
    catch (e) { setError(errorText(e)); }
    finally { setSubmitting(false); }
  }
  return <fieldset className="entry-form" disabled={disabled} onKeyDown={event => {
    if (event.key === 'Enter') { event.preventDefault(); void submit(); }
  }}>
    <legend>登录已过期</legend>
    <p>重新登录后，用原请求确认结果。</p>
    <label>账号<input aria-label="重新登录账号" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></label>
    <label>密码<input aria-label="重新登录密码" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <button type="button" className="primary full" disabled={disabled} onClick={() => void submit()}>{disabled ? '正在确认…' : '重新登录并确认原请求'}</button>
  </fieldset>;
}
