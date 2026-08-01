import { getDb } from "../api/queries/connection";
// TODO: import tables from "./schema"

async function seed() {
  // 打开数据库连接(确保 data 目录与 schema 就绪);当前无种子数据
  getDb();
  console.log("Seeding database...");

  // TODO: insert seed data, e.g.
  // await db.insert(schema.posts).values([
  //   { title: "First post", content: "Hello world" },
  // ]);

  console.log("Done.");
  process.exit(0); // close better-sqlite3 database
}

seed();
