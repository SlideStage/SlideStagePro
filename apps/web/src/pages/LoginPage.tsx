import { useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { GitBranch, LogIn, PanelsTopLeft } from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';

const ERROR_MESSAGES: Record<string, string> = {
  'registration-disabled':
    'Registration is disabled on this server. Ask an administrator to create your account.',
};

export function LoginPage(): JSX.Element {
  const auth = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from ?? '/decks';

  const routedNotice = useMemo(() => {
    const stateNotice = (location.state as { notice?: string } | null)?.notice;
    if (stateNotice) return stateNotice;
    const code = params.get('error');
    return code ? ERROR_MESSAGES[code] ?? null : null;
  }, [location.state, params]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await auth.login(email, password);
      nav(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    }
  }

  return (
    <div className="page auth-page">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <Link to="/" className="auth-brand" aria-label="slidestage home">
          <span className="auth-brand-mark" aria-hidden>
            <PanelsTopLeft size={18} strokeWidth={2.4} />
          </span>
          <span className="auth-brand-name">slidestage</span>
        </Link>
        <h1>Welcome back</h1>
        <p className="muted">Use your slidestage account or a configured OAuth provider.</p>
        {routedNotice ? (
          <div className="alert info" data-testid="login-notice">
            {routedNotice}
          </div>
        ) : null}
        {error ? <div className="alert error">{error}</div> : null}
        <label className="field">
          <span>Email</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            required
            data-testid="login-email"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
            required
            data-testid="login-password"
          />
        </label>
        <button className="btn primary" type="submit" data-testid="login-submit">
          <LogIn className="btn-icon" aria-hidden size={16} />
          Log in
        </button>
        {auth.providers.length > 0 ? (
          <div className="oauth-list">
            {auth.providers.map((provider) => (
              <a
                key={provider.key}
                className="btn ghost"
                href={`/api/auth/oauth/${encodeURIComponent(provider.key)}/start`}
                data-testid={`oauth-${provider.key}`}
              >
                {provider.key === 'github' ? (
                  <GitBranch className="btn-icon" aria-hidden size={16} />
                ) : null}
                Continue with {provider.label}
              </a>
            ))}
          </div>
        ) : null}
        {auth.allowRegistration ? (
          <p className="muted small">
            No account? <Link to="/register" data-testid="login-register-link">Create one</Link>
          </p>
        ) : (
          <p className="muted small" data-testid="login-registration-disabled">
            New accounts are managed by an administrator.
          </p>
        )}
      </form>
    </div>
  );
}
