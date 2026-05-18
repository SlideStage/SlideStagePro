import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { PanelsTopLeft, UserPlus } from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';

export function RegisterPage(): JSX.Element {
  const auth = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  // While the very first auth refresh is in-flight, render nothing rather
  // than briefly flashing the form before bouncing to /login. This matters
  // both for UX and for the lockdown e2e — otherwise the test races against
  // the providers fetch.
  if (auth.loading) {
    return (
      <div className="page auth-page" data-testid="register-loading" />
    );
  }

  if (!auth.allowRegistration) {
    return (
      <Navigate
        to="/login?error=registration-disabled"
        replace
        state={{ from: '/register' }}
      />
    );
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await auth.register(email, password, name);
      nav('/decks', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'registration failed');
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
        <h1>Create your account</h1>
        <p className="muted">Local account. OAuth providers can be linked later.</p>
        {error ? <div className="alert error">{error}</div> : null}
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
            data-testid="register-name"
          />
        </label>
        <label className="field">
          <span>Email</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            required
            data-testid="register-email"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            data-testid="register-password"
          />
        </label>
        <button className="btn primary" type="submit" data-testid="register-submit">
          <UserPlus className="btn-icon" aria-hidden size={16} />
          Create account
        </button>
        <p className="muted small">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}
