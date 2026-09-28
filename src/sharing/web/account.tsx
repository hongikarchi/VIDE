import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, message } from './api';

// ID + password accounts. New accounts need the owner's sign-up code.
export function Account({ onLogin }: { onLogin: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState(''),
    [reveal, setReveal] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      if (mode === 'signup')
        await api('/account/sign-up', 'POST', { username, password, code: code.trim() });
      await api('/account/sign-in', 'POST', { username, password });
      await onLogin();
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  const signup = mode === 'signup';
  return (
    <main className="account">
      <p className="wordmark">VIDE</p>
      <h1>{signup ? '계정 만들기' : '로그인'}</h1>
      <form onSubmit={submit}>
        <label>
          아이디
          <input
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={signup ? 30 : 254}
            pattern={signup ? '[A-Za-z0-9][A-Za-z0-9_.\\-]{2,29}' : undefined}
            title={signup ? '영문·숫자·_ . - 3~30자' : undefined}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          비밀번호
          <span className="password-field">
            <input
              type={reveal ? 'text' : 'password'}
              minLength={8}
              maxLength={128}
              required
              autoComplete={signup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="password-toggle"
              aria-label={reveal ? '비밀번호 숨기기' : '비밀번호 보기'}
              aria-pressed={reveal}
              onClick={() => setReveal(!reveal)}
            >
              {reveal ? '숨기기' : '보기'}
            </button>
          </span>
        </label>
        {signup ? (
          <label>
            가입 코드
            <input
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        ) : null}
        <button className="primary" disabled={busy}>
          {busy ? '처리 중…' : signup ? '가입하고 시작하기' : '로그인'}
        </button>
        <p role="status" className="status">
          {status}
        </p>
      </form>
      <p className="switch">
        {signup ? '이미 계정이 있나요?' : '처음 사용하나요?'}{' '}
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(signup ? 'login' : 'signup');
            setStatus('');
          }}
        >
          {signup ? '로그인' : '계정 만들기'}
        </button>
      </p>
      {signup ? (
        <p className="muted small">비밀번호는 복구할 수 없습니다. 잊지 않게 보관하세요.</p>
      ) : null}
    </main>
  );
}
