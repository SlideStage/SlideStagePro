import { useEffect, useState, type FormEvent } from 'react';
import { ShieldCheck, UserPlus } from 'lucide-react';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  disabledAt: string | null;
  deckCount: number;
  sessionCount: number;
  accounts: Array<{ provider: string; email: string | null }>;
}

async function adminRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export function AdminUsersPage(): JSX.Element {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    const res = await adminRequest<{ users: AdminUser[] }>('/api/admin/users');
    setUsers(res.users);
  }

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'failed'));
  }, []);

  async function createUser(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await adminRequest('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, name, password, role }),
      });
      setEmail('');
      setName('');
      setPassword('');
      setRole('user');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create user failed');
    }
  }

  async function updateUser(
    user: AdminUser,
    input: { role?: string; disabled?: boolean },
  ): Promise<void> {
    setError(null);
    try {
      await adminRequest(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'update user failed');
    }
  }

  return (
    <div className="page admin-page">
      <div className="page-header">
        <div>
          <h1>Users</h1>
          <p className="muted">Manage accounts, roles, and disabled users.</p>
        </div>
      </div>
      {error ? <div className="alert error">{error}</div> : null}
      <form className="admin-create auth-card" onSubmit={(e) => void createUser(e)}>
        <h2>Create user</h2>
        <label className="field">
          <span>Email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            minLength={8}
            required
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button className="btn primary" type="submit" data-testid="admin-create-user">
          <UserPlus className="btn-icon" aria-hidden size={16} />
          Create user
        </button>
      </form>
      <div className="admin-users" data-testid="admin-users">
        {users.map((user) => (
          <section className="admin-user-card" key={user.id}>
            <div>
              <h2>{user.name}</h2>
              <p className="muted small">{user.email}</p>
              <p className="muted small">
                {user.deckCount} decks · {user.sessionCount} sessions ·{' '}
                {user.accounts.map((a) => a.provider).join(', ') || 'no accounts'}
              </p>
            </div>
            <div className="admin-user-actions">
              <select
                aria-label={`role for ${user.email}`}
                value={user.role}
                onChange={(e) => void updateUser(user, { role: e.target.value })}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              <button
                type="button"
                className={`btn ghost ${user.disabledAt ? '' : 'danger'}`}
                onClick={() => void updateUser(user, { disabled: !user.disabledAt })}
              >
                <ShieldCheck className="btn-icon" aria-hidden size={16} />
                {user.disabledAt ? 'Enable' : 'Disable'}
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
