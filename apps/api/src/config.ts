import { z } from "zod";

const numeric = (def: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? Number.parseInt(v, 10) : v))
    .pipe(z.number().int().nonnegative())
    .default(def);

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  DATA_DIR: z.string().default("./data"),

  PORT: numeric(3000),
  HOST: z.string().default("0.0.0.0"),

  BETTER_AUTH_SECRET: z
    .string()
    .min(16, "BETTER_AUTH_SECRET must be at least 16 chars"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a URL"),

  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().optional(),

  UPLOAD_MAX_BYTES: numeric(100 * 1024 * 1024),
  ANNOTATION_MAX_BYTES: numeric(64 * 1024),

  CORS_ORIGINS: csv,
});

export type EnvShape = z.input<typeof envSchema>;

export interface Config {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  databaseUrl: string;
  storage: { driver: "local"; dataDir: string };
  http: { port: number; host: string };
  betterAuthSecret: string;
  betterAuthURL: string;
  bootstrapAdmin:
    | { email: string; password: string; name: string }
    | null;
  uploadMaxBytes: number;
  annotationMaxBytes: number;
  corsOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const bootstrap =
    e.BOOTSTRAP_ADMIN_EMAIL && e.BOOTSTRAP_ADMIN_PASSWORD
      ? {
          email: e.BOOTSTRAP_ADMIN_EMAIL,
          password: e.BOOTSTRAP_ADMIN_PASSWORD,
          name: e.BOOTSTRAP_ADMIN_NAME ?? "Admin",
        }
      : null;
  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    databaseUrl: e.DATABASE_URL,
    storage: { driver: e.STORAGE_DRIVER, dataDir: e.DATA_DIR },
    http: { port: e.PORT, host: e.HOST },
    betterAuthSecret: e.BETTER_AUTH_SECRET,
    betterAuthURL: e.BETTER_AUTH_URL,
    bootstrapAdmin: bootstrap,
    uploadMaxBytes: e.UPLOAD_MAX_BYTES,
    annotationMaxBytes: e.ANNOTATION_MAX_BYTES,
    corsOrigins: e.CORS_ORIGINS,
  };
}
