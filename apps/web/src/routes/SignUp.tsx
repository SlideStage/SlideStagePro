import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authClient } from "../auth/client";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Input } from "../components/Input";

function describeError(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "INVITE_REQUIRED":
      return "An invite is required to register. 注册需要邀请码。";
    case "INVITE_EXPIRED":
      return "This invite has expired. 邀请已过期，请联系管理员获取新的邀请。";
    case "INVITE_USED":
      return "This invite has already been used. 邀请已被使用。";
    case "INVITE_EMAIL_MISMATCH":
      return "This invite is bound to a different email. 邀请绑定了其他邮箱，请使用对应邮箱注册。";
    case "USER_ALREADY_EXISTS":
    case "EMAIL_ALREADY_IN_USE":
      return "That email is already registered. 该邮箱已被注册，请直接登录。";
    case "WEAK_PASSWORD":
      return "Password is too weak. 密码强度不足，请使用至少 8 位包含字母和数字。";
    case "INVALID_EMAIL":
      return "Email looks invalid. 邮箱格式不正确。";
    default:
      return message || "Sign-up failed. 注册失败，请重试。";
  }
}

export function SignUp() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const inviteToken = params.get("invite");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!inviteToken) {
    return (
      <div className="auth-shell">
        <div className="auth-shell__card">
          <div className="auth-shell__brand">
            <span className="brand-dot" aria-hidden />
            <span>SlideStage Pro</span>
          </div>
          <Card
            title="Registration is invite-only"
            description="SlideStage Pro is locked down to invited users. Ask an admin to send you an invite URL — it will land you back here with the token in the URL."
          >
            <Link to="/login">
              <Button variant="secondary">Back to sign in</Button>
            </Link>
          </Card>
        </div>
      </div>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // `inviteToken` is a custom field consumed by the Better Auth `before`
      // hook (see docs/AUTH_FLOW.md §3.3). It travels in the request body.
      const result = await authClient.signUp.email({
        email,
        password,
        name,
        inviteToken,
      } as unknown as Parameters<typeof authClient.signUp.email>[0]);
      const err = (result as { error?: { code?: string; message?: string } }).error;
      if (err) {
        setError(describeError(err.code, err.message));
        return;
      }
      navigate("/dashboard", { replace: true });
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      const message = (caught as { message?: string }).message;
      setError(describeError(code, message));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-shell__card">
        <div className="auth-shell__brand">
          <span className="brand-dot" aria-hidden />
          <span>SlideStage Pro</span>
        </div>
        <Card
          title="Create your account"
          description="You're using an invite. Fill in your details to finish setup."
        >
          <form onSubmit={onSubmit} className="stack">
            <Input
              type="text"
              name="name"
              label="Display name"
              placeholder="Alice Smith"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              type="email"
              name="email"
              label="Email"
              placeholder="you@example.com"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              type="password"
              name="password"
              label="Password"
              placeholder="At least 8 characters"
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <input type="hidden" name="inviteToken" value={inviteToken} readOnly />
            {error ? (
              <div className="alert alert--error" role="alert">
                {error}
              </div>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={submitting}
              disabled={submitting || !email || !password || !name}
            >
              {submitting ? "Creating account…" : "Create account"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
