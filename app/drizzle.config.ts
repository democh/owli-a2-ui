import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    // SQLite 文件路径,默认 ./data/app.db,可用 DATABASE_URL 覆盖
    url: process.env.DATABASE_URL || "data/app.db",
  },
});
