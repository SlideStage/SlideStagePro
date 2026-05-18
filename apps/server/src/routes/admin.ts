import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ERROR_CODES, SlideStageError } from '@slidestage/shared';
import type { AppConfig } from '../config.js';
import { getPrisma } from '../db.js';
import { hashPassword, normalizeEmail, requireAdmin } from '../auth.js';

interface RouteDeps {
  config: AppConfig;
}

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: z.string().min(8),
  role: z.enum(['user', 'admin']).default('user'),
});

const updateUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(['user', 'admin']).optional(),
  disabled: z.boolean().optional(),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  { config }: RouteDeps,
): Promise<void> {
  const prisma = getPrisma();

  app.get('/api/admin/users', async (req) => {
    await requireAdmin(req, config);
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        accounts: true,
        _count: { select: { sessions: true } },
      },
    });
    const deckCounts = await prisma.deck.groupBy({
      by: ['ownerId'],
      _count: { _all: true },
    });
    const deckCountByOwner = new Map(
      deckCounts.map((row) => [row.ownerId, row._count._all]),
    );
    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        role: user.role,
        disabledAt: user.disabledAt,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        deckCount: deckCountByOwner.get(user.id) ?? 0,
        sessionCount: user._count.sessions,
        accounts: user.accounts.map((account) => ({
          provider: account.provider,
          email: account.email,
          displayName: account.displayName,
          createdAt: account.createdAt,
        })),
      })),
    };
  });

  app.post('/api/admin/users', async (req, reply) => {
    await requireAdmin(req, config);
    const body = createUserSchema.parse(req.body);
    const email = normalizeEmail(body.email);
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
          role: body.role,
        },
      });
      await tx.account.create({
        data: {
          userId: created.id,
          provider: 'local',
          providerAccountId: email,
          email,
          displayName: created.name,
        },
      });
      return created;
    });
    reply.code(201);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        disabledAt: user.disabledAt,
      },
    };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    const admin = await requireAdmin(req, config);
    const body = updateUserSchema.parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) {
      throw new SlideStageError(ERROR_CODES.EMISSINGFILE, 'user not found', 404);
    }
    if (target.id === admin.id && body.disabled === true) {
      throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'cannot disable yourself', 400);
    }
    if (target.id === admin.id && body.role === 'user') {
      throw new SlideStageError(ERROR_CODES.EBADMANIFEST, 'cannot demote yourself', 400);
    }
    const user = await prisma.user.update({
      where: { id: target.id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.disabled !== undefined
          ? { disabledAt: body.disabled ? new Date() : null }
          : {}),
      },
    });
    if (body.disabled === true) {
      await prisma.session.deleteMany({ where: { userId: target.id } });
    }
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        disabledAt: user.disabledAt,
      },
    };
  });
}
