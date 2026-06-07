import { db, botSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export function createPgSessionStore() {
  return {
    async get(key: string): Promise<Record<string, unknown> | undefined> {
      try {
        const [row] = await db
          .select({ data: botSessionsTable.data })
          .from(botSessionsTable)
          .where(eq(botSessionsTable.key, key))
          .limit(1);
        return (row?.data as Record<string, unknown>) ?? undefined;
      } catch {
        return undefined;
      }
    },

    async set(key: string, value: Record<string, unknown>): Promise<void> {
      try {
        await db
          .insert(botSessionsTable)
          .values({ key, data: value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: botSessionsTable.key,
            set: { data: value, updatedAt: new Date() },
          });
      } catch {
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await db.delete(botSessionsTable).where(eq(botSessionsTable.key, key));
      } catch {
      }
    },
  };
}
