import { Link, Navigate } from 'react-router-dom';
import {
  ArrowRight,
  GitBranch,
  KeyRound,
  PanelsTopLeft,
  Pencil,
  ShieldCheck,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth.js';

/**
 * Public landing page rendered at `/` for unauthenticated visitors.
 *
 * Authenticated users get bounced to `/decks` immediately so the route still
 * behaves like the previous index redirect — the landing copy is purely a
 * pre-login product surface (per ui-ux-pro-max "Minimal Single Column"
 * pattern: hero → benefits → CTA → footer).
 */
export function LandingPage(): JSX.Element {
  const auth = useAuth();

  if (auth.loading) {
    return <div className="page empty" data-testid="landing-loading" />;
  }

  if (auth.user) {
    return <Navigate to="/decks" replace />;
  }

  const primaryCta = auth.allowRegistration ? (
    <Link to="/register" className="btn cta lg" data-testid="landing-cta-primary">
      Get started — it's free
      <ArrowRight className="btn-icon" aria-hidden size={18} />
    </Link>
  ) : (
    <Link
      to="/login"
      className="btn cta lg"
      data-testid="landing-cta-primary"
    >
      Sign in
      <ArrowRight className="btn-icon" aria-hidden size={18} />
    </Link>
  );

  return (
    <div className="landing-page" data-testid="landing-page">
      <div className="landing-shell">
        {/* ── Top bar ────────────────────────────────────────────────── */}
        <header className="landing-topbar">
          <Link to="/" className="landing-brand" aria-label="slidestage home">
            <span className="landing-brand-mark" aria-hidden>
              <PanelsTopLeft size={20} strokeWidth={2.4} />
            </span>
            <span>
              <span className="landing-brand-name">slidestage</span>
              <span className="landing-brand-tag">platform</span>
            </span>
          </Link>
          <nav className="landing-topbar-actions" aria-label="Account">
            <Link to="/login" className="btn ghost" data-testid="landing-login">
              Log in
            </Link>
            {auth.allowRegistration ? (
              <Link
                to="/register"
                className="btn primary"
                data-testid="landing-register"
              >
                Sign up
              </Link>
            ) : null}
          </nav>
        </header>

        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="landing-hero">
          <span className="landing-eyebrow">
            <span className="landing-eyebrow-dot" aria-hidden />
            Self-hosted · Stage A v0.1
          </span>
          <h1 className="landing-headline">
            Host, present, and annotate <em>.stage</em> decks on your own
            infrastructure.
          </h1>
          <p className="landing-subhead">
            A self-hosted runtime for the open <code>.stage</code> container:
            atomic upload, hardened static serving, PowerPoint-style presenter
            tools, and in-place speaker-note editing — without re-packing your
            decks.
          </p>

          <div className="landing-cta-row">
            {primaryCta}
            <a
              href="https://github.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="btn ghost lg"
              data-testid="landing-cta-github"
            >
              <GitBranch className="btn-icon" aria-hidden size={18} />
              View on GitHub
            </a>
          </div>
          {!auth.allowRegistration ? (
            <p
              className="landing-cta-hint"
              data-testid="landing-registration-disabled"
            >
              Sign-ups are closed on this instance. Ask an administrator to
              create your account, then{' '}
              <Link to="/login" style={{ color: 'var(--primary)' }}>
                log in
              </Link>
              .
            </p>
          ) : (
            <p className="landing-cta-hint">
              No credit card. Run <code>pnpm dev</code> locally, or pull the
              image into your own cluster.
            </p>
          )}

          {/* ── Product preview (composed, not a real screenshot) ──── */}
          <div
            className="landing-preview"
            role="img"
            aria-label="slidestage presenter interface preview"
          >
            <div className="landing-preview-bar">
              <div className="landing-preview-bar-dots" aria-hidden>
                <span />
                <span />
                <span />
              </div>
              <span className="landing-preview-bar-title">
                slidestage /decks/keynote-2025/presenter
              </span>
            </div>
            <div className="landing-preview-body">
              <div className="landing-preview-sidebar" aria-hidden>
                <span className="landing-preview-tool">
                  <Sparkles size={18} />
                </span>
                <span className="landing-preview-tool active">
                  <Wand2 size={18} />
                </span>
                <span className="landing-preview-tool">
                  <Pencil size={18} />
                </span>
                <span className="landing-preview-tool">
                  <KeyRound size={18} />
                </span>
              </div>
              <div className="landing-preview-stage">
                <div className="landing-preview-slide">
                  <span className="landing-preview-slide-eyebrow">
                    Stage A · MVP
                  </span>
                  <h3 className="landing-preview-slide-title">
                    Ship presentations without reshipping decks.
                  </h3>
                  <ul className="landing-preview-slide-bullets">
                    <li>Owner-side notes editing with autosave</li>
                    <li>BroadcastChannel-synced audience view</li>
                    <li>Nine PowerPoint-style presenter tools</li>
                  </ul>
                </div>
                <span className="landing-preview-laser" aria-hidden />
              </div>
              <div className="landing-preview-notes" aria-hidden>
                <span className="landing-preview-notes-head">
                  Speaker notes
                </span>
                <p className="landing-preview-notes-body">
                  Edits sync to the deck&apos;s manifest and the export zip in
                  under a second.
                </p>
                <span className="landing-preview-notes-pill">● Saved</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Benefits ──────────────────────────────────────────────── */}
        <section className="landing-benefits" aria-label="Key benefits">
          <article className="landing-benefit">
            <span className="landing-benefit-icon" aria-hidden>
              <Wand2 size={20} />
            </span>
            <h2 className="landing-benefit-title">
              Presenter tools, not slideware
            </h2>
            <p className="landing-benefit-body">
              Laser pointer, pen, highlighter, eraser, spotlight, blackout &
              whiteout — all driven by PointerEvents, synced over
              BroadcastChannel, persisted per (deck, user, slide).
            </p>
          </article>
          <article className="landing-benefit">
            <span className="landing-benefit-icon" aria-hidden>
              <Pencil size={20} />
            </span>
            <h2 className="landing-benefit-title">
              Edit notes, export the deck
            </h2>
            <p className="landing-benefit-body">
              Speaker notes save inline with 800 ms debounce, mirror to{' '}
              <code>manifest.json</code> + <code>speaker-notes.json</code> on
              disk, and re-pack into a fresh <code>.stage</code> zip in one
              click.
            </p>
          </article>
          <article className="landing-benefit">
            <span className="landing-benefit-icon" aria-hidden>
              <ShieldCheck size={20} />
            </span>
            <h2 className="landing-benefit-title">
              Self-hosted by design
            </h2>
            <p className="landing-benefit-body">
              Hardened upload pipeline (zip-slip, zip-bomb, symlink guards),
              per-file CSP on slide HTML, real session cookies, and an
              optional <code>AUTH_ALLOW_REGISTRATION=false</code> lockdown.
            </p>
          </article>
        </section>

        {/* ── Bottom CTA card ───────────────────────────────────────── */}
        <section className="landing-cta-card">
          <h2 className="landing-cta-title">
            Bring your deck. Skip the slideware lock-in.
          </h2>
          <p className="landing-cta-sub">
            Upload a <code>.stage</code> package, share the link, and run
            your next session from a browser tab you own.
          </p>
          <div className="landing-cta-row">
            {auth.allowRegistration ? (
              <Link
                to="/register"
                className="btn cta lg"
                data-testid="landing-cta-secondary"
              >
                Create your account
                <ArrowRight className="btn-icon" aria-hidden size={18} />
              </Link>
            ) : (
              <Link
                to="/login"
                className="btn cta lg"
                data-testid="landing-cta-secondary"
              >
                Sign in
                <ArrowRight className="btn-icon" aria-hidden size={18} />
              </Link>
            )}
            <Link to="/login" className="btn ghost lg">
              I already have an account
            </Link>
          </div>
        </section>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <footer className="landing-footer">
          <span>© slidestage platform — Stage A · v0.1.0</span>
          <nav aria-label="Footer">
            <Link to="/login">Log in</Link>
            {auth.allowRegistration ? (
              <>
                {' · '}
                <Link to="/register">Register</Link>
              </>
            ) : null}
          </nav>
        </footer>
      </div>
    </div>
  );
}
