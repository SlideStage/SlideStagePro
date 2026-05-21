import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, Plus, Trash2, UserCircle2 } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { InviteRecord, UserRecord, UserRole } from "../api/types";
import { useSession, userIsAdmin, type SessionUser } from "../auth/client";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Empty } from "../components/Empty";
import { Input } from "../components/Input";
import { Modal } from "../components/Modal";
import { Spinner } from "../components/Spinner";
import { formatRelative } from "../lib/format";

function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

function inviteUrl(token: string): string {
  if (typeof window === "undefined") return `/sign-up?invite=${token}`;
  return `${window.location.origin}/sign-up?invite=${encodeURIComponent(token)}`;
}

function AccountSection({ user }: { user: SessionUser | undefined }) {
  return (
    <Card title="Your account">
      {user ? (
        <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              background: "var(--color-surface-alt)",
              border: "1px solid var(--color-border)",
              display: "grid",
              placeItems: "center",
              color: "var(--color-text-muted)",
              flexShrink: 0,
            }}
          >
            <UserCircle2 size={26} aria-hidden />
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <div style={{ fontWeight: 600 }}>{user.name || "—"}</div>
            <div className="muted">{user.email}</div>
            <div>
              <span className={`tag ${user.role === "admin" ? "tag--admin" : ""}`}>
                {user.role ?? "user"}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <Spinner label="Loading account…" />
      )}
    </Card>
  );
}

function InvitesSection() {
  const [items, setItems] = useState<InviteRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [recentlyCreated, setRecentlyCreated] = useState<InviteRecord | null>(null);

  const [draftEmail, setDraftEmail] = useState("");
  const [draftRole, setDraftRole] = useState<UserRole>("user");
  const [draftTtl, setDraftTtl] = useState<string>("72");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api.invites.list();
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load invites.");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError(null);
    try {
      const ttl = Number.parseInt(draftTtl, 10);
      const invite = await api.invites.create({
        email: draftEmail.trim() || undefined,
        role: draftRole,
        ttlHours: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
      });
      setRecentlyCreated(invite);
      setShowCreate(false);
      setDraftEmail("");
      setDraftRole("user");
      setDraftTtl("72");
      await refresh();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Failed to create invite.");
    } finally {
      setCreateBusy(false);
    }
  }

  async function onRevoke(invite: InviteRecord) {
    if (!confirm(`Revoke invite for ${invite.email ?? "(any email)"}?`)) return;
    try {
      await api.invites.delete(invite.id);
      setItems((prev) => (prev ? prev.filter((i) => i.id !== invite.id) : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke invite.");
    }
  }

  async function onCopy(invite: InviteRecord) {
    try {
      await copyToClipboard(inviteUrl(invite.token));
    } catch {
      // ignore; nothing actionable
    }
  }

  return (
    <Card
      title="Invites"
      description="Send these URLs to invitees. Each invite is single-use and time-limited."
      actions={
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<Plus size={13} aria-hidden />}
          onClick={() => setShowCreate(true)}
        >
          New invite
        </Button>
      }
    >
      {error ? <div className="alert alert--error">{error}</div> : null}
      {recentlyCreated ? (
        <div className="alert alert--success" role="status">
          <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
            <strong>Invite ready — copy the URL now, you won&apos;t see the token again.</strong>
            <div className="copy-row">
              <code>{inviteUrl(recentlyCreated.token)}</code>
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<Copy size={13} aria-hidden />}
                onClick={() => onCopy(recentlyCreated)}
              >
                Copy
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {items === null ? (
        <Spinner label="Loading invites…" />
      ) : items.length === 0 ? (
        <Empty
          title="No invites yet"
          description="Generate a single-use URL to add a user. Admin invites are logged in the audit trail."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Expires</th>
                <th>Status</th>
                <th style={{ width: 1 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((invite) => {
                const status = invite.usedAt
                  ? `used ${formatRelative(invite.usedAt)}`
                  : new Date(invite.expiresAt).getTime() < Date.now()
                    ? "expired"
                    : `expires ${formatRelative(invite.expiresAt)}`;
                return (
                  <tr key={invite.id}>
                    <td>{invite.email ?? <span className="muted">(any)</span>}</td>
                    <td>
                      <span className={`tag ${invite.role === "admin" ? "tag--admin" : ""}`}>
                        {invite.role}
                      </span>
                    </td>
                    <td>{formatRelative(invite.expiresAt)}</td>
                    <td className="muted">{status}</td>
                    <td>
                      <div className="row-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<Copy size={13} aria-hidden />}
                          onClick={() => onCopy(invite)}
                          disabled={!!invite.usedAt}
                        >
                          Copy URL
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<Trash2 size={13} aria-hidden />}
                          onClick={() => onRevoke(invite)}
                        >
                          Revoke
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={showCreate}
        onClose={() => (createBusy ? undefined : setShowCreate(false))}
        title="Create invite"
        description="Optionally bind it to a specific email. Defaults to user role / 72 hours."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setShowCreate(false)}
              disabled={createBusy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              form="invite-form"
              type="submit"
              loading={createBusy}
            >
              Create invite
            </Button>
          </>
        }
      >
        <form id="invite-form" onSubmit={onCreate} className="stack">
          <Input
            label="Email (optional)"
            type="email"
            placeholder="alice@example.com"
            value={draftEmail}
            onChange={(e) => setDraftEmail(e.target.value)}
          />
          <div className="field">
            <label className="field__label" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              className="field__input"
              value={draftRole}
              onChange={(e) => setDraftRole(e.target.value as UserRole)}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <Input
            label="Expires after (hours)"
            type="number"
            min={1}
            max={24 * 30}
            value={draftTtl}
            onChange={(e) => setDraftTtl(e.target.value)}
          />
          {createError ? <div className="alert alert--error">{createError}</div> : null}
        </form>
      </Modal>
    </Card>
  );
}

function UsersSection({ currentUserId }: { currentUserId: string | undefined }) {
  const [items, setItems] = useState<UserRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api.users.list();
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load users.");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onChangeRole(user: UserRecord, next: UserRole) {
    if (user.role === next) return;
    setPending(user.id);
    try {
      const updated = await api.users.update(user.id, { role: next });
      setItems((prev) => prev?.map((u) => (u.id === user.id ? updated : u)) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update role.");
    } finally {
      setPending(null);
    }
  }

  async function onDelete(user: UserRecord) {
    if (user.id === currentUserId) return;
    if (!confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    setPending(user.id);
    try {
      await api.users.delete(user.id);
      setItems((prev) => prev?.filter((u) => u.id !== user.id) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete user.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Card
      title="Users"
      description="All accounts on this instance. Be careful with role changes — they take effect immediately."
    >
      {error ? <div className="alert alert--error">{error}</div> : null}
      {items === null ? (
        <Spinner label="Loading users…" />
      ) : items.length === 0 ? (
        <Empty title="No users" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Created</th>
                <th style={{ width: 1 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((user) => {
                const isSelf = user.id === currentUserId;
                return (
                  <tr key={user.id}>
                    <td>{user.name ?? <span className="muted">—</span>}</td>
                    <td>{user.email}</td>
                    <td>
                      <select
                        className="field__input"
                        style={{ height: 28, padding: "0 8px", fontSize: 12.5 }}
                        value={user.role}
                        disabled={pending === user.id || isSelf}
                        onChange={(e) => onChangeRole(user, e.target.value as UserRole)}
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="muted">{formatRelative(user.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<Trash2 size={13} aria-hidden />}
                          onClick={() => onDelete(user)}
                          disabled={isSelf || pending === user.id}
                          title={isSelf ? "You cannot delete yourself." : undefined}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function Settings() {
  const { data } = useSession();
  const user = data?.user as SessionUser | undefined;
  const isAdmin = userIsAdmin(user);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <header className="page-header">
        <div className="page-header__heading">
          <h1>Settings</h1>
          <p>Your account, invites, and team. Admin-only sections appear when you have the role.</p>
        </div>
      </header>

      <AccountSection user={user} />

      {isAdmin ? (
        <>
          <InvitesSection />
          <UsersSection currentUserId={user?.id} />
        </>
      ) : null}
    </div>
  );
}
