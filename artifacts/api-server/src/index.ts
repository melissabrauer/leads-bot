import app from "./app";
import { logger } from "./lib/logger";
import { createBot } from "./bot";
import { db } from "@workspace/db";
import { leadsTable, recruiterEarningsTable, transactionsTable, usersTable } from "@workspace/db/schema";
import { eq, and, lt, sql } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Start Telegram bot
try {
  const bot = createBot();
  bot.launch({ dropPendingUpdates: true });
  logger.info("Telegram bot started");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
} catch (err) {
  logger.error({ err }, "Failed to start Telegram bot");
}

// ─── Auto-demote hot leads older than 14 days to cold ────────────────────────
async function demoteOldHotLeads() {
  try {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const updated = await db
      .update(leadsTable)
      .set({ type: "cold" })
      .where(and(eq(leadsTable.type, "hot"), lt(leadsTable.createdAt, cutoff)))
      .returning({ id: leadsTable.id });
    if (updated.length > 0) {
      logger.info({ count: updated.length }, "Demoted hot leads to cold (older than 14 days)");
    }
  } catch (err) {
    logger.error({ err }, "Failed to demote hot leads");
  }
}

demoteOldHotLeads();
setInterval(demoteOldHotLeads, 60 * 60 * 1000); // every hour

// ─── Vest recruiter earnings after 14 days ────────────────────────────────────
async function vestRecruiterEarnings() {
  try {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const pending = await db.select().from(recruiterEarningsTable).where(
      and(eq(recruiterEarningsTable.status, "pending"), lt(recruiterEarningsTable.createdAt, cutoff)),
    );
    for (const earning of pending) {
      await db.update(usersTable).set({
        balance: sql`${usersTable.balance} + ${earning.amount}`,
        pendingBalance: sql`GREATEST(${usersTable.pendingBalance} - ${earning.amount}, 0)`,
      }).where(eq(usersTable.id, earning.recruiterId));
      await db.update(recruiterEarningsTable).set({ status: "vested" }).where(eq(recruiterEarningsTable.id, earning.id));
      await db.insert(transactionsTable).values({
        userId: earning.recruiterId,
        type: "recruiter_vested",
        amount: earning.amount,
        comment: "Перераховано на основний баланс після 14 днів",
      });
    }
    if (pending.length > 0) {
      logger.info({ count: pending.length }, "Vested recruiter earnings");
    }
  } catch (err) {
    logger.error({ err }, "Failed to vest recruiter earnings");
  }
}

vestRecruiterEarnings();
setInterval(vestRecruiterEarnings, 60 * 60 * 1000); // every hour

// Log the webhook URL for manual configuration in @CryptoBot → My Apps → Edit App → Webhooks
const domain = process.env.REPLIT_DEV_DOMAIN || process.env.WEBHOOK_DOMAIN;
if (domain) {
  logger.info({ url: `https://${domain}/api/crypto-webhook` }, "CryptoPay webhook URL (set manually in @CryptoBot)");
}
