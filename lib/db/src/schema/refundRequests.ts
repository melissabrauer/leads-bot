import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { leadsTable } from "./leads";

export const refundStatusEnum = pgEnum("refund_status", ["pending", "approved", "rejected"]);

export const refundRequestsTable = pgTable("refund_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  leadId: integer("lead_id").notNull().references(() => leadsTable.id),
  description: text("description").default(""),
  screenshotFileId: text("screenshot_file_id"),
  status: refundStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRefundRequestSchema = createInsertSchema(refundRequestsTable).omit({ id: true, createdAt: true });
export type InsertRefundRequest = z.infer<typeof insertRefundRequestSchema>;
export type RefundRequest = typeof refundRequestsTable.$inferSelect;
