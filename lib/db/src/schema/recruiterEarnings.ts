import { pgTable, serial, integer, numeric, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const earningStatusEnum = pgEnum("earning_status", ["pending", "vested", "refunded"]);

export const recruiterEarningsTable = pgTable("recruiter_earnings", {
  id: serial("id").primaryKey(),
  recruiterId: integer("recruiter_id").notNull(),
  purchaseId: integer("purchase_id").notNull(),
  leadId: integer("lead_id").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  status: earningStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRecruiterEarningSchema = createInsertSchema(recruiterEarningsTable).omit({ id: true, createdAt: true });
export type InsertRecruiterEarning = z.infer<typeof insertRecruiterEarningSchema>;
export type RecruiterEarning = typeof recruiterEarningsTable.$inferSelect;
