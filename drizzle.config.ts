import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : undefined,
  migrations: {
    table: "__panini_migrations",
    schema: "drizzle",
  },
  strict: true,
  verbose: true,
});
