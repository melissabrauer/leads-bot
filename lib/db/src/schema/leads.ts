import { pgTable, serial, text, numeric, timestamp, pgEnum, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leadTypeEnum = pgEnum("lead_type", ["hot", "cold"]);
export const leadStatusEnum = pgEnum("lead_status", ["active", "pending_review", "rejected"]);

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  workLanguage: text("work_language"),
  position: text("position"),
  age: text("age"),
  nationality: text("nationality"),
  currentLocation: text("current_location"),
  workExperience: text("work_experience"),
  monthlyResult: text("monthly_result"),
  desiredSalary: text("desired_salary"),
  startAvailability: text("start_availability"),
  willingToRelocate: text("willing_to_relocate"),
  additionalInfo: text("additional_info"),
  phone: text("phone"),
  telegramContact: text("telegram_contact"),
  whatsapp: text("whatsapp"),
  price: numeric("price", { precision: 10, scale: 2 }).notNull().default("0"),
  type: leadTypeEnum("type").notNull().default("hot"),
  status: leadStatusEnum("status").notNull().default("active"),
  submittedBy: integer("submitted_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, createdAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
