import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadSubscriptionsTable = pgTable("lead_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  type: text("type").notNull(),
  languages: text("languages").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertLeadSubscriptionSchema = createInsertSchema(leadSubscriptionsTable).omit({ id: true, createdAt: true });
export type InsertLeadSubscription = z.infer<typeof insertLeadSubscriptionSchema>;
export type LeadSubscription = typeof leadSubscriptionsTable.$inferSelect;
