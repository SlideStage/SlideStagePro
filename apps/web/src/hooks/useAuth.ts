import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  providers: Array<{ key: string; label: string }>;
  /**
   * Mirror of the server's `AUTH_ALLOW_REGISTRATION` switch (with the
   * bootstrap-admin exception already applied — i.e. if the `User` table is
   * empty the server reports `true` even when the env var is `false`).
   *
   * Pessimistic during the very first refresh: defaults to `false` so we
   * never flash a register link the server is about to reject.
   */
  allowRegistration: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (input: { name?: string; avatarUrl?: string | null }) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function authRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      message = body.message ?? message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [providers, setProviders] = useState<Array<{ key: string; label: string }>>([]);
  const [allowRegistration, setAllowRegistration] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [me, configuredProviders] = await Promise.all([
        authRequest<{ user: AuthUser | null }>('/api/auth/me').catch((e) => {
          if (e instanceof Error && e.message.includes('401')) return { user: null };
          return { user: null };
        }),
        authRequest<{
          providers: Array<{ key: string; label: string }>;
          allowRegistration?: boolean;
        }>('/api/auth/providers').catch(() => ({
          providers: [],
          allowRegistration: false,
        })),
      ]);
      setUser(me.user);
      setProviders(configuredProviders.providers);
      // Old servers (before the lockdown switch) omit the field. Treat that
      // as "open" for backwards compatibility with self-hosted deployments
      // that haven't bumped yet.
      setAllowRegistration(configuredProviders.allowRegistration ?? true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load auth');
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authRequest<{ user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setUser(res.user);
  }, []);

  const register = useCallback(
    async (email: string, password: string, name: string) => {
      const res = await authRequest<{ user: AuthUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name }),
      });
      setUser(res.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    await authRequest<{ ok: true }>('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const updateProfile = useCallback(
    async (input: { name?: string; avatarUrl?: string | null }) => {
      const res = await authRequest<{ user: AuthUser }>('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      setUser(res.user);
    },
    [],
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await authRequest<{ ok: true }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setUser(null);
    },
    [],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      error,
      providers,
      allowRegistration,
      refresh,
      login,
      register,
      logout,
      updateProfile,
      changePassword,
    }),
    [
      user,
      loading,
      error,
      providers,
      allowRegistration,
      refresh,
      login,
      register,
      logout,
      updateProfile,
      changePassword,
    ],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
