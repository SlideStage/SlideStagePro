import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import type { Auth } from "./index.js";

/**
 * On first boot, if the user table is empty, create the configured bootstrap
 * admin (BOOTSTRAP_ADMIN_* env). If those env vars are missing, exit with code
 * 2 — refuse to serve traffic without an admin (per AUTH_FLOW §3.1).
 */
export async function ensureBootstrapAdmin(
  config: Config,
  prisma: PrismaClient,
  auth: Auth,
): Promise<{ created: boolean }> {
  const count = await prisma.user.count();
  if (count > 0) return { created: false };

  const admin = config.bootstrapAdmin;
  if (!admin) {
    console.error(
      "[bootstrap] no users exist and BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD are not set",
    );
    console.error("[bootstrap] refusing to start — set these env vars and retry");
    process.exit(2);
  }

  // Call Better Auth's sign-up endpoint. The invite hook short-circuits
  // when the user table is empty (see databaseHooks.user.create.before),
  // so the first call here always succeeds without needing an invite.
  await auth.api.signUpEmail({
    body: {
      email: admin.email,
      password: admin.password,
      name: admin.name,
    },
  });

  // Promote the freshly-created user to admin.
  const updated = await prisma.user.update({
    where: { email: admin.email },
    data: { role: "admin" },
  });

  console.log(
    `[bootstrap] created admin user email=${updated.email} id=${updated.id}`,
  );
  return { created: true };
}
