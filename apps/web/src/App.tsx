import { Outlet, NavLink, Link, useNavigate } from 'react-router-dom';
import {
  Library,
  LogOut,
  PanelsTopLeft,
  Shield,
  Upload,
  UserCircle,
} from 'lucide-react';
import { useAuth } from './hooks/useAuth.js';

export function App(): JSX.Element {
  const { user, logout, allowRegistration } = useAuth();
  const nav = useNavigate();

  async function handleLogout(): Promise<void> {
    await logout();
    nav('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/decks" className="brand">
          <span className="brand-mark">
            <PanelsTopLeft className="brand-mark-icon" aria-hidden size={18} />
          </span>
          <span className="brand-name">slidestage</span>
          <span className="brand-tag">platform v0.1</span>
        </NavLink>
        <nav className="app-nav">
          <NavLink to="/decks">
            <Library className="nav-icon" aria-hidden size={16} />
            Library
          </NavLink>
          <NavLink to="/decks/upload">
            <Upload className="nav-icon" aria-hidden size={16} />
            Upload
          </NavLink>
          {user?.role === 'admin' ? (
            <NavLink to="/admin/users" data-testid="admin-users-link">
              <Shield className="nav-icon" aria-hidden size={16} />
              Users
            </NavLink>
          ) : null}
        </nav>
        <div className="app-user" title="Current user">
          {user ? (
            <>
              <span className="user-dot" />
              <Link to="/profile" className="app-user-link">
                <UserCircle className="nav-icon" aria-hidden size={16} />
                <span>{user.name}</span>
              </Link>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => void handleLogout()}
                data-testid="logout-button"
              >
                <LogOut className="btn-icon" aria-hidden size={14} />
                Logout
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login">Log in</NavLink>
              {allowRegistration ? (
                <NavLink to="/register" data-testid="header-register-link">
                  Register
                </NavLink>
              ) : null}
            </>
          )}
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
