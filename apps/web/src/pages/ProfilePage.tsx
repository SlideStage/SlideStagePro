import { useState, type FormEvent } from 'react';
import { KeyRound, Save } from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';

export function ProfilePage(): JSX.Element {
  const auth = useAuth();
  const [name, setName] = useState(auth.user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveProfile(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await auth.updateProfile({ name });
      setMessage('Profile updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'profile update failed');
    }
  }

  async function savePassword(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await auth.changePassword(currentPassword, newPassword);
      setMessage('Password changed. Please log in again.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'password change failed');
    }
  }

  return (
    <div className="page profile-page">
      <div className="page-header">
        <h1>Profile</h1>
      </div>
      {message ? <div className="alert success">{message}</div> : null}
      {error ? <div className="alert error">{error}</div> : null}
      <div className="profile-grid">
        <form className="auth-card" onSubmit={(e) => void saveProfile(e)}>
          <h2>Account</h2>
          <p className="muted small">{auth.user?.email}</p>
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              data-testid="profile-name"
            />
          </label>
          <button className="btn primary" type="submit" data-testid="profile-save">
            <Save className="btn-icon" aria-hidden size={16} />
            Save profile
          </button>
        </form>
        <form className="auth-card" onSubmit={(e) => void savePassword(e)}>
          <h2>Password</h2>
          <label className="field">
            <span>Current password</span>
            <input
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              data-testid="profile-current-password"
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              type="password"
              minLength={8}
              autoComplete="new-password"
              data-testid="profile-new-password"
            />
          </label>
          <button className="btn ghost" type="submit" data-testid="profile-password-save">
            <KeyRound className="btn-icon" aria-hidden size={16} />
            Change password
          </button>
        </form>
      </div>
    </div>
  );
}
