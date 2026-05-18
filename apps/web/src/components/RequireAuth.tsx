import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';

export function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="page empty">Loading session...</div>;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}
