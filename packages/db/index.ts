import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

// Re-export the generated client surface (PrismaClient, the `Prisma` namespace,
// model types, enums, ...) so consumers can `import { Prisma } from "db"`.
export * from "./generated/prisma/client";

let prisma: PrismaClient | null = null;

/**
 * Returns a lazily-instantiated, shared PrismaClient.
 *
 * Prisma 7 talks to Postgres through the `@prisma/adapter-pg` driver adapter,
 * so no native query engine binary is required — this keeps the client portable
 * across Node hosts. `DATABASE_URL` is read at first use.
 */
function usePrismaClient(): PrismaClient {
  if (!prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
  }
  return prisma;
}

export { usePrismaClient };