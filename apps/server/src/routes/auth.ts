import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Prisma, User } from '@prisma/client';
import { z } from 'zod';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';
import type { AppConfig, OAuthProviderConfig } from '../config.js';
import { getPrisma } from '../db.js';
import {
  clearSession,
  createSession,
  getOptionalUser,
  hashPassword,
  normalizeEmail,
  requireUser,
  verifyPassword,
  type AuthUser,
} from '../auth.js';
import { FixedWindowRateLimiter, ipRateLimitKey } from '../rate-limit.js';

interface RouteDeps {
  config: AppConfig;
}

interface OAuthProfile {
  provider: string;
  providerAccountId: string;
  email: string | null;
  emailVerified?: boolean | null;
  name: string;
  avatarUrl: string | null;
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const profileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const oauthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_LOGIN_EMAIL_MAX = 10;
const AUTH_LOGIN_IP_MAX = 100;
const AUTH_REGISTER_EMAIL_MAX = 3;
const AUTH_REGISTER_IP_MAX = 50;
const AUTH_OAUTH_START_IP_MAX = 30;

function publicUser(user: AuthUser): AuthUser {
  return user;
}

async function assignBootstrapRole(
  tx: Prisma.TransactionClient,
  user: User,
): Promise<User> {
  const userCount = await tx.user.count();
  if (userCount !== 1 || user.role === 'admin') return user;
  return tx.user.update({
    where: { id: user.id },
    data: { role: 'admin' },
  });
}

function oauthCookieOptions(config: AppConfig) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.auth.cookieSecure,
    maxAge: 10 * 60,
  };
}

function clearOAuthCookies(reply: FastifyReply): void {
  reply.clearCookie('slidestage_oauth_state', { path: '/' });
  reply.clearCookie('slidestage_oauth_pkce', { path: '/' });
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function requiresVerifiedEmail(profile: OAuthProfile): boolean {
  return profile.provider.startsWith('oidc:');
}

function configuredProvider(
  config: AppConfig,
  key: string,
): { kind: 'github' | 'oidc'; provider: OAuthProviderConfig } | null {
  if (key === 'github' && config.auth.github) {
    return { kind: 'github', provider: config.auth.github };
  }
  const oidc = config.auth.oidcProviders.find((p) => p.key === key);
  return oidc ? { kind: 'oidc', provider: oidc } : null;
}

/**
 * Returns whether self-service registration is currently allowed.
 *
 * Rules (see `docs/USER_MANAGEMENT.md` § Registration lockdown):
 *   - If `config.auth.allowRegistration === true`, always `true`.
 *   - Otherwise we still allow the **very first** account so a fresh
 *     deployment can mint its bootstrap admin without manual DB poking.
 */
async function isRegistrationAllowed(config: AppConfig): Promise<boolean> {
  if (config.auth.allowRegistration) return true;
  const prisma = getPrisma();
  const userCount = await prisma.user.count();
  return userCount === 0;
}

export async function findOrCreateOAuthUser(
  profile: OAuthProfile,
  options: { allowAutoCreate: boolean } = { allowAutoCreate: true },
): Promise<AuthUser> {
  const prisma = getPrisma();
  const existingAccount = await prisma.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: profile.provider,
        providerAccountId: profile.providerAccountId,
      },
    },
    include: { user: true },
  });
  if (existingAccount) {
    const user = await prisma.user.update({
      where: { id: existingAccount.userId },
      data: { lastLoginAt: new Date() },
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
    };
  }

  const trustedEmail =
    !requiresVerifiedEmail(profile) || profile.emailVerified === true
      ? profile.email
      : null;
  const email =
    trustedEmail ??
    `${profile.providerAccountId}@${profile.provider.replace(/[^a-z0-9-]/gi, '-')}.oauth.local`;
  const normalizedEmail = normalizeEmail(email);
  const existingUser = trustedEmail
    ? await prisma.user.findUnique({
        where: { email: normalizedEmail },
      })
    : null;

  if (!existingUser && !options.allowAutoCreate) {
    throw new SlideStageError(
      ERROR_CODES.EREGCLOSED,
      'registration is disabled; ask an administrator to create your account',
      403,
    );
  }

  const user = await prisma.$transaction(async (tx) => {
    let owner = existingUser;
    if (!owner) {
      owner = await assignBootstrapRole(
        tx,
        await tx.user.create({
          data: {
            email: normalizedEmail,
            name: profile.name,
            avatarUrl: profile.avatarUrl,
            lastLoginAt: new Date(),
          },
        }),
      );
    }
    await tx.account.create({
      data: {
        userId: owner.id,
        provider: profile.provider,
        providerAccountId: profile.providerAccountId,
        email: normalizedEmail,
        displayName: profile.name,
        avatarUrl: profile.avatarUrl,
      },
    });
    return tx.user.update({
      where: { id: owner.id },
      data: {
        lastLoginAt: new Date(),
        avatarUrl: owner.avatarUrl ?? profile.avatarUrl,
      },
    });
  });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
  };
}

async function githubProfile(
  provider: OAuthProviderConfig,
  code: string,
): Promise<OAuthProfile> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: provider.redirectUri,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new SlideStageError(
      ERROR_CODES.EBADMANIFEST,
      `GitHub OAuth failed: ${tokenJson.error ?? tokenRes.status}`,
      401,
    );
  }
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${tokenJson.access_token}`,
  };
  const user = (await (await fetch('https://api.github.com/user', { headers })).json()) as {
    id: number;
    login: string;
    name?: string | null;
    avatar_url?: string | null;
    email?: string | null;
  };
  const emails = (await (
    await fetch('https://api.github.com/user/emails', { headers })
  ).json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
  const email =
    emails.find((e) => e.primary && e.verified)?.email ??
    emails.find((e) => e.verified)?.email ??
    null;
  return {
    provider: 'github',
    providerAccountId: String(user.id),
    email,
    emailVerified: email !== null,
    name: user.name ?? user.login,
    avatarUrl: user.avatar_url ?? null,
  };
}

async function oidcProfile(
  provider: OAuthProviderConfig,
  code: string,
  state: string,
  pkce: string,
  callbackUrl: string,
): Promise<OAuthProfile> {
  const oidc = (await import('openid-client')) as any;
  const config = await oidc.discovery(
    new URL(provider.issuer!),
    provider.clientId,
    provider.clientSecret,
  );
  const tokens = await oidc.authorizationCodeGrant(
    config,
    new URL(callbackUrl),
    { expectedState: state, pkceCodeVerifier: pkce },
  );
  const claims = tokens.claims?.() ?? {};
  const userInfo =
    tokens.access_token && claims.sub
      ? await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)
      : {};
  const merged = { ...userInfo, ...claims } as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    preferred_username?: string;
    picture?: string;
  };
  if (!merged.sub) {
    throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'OIDC profile missing sub', 401);
  }
  return {
    provider: `oidc:${provider.key}`,
    providerAccountId: merged.sub,
    email: merged.email_verified === true ? merged.email ?? null : null,
    emailVerified: merged.email_verified === true,
    name: merged.name ?? merged.preferred_username ?? merged.email ?? 'OIDC user',
    avatarUrl: merged.picture ?? null,
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  { config }: RouteDeps,
): Promise<void> {
  const prisma = getPrisma();
  const loginEmailLimiter = new FixedWindowRateLimiter({
    label: 'login email',
    max: AUTH_LOGIN_EMAIL_MAX,
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  });
  const loginIpLimiter = new FixedWindowRateLimiter({
    label: 'login IP',
    max: AUTH_LOGIN_IP_MAX,
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  });
  const registerEmailLimiter = new FixedWindowRateLimiter({
    label: 'registration email',
    max: AUTH_REGISTER_EMAIL_MAX,
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  });
  const registerIpLimiter = new FixedWindowRateLimiter({
    label: 'registration IP',
    max: AUTH_REGISTER_IP_MAX,
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  });
  const oauthStartIpLimiter = new FixedWindowRateLimiter({
    label: 'OAuth start',
    max: AUTH_OAUTH_START_IP_MAX,
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  });

  app.get('/api/auth/providers', async () => ({
    providers: [
      ...(config.auth.github ? [{ key: 'github', label: 'GitHub' }] : []),
      ...config.auth.oidcProviders.map((p) => ({ key: p.key, label: p.key })),
    ],
    allowRegistration: await isRegistrationAllowed(config),
  }));

  app.get('/api/auth/me', async (req, reply) => {
    const user = await getOptionalUser(req, config);
    if (!user) {
      reply.code(401);
      return { user: null };
    }
    return { user: publicUser(user) };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const email = normalizeEmail(body.email);
    registerIpLimiter.hit(ipRateLimitKey(req));
    registerEmailLimiter.hit(email);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'email already registered', 409);
    }
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: body.name.trim(),
          passwordHash,
          lastLoginAt: new Date(),
        },
      });
      const userCount = await tx.user.count();
      // Registration lockdown: refuse fresh sign-ups when the switch is off
      // unless this transaction created the bootstrap admin.
      if (!config.auth.allowRegistration && userCount > 1) {
        throw new SlideStageError(
          ERROR_CODES.EREGCLOSED,
          'registration is disabled; ask an administrator to create your account',
          403,
        );
      }
      const bootstrapAwareUser = await assignBootstrapRole(tx, created);
      await tx.account.create({
        data: {
          userId: bootstrapAwareUser.id,
          provider: 'local',
          providerAccountId: email,
          email,
          displayName: bootstrapAwareUser.name,
        },
      });
      return bootstrapAwareUser;
    });
    await createSession(reply, config, user.id, req);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        role: user.role,
      },
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const email = normalizeEmail(body.email);
    loginIpLimiter.hit(ipRateLimitKey(req));
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      loginEmailLimiter.hit(email);
      throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'invalid email or password', 401);
    }
    if (user.disabledAt) {
      throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'user is disabled', 403);
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) {
      loginEmailLimiter.hit(email);
      throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'invalid email or password', 401);
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await createSession(reply, config, user.id, req);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        role: user.role,
      },
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await clearSession(req, reply, config);
    return { ok: true };
  });

  app.patch('/api/auth/me', async (req) => {
    const current = await requireUser(req, config);
    const body = profileSchema.parse(req.body);
    const user = await prisma.user.update({
      where: { id: current.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
      },
    });
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        role: user.role,
      },
    };
  });

  app.post('/api/auth/change-password', async (req) => {
    const current = await requireUser(req, config);
    const body = passwordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: current.id } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'current password is incorrect', 401);
    }
    await prisma.$transaction([
      prisma.user.update({
        where: { id: current.id },
        data: { passwordHash: await hashPassword(body.newPassword) },
      }),
      prisma.session.deleteMany({ where: { userId: current.id } }),
    ]);
    return { ok: true };
  });

  app.get<{ Params: { provider: string } }>(
    '/api/auth/oauth/:provider/start',
    async (req, reply) => {
      oauthStartIpLimiter.hit(ipRateLimitKey(req));
      const configured = configuredProvider(config, req.params.provider);
      if (!configured) {
        throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'OAuth provider not configured', 404);
      }
      const state = randomSecret();
      const pkce = randomSecret();
      reply.setCookie('slidestage_oauth_state', state, oauthCookieOptions(config));
      reply.setCookie('slidestage_oauth_pkce', pkce, oauthCookieOptions(config));

      if (configured.kind === 'github') {
        const url = new URL('https://github.com/login/oauth/authorize');
        url.searchParams.set('client_id', configured.provider.clientId);
        url.searchParams.set('redirect_uri', configured.provider.redirectUri);
        url.searchParams.set('scope', 'read:user user:email');
        url.searchParams.set('state', state);
        return reply.redirect(url.toString());
      }

      const oidc = (await import('openid-client')) as any;
      const oidcConfig = await oidc.discovery(
        new URL(configured.provider.issuer!),
        configured.provider.clientId,
        configured.provider.clientSecret,
      );
      const challenge = await oidc.calculatePKCECodeChallenge(pkce);
      const url = oidc.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: configured.provider.redirectUri,
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return reply.redirect(url.toString());
    },
  );

  app.get<{ Params: { provider: string } }>(
    '/api/auth/oauth/:provider/callback',
    async (req, reply) => {
      const configured = configuredProvider(config, req.params.provider);
      if (!configured) {
        throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'OAuth provider not configured', 404);
      }
      const query = oauthCallbackSchema.parse(req.query);
      const stateCookie = req.cookies?.stage_oauth_state;
      const pkce = req.cookies?.stage_oauth_pkce;
      if (!stateCookie || stateCookie !== query.state || !pkce) {
        throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'invalid OAuth state', 401);
      }

      const callbackUrl = `${configured.provider.redirectUri}${configured.provider.redirectUri.includes('?') ? '&' : '?'}code=${encodeURIComponent(query.code)}&state=${encodeURIComponent(query.state)}`;
      const profile =
        configured.kind === 'github'
          ? await githubProfile(configured.provider, query.code)
          : await oidcProfile(
              configured.provider,
              query.code,
              query.state,
              pkce,
              callbackUrl,
            );
      const allowAutoCreate = await isRegistrationAllowed(config);
      let user: AuthUser;
      try {
        user = await findOrCreateOAuthUser(profile, { allowAutoCreate });
      } catch (err) {
        if (err instanceof SlideStageError && err.code === ERROR_CODES.EREGCLOSED) {
          clearOAuthCookies(reply);
          // Friendly redirect: surface the lockdown on the login screen
          // instead of dumping a JSON 403 inside the OAuth tab.
          return reply.redirect(
            `${config.webOrigin}/login?error=registration-disabled`,
          );
        }
        throw err;
      }
      await createSession(reply, config, user.id, req);
      clearOAuthCookies(reply);
      return reply.redirect(`${config.webOrigin}/decks`);
    },
  );
}
