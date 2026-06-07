import { Router } from "express";
import { db } from "@workspace/db";
import { topupRequestsTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { verifyWebhookToken } from "../lib/cryptoPay";

const router = Router();

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

async function sendTelegramMessage(chatId: string | number, text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch {}
}

router.get("/crypto-webhook", (_req, res) => {
  res.json({ ok: true });
});

router.post("/crypto-webhook", async (req, res) => {
  const headerToken = req.headers["crypto-pay-api-token"] as string | undefined;
  if (!verifyWebhookToken(headerToken)) {
    res.status(401).json({ ok: false });
    return;
  }

  const update = req.body as {
    update_type: string;
    payload?: {
      invoice_id: number;
      status: string;
      amount: string;
      payload?: string;
    };
  };

  if (update.update_type !== "invoice_paid" || !update.payload) {
    res.json({ ok: true });
    return;
  }

  const { invoice_id, amount, payload: topupReqId } = update.payload;

  if (!topupReqId) {
    res.json({ ok: true });
    return;
  }

  const reqId = parseInt(topupReqId, 10);
  if (isNaN(reqId)) {
    res.json({ ok: true });
    return;
  }

  const [topupReq] = await db
    .select({ req: topupRequestsTable, user: usersTable })
    .from(topupRequestsTable)
    .innerJoin(usersTable, eq(topupRequestsTable.userId, usersTable.id))
    .where(and(eq(topupRequestsTable.id, reqId), eq(topupRequestsTable.status, "pending")))
    .limit(1);

  if (!topupReq) {
    res.json({ ok: true });
    return;
  }

  const { req: topup, user } = topupReq;
  // Use our stored USD amount from DB — NOT the webhook `amount` which is
  // denominated in the crypto asset the user paid with (TON, BTC, etc.)
  const credited = parseFloat(topup.amount);

  await db.update(topupRequestsTable)
    .set({ status: "approved" })
    .where(eq(topupRequestsTable.id, reqId));

  // Atomic increment — safe against concurrent requests
  await db.update(usersTable)
    .set({ balance: sql`${usersTable.balance} + ${credited}` })
    .where(eq(usersTable.id, user.id));

  // Re-read updated balance for notifications
  const [updatedUser] = await db
    .select({ balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.id, user.id))
    .limit(1);
  const newBalance = parseFloat(updatedUser?.balance || "0").toFixed(2);

  const clientName = `@${user.username || user.firstName || user.telegramId}`;

  // Notify client
  if (user.telegramId) {
    await sendTelegramMessage(
      user.telegramId,
      `✅ <b>Баланс поповнено!</b>\n\n` +
      `💰 Зараховано: <b>$${credited.toFixed(2)}</b>\n` +
      `💼 Поточний баланс: <b>$${newBalance}</b>\n\n` +
      `💳 Спосіб: 💎 Crypto Bot\n` +
      `🔗 Invoice ID: <code>${invoice_id}</code>`,
    );
  }

  // Notify all admins
  const adminMsg =
    `✅ <b>Поповнення через Crypto Bot</b>\n\n` +
    `👤 Клієнт: ${clientName}\n` +
    `💰 Сума: <b>$${credited.toFixed(2)}</b>\n` +
    `💼 Баланс клієнта: <b>$${newBalance}</b>\n` +
    `🔗 Invoice ID: <code>${invoice_id}</code>`;

  await Promise.all(ADMIN_IDS.map((adminId) => sendTelegramMessage(adminId, adminMsg)));

  res.json({ ok: true });
});

export default router;
