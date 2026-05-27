import { LayoutDashboard, LogOut, Plus, Presentation, Settings as SettingsIcon } from "lucide-react";
import { Link, NavLink, useNavigate } from "react-router";
import proMarkSvgUrl from "@slidestage/brand/assets/svg/slidestage-pro-mark.svg?url";
import { signOut, useSession, userIsAdmin, type SessionUser } from "../auth/client";
import { Button } from "./Button";

export function Header() {
  const { data } = useSession();
  const navigate = useNavigate();
  const user = data?.user as SessionUser | undefined;
  const isAdmin = userIsAdmin(user);

  async function handleSignOut() {
    try {
      await signOut();
    } finally {
      navigate("/login", { replace: true });
    }
  }

  return (
    <header className="app-header">
      <div className="app-header__inner">
        <Link to="/dashboard" className="app-header__brand">
          <img
            src={proMarkSvgUrl}
            alt=""
            width={24}
            height={24}
            className="brand-mark"
          />
          <span className="brand-name">SlideStage Pro</span>
        </Link>
        <nav className="app-header__nav" aria-label="Primary">
          <NavLink to="/dashboard" className="nav-link">
            <LayoutDashboard size={16} aria-hidden />
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/decks" className="nav-link">
            <Presentation size={16} aria-hidden />
            <span>Decks</span>
          </NavLink>
          <NavLink to="/decks/upload" className="nav-link">
            <Plus size={16} aria-hidden />
            <span>Upload</span>
          </NavLink>
          <NavLink to="/settings" className="nav-link">
            <SettingsIcon size={16} aria-hidden />
            <span>Settings</span>
          </NavLink>
        </nav>
        <div className="app-header__actions">
          {user ? (
            <span className="user-chip" title={user.email}>
              <span className="user-chip__name">{user.name || user.email}</span>
              {isAdmin ? <span className="user-chip__role">admin</span> : null}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<LogOut size={14} aria-hidden />}
            onClick={handleSignOut}
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
