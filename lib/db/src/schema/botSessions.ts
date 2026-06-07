import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const botSessionsTable = pgTable("bot_sessions", {
  key: text("key").primaryKey(),
  data: jsonb("data").notNull().default({}),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
