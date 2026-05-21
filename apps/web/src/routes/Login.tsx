import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authClient } from "../auth/client";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Input } from "../components/Input";

function describeError(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "INVALID_EMAIL":
      return "Email address looks invalid.";
    case "USER_NOT_FOUND":
    case "INVALID_CREDENTIALS":
    case "INVALID_EMAIL_OR_PASSWORD":
      return "Email or password is incorrect.";
    case "BANNED":
    case "USER_BANNED":
      return "This account has been disabled. Contact your administrator.";
    default:
      return message || "Sign-in failed. Please try again.";
  }
}

export function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = params.get("next") ?? "/dashboard";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await authClient.signIn.email({ email, password });
      // Better Auth returns `{ data, error }` on the client.
      const err = (result as { error?: { code?: string; message?: string } }).error;
      if (err) {
        setError(describeError(err.code, err.message));
        return;
      }
      navigate(next, { replace: true });
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
        <Card title="Sign in" description="Use your work email and password.">
          <form onSubmit={onSubmit} className="stack">
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
              placeholder="••••••••"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
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
              disabled={submitting || !email || !password}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="muted" style={{ marginTop: 12 }}>
            Need an account? Ask your admin for an invite link, then follow it back
            here as <Link to="/sign-up">/sign-up</Link>.
          </p>
        </Card>
      </div>
    </div>
  );
}
