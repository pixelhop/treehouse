import { usePrismaClient } from "../index";

const prisma = usePrismaClient();

async function main() {
  // Add any seed data you want to preload into new environments here.
  // Auth tables (user/account/session/organization/...) are owned by
  // better-auth — prefer creating users through the auth API rather than
  // inserting them directly so password hashing and hooks run.
}

main()
  .catch((error) => {
    console.error("Failed to run seed script", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });