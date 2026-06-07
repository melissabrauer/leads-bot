import pg from "pg";

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool
  .query(
    `CREATE TABLE IF NOT EXISTS bot_sessions (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`
  )
  .catch((err) => console.error("bot_sessions table init error:", err));

export function createPgSessionStore() {
  return {
    async get(key: string): Promise<Record<string, unknown> | undefined> {
      try {
        const { rows } = await pool.query(
          "SELECT data FROM bot_sessions WHERE key = $1",
          [key]
        );
        return rows[0]?.data ?? undefined;
      } catch {
        return undefined;
      }
    },

    async set(key: string, value: Record<string, unknown>): Promise<void> {
      try {
        await pool.query(
          `INSERT INTO bot_sessions (key, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = NOW()`,
          [key, JSON.stringify(value)]
        );
      } catch {
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await pool.query("DELETE FROM bot_sessions WHERE key = $1", [key]);
      } catch {
      }
    },
  };
}
