import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const recruiterAppStatusEnum = pgEnum("recruiter_app_status", ["pending", "approved", "rejected"]);

export const recruiterApplicationsTable = pgTable("recruiter_applications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  status: recruiterAppStatusEnum("status").notNull().default("pending"),
  comment: text("comment").default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertRecruiterApplicationSchema = createInsertSchema(recruiterApplicationsTable).omit({ id: true, createdAt: true });
export type InsertRecruiterApplication = z.infer<typeof insertRecruiterApplicationSchema>;
export type RecruiterApplication = typeof recruiterApplicationsTable.$inferSelect;
