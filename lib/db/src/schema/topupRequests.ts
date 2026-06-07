import { pgTable, serial, integer, numeric, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const topupStatusEnum = pgEnum("topup_status", ["pending", "approved", "rejected"]);

export const topupRequestsTable = pgTable("topup_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  comment: text("comment").default(""),
  invoiceId: text("invoice_id"),
  status: topupStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTopupRequestSchema = createInsertSchema(topupRequestsTable).omit({ id: true, createdAt: true });
export type InsertTopupRequest = z.infer<typeof insertTopupRequestSchema>;
export type TopupRequest = typeof topupRequestsTable.$inferSelect;
