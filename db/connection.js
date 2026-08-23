import Database from "better-sqlite3";

export const db = new Database(process.env.DB_PATH || "purevision.db");
