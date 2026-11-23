import "dotenv/config";
import { defineConfig } from "prisma/config";

// `prisma generate` runs on every `pnpm install` (db postinstall) and needs no
// live DB, so we avoid prisma's `env()` helper here — it throws when
// DATABASE_URL is unset, which breaks installs in DB-less environments (the
// Cloudflare frontend build, fresh CI). Read process.env via a typed globalThis
// cast (this package typechecks without @types/node). migrate/deploy run where
// DATABASE_URL is set and get the real value.
const databaseUrl =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.DATABASE_URL ?? "";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});