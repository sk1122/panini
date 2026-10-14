import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runDrizzleMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;

export async function migrate(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const besideCompiledOutput = fileURLToPath(new URL("../../../drizzle/", import.meta.url));
  const workspaceDirectory = resolve(process.cwd(), "drizzle");
  const migrationsFolder = existsSync(besideCompiledOutput) ? besideCompiledOutput : workspaceDirectory;
  try {
    await runDrizzleMigrations(drizzle(pool), {
      migrationsFolder,
      migrationsSchema: "drizzle",
      migrationsTable: "__panini_migrations",
    });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  await migrate(databaseUrl);
  console.log("Database migrations are up to date.");
}
