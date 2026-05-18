import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';
import type { AppConfig } from './config.js';
import { getPrisma } from './db.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  return argon2.verify(hash, password);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionCookieOptions(config: AppConfig, expires: Date) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.auth.cookieSecure,
    expires,
  };
}

export async function createSession(
  reply: FastifyReply,
  config: AppConfig,
  userId: string,
  req?: FastifyRequest,
): Promise<void> {
  const prisma = getPrisma();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.sessionDays * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      id: hashToken(token),
      userId,
      expiresAt,
      userAgent: req?.headers['user-agent'] ?? null,
      ip: req?.ip ?? null,
    },
  });
  reply.setCookie(
    config.auth.sessionCookie,
    token,
    sessionCookieOptions(config, expiresAt),
  );
}

export async function clearSession(
  req: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): Promise<void> {
  const token = req.cookies?.[config.auth.sessionCookie];
  if (token) {
    await getPrisma().session.deleteMany({ where: { id: hashToken(token) } });
  }
  reply.clearCookie(config.auth.sessionCookie, { path: '/' });
}

export async function getOptionalUser(
  req: FastifyRequest,
  config: AppConfig,
): Promise<AuthUser | null> {
  const token = req.cookies?.[config.auth.sessionCookie];
  if (!token) return null;

  const prisma = getPrisma();
  const session = await prisma.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    if (session) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    }
    return null;
  }
  if (session.user.disabledAt) {
    throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'user is disabled', 403);
  }
  await prisma.session.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    avatarUrl: session.user.avatarUrl,
    role: session.user.role,
  };
}

export async function requireUser(
  req: FastifyRequest,
  config: AppConfig,
): Promise<AuthUser> {
  const user = await getOptionalUser(req, config);
  if (!user) {
    throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'authentication required', 401);
  }
  return user;
}

export async function requireAdmin(
  req: FastifyRequest,
  config: AppConfig,
): Promise<AuthUser> {
  const user = await requireUser(req, config);
  if (user.role !== 'admin') {
    throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'admin role required', 403);
  }
  return user;
}

export async function getUserId(
  req: FastifyRequest,
  config: AppConfig,
): Promise<string> {
  return (await requireUser(req, config)).id;
}
