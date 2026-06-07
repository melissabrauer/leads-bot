import { Telegraf, session } from "telegraf";
import { message } from "telegraf/filters";
import { tr, type Lang } from "./i18n";
import { db } from "@workspace/db";
import {
  usersTable,
  leadsTable,
  purchasesTable,
  topupRequestsTable,
  refundRequestsTable,
  leadSubscriptionsTable,
  recruiterEarningsTable,
  withdrawalRequestsTable,
  transactionsTable,
  recruiterApplicationsTable,
} from "@workspace/db";
import { eq, and, inArray, sql, or, desc, gte } from "drizzle-orm";
import { logger } from "../lib/logger";
import * as XLSX from "xlsx";
import type { Context } from "telegraf";
import { createInvoice } from "../lib/cryptoPay";
import fs from "fs";
import path from "path";
const QR_WALLET_PATH = path.join(process.cwd(), "assets/qr-wallet.jpg");

const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((id) => parseInt(id.trim())).filter(Boolean);
const WITHDRAWAL_FEE = 5; // USDT TRC20 network fee

const LANGUAGES: { label: string; keywords: string[] }[] = [
  { label: "🇬🇧 Англійська",    keywords: ["english", "англ"] },
  { label: "🇩🇪 Німецька",      keywords: ["german", "deutsch", "нім"] },
  { label: "🇫🇷 Французька",    keywords: ["french", "français", "franc"] },
  { label: "🇮🇹 Італійська",    keywords: ["italian", "italiano", "іт"] },
  { label: "🇷🇺 Російська",     keywords: ["russian", "рос"] },
  { label: "🇷🇴 Румунська",     keywords: ["romanian", "român"] },
  { label: "🇨🇿 Чеська",        keywords: ["czech", "čeština"] },
  { label: "🇸🇰 Словацька",     keywords: ["slovak", "slovenčina"] },
  { label: "🇵🇱 Польська",      keywords: ["polish", "polski"] },
  { label: "🇷🇸 Сербська",      keywords: ["serbian", "srpski"] },
  { label: "🇸🇦 Арабська",      keywords: ["arabic", "arab"] },
  { label: "🇪🇸 Іспанська",     keywords: ["spanish", "español"] },
  { label: "🇵🇹 Португальська", keywords: ["portuguese", "português"] },
  { label: "🇭🇺 Угорська",      keywords: ["hungarian", "magyar"] },
  { label: "🇹🇷 Турецька",      keywords: ["turkish", "türk"] },
  { label: "🇰🇷 Корейська",     keywords: ["korean", "한국"] },
];

function langMatchesLead(leadLang: string, selectedLabels: string[]): boolean {
  const lower = leadLang.toLowerCase().trim();
  return selectedLabels.some((label) => {
    // Exact label match — recruiter stores workLanguage as full emoji-label
    if (lower === label.toLowerCase().trim()) return true;
    // Label text (without emoji) contained in stored value
    const labelText = label.replace(/[\u{1F1E0}-\u{1F1FF}\u{1F300}-\u{1FFFF}\s]+/gu, "").toLowerCase().trim();
    if (labelText.length > 1 && lower.includes(labelText)) return true;
    // Keyword matching — for manually typed values ("English", "Polish", etc.)
    const entry = LANGUAGES.find((l) => l.label === label);
    if (!entry) return false;
    return entry.keywords.some((kw) => lower.includes(kw));
  });
}

interface SessionData {
  step?: string;
  leadData?: Record<string, string>;
  selectedLanguages?: string[];
  topupAmount?: number;
  refundLeadId?: number;
  clientIdForTopup?: number;
  leadIds?: number[];
  leadIndex?: number;
  leadMode?: "browse" | "purchased";
  editLeadId?: number;
  editLeadField?: string;
  recruiterGrantTarget?: string;
  withdrawalAmount?: number;
  withdrawalId?: number;
  recruiterLeadType?: "hot" | "cold";
  recruiterLeadLanguage?: string;
  recruiterLeadExperience?: string;
  myLeadIds?: number[];
  myLeadIndex?: number;
  adminApprovingLeadId?: number;
  adminLeadType?: "hot" | "cold";
  adminLeadLanguage?: string;
  adminLeadExperience?: string;
  adminLeadParsed?: Record<string, string>;
  supportTargetUserId?: number;
}

type BotContext = Context & { session: SessionData };

export function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const bot = new Telegraf<BotContext>(token);

  bot.use(session({ defaultSession: (): SessionData => ({}) }));

  bot.catch((err, ctx) => {
    logger.error({ err, update: ctx.update }, "Bot update error");
    ctx.reply(tr(null).internalError).catch(() => {});
  });

  // Ensure user exists in DB
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const telegramId = ctx.from.id;
    const existing = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramId, telegramId))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(usersTable).values({
        telegramId,
        firstName: ctx.from.first_name || "",
        lastName: ctx.from.last_name || "",
        username: ctx.from.username || "",
        isAdmin: ADMIN_IDS.includes(telegramId),
      });
    }
    return next();
  });

  // ─── START / MAIN MENU ───────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    ctx.session = {};
    const user = await getUser(ctx.from!.id);
    if (user?.isAdmin) {
      await showAdminMenu(ctx);
    } else if (!user?.lang || user.lang === "uk") {
      // Show language chooser only for truly new users (lang defaults to 'uk' on insert)
      // We check if this is a new user by checking if they have purchases or other activity
      const isNewUser = user?.createdAt && (Date.now() - new Date(user.createdAt).getTime()) < 30000;
      if (isNewUser) {
        await ctx.reply(tr("uk").chooseLanguage, {
          reply_markup: {
            inline_keyboard: [[
              { text: "🇺🇦 Українська", callback_data: "set_lang:uk" },
              { text: "🇷🇺 Русский", callback_data: "set_lang:ru" },
              { text: "🇬🇧 English", callback_data: "set_lang:en" },
            ]],
          },
        });
      } else {
        await showUserMenu(ctx);
      }
    } else {
      await showUserMenu(ctx);
    }
  });

  bot.command("menu", async (ctx) => {
    ctx.session = {};
    const user = await getUser(ctx.from!.id);
    if (user?.isAdmin) {
      await showAdminMenu(ctx);
    } else {
      await showUserMenu(ctx);
    }
  });

  // ─── LANGUAGE SELECTION ───────────────────────────────────────────────────────
  bot.action(/^set_lang:(uk|ru|en)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const lang = ctx.match[1] as Lang;
    const telegramId = ctx.from!.id;
    await db.update(usersTable).set({ lang }).where(eq(usersTable.telegramId, telegramId));
    const t = tr(lang);
    await ctx.editMessageText(t.languageSet).catch(async () => {
      await ctx.reply(t.languageSet);
    });
    await showUserMenu(ctx);
  });

  // ─── USER MENU (client + recruiter unified) ───────────────────────────────────
  async function showUserMenu(ctx: BotContext) {
    const user = await getUser(ctx.from!.id);
    const isRecruiter = user?.isRecruiter ?? false;
    const t = tr(user?.lang);

    const keyboard: { text: string }[][] = [
      [{ text: t.btnHotLeads }, { text: t.btnColdLeads }],
      [{ text: t.btnMyAccount }, { text: t.btnSubscriptions }],
    ];

    if (isRecruiter) {
      keyboard.push([{ text: t.btnAddLead }, { text: t.btnMyLeads }]);
    } else {
      keyboard.push([{ text: t.btnWantToSell }]);
    }
    keyboard.push([{ text: t.btnSettings }]);

    await ctx.reply(t.mainMenu, {
      reply_markup: { keyboard, resize_keyboard: true },
    });
  }

  // ─── ADMIN MENU ──────────────────────────────────────────────────────────────
  async function showAdminMenu(ctx: BotContext) {
    const tUk = tr("uk");
    await ctx.reply(tUk.adminPanel, {
      reply_markup: {
        keyboard: [
          [{ text: tUk.btnHotLeads }, { text: tUk.btnColdLeads }],
          [{ text: tUk.btnUploadLead }, { text: tUk.btnClients }],
          [{ text: tUk.btnTopupRequests }, { text: tUk.btnRefundRequests }],
          [{ text: tUk.btnLeadRequests }],
          [{ text: tUk.btnAllTransactions }, { text: tUk.btnDeleteAllLeads }],
        ],
        resize_keyboard: true,
      },
    });
  }


  // ─── HOT LEADS ───────────────────────────────────────────────────────────────
  // Multi-language button matching helpers
  function isHotLeadsBtn(text: string) {
    return text === tr("uk").btnHotLeads || text === tr("ru").btnHotLeads || text === tr("en").btnHotLeads;
  }
  function isColdLeadsBtn(text: string) {
    return text === tr("uk").btnColdLeads || text === tr("ru").btnColdLeads || text === tr("en").btnColdLeads;
  }
  function isMyAccountBtn(text: string) {
    return text === tr("uk").btnMyAccount || text === tr("ru").btnMyAccount || text === tr("en").btnMyAccount;
  }
  function isSubscriptionsBtn(text: string) {
    return text === tr("uk").btnSubscriptions || text === tr("ru").btnSubscriptions || text === tr("en").btnSubscriptions;
  }
  function isAddLeadBtn(text: string) {
    return text === tr("uk").btnAddLead || text === tr("ru").btnAddLead || text === tr("en").btnAddLead;
  }
  function isMyLeadsBtn(text: string) {
    return text === tr("uk").btnMyLeads || text === tr("ru").btnMyLeads || text === tr("en").btnMyLeads;
  }
  function isWantToSellBtn(text: string) {
    return text === tr("uk").btnWantToSell || text === tr("ru").btnWantToSell || text === tr("en").btnWantToSell;
  }
  function isSettingsBtn(text: string) {
    return text === tr("uk").btnSettings || text === tr("ru").btnSettings || text === tr("en").btnSettings;
  }
  function isWithdrawBtn(text: string) {
    return text === tr("uk").btnWithdraw || text === tr("ru").btnWithdraw || text === tr("en").btnWithdraw;
  }
  function isMyTransactionsBtn(text: string) {
    return text === tr("uk").btnMyTransactions || text === tr("ru").btnMyTransactions || text === tr("en").btnMyTransactions;
  }
  function isSellLeadsBtn(text: string) {
    return isWantToSellBtn(text);
  }

  bot.hears((text) => isHotLeadsBtn(text), async (ctx) => {
    ctx.session = { selectedLanguages: [] };
    await showLanguageFilter(ctx, "hot");
  });

  bot.hears((text) => isColdLeadsBtn(text), async (ctx) => {
    ctx.session = { selectedLanguages: [] };
    await showLanguageFilter(ctx, "cold");
  });

  async function showLanguageFilter(ctx: BotContext, type: "hot" | "cold") {
    ctx.session.step = `filter_${type}`;
    ctx.session.selectedLanguages = [];
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);

    const buttons = buildLangButtons(type, [], t);
    await ctx.reply(t.chooseLanguageFilter, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
  }

  function buildLangButtons(type: "hot" | "cold", selected: string[], t?: ReturnType<typeof tr>) {
    const trans = t ?? tr("uk");
    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < LANGUAGES.length; i += 2) {
      const row = [LANGUAGES[i], LANGUAGES[i + 1]].filter(Boolean).map((l, offset) => {
        const idx = i + offset;
        const isSelected = selected.includes(l.label);
        return {
          text: isSelected ? `✅ ${l.label}` : l.label,
          callback_data: `lt:${type === "hot" ? "h" : "c"}:${idx}`,
        };
      });
      rows.push(row);
    }
    rows.push([{ text: trans.showSelected, callback_data: `lc:${type === "hot" ? "h" : "c"}` }]);
    rows.push([{ text: trans.showAll, callback_data: `lca:${type === "hot" ? "h" : "c"}` }]);
    return rows;
  }

  bot.action(/^lt:(h|c):(\d+)$/, async (ctx) => {
    const type = ctx.match[1] === "h" ? "hot" : "cold";
    const langIdx = parseInt(ctx.match[2]);
    const lang = LANGUAGES[langIdx];
    if (!lang) { await ctx.answerCbQuery(); return; }
    if (!ctx.session.selectedLanguages) ctx.session.selectedLanguages = [];

    const idx = ctx.session.selectedLanguages.indexOf(lang.label);
    if (idx === -1) {
      ctx.session.selectedLanguages.push(lang.label);
    } else {
      ctx.session.selectedLanguages.splice(idx, 1);
    }

    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: buildLangButtons(type, ctx.session.selectedLanguages, t),
      });
    } catch {}
    await ctx.answerCbQuery();
  });

  bot.action(/^lca:(h|c)$/, async (ctx) => {
    const type = ctx.match[1] === "h" ? "hot" : "cold";
    await ctx.answerCbQuery();
    ctx.session.selectedLanguages = [];
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    await ctx.reply(t.leadBrowseWarning, { parse_mode: "HTML" });
    await initLeadBrowse(ctx, type, []);
  });

  bot.action(/^lc:(h|c)$/, async (ctx) => {
    const type = ctx.match[1] === "h" ? "hot" : "cold";
    const selectedLangs = ctx.session.selectedLanguages || [];
    await ctx.answerCbQuery();

    if (selectedLangs.length === 0) {
      const user = await getUser(ctx.from!.id);
      const t = tr(user?.lang);
      await ctx.reply(t.selectAtLeastOne);
      return;
    }

    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    await ctx.reply(t.leadBrowseWarning, { parse_mode: "HTML" });
    await initLeadBrowse(ctx, type, selectedLangs);
  });

  // ─── PAGINATED LEAD BROWSING ──────────────────────────────────────────────────

  async function getRefundButton(userId: number, leadId: number, lang?: string | null) {
    const t = tr(lang);
    const [refund] = await db
      .select()
      .from(refundRequestsTable)
      .where(and(eq(refundRequestsTable.userId, userId), eq(refundRequestsTable.leadId, leadId)))
      .limit(1);
    if (!refund) {
      return [{ text: t.refundInvalidLead, callback_data: `refund_start:${leadId}` }];
    }
    const label =
      refund.status === "pending" ? t.refundPending :
      refund.status === "approved" ? t.refundApproved : t.refundRejected;
    return [{ text: label, callback_data: "noop" }];
  }

  async function showLeadPage(ctx: BotContext, idx: number, edit = false) {
    const ids = ctx.session.leadIds ?? [];
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);

    if (ids.length === 0) {
      const msg = t.noLeads;
      if (edit) await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
      else await ctx.reply(msg);
      return;
    }

    const i = Math.max(0, Math.min(idx, ids.length - 1));
    ctx.session.leadIndex = i;
    const leadId = ids[i];

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    if (!lead) {
      const newIds = ids.filter((id) => id !== leadId);
      ctx.session.leadIds = newIds;
      if (newIds.length === 0) {
        const msg = t.noMoreLeads;
        if (edit) await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
        else await ctx.reply(msg);
        return;
      }
      await showLeadPage(ctx, Math.min(i, newIds.length - 1), edit);
      return;
    }

    const isAdmin = user?.isAdmin ?? false;
    const mode = ctx.session.leadMode ?? "browse";

    let text: string;
    let topRow: { text: string; callback_data: string }[];

    if (isAdmin) {
      const [soldCountResult, recruiterRows] = await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(purchasesTable).where(eq(purchasesTable.leadId, lead.id)),
        lead.submittedBy
          ? db.select().from(usersTable).where(eq(usersTable.id, lead.submittedBy)).limit(1)
          : Promise.resolve([] as (typeof usersTable.$inferSelect)[]),
      ]);
      const soldCount = Number(soldCountResult[0]?.count || 0);
      const recruiter = recruiterRows[0];
      const authorName = recruiter ? `@${recruiter.username || recruiter.firstName}` : "Адмін";
      text =
        formatLeadFull(lead, "uk") +
        `\n\n🛒 Продано: <b>${soldCount} раз${soldCount === 1 ? "" : soldCount < 5 ? "и" : "ів"}</b>\n👔 Автор: <b>${authorName}</b>`;
      topRow = [
        { text: "🗑 Видалити лід", callback_data: `lead_delete:${lead.id}` },
        { text: "✏️ Редагувати", callback_data: `le:${lead.id}` },
      ];
    } else if (mode === "purchased") {
      text = formatLeadFull(lead, user?.lang);
      topRow = await getRefundButton(user!.id, lead.id, user?.lang);
    } else {
      const [purchase] = await db
        .select()
        .from(purchasesTable)
        .where(and(eq(purchasesTable.userId, user!.id), eq(purchasesTable.leadId, leadId)))
        .limit(1);
      if (purchase) {
        text = formatLeadFull(lead, user?.lang);
        topRow = await getRefundButton(user!.id, lead.id, user?.lang);
      } else {
        text = formatLeadPreview(lead, user?.lang);
        topRow = [{ text: t.btnBuy(parseFloat(lead.price || "0").toFixed(2)), callback_data: `lead_buy:${lead.id}` }];
      }
    }

    const navRow = [
      { text: "◀️", callback_data: i > 0 ? "lp:prev" : "noop" },
      { text: `${i + 1} / ${ids.length}`, callback_data: "noop" },
      { text: "▶️", callback_data: i < ids.length - 1 ? "lp:next" : "noop" },
    ];

    const opts = {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: [topRow, navRow, [{ text: t.btnCancel, callback_data: "lp:cancel" }]],
      },
    };

    try {
      if (edit) await ctx.editMessageText(text, opts);
      else await ctx.reply(text, opts);
    } catch {
      if (edit) await ctx.reply(text, opts);
    }
  }

  // ─── MY LEADS PAGINATED (RECRUITER) ──────────────────────────────────────────
  async function showMyLeadPage(ctx: BotContext, idx: number, edit = false) {
    const ids = ctx.session.myLeadIds ?? [];
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);

    if (ids.length === 0) {
      const msg = t.myLeadsNone;
      if (edit) await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
      else await ctx.reply(msg);
      return;
    }
    const i = Math.max(0, Math.min(idx, ids.length - 1));
    ctx.session.myLeadIndex = i;
    const leadId = ids[i];

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    if (!lead) {
      const newIds = ids.filter((id) => id !== leadId);
      ctx.session.myLeadIds = newIds;
      if (newIds.length === 0) {
        const msg = t.myLeadsNone;
        if (edit) await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
        else await ctx.reply(msg);
        return;
      }
      await showMyLeadPage(ctx, Math.min(i, newIds.length - 1), edit);
      return;
    }

    const soldCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(purchasesTable)
      .where(eq(purchasesTable.leadId, lead.id));
    const soldCount = Number(soldCountResult[0]?.count || 0);

    const statusLabel: Record<string, string> = {
      active: t.statusActive,
      pending_review: t.statusPending,
      rejected: t.statusRejected,
    };

    const text =
      formatLeadFull(lead, user?.lang) +
      `\n\n${statusLabel[lead.status] || lead.status}\n${t.soldTimes(soldCount)}`;

    const actionRow = [
      { text: t.btnEdit, callback_data: `ml_edit:${lead.id}` },
      { text: t.btnDelete, callback_data: `ml_delete:${lead.id}` },
    ];
    const navRow = [
      { text: "◀️", callback_data: i > 0 ? "ml:prev" : "noop" },
      { text: `${i + 1} / ${ids.length}`, callback_data: "noop" },
      { text: "▶️", callback_data: i < ids.length - 1 ? "ml:next" : "noop" },
    ];

    const opts = {
      parse_mode: "HTML" as const,
      reply_markup: {
        inline_keyboard: [actionRow, navRow, [{ text: t.btnClose, callback_data: "ml:cancel" }]],
      },
    };

    try {
      if (edit) await ctx.editMessageText(text, opts);
      else await ctx.reply(text, opts);
    } catch {
      if (edit) await ctx.reply(text, opts);
    }
  }

  async function initLeadBrowse(ctx: BotContext, type: "hot" | "cold", langs: string[]) {
    const allLeads = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.type, type), eq(leadsTable.status, "active")))
      .orderBy(desc(leadsTable.createdAt));

    const filtered = langs.length > 0
      ? allLeads.filter((l) => l.workLanguage ? langMatchesLead(l.workLanguage, langs) : false)
      : allLeads;

    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);

    if (filtered.length === 0) {
      await ctx.reply(t.noLeadsFilter);
      return;
    }

    ctx.session.leadIds = filtered.map((l) => l.id);
    ctx.session.leadIndex = 0;
    ctx.session.leadMode = "browse";
    await showLeadPage(ctx, 0, false);

    // Subscription offer
    if (user && !user.isAdmin) {
      const langsStr = langs.join(",");
      const userSubs = await db.select().from(leadSubscriptionsTable)
        .where(and(eq(leadSubscriptionsTable.userId, user.id), eq(leadSubscriptionsTable.type, type)));
      const exactSub = userSubs.find((s) => s.languages === langsStr);

      const typeLabel = type === "hot" ? t.hotLabel : t.coldLabel;
      const langsLabel = langs.length > 0 ? langs.join(", ") : t.allLanguages;
      const tc = type === "hot" ? "h" : "c";

      const button = exactSub
        ? [{ text: t.btnUnsubscribe, callback_data: `sub_del:${exactSub.id}` }]
        : [{ text: t.btnSubscribe, callback_data: `sub_on:${tc}` }];

      await ctx.reply(
        `${t.notifyHeader(typeLabel)}\n${t.filterLabel(langsLabel)}`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [button] },
        },
      );
    }
  }

  // Navigation handlers
  // ─── SUBSCRIPTION ACTIONS ────────────────────────────────────────────────────
  bot.action(/^sub_on:(h|c)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user) return;
    const t = tr(user.lang);
    const type = ctx.match[1] === "h" ? "hot" : "cold";
    const langs = (ctx.session.selectedLanguages || []).join(",");

    const existing = await db.select().from(leadSubscriptionsTable)
      .where(and(
        eq(leadSubscriptionsTable.userId, user.id),
        eq(leadSubscriptionsTable.type, type),
        eq(leadSubscriptionsTable.languages, langs),
      )).limit(1);

    if (existing.length > 0) {
      await ctx.reply(t.alreadySubscribed);
      return;
    }

    await db.insert(leadSubscriptionsTable)
      .values({ userId: user.id, type, languages: langs })
      .returning();

    const typeLabel = type === "hot" ? t.hotLabel : t.coldLabel;
    const langsLabel = langs.length > 0 ? langs.replace(/,/g, ", ") : t.allLanguages;
    await ctx.deleteMessage().catch(() => {});
    const sentMsg = await ctx.reply(
      t.subscribed(typeLabel, langsLabel),
      { parse_mode: "HTML" },
    );
    setTimeout(() => {
      ctx.telegram.deleteMessage(sentMsg.chat.id, sentMsg.message_id).catch(() => {});
    }, 4000);
  });

  bot.action(/^sub_del:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    const subId = parseInt(ctx.match[1]);
    await db.delete(leadSubscriptionsTable).where(eq(leadSubscriptionsTable.id, subId));
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(t.unsubscribed);
  });

  // ─── CLIENT: MY SUBSCRIPTIONS ────────────────────────────────────────────────
  bot.hears((text) => isSubscriptionsBtn(text), async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user || user.isAdmin) return;
    const t = tr(user.lang);

    const subs = await db
      .select()
      .from(leadSubscriptionsTable)
      .where(eq(leadSubscriptionsTable.userId, user.id))
      .orderBy(leadSubscriptionsTable.createdAt);

    if (subs.length === 0) {
      await ctx.reply(t.noSubscriptions, { parse_mode: "HTML" });
      return;
    }

    const lines = subs.map((s, i) => {
      const typeLabel = s.type === "hot" ? t.hotLabel : t.coldLabel;
      const langsLabel = s.languages ? s.languages.replace(/,/g, ", ") : t.allLanguages;
      return `${i + 1}. ${typeLabel} · ${langsLabel}`;
    });

    const buttons = subs.map((s) => {
      const typeLabel = s.type === "hot" ? "🔥" : "❄️";
      const langsShort = s.languages ? s.languages.split(",")[0] + (s.languages.includes(",") ? "…" : "") : t.allLanguages;
      return [{ text: `❌ ${typeLabel} ${langsShort}`, callback_data: `sub_del:${s.id}` }];
    });

    await ctx.reply(
      `${t.subscriptionsHeader(subs.length)}\n\n${lines.join("\n")}\n\n${t.subscriptionsFooter}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      },
    );
  });

  // ─── NOTIFY SUBSCRIBERS (called after every lead insert) ─────────────────────
  async function notifySubscribers(lead: { id: number; type: string; workLanguage?: string | null; fullName: string; workExperience?: string | null; monthlyResult?: string | null; desiredSalary?: string | null; startAvailability?: string | null; willingToRelocate?: string | null; additionalInfo?: string | null; position?: string | null; age?: string | null; nationality?: string | null; currentLocation?: string | null; price: string; createdAt: Date | string }) {
    const subs = await db
      .select()
      .from(leadSubscriptionsTable)
      .where(eq(leadSubscriptionsTable.type, lead.type));

    for (const sub of subs) {
      if (sub.languages && sub.languages.trim()) {
        const langs = sub.languages.split(",").map((l) => l.trim()).filter(Boolean);
        if (langs.length > 0 && lead.workLanguage) {
          if (!langMatchesLead(lead.workLanguage, langs)) continue;
        } else if (langs.length > 0 && !lead.workLanguage) {
          continue;
        }
      }
      const [subscriber] = await db.select().from(usersTable).where(eq(usersTable.id, sub.userId)).limit(1);
      if (!subscriber?.telegramId) continue;
      const t = tr(subscriber.lang);
      try {
        await bot.telegram.sendMessage(
          subscriber.telegramId,
          `${t.newLeadNotify}\n\n${formatLeadPreview(lead as any, subscriber.lang)}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: t.btnBuy(parseFloat(lead.price || "0").toFixed(2)), callback_data: `lead_buy:${lead.id}` },
              ]],
            },
          },
        );
      } catch {}
    }
  }

  bot.action("lp:prev", async (ctx) => {
    await ctx.answerCbQuery();
    await showLeadPage(ctx, (ctx.session.leadIndex ?? 0) - 1, true);
  });

  bot.action("lp:next", async (ctx) => {
    await ctx.answerCbQuery();
    await showLeadPage(ctx, (ctx.session.leadIndex ?? 0) + 1, true);
  });

  bot.action("lp:cancel", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.leadIds = [];
    ctx.session.leadIndex = 0;
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    await ctx.editMessageText(t.viewCancelled).catch(() => {});
  });

  bot.action(/lead_delete:(\d+)/, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) { await ctx.answerCbQuery("❌ Недостатньо прав"); return; }
    const leadId = parseInt(ctx.match[1]);

    // Remove from session list
    const ids = ctx.session.leadIds ?? [];
    const idx = ctx.session.leadIndex ?? 0;
    const newIds = ids.filter((id) => id !== leadId);
    ctx.session.leadIds = newIds;

    // Delete from DB (cascade child records first)
    await db.delete(refundRequestsTable).where(eq(refundRequestsTable.leadId, leadId));
    await db.delete(purchasesTable).where(eq(purchasesTable.leadId, leadId));
    await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
    await ctx.answerCbQuery();
    const userDel = await getUser(ctx.from!.id);
    if (userDel) {
      const tDel = tr(userDel.lang);
      if (newIds.length === 0) {
        await ctx.editMessageText(tDel.leadDeletedNoMore).catch(() => {});
        return;
      }
    } else {
      if (newIds.length === 0) {
        await ctx.editMessageText(tr("uk").leadDeletedNoMore).catch(() => {});
        return;
      }
    }
    await showLeadPage(ctx, Math.min(idx, newIds.length - 1), true);
  });

  // ─── ADMIN: EDIT LEAD ─────────────────────────────────────────────────────────

  const LEAD_EDIT_FIELDS: { code: string; label: string }[] = [
    { code: "fn",  label: "ПІБ" },
    { code: "wl",  label: "Мова" },
    { code: "pos", label: "Посада" },
    { code: "ag",  label: "Вік" },
    { code: "nat", label: "Національність" },
    { code: "loc", label: "Локація" },
    { code: "exp", label: "Досвід" },
    { code: "mr",  label: "Сер. результат" },
    { code: "sal", label: "Бажана зарплата" },
    { code: "sa",  label: "Готовий почати" },
    { code: "rel", label: "Готовий переїхати" },
    { code: "ai",  label: "Додатково" },
    { code: "ph",  label: "Телефон" },
    { code: "tg",  label: "Telegram" },
    { code: "wa",  label: "WhatsApp" },
    { code: "pr",  label: "Ціна" },
    { code: "tp",  label: "🔄 Тип (гарячий/холодний)" },
  ];

  const LEAD_FIELD_MAP: Record<string, string> = {
    fn: "fullName", wl: "workLanguage", pos: "position",
    ag: "age", nat: "nationality", loc: "currentLocation",
    exp: "workExperience", mr: "monthlyResult", sal: "desiredSalary",
    sa: "startAvailability", rel: "willingToRelocate", ai: "additionalInfo",
    ph: "phone", tg: "telegramContact", wa: "whatsapp", pr: "price",
  };

  const LEAD_FIELD_NAMES: Record<string, string> = {
    fn: "ПІБ", wl: "Мова", pos: "Посада", ag: "Вік",
    nat: "Національність", loc: "Локацію", exp: "Досвід",
    mr: "Сер. результат", sal: "Бажану зарплату", sa: "Готовий почати",
    rel: "Готовий переїхати", ai: "Додатково", ph: "Телефон",
    tg: "Telegram", wa: "WhatsApp", pr: "Ціну",
  };

  bot.action(/^le:(\d+)$/, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) { await ctx.answerCbQuery("❌ Недостатньо прав"); return; }
    await ctx.answerCbQuery();
    const leadId = parseInt(ctx.match[1]);

    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < LEAD_EDIT_FIELDS.length - 1; i += 2) {
      const row = [
        { text: LEAD_EDIT_FIELDS[i].label, callback_data: `lef:${leadId}:${LEAD_EDIT_FIELDS[i].code}` },
        { text: LEAD_EDIT_FIELDS[i + 1].label, callback_data: `lef:${leadId}:${LEAD_EDIT_FIELDS[i + 1].code}` },
      ];
      rows.push(row);
    }
    // last field (tp) alone
    const last = LEAD_EDIT_FIELDS[LEAD_EDIT_FIELDS.length - 1];
    rows.push([{ text: last.label, callback_data: `lef:${leadId}:${last.code}` }]);
    const tUkEd = tr("uk");
    rows.push([{ text: tUkEd.btnCancel, callback_data: "noop" }]);

    await ctx.reply(tUkEd.adminChooseEditField, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  });

  bot.action(/^lef:(\d+):(\w+)$/, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) { await ctx.answerCbQuery("❌ Недостатньо прав"); return; }
    await ctx.answerCbQuery();
    const leadId = parseInt(ctx.match[1]);
    const code = ctx.match[2];

    if (code === "tp") {
      const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
      if (!lead) return;
      const newType = lead.type === "hot" ? "cold" : "hot";
      await db.update(leadsTable).set({ type: newType }).where(eq(leadsTable.id, leadId));
      const tUkAdmin = tr("uk");
      await ctx.reply(tUkAdmin.adminTypeChanged(newType === "hot" ? tUkAdmin.labelHot : tUkAdmin.labelCold));
      await showLeadPage(ctx, ctx.session.leadIndex ?? 0, false);
      return;
    }

    ctx.session.step = "edit_lead_field";
    ctx.session.editLeadId = leadId;
    ctx.session.editLeadField = code;
    await ctx.reply(tr("uk").adminEnterFieldValue(LEAD_FIELD_NAMES[code] || code), { parse_mode: "HTML" });
  });

  // ─── BUY LEAD ─────────────────────────────────────────────────────────────────
  bot.action(/lead_buy:(\d+)/, async (ctx) => {
    const leadId = parseInt(ctx.match[1]);

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    const user = await getUser(ctx.from!.id);
    if (!lead || !user) { await ctx.answerCbQuery("❌ Помилка"); return; }

    const balance = parseFloat(user.balance || "0");
    const price = parseFloat(lead.price || "0");

    if (balance < price) {
      const tBuy = tr(user.lang);
      await ctx.answerCbQuery(tBuy.insufficientFunds(balance.toFixed(2)));
      return;
    }

    // Prevent recruiter from buying own lead
    if (lead.submittedBy && lead.submittedBy === user.id) {
      await ctx.answerCbQuery(tr(user.lang).cantBuyOwnLead);
      return;
    }

    await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} - ${price}` })
      .where(eq(usersTable.id, user.id));
    const [purchase] = await db.insert(purchasesTable).values({ userId: user.id, leadId }).returning();

    // Log client purchase transaction
    await db.insert(transactionsTable).values({
      userId: user.id,
      type: "lead_purchase",
      amount: (-price).toFixed(2),
      comment: `Купівля ліда: ${lead.fullName}`,
    });

    // Recruiter earning: 50% of price
    if (lead.submittedBy && lead.status === "active") {
      const earning = +(price * 0.5).toFixed(2);
      await db.insert(recruiterEarningsTable).values({
        recruiterId: lead.submittedBy,
        purchaseId: purchase.id,
        leadId: lead.id,
        amount: earning.toFixed(2),
        status: "pending",
      });
      await db.update(usersTable)
        .set({ pendingBalance: sql`${usersTable.pendingBalance} + ${earning}` })
        .where(eq(usersTable.id, lead.submittedBy));
      await db.insert(transactionsTable).values({
        userId: lead.submittedBy,
        type: "recruiter_earning",
        amount: earning.toFixed(2),
        comment: `50% від продажу ліда: ${lead.fullName}`,
      });
      const [rec] = await db.select().from(usersTable).where(eq(usersTable.id, lead.submittedBy)).limit(1);
      if (rec?.telegramId) {
        const unlockDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString("uk-UA");
        try {
          await bot.telegram.sendMessage(
            rec.telegramId,
            tr(rec.lang).leadBought(lead.fullName, earning.toFixed(2), unlockDate),
            { parse_mode: "HTML" },
          );
        } catch {}
      }
    }

    const updatedUser = await getUser(ctx.from!.id);
    await ctx.answerCbQuery(tr(updatedUser?.lang).leadPurchasedToast(parseFloat(updatedUser?.balance || "0").toFixed(2)));
    // Refresh page — lead is now purchased, so full info + "Невалідний лід" will appear
    await showLeadPage(ctx, ctx.session.leadIndex ?? 0, true);
  });

  // ─── SETTINGS ────────────────────────────────────────────────────────────────
  bot.hears((text) => isSettingsBtn(text), async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user || user.isAdmin) return;
    const t = tr(user.lang);
    await ctx.reply(t.settingsMenu, {
      reply_markup: {
        inline_keyboard: [
          [{ text: t.btnChangeLanguage, callback_data: "settings_lang" }],
          [{ text: t.btnSupport, callback_data: "support_start" }],
        ],
      },
    });
  });

  bot.action("settings_lang", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    await ctx.reply(t.chooseLanguage, {
      reply_markup: {
        inline_keyboard: [[
          { text: "🇺🇦 Українська", callback_data: "set_lang:uk" },
          { text: "🇷🇺 Русский", callback_data: "set_lang:ru" },
          { text: "🇬🇧 English", callback_data: "set_lang:en" },
        ]],
      },
    });
  });

  bot.action("support_start", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user) return;
    const t = tr(user.lang);
    ctx.session.step = "support_message";
    await ctx.reply(t.supportPrompt, {
      reply_markup: { inline_keyboard: [[{ text: t.btnCancel, callback_data: "support_cancel" }]] },
    });
  });

  bot.action("support_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = undefined;
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(t.viewCancelled);
  });

  bot.action(/^support_reply:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const targetUserId = parseInt(ctx.match[1]);
    ctx.session.step = "support_reply";
    ctx.session.supportTargetUserId = targetUserId;
    await ctx.reply(tr("uk").supportReplyPrompt, {
      reply_markup: { inline_keyboard: [[{ text: tr("uk").btnCancel, callback_data: "support_cancel" }]] },
    });
  });

  // ─── MY CABINET ──────────────────────────────────────────────────────────────
  bot.hears((text) => isMyAccountBtn(text), async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user) return;
    if (user.isAdmin) return;
    const t = tr(user.lang);

    const [purchaseCount, soldCount] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(purchasesTable).where(eq(purchasesTable.userId, user.id)),
      user.isRecruiter
        ? db.select({ count: sql<number>`count(*)` }).from(leadsTable).where(and(eq(leadsTable.submittedBy, user.id), eq(leadsTable.status, "active")))
        : Promise.resolve([{ count: 0 }]),
    ]);

    const balance = parseFloat(user.balance || "0").toFixed(2);
    const pendingBalance = parseFloat(user.pendingBalance || "0").toFixed(2);
    const bought = Number(purchaseCount[0]?.count || 0);
    const sold = Number((soldCount as { count: number }[])[0]?.count || 0);

    let text = `${t.myAccount}\n\n${t.balance}: <b>$${balance}</b>`;
    if (user.isRecruiter) {
      text += `\n${t.pendingBalance}: <b>$${pendingBalance}</b> <i>(${t.fourteenDays})</i>`;
    }
    text += `\n${t.purchasedLeads}: <b>${bought}</b>`;
    if (user.isRecruiter) {
      text += `\n📤 ${bought !== null ? `${sold}` : "0"}`;
    }

    const inlineKeyboard: { text: string; callback_data: string }[][] = [
      [{ text: t.btnTopup, callback_data: "topup_start" }],
    ];
    if (user.isRecruiter) {
      inlineKeyboard.push([{ text: t.btnWithdraw, callback_data: "withdraw_start" }]);
    }
    inlineKeyboard.push([{ text: t.btnViewPurchased, callback_data: "my_leads" }]);
    inlineKeyboard.push([{ text: t.btnTransactionHistory, callback_data: "my_transactions" }]);

    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  });

  bot.action("topup_start", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    ctx.session.step = "topup_amount";
    await ctx.reply(
      t.enterTopupAmount,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: t.btnCancel, callback_data: "topup_cancel" }]],
        },
      },
    );
  });

  bot.action("topup_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = undefined;
    ctx.session.topupAmount = undefined;
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    await ctx.reply(t.viewCancelled);
  });

  bot.action("topup_pay_crypto", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user) return;
    const t = tr(user.lang);
    const amount = ctx.session.topupAmount;
    if (!amount) { await ctx.reply(t.sessionExpired); return; }

    ctx.session.topupAmount = undefined;

    try {
      const [newReq] = await db.insert(topupRequestsTable).values({
        userId: user.id,
        amount: amount.toFixed(2),
        status: "pending",
      }).returning();

      const invoice = await createInvoice(amount, newReq.id.toString());

      await db.update(topupRequestsTable)
        .set({ invoiceId: invoice.invoice_id.toString() })
        .where(eq(topupRequestsTable.id, newReq.id));

      await ctx.reply(
        t.cryptoPayPrompt(amount.toFixed(2)),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: t.btnPayCrypto, url: invoice.pay_url }],
              [{ text: t.btnCancel, callback_data: "topup_cancel" }],
            ],
          },
        },
      );
    } catch (err) {
      logger.error({ err }, "Failed to create CryptoPay invoice");
      await ctx.reply(t.errorCreatingInvoice);
    }
  });

  const MANUAL_WALLET = "TCRAF93h1oJjUdgD3opjg2WZmwKPGmWZXa";

  bot.action("topup_pay_manual", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    const amount = ctx.session.topupAmount;
    if (!amount) { await ctx.reply(t.sessionExpired); return; }

    ctx.session.step = "manual_topup_hash";

    await ctx.replyWithPhoto({ source: fs.createReadStream(QR_WALLET_PATH) }, {
      caption: t.manualTopupCaption(amount.toFixed(2), MANUAL_WALLET),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: t.btnCopyAddress, copy_text: { text: MANUAL_WALLET } } as any],
          [{ text: t.btnCancel, callback_data: "topup_cancel" }],
        ],
      },
    });
  });

  bot.action("my_leads", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user) return;
    const t = tr(user.lang);

    const purchases = await db
      .select({ leadId: purchasesTable.leadId })
      .from(purchasesTable)
      .where(eq(purchasesTable.userId, user.id))
      .orderBy(desc(purchasesTable.createdAt));

    if (purchases.length === 0) {
      await ctx.reply(t.noPurchasedLeads);
      return;
    }

    ctx.session.leadIds = purchases.map((p) => p.leadId);
    ctx.session.leadIndex = 0;
    ctx.session.leadMode = "purchased";
    await showLeadPage(ctx, 0, false);
  });

  // ─── SHARED: BUILD TX ENTRIES ────────────────────────────────────────────────
  async function buildTxEntries(userId: number, lang?: string | null): Promise<{ date: Date; text: string }[]> {
    const tTx = tr(lang);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [topups, buys, allTxs] = await Promise.all([
      db.select().from(topupRequestsTable)
        .where(and(eq(topupRequestsTable.userId, userId), gte(topupRequestsTable.createdAt, since)))
        .orderBy(desc(topupRequestsTable.createdAt)),
      db.select({ purchase: purchasesTable, lead: leadsTable })
        .from(purchasesTable)
        .innerJoin(leadsTable, eq(purchasesTable.leadId, leadsTable.id))
        .where(and(eq(purchasesTable.userId, userId), gte(purchasesTable.createdAt, since)))
        .orderBy(desc(purchasesTable.createdAt)),
      db.select().from(transactionsTable)
        .where(and(eq(transactionsTable.userId, userId), gte(transactionsTable.createdAt, since)))
        .orderBy(desc(transactionsTable.createdAt)),
    ]);

    const entries: { date: Date; text: string }[] = [];

    for (const tx of topups) {
      const status = tx.status === "approved" ? "✅" : tx.status === "rejected" ? "❌" : "⏳";
      let method: string = tTx.txMethodAdmin;
      let hashLine = "";
      if (tx.invoiceId) {
        method = "💎 Crypto Bot";
        hashLine = `\n🔗 Invoice ID: <code>${tx.invoiceId}</code>`;
      } else if (tx.comment?.startsWith("manual:")) {
        method = "🏦 USDT TRC20";
        const hash = tx.comment.replace("manual:", "");
        hashLine = `\n🔗 TxHash: <code>${hash.slice(0, 16)}...${hash.slice(-8)}</code>`;
      }
      entries.push({
        date: tx.createdAt,
        text: `${status} <b>+$${parseFloat(tx.amount).toFixed(2)}</b> · ${fmtDate(tx.createdAt)}\n${tTx.txTopupLabel} · ${method}${hashLine}`,
      });
    }

    for (const { purchase, lead } of buys) {
      entries.push({
        date: purchase.createdAt,
        text: `🛒 <b>-$${parseFloat(lead.price || "0").toFixed(2)}</b> · ${fmtDate(purchase.createdAt)}\n${tTx.txLeadPurchaseLabel}: ${lead.fullName}`,
      });
    }

    const txTypeLabel: Record<string, string> = {
      topup: tTx.txTopupAdminLabel,
      refund: tTx.txRefundLabel,
      recruiter_earning: tTx.txRecruiterEarningLabel,
      recruiter_refund: tTx.txRecruiterRefundLabel,
      recruiter_vested: tTx.txRecruiterVestedLabel,
      withdrawal: tTx.txWithdrawalLabel,
      withdrawal_rejected: tTx.txWithdrawalRejectedLabel,
    };
    for (const tx of allTxs) {
      const label = txTypeLabel[tx.type];
      if (!label) continue;
      const amount = parseFloat(tx.amount);
      const sign = amount >= 0 ? "+" : "";
      entries.push({
        date: tx.createdAt,
        text: `${label} <b>${sign}$${amount.toFixed(2)}</b> · ${fmtDate(tx.createdAt)}\n📝 ${tx.comment || "—"}`,
      });
    }

    entries.sort((a, b) => b.date.getTime() - a.date.getTime());
    return entries;
  }

  // ─── CLIENT: MY TRANSACTIONS ─────────────────────────────────────────────────
  bot.action("my_transactions", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user) return;
    const t = tr(user.lang);

    const entries = await buildTxEntries(user.id, user.lang);

    if (entries.length === 0) {
      await ctx.reply(t.noTransactions);
      return;
    }

    await ctx.reply(
      `${t.transactionsHeader(entries.length)}\n\n` + entries.map((e) => e.text).join("\n\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.action(/refund_start:(\d+)/, async (ctx) => {
    const leadId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();

    const user = await getUser(ctx.from!.id);
    if (!user) return;
    const t = tr(user.lang);

    const [purchase] = await db
      .select()
      .from(purchasesTable)
      .where(and(eq(purchasesTable.userId, user.id), eq(purchasesTable.leadId, leadId)))
      .limit(1);

    if (purchase) {
      const daysSincePurchase = (Date.now() - new Date(purchase.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSincePurchase > 14) {
        await ctx.reply(
          t.refundExpired(new Date(purchase.createdAt).toLocaleDateString("uk-UA")),
          { parse_mode: "HTML" },
        );
        return;
      }
    }

    ctx.session.step = "refund_description";
    ctx.session.refundLeadId = leadId;
    await ctx.reply(t.refundPrompt, { parse_mode: "HTML" });
  });

  bot.action("noop", async (ctx) => await ctx.answerCbQuery());

  // ─── SHARED CONSTANTS ────────────────────────────────────────────────────────
  const EXPERIENCE_OPTIONS = [
    "Conversion",
    "Retention",
    "Team leader",
    "No experience",
    "Other",
  ];

  // ─── ADMIN: UPLOAD LEAD ──────────────────────────────────────────────────────
  bot.hears((text) => text === tr("uk").btnUploadLead, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;

    const tUk = tr("uk");
    await ctx.reply(tUk.adminChooseUploadMethod, {
      reply_markup: {
        inline_keyboard: [
          [{ text: tUk.adminUploadSingle, callback_data: "upload_single" }],
          [{ text: tUk.adminUploadBulk, callback_data: "upload_bulk" }],
        ],
      },
    });
  });

  bot.action("upload_single", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;
    ctx.session.adminLeadType = undefined;
    ctx.session.adminLeadLanguage = undefined;
    ctx.session.adminLeadExperience = undefined;
    ctx.session.adminLeadParsed = undefined;
    ctx.session.step = undefined;
    await ctx.reply(
      "🔥 Гарячий чи ❄️ Холодний лід?",
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "🔥 Гарячий", callback_data: "al_type:hot" },
            { text: "❄️ Холодний", callback_data: "al_type:cold" },
          ]],
        },
      },
    );
  });

  bot.action(/^al_type:(hot|cold)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;
    ctx.session.adminLeadType = ctx.match[1] as "hot" | "cold";
    const typeLabel = ctx.match[1] === "hot" ? "🔥 Гарячий" : "❄️ Холодний";
    await ctx.editMessageText(
      `${typeLabel}\n\n🌐 Вибери мову ліда:`,
      {
        reply_markup: {
          inline_keyboard: (() => {
            const rows = [];
            for (let i = 0; i < LANGUAGES.length; i += 2) {
              const row = [LANGUAGES[i], LANGUAGES[i + 1]].filter(Boolean).map((l, off) => ({
                text: l.label,
                callback_data: `al_lang:${i + off}`,
              }));
              rows.push(row);
            }
            return rows;
          })(),
        },
      },
    );
  });

  bot.action(/^al_lang:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;
    const idx = parseInt(ctx.match[1]);
    const lang = LANGUAGES[idx];
    if (!lang) return;
    ctx.session.adminLeadLanguage = lang.label;
    const typeLabel = ctx.session.adminLeadType === "hot" ? "🔥 Гарячий" : "❄️ Холодний";
    await ctx.editMessageText(
      `${typeLabel} · ${lang.label}\n\n💼 Досвід ліда:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: EXPERIENCE_OPTIONS[0], callback_data: "al_exp:0" },
              { text: EXPERIENCE_OPTIONS[1], callback_data: "al_exp:1" },
            ],
            [
              { text: EXPERIENCE_OPTIONS[2], callback_data: "al_exp:2" },
              { text: EXPERIENCE_OPTIONS[3], callback_data: "al_exp:3" },
            ],
            [{ text: EXPERIENCE_OPTIONS[4], callback_data: "al_exp:4" }],
          ],
        },
      },
    );
  });

  bot.action(/^al_exp:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;
    const expIdx = parseInt(ctx.match[1]);
    const exp = EXPERIENCE_OPTIONS[expIdx];
    if (!exp) return;

    if (exp === "Other") {
      ctx.session.step = "admin_experience_other";
      await ctx.editMessageText(
        `✏️ Введіть досвід вручну:`,
        { reply_markup: { inline_keyboard: [] } },
      );
      return;
    }

    ctx.session.adminLeadExperience = exp;
    ctx.session.step = "admin_upload_parse";
    await showAdminLeadTemplate(ctx, exp);
  });

  bot.action("al_cancel", async (ctx) => {
    await ctx.answerCbQuery("Скасовано");
    ctx.session.step = undefined;
    ctx.session.adminLeadType = undefined;
    ctx.session.adminLeadLanguage = undefined;
    ctx.session.adminLeadExperience = undefined;
    ctx.session.adminLeadParsed = undefined;
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(tr("uk").adminCancelled);
    await showAdminMenu(ctx);
  });

  bot.action("upload_bulk", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = "upload_file";
    await ctx.reply(tr("uk").adminBulkUploadPrompt);
  });

  // ─── ADMIN: CLIENTS ──────────────────────────────────────────────────────────
  bot.hears((text) => text === tr("uk").btnClients, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;

    const clients = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.isAdmin, false));

    const tUk = tr("uk");
    if (clients.length === 0) {
      await ctx.reply(tUk.adminNoClients);
      return;
    }

    const buttons = clients.map((c) => [
      {
        text: `@${c.username || c.firstName || c.telegramId}`,
        callback_data: `admin_client:${c.id}`,
      },
    ]);

    await ctx.reply(tUk.adminClientsHeader(clients.length), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
  });

  bot.action(/admin_client:(\d+)/, async (ctx) => {
    const clientId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();

    const [client] = await db.select().from(usersTable).where(eq(usersTable.id, clientId)).limit(1);
    if (!client) return;

    const [purchases, submittedLeads] = await Promise.all([
      db.select({ lead: leadsTable })
        .from(purchasesTable)
        .innerJoin(leadsTable, eq(purchasesTable.leadId, leadsTable.id))
        .where(eq(purchasesTable.userId, clientId)),
      db.select()
        .from(leadsTable)
        .where(eq(leadsTable.submittedBy, clientId))
        .orderBy(desc(leadsTable.createdAt)),
    ]);

    const leadNames = purchases.map((p) => p.lead.fullName).join(", ") || "—";
    const balance = parseFloat(client.balance || "0").toFixed(2);

    const statusLabel: Record<string, string> = {
      active: "✅",
      pending_review: "⏳",
      rejected: "❌",
    };
    const submittedInfo = submittedLeads.length > 0
      ? submittedLeads.map((l) => `${statusLabel[l.status] ?? "?"} ${l.fullName}`).join("\n")
      : "—";

    const roleLabel = client.isRecruiter ? "👔 Рекрутер" : "👤 Клієнт";

    await ctx.reply(
      `${roleLabel}\n\n` +
        `📛 Ім'я: ${client.firstName} ${client.lastName}\n` +
        `🔤 Username: @${client.username || "—"}\n` +
        `💰 Баланс: <b>$${balance}</b>\n` +
        `🛒 Куплено лідів: ${purchases.length}\n` +
        `📋 Куплені ліди: ${leadNames}` +
        (submittedLeads.length > 0
          ? `\n\n📤 Подані ліди (${submittedLeads.length}):\n${submittedInfo}`
          : ""),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Поповнити баланс", callback_data: `admin_topup:${clientId}` }],
            [{ text: "📊 Транзакції", callback_data: `admin_client_tx:${clientId}` }],
            client.isRecruiter
              ? [{ text: "🚫 Відкликати права рекрутера", callback_data: `revoke_rec:${clientId}` }]
              : [{ text: "👔 Надати права рекрутера", callback_data: `grant_rec:${clientId}` }],
            [{ text: "◀️ Назад", callback_data: "admin_back_clients" }],
          ],
        },
      },
    );
  });

  bot.action(/admin_topup:(\d+)/, async (ctx) => {
    const clientId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    ctx.session.step = "admin_topup_amount";
    ctx.session.clientIdForTopup = clientId;
    await ctx.reply(tr("uk").adminTopupAmountPrompt);
  });

  bot.action("admin_back_clients", async (ctx) => {
    await ctx.answerCbQuery();
    const clients = await db.select().from(usersTable).where(eq(usersTable.isAdmin, false));
    const buttons = clients.map((c) => [
      {
        text: `@${c.username || c.firstName || c.telegramId}`,
        callback_data: `admin_client:${c.id}`,
      },
    ]);
    await ctx.editMessageText(tr("uk").adminClientsHeader(clients.length), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
  });

  // ─── ADMIN: CLIENT TRANSACTIONS ──────────────────────────────────────────────
  bot.action(/admin_client_tx:(\d+)/, async (ctx) => {
    const clientId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();

    const [client] = await db.select().from(usersTable).where(eq(usersTable.id, clientId)).limit(1);
    if (!client) return;

    const entries = await buildTxEntries(clientId);

    if (entries.length === 0) {
      await ctx.reply(`📊 Немає транзакцій для @${client.username || client.firstName}.`);
      return;
    }

    await ctx.reply(
      `📊 <b>Транзакції @${client.username || client.firstName} (${entries.length})</b>\n<i>За останні 30 днів</i>\n\n` + entries.map((e) => e.text).join("\n\n"),
      { parse_mode: "HTML" },
    );
  });

  // ─── ADMIN: ALL TRANSACTIONS ──────────────────────────────────────────────────
  bot.hears((text) => text === tr("uk").btnAllTransactions, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;

    const [topups, buys, allTxs] = await Promise.all([
      db.select({ tx: topupRequestsTable, client: usersTable })
        .from(topupRequestsTable)
        .innerJoin(usersTable, eq(topupRequestsTable.userId, usersTable.id))
        .orderBy(desc(topupRequestsTable.createdAt)).limit(50),
      db.select({ purchase: purchasesTable, lead: leadsTable, client: usersTable })
        .from(purchasesTable)
        .innerJoin(leadsTable, eq(purchasesTable.leadId, leadsTable.id))
        .innerJoin(usersTable, eq(purchasesTable.userId, usersTable.id))
        .orderBy(desc(purchasesTable.createdAt)).limit(50),
      db.select({ tx: transactionsTable, client: usersTable })
        .from(transactionsTable)
        .innerJoin(usersTable, eq(transactionsTable.userId, usersTable.id))
        .orderBy(desc(transactionsTable.createdAt)).limit(50),
    ]);

    type Entry = { date: Date; text: string };
    const entries: Entry[] = [];

    for (const { tx, client: c } of topups) {
      const status = tx.status === "approved" ? "✅" : tx.status === "rejected" ? "❌" : "⏳";
      const name = `@${c.username || c.firstName}`;
      let method = "👤 Адміністратор";
      let hashLine = "";
      if (tx.invoiceId) {
        method = "💎 Crypto Bot";
        hashLine = `\n🔗 Invoice ID: <code>${tx.invoiceId}</code>`;
      } else if (tx.comment?.startsWith("manual:")) {
        method = "🏦 USDT TRC20";
        const hash = tx.comment.replace("manual:", "");
        hashLine = `\n🔗 TxHash: <code>${hash.slice(0, 16)}...${hash.slice(-8)}</code>`;
      }
      entries.push({
        date: tx.createdAt,
        text: `${status} <b>+$${parseFloat(tx.amount).toFixed(2)}</b> · ${fmtDate(tx.createdAt)}\n👤 ${name} · 💳 Поповнення · ${method}${hashLine}`,
      });
    }

    for (const { purchase, lead, client: c } of buys) {
      const name = `@${c.username || c.firstName}`;
      entries.push({
        date: purchase.createdAt,
        text: `🛒 <b>-$${parseFloat(lead.price || "0").toFixed(2)}</b> · ${fmtDate(purchase.createdAt)}\n👤 ${name} · Купівля ліда: ${lead.fullName}`,
      });
    }

    const txTypeLabel: Record<string, string> = {
      topup: "👤 Поповнення адміністратором",
      refund: "↩️ Повернення за лід",
      recruiter_earning: "💰 Заробіток рекрутера",
      recruiter_refund: "❌ Списання (повернення)",
      recruiter_vested: "✅ Нараховано з очікування",
      withdrawal: "💸 Вивід коштів",
      withdrawal_rejected: "↩️ Вивід відхилено",
    };
    for (const { tx, client: c } of allTxs) {
      const label = txTypeLabel[tx.type];
      if (!label) continue;
      const name = `@${c.username || c.firstName}`;
      const amount = parseFloat(tx.amount);
      const sign = amount >= 0 ? "+" : "";
      entries.push({
        date: tx.createdAt,
        text: `${label} <b>${sign}$${amount.toFixed(2)}</b> · ${fmtDate(tx.createdAt)}\n👤 ${name} · 📝 ${tx.comment || "—"}`,
      });
    }

    entries.sort((a, b) => b.date.getTime() - a.date.getTime());

    const tUk = tr("uk");
    if (entries.length === 0) {
      await ctx.reply(tUk.adminNoTransactions);
      return;
    }

    const shown = entries.slice(0, 50);
    await ctx.reply(
      tUk.adminAllTransactionsHeader(shown.length) + "\n\n" + shown.map((e) => e.text).join("\n\n"),
      { parse_mode: "HTML" },
    );
  });

  // ─── CLIENT: WANT TO SELL LEADS ──────────────────────────────────────────────
  bot.hears((text) => isWantToSellBtn(text), async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user) return;
    const t = tr(user.lang);

    // If already a recruiter — show unified menu
    if (user.isRecruiter) {
      await showUserMenu(ctx);
      return;
    }

    // Check for existing pending application
    const [existing] = await db
      .select()
      .from(recruiterApplicationsTable)
      .where(and(eq(recruiterApplicationsTable.userId, user.id), eq(recruiterApplicationsTable.status, "pending")))
      .limit(1);

    if (existing) {
      await ctx.reply(t.recruiterAlreadyApplied, { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(
      t.recruiterRulesText,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: t.recruiterAgreeBtn, callback_data: "apply_recruiter" }]],
        },
      },
    );
  });

  bot.action("apply_recruiter", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user) return;

    const t = tr(user.lang);
    if (user.isRecruiter) {
      await ctx.editMessageText(t.recruiterAlreadyIs);
      return;
    }

    const [existing] = await db
      .select()
      .from(recruiterApplicationsTable)
      .where(and(eq(recruiterApplicationsTable.userId, user.id), eq(recruiterApplicationsTable.status, "pending")))
      .limit(1);

    if (existing) {
      await ctx.editMessageText(t.recruiterAlreadyApplied);
      return;
    }

    const [app] = await db.insert(recruiterApplicationsTable).values({
      userId: user.id,
      status: "pending",
    }).returning();

    await ctx.editMessageText(t.recruiterApplicationSent, { parse_mode: "HTML" });

    for (const adminId of ADMIN_IDS) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          `🤝 <b>Нова заявка на рекрутера</b>\n\n👤 @${user.username || user.firstName}\n🆔 ID: ${user.id}\n📅 ${fmtDate(new Date())}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Схвалити", callback_data: `rapprove:${app.id}` },
                { text: "❌ Відхилити", callback_data: `rreject:${app.id}` },
              ]],
            },
          },
        );
      } catch {}
    }
  });

  bot.action(/rapprove:(\d+)/, async (ctx) => {
    const appId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const [application] = await db.select().from(recruiterApplicationsTable).where(eq(recruiterApplicationsTable.id, appId)).limit(1);
    if (!application) return;
    const tUk = tr("uk");
    if (application.status !== "pending") {
      await ctx.editMessageText(tUk.adminApplicationAlreadyProcessed).catch(() => {});
      return;
    }
    await db.update(recruiterApplicationsTable).set({ status: "approved" }).where(eq(recruiterApplicationsTable.id, appId));
    await db.update(usersTable).set({ isRecruiter: true }).where(eq(usersTable.id, application.userId));
    const [applicant] = await db.select().from(usersTable).where(eq(usersTable.id, application.userId)).limit(1);
    await ctx.editMessageText(tUk.adminApplicationApproved(applicant?.username || applicant?.firstName || "")).catch(() => {});
    if (applicant?.telegramId) {
      try {
        const appT = tr(applicant.lang);
        await bot.telegram.sendMessage(applicant.telegramId, appT.recruiterApproved, { parse_mode: "HTML" });
      } catch {}
    }
  });

  bot.action(/rreject:(\d+)/, async (ctx) => {
    const appId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const [application] = await db.select().from(recruiterApplicationsTable).where(eq(recruiterApplicationsTable.id, appId)).limit(1);
    if (!application) return;
    const tUk = tr("uk");
    if (application.status !== "pending") {
      await ctx.editMessageText(tUk.adminApplicationAlreadyProcessed).catch(() => {});
      return;
    }
    await db.update(recruiterApplicationsTable).set({ status: "rejected" }).where(eq(recruiterApplicationsTable.id, appId));
    const [applicant] = await db.select().from(usersTable).where(eq(usersTable.id, application.userId)).limit(1);
    await ctx.editMessageText(tUk.adminApplicationRejected(applicant?.username || applicant?.firstName || "")).catch(() => {});
    if (applicant?.telegramId) {
      try {
        const appT = tr(applicant.lang);
        await bot.telegram.sendMessage(applicant.telegramId, appT.recruiterRejected, { parse_mode: "HTML" });
      } catch {}
    }
  });

  // ─── ADMIN: RECRUITERS ───────────────────────────────────────────────────────
  bot.action(/grant_rec:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const admin = await getUser(ctx.from!.id);
    if (!admin?.isAdmin) return;
    const userId = parseInt(ctx.match[1]);
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target) return;
    await db.update(usersTable).set({ isRecruiter: true }).where(eq(usersTable.id, userId));
    await ctx.reply(`✅ Права рекрутера надано @${target.username || target.firstName}`);
    try {
      await bot.telegram.sendMessage(
        target.telegramId,
        tr(target.lang).recruiterGranted,
        { parse_mode: "HTML" },
      );
    } catch {}
  });

  bot.action(/revoke_rec:(\d+)/, async (ctx) => {
    const userId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target) return;
    await db.update(usersTable).set({ isRecruiter: false }).where(eq(usersTable.id, userId));
    await ctx.reply(`✅ Права рекрутера відкликано у @${target.username || target.firstName}`);
    try {
      await bot.telegram.sendMessage(
        target.telegramId,
        tr(target.lang).recruiterRevoked,
        { parse_mode: "HTML" },
      );
    } catch {}
  });

  // ─── ADMIN: LEAD SUBMISSIONS ─────────────────────────────────────────────────
  async function showLeadRequests(ctx: BotContext) {
    const tUk = tr("uk");
    const pending = await db
      .select({ lead: leadsTable, recruiter: usersTable })
      .from(leadsTable)
      .leftJoin(usersTable, eq(leadsTable.submittedBy, usersTable.id))
      .where(eq(leadsTable.status, "pending_review"))
      .orderBy(desc(leadsTable.createdAt));

    if (pending.length === 0) {
      await ctx.reply(tUk.adminNoLeadRequests);
      return;
    }

    for (const { lead, recruiter } of pending) {
      const recruiterName = recruiter ? `@${recruiter.username || recruiter.firstName}` : "—";
      await ctx.reply(
        formatLeadFull(lead, "uk") + tUk.adminLeadRequestRow(recruiterName),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Одобрити", callback_data: `sub_ok:${lead.id}` },
              { text: "❌ Відхилити", callback_data: `sub_no:${lead.id}` },
            ]],
          },
        },
      );
    }
  }

  bot.hears((text) => text === tr("uk").btnLeadRequests, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;
    await showLeadRequests(ctx);
  });

  bot.action("admin_lead_requests", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;
    await showLeadRequests(ctx);
  });

  bot.action(/sub_ok:(\d+)/, async (ctx) => {
    const leadId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    if (!lead) return;
    ctx.session.step = "admin_set_price";
    ctx.session.adminApprovingLeadId = leadId;
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(tr("uk").adminSetPrice(lead.fullName), { parse_mode: "HTML" });
  });

  bot.action(/^view_lead:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;
    const leadId = parseInt(ctx.match[1]);
    ctx.session.leadIds = [leadId];
    ctx.session.leadIndex = 0;
    ctx.session.leadMode = "browse";
    await showLeadPage(ctx, 0, false);
  });

  bot.action(/sub_no:(\d+)/, async (ctx) => {
    const leadId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    if (!lead) return;
    await db.update(leadsTable).set({ status: "rejected" }).where(eq(leadsTable.id, leadId));
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(tr("uk").adminLeadRejected(lead.fullName), { parse_mode: "HTML" });
    if (lead.submittedBy) {
      const [rec] = await db.select().from(usersTable).where(eq(usersTable.id, lead.submittedBy)).limit(1);
      if (rec?.telegramId) {
        try {
          const recT = tr(rec.lang);
          await bot.telegram.sendMessage(
            rec.telegramId,
            recT.leadRejectedNotify(lead.fullName),
            { parse_mode: "HTML" },
          );
        } catch {}
      }
    }
  });

  // ─── ADMIN: TOPUP REQUESTS ───────────────────────────────────────────────────
  bot.hears((text) => text === tr("uk").btnTopupRequests, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;

    const requests = await db
      .select({ req: topupRequestsTable, user: usersTable })
      .from(topupRequestsTable)
      .innerJoin(usersTable, eq(topupRequestsTable.userId, usersTable.id))
      .where(eq(topupRequestsTable.status, "pending"));

    const tUk = tr("uk");
    if (requests.length === 0) {
      await ctx.reply(tUk.adminNoTopupRequests);
      return;
    }

    for (const { req, user: client } of requests) {
      await ctx.reply(
        tUk.adminTopupRequest(client.username || client.firstName || String(client.telegramId), req.amount, req.comment || "—"),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Підтвердити", callback_data: `topup_approve:${req.id}` },
                { text: "❌ Відхилити", callback_data: `topup_reject:${req.id}` },
              ],
            ],
          },
        },
      );
    }
  });

  bot.action(/topup_approve:(\d+)/, async (ctx) => {
    const reqId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();

    const [req] = await db
      .select()
      .from(topupRequestsTable)
      .where(eq(topupRequestsTable.id, reqId))
      .limit(1);
    if (!req) return;

    await db
      .update(topupRequestsTable)
      .set({ status: "approved" })
      .where(eq(topupRequestsTable.id, reqId));

    await db
      .update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${req.amount}` })
      .where(eq(usersTable.id, req.userId));

    const hash = req.comment?.startsWith("manual:") ? req.comment.replace("manual:", "") : null;
    const method = req.invoiceId ? "💎 Crypto Bot" : "🏦 USDT TRC20";
    const txComment = req.invoiceId
      ? `Поповнення ${method} · Invoice: ${req.invoiceId}`
      : hash
        ? `Поповнення ${method} · TxHash: ${hash}`
        : `Поповнення ${method}`;

    await db.insert(transactionsTable).values({
      userId: req.userId,
      type: "topup",
      amount: req.amount,
      comment: txComment,
    });

    const [client] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const newBalance = parseFloat(client?.balance || "0").toFixed(2);

    await ctx.editMessageText(
      `✅ Поповнення на $${req.amount} підтверджено для @${client?.username || client?.firstName}`,
    );

    const hashLine = hash
      ? `\n🔗 TxHash: <code>${hash.slice(0, 16)}...${hash.slice(-8)}</code>`
      : "";

    try {
      await bot.telegram.sendMessage(
        client!.telegramId,
        tr(client!.lang).topupApproved(parseFloat(req.amount).toFixed(2), newBalance) + hashLine,
        { parse_mode: "HTML" },
      );
    } catch {}
  });

  bot.action(/topup_reject:(\d+)/, async (ctx) => {
    const reqId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();

    const [req] = await db
      .select()
      .from(topupRequestsTable)
      .where(eq(topupRequestsTable.id, reqId))
      .limit(1);
    if (!req) return;

    await db
      .update(topupRequestsTable)
      .set({ status: "rejected" })
      .where(eq(topupRequestsTable.id, reqId));

    const [client] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);

    await ctx.editMessageText(`❌ Запит на поповнення $${req.amount} відхилено.`);

    try {
      await bot.telegram.sendMessage(
        client!.telegramId,
        tr(client!.lang).topupRejected(parseFloat(req.amount).toFixed(2)),
        { parse_mode: "HTML" },
      );
    } catch {}
  });

  // ─── ADMIN: REFUND REQUESTS ──────────────────────────────────────────────────
  bot.hears((text) => text === tr("uk").btnRefundRequests, async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isAdmin) return;

    const requests = await db
      .select({ req: refundRequestsTable, user: usersTable, lead: leadsTable })
      .from(refundRequestsTable)
      .innerJoin(usersTable, eq(refundRequestsTable.userId, usersTable.id))
      .innerJoin(leadsTable, eq(refundRequestsTable.leadId, leadsTable.id))
      .where(eq(refundRequestsTable.status, "pending"));

    const tUk = tr("uk");
    if (requests.length === 0) {
      await ctx.reply(tUk.adminNoRefundRequests);
      return;
    }

    for (const { req, user: client, lead } of requests) {
      await ctx.reply(
        tUk.adminRefundRequest(client.username || client.firstName || String(client.telegramId), lead.fullName, lead.price || "0", req.description || "—"),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Повернути кошти", callback_data: `refund_approve:${req.id}` },
                { text: "❌ Відхилити", callback_data: `refund_reject:${req.id}` },
              ],
            ],
          },
        },
      );

      if (req.screenshotFileId) {
        try {
          await ctx.replyWithPhoto(req.screenshotFileId, { caption: "📸 Скріншот підтвердження" });
        } catch {}
      }
    }
  });

  bot.action(/refund_approve:(\d+)/, async (ctx) => {
    const reqId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();

    const [req] = await db
      .select()
      .from(refundRequestsTable)
      .where(eq(refundRequestsTable.id, reqId))
      .limit(1);
    if (!req) return;

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, req.leadId)).limit(1);

    await db
      .update(refundRequestsTable)
      .set({ status: "approved" })
      .where(eq(refundRequestsTable.id, reqId));

    await db
      .update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${lead?.price || 0}` })
      .where(eq(usersTable.id, req.userId));

    // Log refund transaction for client
    await db.insert(transactionsTable).values({
      userId: req.userId,
      type: "refund",
      amount: lead?.price || "0",
      comment: `Повернення за лід: ${lead?.fullName}`,
    });

    // Handle recruiter earning reversal
    if (lead?.submittedBy) {
      const [earning] = await db.select().from(recruiterEarningsTable)
        .where(and(
          eq(recruiterEarningsTable.leadId, req.leadId),
          eq(recruiterEarningsTable.recruiterId, lead.submittedBy),
          eq(recruiterEarningsTable.status, "pending"),
        )).limit(1);

      if (earning) {
        await db.update(recruiterEarningsTable)
          .set({ status: "refunded" })
          .where(eq(recruiterEarningsTable.id, earning.id));
        await db.update(usersTable)
          .set({ pendingBalance: sql`GREATEST(${usersTable.pendingBalance} - ${earning.amount}, 0)` })
          .where(eq(usersTable.id, lead.submittedBy));
        await db.insert(transactionsTable).values({
          userId: lead.submittedBy,
          type: "recruiter_refund",
          amount: `-${earning.amount}`,
          comment: `Повернення клієнтом за лід: ${lead.fullName}`,
        });
        const [recUser] = await db.select().from(usersTable).where(eq(usersTable.id, lead.submittedBy)).limit(1);
        if (recUser?.telegramId) {
          try {
            await bot.telegram.sendMessage(
              recUser.telegramId,
              tr(recUser.lang).recruiterRefundNotify(lead.fullName, earning.amount),
              { parse_mode: "HTML" },
            );
          } catch {}
        }
      }
    }

    const [client] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    const newBalance = parseFloat(client?.balance || "0").toFixed(2);

    await ctx.editMessageText(`✅ Повернення $${lead?.price} схвалено.`);

    try {
      await bot.telegram.sendMessage(
        client!.telegramId,
        tr(client!.lang).refundApprovedNotify(lead?.fullName || "", lead?.price || "0", newBalance),
        { parse_mode: "HTML" },
      );
    } catch {}
  });

  bot.action(/refund_reject:(\d+)/, async (ctx) => {
    const reqId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();

    const [req] = await db
      .select()
      .from(refundRequestsTable)
      .where(eq(refundRequestsTable.id, reqId))
      .limit(1);
    if (!req) return;

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, req.leadId)).limit(1);

    await db
      .update(refundRequestsTable)
      .set({ status: "rejected" })
      .where(eq(refundRequestsTable.id, reqId));

    const [client] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);

    await ctx.editMessageText(`❌ Запит на повернення відхилено.`);

    try {
      await bot.telegram.sendMessage(
        client!.telegramId,
        tr(client!.lang).refundRejectedNotify(lead?.fullName || ""),
        { parse_mode: "HTML" },
      );
    } catch {}
  });

  // ─── ADMIN: DELETE ALL LEADS ─────────────────────────────────────────────────
  bot.hears((text) => text === tr("uk").btnDeleteAllLeads, async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const tUk = tr("uk");
    await ctx.reply(tUk.adminDeleteAllConfirm, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: tUk.adminDeleteAllYes, callback_data: "delete_all_leads_confirm" },
          { text: tUk.adminDeleteAllNo, callback_data: "delete_all_leads_cancel" },
        ]],
      },
    });
  });

  bot.action("delete_all_leads_confirm", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from!.id)) { await ctx.answerCbQuery(); return; }
    await ctx.answerCbQuery();
    // Must delete child records first to satisfy foreign key constraints
    await db.delete(refundRequestsTable);
    await db.delete(purchasesTable);
    await db.delete(leadsTable);
    const tUk = tr("uk");
    await ctx.editMessageText(tUk.adminDeleteAllDone);
    await showAdminMenu(ctx);
  });

  bot.action("delete_all_leads_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(tr("uk").adminDeleteCancelled);
  });

  // ─── MESSAGE HANDLER (multi-step flows) ──────────────────────────────────────
  bot.on(message("text"), async (ctx, next) => {
    const step = ctx.session.step;
    const text = ctx.message.text;

    // Pass keyboard buttons to hears handlers when no step is active
    const ukT = tr("uk");
    const isMenuButton =
      isHotLeadsBtn(text) || isColdLeadsBtn(text) || isMyAccountBtn(text) ||
      isSubscriptionsBtn(text) || isAddLeadBtn(text) || isMyLeadsBtn(text) ||
      isSellLeadsBtn(text) || isSettingsBtn(text) ||
      isWithdrawBtn(text) || isMyTransactionsBtn(text) ||
      // Admin buttons (always Ukrainian)
      text === ukT.btnUploadLead || text === ukT.btnClients ||
      text === ukT.btnTopupRequests || text === ukT.btnRefundRequests ||
      text === ukT.btnAllTransactions || text === ukT.btnLeadRequests ||
      text === ukT.btnDeleteAllLeads;
    if (!step && isMenuButton) {
      return next();
    }

    // Admin: edit lead field
    if (step === "edit_lead_field") {
      const leadId = ctx.session.editLeadId;
      const code = ctx.session.editLeadField;
      if (!leadId || !code) return;
      const colName = LEAD_FIELD_MAP[code];
      if (!colName) return;
      await db.update(leadsTable).set({ [colName]: text } as any).where(eq(leadsTable.id, leadId));
      ctx.session.step = undefined;
      ctx.session.editLeadId = undefined;
      ctx.session.editLeadField = undefined;
      await ctx.reply(tr("uk").adminFieldUpdated(LEAD_FIELD_NAMES[code] || code), { parse_mode: "HTML" });
      await showLeadPage(ctx, ctx.session.leadIndex ?? 0, false);
      return;
    }

    // Recruiter: edit own lead field
    if (step === "recruiter_edit_lead_field") {
      const leadId = ctx.session.editLeadId;
      const code = ctx.session.editLeadField;
      if (!leadId || !code) return;
      const user = await getUser(ctx.from!.id);
      if (!user?.isRecruiter) return;
      const [lead] = await db
        .select()
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.submittedBy, user.id)))
        .limit(1);
      if (!lead) { ctx.session.step = undefined; return; }
      const colName = LEAD_FIELD_MAP[code];
      if (!colName) return;
      await db.update(leadsTable).set({ [colName]: text } as any).where(eq(leadsTable.id, leadId));
      ctx.session.step = undefined;
      ctx.session.editLeadId = undefined;
      ctx.session.editLeadField = undefined;
      const tRec = tr(user.lang);
      await ctx.reply(tRec.adminFieldUpdated(LEAD_FIELD_NAMES[code] || code), { parse_mode: "HTML" });
      await showMyLeadPage(ctx, ctx.session.myLeadIndex ?? 0, false);
      return;
    }

    // Support message from user → forward to all admins
    if (step === "support_message") {
      const user = await getUser(ctx.from!.id);
      if (!user) return;
      const t = tr(user.lang);
      ctx.session.step = undefined;
      const tUkAdmin = tr("uk");
      const header = tUkAdmin.adminSupportHeader(
        ctx.from!.username || "",
        ctx.from!.first_name || "",
        ctx.from!.id,
      );
      for (const adminId of ADMIN_IDS) {
        await bot.telegram.sendMessage(adminId, `${header}\n\n${text}`, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: tUkAdmin.btnReplySupport, callback_data: `support_reply:${ctx.from!.id}` },
            ]],
          },
        }).catch(() => {});
      }
      await ctx.reply(t.supportSent);
      return;
    }

    // Support reply from admin → forward to user
    if (step === "support_reply") {
      const targetUserId = ctx.session.supportTargetUserId;
      if (!targetUserId) { ctx.session.step = undefined; return; }
      ctx.session.step = undefined;
      ctx.session.supportTargetUserId = undefined;
      const targetUser = await db.select().from(usersTable).where(eq(usersTable.telegramId, BigInt(targetUserId))).limit(1);
      const userLang = targetUser[0]?.lang;
      const tUser = tr(userLang);
      await bot.telegram.sendMessage(targetUserId, tUser.supportReplyReceived(text), {
        parse_mode: "HTML",
      }).catch(() => {});
      await ctx.reply("✅ Відповідь надіслано користувачу.");
      return;
    }

    // Topup amount (client) — stores amount and shows payment method choice
    if (step === "topup_amount") {
      const tUser = await getUser(ctx.from!.id);
      const tLang = tr(tUser?.lang);
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 10) {
        await ctx.reply(tLang.invalidTopupAmount);
        return;
      }
      ctx.session.step = undefined;
      ctx.session.topupAmount = amount;
      await ctx.reply(
        tLang.choosePaymentMethod(amount.toFixed(2)),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: tLang.btnPayCrypto, callback_data: "topup_pay_crypto" },
                { text: tLang.btnPayManual, callback_data: "topup_pay_manual" },
              ],
              [{ text: tLang.btnCancel, callback_data: "topup_cancel" }],
            ],
          },
        },
      );
      return;
    }

    // Manual topup: waiting for TRC20 transaction hash
    if (step === "manual_topup_hash") {
      const hash = text.trim();
      const hashUser = await getUser(ctx.from!.id);
      const hashT = tr(hashUser?.lang);
      if (!/^[a-fA-F0-9]{64}$/.test(hash)) {
        await ctx.reply(hashT.invalidTxHash, { parse_mode: "HTML" });
        return;
      }
      const user = hashUser;
      if (!user) return;
      const amount = ctx.session.topupAmount || 0;

      const [newReq] = await db.insert(topupRequestsTable).values({
        userId: user.id,
        amount: amount.toFixed(2),
        comment: `manual:${hash}`,
        status: "pending",
      }).returning();

      ctx.session.step = undefined;
      ctx.session.topupAmount = undefined;

      for (const adminId of ADMIN_IDS) {
        try {
          await bot.telegram.sendMessage(
            adminId,
            `🏦 <b>Ручний запит на поповнення</b>\n\n👤 @${ctx.from.username || ctx.from.first_name}\n💰 Сума: <b>$${amount.toFixed(2)}</b>\n\n🔑 Hash транзакції:\n<code>${hash}</code>\n\n🔍 Перевірте на <a href="https://tronscan.org/#/transaction/${hash}">TronScan</a>`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  { text: "✅ Підтвердити", callback_data: `topup_approve:${newReq.id}` },
                  { text: "❌ Відхилити", callback_data: `topup_reject:${newReq.id}` },
                ]],
              },
            },
          );
        } catch {}
      }

      await ctx.reply(hashT.txHashAccepted, { parse_mode: "HTML" });
      return;
    }

    // Admin manual topup amount
    if (step === "admin_topup_amount") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply(tr("uk").adminInvalidAmount);
        return;
      }
      const clientId = ctx.session.clientIdForTopup;
      if (!clientId) return;

      await db
        .update(usersTable)
        .set({ balance: sql`${usersTable.balance} + ${amount}` })
        .where(eq(usersTable.id, clientId));

      const [client] = await db.select().from(usersTable).where(eq(usersTable.id, clientId)).limit(1);
      const newBalance = parseFloat(client?.balance || "0").toFixed(2);

      ctx.session.step = undefined;
      ctx.session.clientIdForTopup = undefined;

      await db.insert(transactionsTable).values({
        userId: clientId,
        type: "topup",
        amount: String(amount),
        comment: "Поповнення адміністратором",
      });

      await ctx.reply(`✅ Баланс @${client?.username || client?.firstName} поповнено на $${amount}. Новий баланс: $${newBalance}`);

      try {
        await bot.telegram.sendMessage(
          client!.telegramId,
          `✅ Ваш баланс поповнено адміністратором на <b>$${amount}</b>!\n\nПоточний баланс: <b>$${newBalance}</b>`,
          { parse_mode: "HTML" },
        );
      } catch {}
      return;
    }

    // Recruiter withdrawal: amount step
    if (step === "withdrawal_amount") {
      const user = await getUser(ctx.from!.id);
      if (!user?.isRecruiter) return;
      const t = tr(user.lang);
      const balance = parseFloat(user.balance || "0");
      const fee = WITHDRAWAL_FEE;
      const available = +(balance - fee).toFixed(2);
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 10 || amount > available) {
        await ctx.reply(t.withdrawalMin("10") + ` (макс $${available.toFixed(2)})`);
        return;
      }
      ctx.session.withdrawalAmount = amount;
      ctx.session.step = "withdrawal_wallet";
      await ctx.reply(
        `💵 ${t.balance}: <b>$${amount.toFixed(2)}</b>\n🔸 Комісія мережі: <b>$${fee.toFixed(2)}</b>\n💰 Списано з балансу: <b>$${(amount + fee).toFixed(2)}</b>\n\n${t.withdrawalEnterAddress}`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Recruiter withdrawal: wallet step
    if (step === "withdrawal_wallet") {
      const user = await getUser(ctx.from!.id);
      if (!user?.isRecruiter) return;
      const t = tr(user.lang);
      const wallet = text.trim();
      const trc20Regex = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
      if (!trc20Regex.test(wallet)) {
        await ctx.reply(
          `❌ <b>Невірний формат гаманця</b>\n\nАдреса USDT TRC20 повинна:\n• Починатись з літери <b>T</b>\n• Містити рівно <b>34 символи</b>\n\nПриклад: <code>TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE</code>\n\n${t.withdrawalEnterAddress}`,
          { parse_mode: "HTML" },
        );
        return;
      }
      const amount = ctx.session.withdrawalAmount;
      if (!amount) { ctx.session.step = undefined; return; }
      const fee = WITHDRAWAL_FEE;
      const total = +(amount + fee).toFixed(2);
      const balance = parseFloat(user.balance || "0");
      if (total > balance) {
        await ctx.reply(t.withdrawalInsufficient(balance.toFixed(2)));
        ctx.session.step = undefined;
        ctx.session.withdrawalAmount = undefined;
        return;
      }
      await db.update(usersTable)
        .set({ balance: sql`${usersTable.balance} - ${total}` })
        .where(eq(usersTable.id, user.id));
      const [withdrawal] = await db.insert(withdrawalRequestsTable).values({
        recruiterId: user.id,
        amount: amount.toFixed(2),
        fee: fee.toFixed(2),
        walletAddress: wallet,
        status: "pending",
      }).returning();
      await db.insert(transactionsTable).values({
        userId: user.id,
        type: "withdrawal",
        amount: (-total).toFixed(2),
        comment: `Вивід $${amount.toFixed(2)} + комісія $${fee.toFixed(2)} → ${wallet}`,
      });
      ctx.session.step = undefined;
      ctx.session.withdrawalAmount = undefined;
      await ctx.reply(t.withdrawalSent, { parse_mode: "HTML" });
      for (const adminId of ADMIN_IDS) {
        try {
          await bot.telegram.sendMessage(
            adminId,
            `💸 <b>Запит на вивід коштів</b>\n\n👔 Рекрутер: @${user.username || user.firstName} (ID: ${user.id})\n💵 Сума: <b>$${amount.toFixed(2)} USDT</b>\n🔸 Комісія: <b>$${fee.toFixed(2)}</b>\n\n📍 Гаманець TRC20:\n<code>${wallet}</code>`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  { text: "✅ Підтвердити виплату", callback_data: `wd_confirm:${withdrawal.id}` },
                  { text: "❌ Відхилити", callback_data: `wd_reject:${withdrawal.id}` },
                ]],
              },
            },
          );
        } catch {}
      }
      await showUserMenu(ctx);
      return;
    }

    // Admin withdrawal: tx hash step
    if (step === "withdrawal_hash") {
      const user = await getUser(ctx.from!.id);
      if (!user?.isAdmin) return;
      const wdId = ctx.session.withdrawalId;
      if (!wdId) { ctx.session.step = undefined; return; }
      const txHash = text.trim();
      const [wd] = await db.select().from(withdrawalRequestsTable).where(eq(withdrawalRequestsTable.id, wdId)).limit(1);
      if (!wd) { ctx.session.step = undefined; return; }
      await db.update(withdrawalRequestsTable)
        .set({ status: "completed", txHash })
        .where(eq(withdrawalRequestsTable.id, wdId));
      ctx.session.step = undefined;
      ctx.session.withdrawalId = undefined;
      await ctx.reply(`✅ Вивід #${wdId} підтверджено. Хеш: <code>${txHash}</code>`, { parse_mode: "HTML" });
      const [rec] = await db.select().from(usersTable).where(eq(usersTable.id, wd.recruiterId)).limit(1);
      if (rec?.telegramId) {
        try {
          await bot.telegram.sendMessage(
            rec.telegramId,
            `✅ <b>Вивід коштів успішний!</b>\n\n💵 Сума: <b>$${parseFloat(wd.amount).toFixed(2)} USDT</b>\n\nПеревірте ваш гаманець та хеш транзакції:\n<code>${txHash}</code>\n\n🔗 <a href="https://tronscan.org/#/transaction/${txHash}">Переглянути на TronScan</a>`,
            { parse_mode: "HTML" },
          );
        } catch {}
      }
      return;
    }

    // Refund description
    if (step === "refund_description") {
      ctx.session.leadData = { description: text };
      ctx.session.step = "refund_screenshot";
      const refUser = await getUser(ctx.from!.id);
      const refT = tr(refUser?.lang);
      await ctx.reply(refT.sendRefundScreenshot);
      return;
    }

    // Recruiter: typed custom experience ("Other")
    if (step === "recruiter_experience_other") {
      const user = await getUser(ctx.from!.id);
      if (!user?.isRecruiter) return;
      ctx.session.recruiterLeadExperience = text.trim();
      ctx.session.step = "recruiter_upload_parse";
      await showRecruiterTemplate(ctx, text.trim());
      return;
    }

    // Admin: set price when approving recruiter lead
    if (step === "admin_set_price") {
      const adminUser = await getUser(ctx.from!.id);
      if (!adminUser?.isAdmin) return;
      const tUk = tr("uk");
      const leadId = ctx.session.adminApprovingLeadId;
      if (!leadId) return;
      const priceRaw = text.replace(/[^0-9.,]/g, "").replace(",", ".");
      const price = parseFloat(priceRaw);
      if (isNaN(price) || price <= 0) {
        await ctx.reply(tUk.invalidPrice, { parse_mode: "HTML" });
        return;
      }
      const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
      if (!lead) { ctx.session.step = undefined; return; }
      const [approvedLead] = await db.update(leadsTable)
        .set({ status: "active", price: price.toFixed(2) })
        .where(eq(leadsTable.id, leadId))
        .returning();
      ctx.session.step = undefined;
      ctx.session.adminApprovingLeadId = undefined;
      await ctx.reply(
        tUk.leadPublished(lead.fullName, price.toFixed(2)),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: tUk.btnViewLead, callback_data: `view_lead:${leadId}` },
            ]],
          },
        },
      );
      if (approvedLead) await notifySubscribers(approvedLead);
      if (lead.submittedBy) {
        const [rec] = await db.select().from(usersTable).where(eq(usersTable.id, lead.submittedBy)).limit(1);
        if (rec?.telegramId) {
          try {
            const recT = tr(rec.lang);
            await bot.telegram.sendMessage(
              rec.telegramId,
              recT.leadPublishedNotify(lead.fullName, price.toFixed(2)),
              { parse_mode: "HTML" },
            );
          } catch {}
        }
      }
      return;
    }

    // Admin: typed custom experience ("Other")
    if (step === "admin_experience_other") {
      const adminUser = await getUser(ctx.from!.id);
      if (!adminUser?.isAdmin) return;
      ctx.session.adminLeadExperience = text.trim();
      ctx.session.step = "admin_upload_parse";
      await showAdminLeadTemplate(ctx, text.trim());
      return;
    }

    // Admin: parse filled template
    if (step === "admin_upload_parse") {
      const adminUser = await getUser(ctx.from!.id);
      if (!adminUser?.isAdmin) return;
      const tUk = tr("uk");
      const parsed = parseLeadText(text);
      if (!parsed.fullName) {
        await ctx.reply(tUk.parseError, { parse_mode: "HTML" });
        return;
      }
      const duplicate = await findDuplicateLead(parsed.phone, parsed.telegramContact, parsed.whatsapp);
      if (duplicate) {
        await ctx.reply(tUk.duplicateLeadAdmin(duplicate.fullName), { parse_mode: "HTML" });
        ctx.session.step = undefined;
        ctx.session.adminLeadType = undefined;
        ctx.session.adminLeadLanguage = undefined;
        ctx.session.adminLeadExperience = undefined;
        ctx.session.adminLeadParsed = undefined;
        await showAdminMenu(ctx);
        return;
      }
      // Store parsed data in session, ask for price
      ctx.session.adminLeadParsed = {
        fullName: parsed.fullName,
        workExperience: parsed.workExperience || "",
        age: parsed.age || "",
        nationality: parsed.nationality || "",
        currentLocation: parsed.currentLocation || "",
        monthlyResult: parsed.monthlyResult || "",
        desiredSalary: parsed.desiredSalary || "",
        startAvailability: parsed.startAvailability || "",
        willingToRelocate: parsed.willingToRelocate || "",
        additionalInfo: parsed.additionalInfo || "",
        phone: parsed.phone || "",
        telegramContact: parsed.telegramContact || "",
        whatsapp: parsed.whatsapp || "",
      };
      ctx.session.step = "admin_upload_price";
      await ctx.reply(tUk.adminSetPriceNew(parsed.fullName), { parse_mode: "HTML" });
      return;
    }

    // Admin: set price for new lead
    if (step === "admin_upload_price") {
      const adminUser = await getUser(ctx.from!.id);
      if (!adminUser?.isAdmin) return;
      const priceRaw = text.replace(/[^0-9.,]/g, "").replace(",", ".");
      const price = parseFloat(priceRaw);
      const tUk2 = tr("uk");
      if (isNaN(price) || price <= 0) {
        await ctx.reply(tUk2.invalidPrice, { parse_mode: "HTML" });
        return;
      }
      const p = ctx.session.adminLeadParsed || {};
      const position = ctx.session.adminLeadExperience || "";
      const workLanguage = ctx.session.adminLeadLanguage || "";
      const type: "hot" | "cold" = ctx.session.adminLeadType ?? "hot";
      const [adminNewLead] = await db.insert(leadsTable).values({
        fullName: p.fullName || "",
        workLanguage,
        position,
        age: p.age || "",
        nationality: p.nationality || "",
        currentLocation: p.currentLocation || "",
        workExperience: p.workExperience || "",
        monthlyResult: p.monthlyResult || "",
        desiredSalary: p.desiredSalary || "",
        startAvailability: p.startAvailability || "",
        willingToRelocate: p.willingToRelocate || "",
        additionalInfo: p.additionalInfo || "",
        phone: p.phone || "",
        telegramContact: p.telegramContact || "",
        whatsapp: p.whatsapp || "",
        price: price.toFixed(2),
        type,
        status: "active",
      }).returning();
      ctx.session.step = undefined;
      ctx.session.adminLeadType = undefined;
      ctx.session.adminLeadLanguage = undefined;
      ctx.session.adminLeadExperience = undefined;
      ctx.session.adminLeadParsed = undefined;
      await ctx.reply(
        tUk2.leadPublished(p.fullName || "", price.toFixed(2)),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: tUk2.btnViewLead, callback_data: `view_lead:${adminNewLead?.id}` },
            ]],
          },
        },
      );
      if (adminNewLead) await notifySubscribers(adminNewLead);
      return;
    }

    // Recruiter: submit lead for review
    if (step === "recruiter_upload_parse") {
      const recruiter = await getUser(ctx.from!.id);
      if (!recruiter?.isRecruiter) return;
      const t = tr(recruiter.lang);
      const parsed = parseLeadText(text);
      if (!parsed.fullName) {
        await ctx.reply(t.parseError, { parse_mode: "HTML" });
        return;
      }
      const duplicate = await findDuplicateLead(parsed.phone, parsed.telegramContact, parsed.whatsapp);
      if (duplicate) {
        await ctx.reply(t.duplicateLead(duplicate.fullName), { parse_mode: "HTML" });
        ctx.session.step = undefined;
        await showUserMenu(ctx);
        return;
      }
      const typeRaw = (parsed.type || "hot").toLowerCase().trim();
      const type: "hot" | "cold" = ctx.session.recruiterLeadType
        ?? (typeRaw === "cold" ? "cold" : "hot");
      const workLanguage = ctx.session.recruiterLeadLanguage || parsed.workLanguage || "";
      const position = ctx.session.recruiterLeadExperience || "";
      const workExperience = parsed.workExperience || "";
      ctx.session.recruiterLeadType = undefined;
      ctx.session.recruiterLeadLanguage = undefined;
      ctx.session.recruiterLeadExperience = undefined;
      const [newLead] = await db.insert(leadsTable).values({
        fullName: parsed.fullName,
        workLanguage,
        position,
        age: parsed.age || "",
        nationality: parsed.nationality || "",
        currentLocation: parsed.currentLocation || "",
        workExperience,
        monthlyResult: parsed.monthlyResult || "",
        desiredSalary: parsed.desiredSalary || "",
        startAvailability: parsed.startAvailability || "",
        willingToRelocate: parsed.willingToRelocate || "",
        additionalInfo: parsed.additionalInfo || "",
        phone: parsed.phone || "",
        telegramContact: parsed.telegramContact || "",
        whatsapp: parsed.whatsapp || "",
        price: "0",
        type,
        status: "pending_review",
        submittedBy: recruiter.id,
      }).returning();
      ctx.session.step = undefined;
      await ctx.reply(t.leadSubmitted(parsed.fullName), { parse_mode: "HTML" });
      for (const adminId of ADMIN_IDS) {
        try {
          await bot.telegram.sendMessage(
            adminId,
            `📋 <b>Новий запит на публікацію ліда</b>\n\n👔 Рекрутер: @${recruiter.username || recruiter.firstName}\n👤 Лід: ${parsed.fullName}`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  { text: "📋 Переглянути запити", callback_data: "admin_lead_requests" },
                ]],
              },
            },
          );
        } catch {}
      }
      await showUserMenu(ctx);
      return;
    }

    // Upload lead - single message parse
    if (step === "upload_parse") {
      const parsed = parseLeadText(text);
      if (!parsed.fullName) {
        await ctx.reply(
          "❌ Не вдалося розпізнати дані. Переконайтесь, що заповнили поле <b>Full name</b> і надіслали в правильному форматі.\n\nСпробуйте ще раз:",
          { parse_mode: "HTML" },
        );
        return;
      }
      const typeRaw = (parsed.type || "hot").toLowerCase().trim();
      const type: "hot" | "cold" = typeRaw === "cold" ? "cold" : "hot";

      const duplicate = await findDuplicateLead(parsed.phone, parsed.telegramContact, parsed.whatsapp);
      if (duplicate) {
        await ctx.reply(
          tr("uk").duplicateLeadAdmin(duplicate.fullName),
          { parse_mode: "HTML" },
        );
        ctx.session.step = undefined;
        ctx.session.leadData = {};
        await showAdminMenu(ctx);
        return;
      }

      const [adminNewLead] = await db.insert(leadsTable).values({
        fullName: parsed.fullName,
        workLanguage: parsed.workLanguage || "",
        position: parsed.position || "",
        age: parsed.age || "",
        nationality: parsed.nationality || "",
        currentLocation: parsed.currentLocation || "",
        workExperience: parsed.workExperience || "",
        monthlyResult: parsed.monthlyResult || "",
        desiredSalary: parsed.desiredSalary || "",
        startAvailability: parsed.startAvailability || "",
        willingToRelocate: parsed.willingToRelocate || "",
        additionalInfo: parsed.additionalInfo || "",
        phone: parsed.phone || "",
        telegramContact: parsed.telegramContact || "",
        whatsapp: parsed.whatsapp || "",
        price: parsed.price || "0",
        type,
      }).returning();

      ctx.session.step = undefined;
      ctx.session.leadData = {};
      await ctx.reply(tr("uk").leadPublished(parsed.fullName, adminNewLead?.price || "0"), { parse_mode: "HTML" });
      if (adminNewLead) await notifySubscribers(adminNewLead);
      await showAdminMenu(ctx);
      return;
    }

  });

  // ─── RECRUITER HANDLERS ──────────────────────────────────────────────────────

  async function showAdminLeadTemplate(ctx: BotContext, exp: string) {
    const tUk = tr("uk");
    const typeLabel = ctx.session.adminLeadType === "hot" ? tUk.btnHot : tUk.btnCold;
    const lang = ctx.session.adminLeadLanguage || "—";
    await ctx.reply(
      tUk.templateInstruction(typeLabel, lang, exp),
      { parse_mode: "HTML" },
    );
    await ctx.reply(
      `<code>${tUk.templateCode}</code>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: tUk.btnCancel, callback_data: "al_cancel" },
          ]],
        },
      },
    );
  }

  async function showRecruiterTemplate(ctx: BotContext, exp: string) {
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    const typeLabel = ctx.session.recruiterLeadType === "hot" ? t.btnHot : t.btnCold;
    const lang = ctx.session.recruiterLeadLanguage || "—";
    await ctx.reply(
      t.templateInstruction(typeLabel, lang, exp),
      { parse_mode: "HTML" },
    );
    await ctx.reply(
      `<code>${t.templateCode}</code>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: t.btnCancel, callback_data: "rl_cancel" },
          ]],
        },
      },
    );
  }

  bot.hears((text) => isAddLeadBtn(text), async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const t = tr(user.lang);
    ctx.session.recruiterLeadType = undefined;
    ctx.session.recruiterLeadLanguage = undefined;
    ctx.session.recruiterLeadExperience = undefined;
    ctx.session.step = undefined;
    await ctx.reply(
      t.chooseLeadType,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: t.btnHot, callback_data: "rl_type:hot" },
              { text: t.btnCold, callback_data: "rl_type:cold" },
            ],
          ],
        },
      },
    );
  });

  bot.action(/^rl_type:(hot|cold)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const t = tr(user.lang);
    ctx.session.recruiterLeadType = ctx.match[1] as "hot" | "cold";
    const typeLabel = ctx.match[1] === "hot" ? t.btnHot : t.btnCold;
    await ctx.editMessageText(
      `${typeLabel}\n\n${t.chooseLanguage2}`,
      {
        reply_markup: {
          inline_keyboard: [
            ...(() => {
              const rows = [];
              for (let i = 0; i < LANGUAGES.length; i += 2) {
                const row = [LANGUAGES[i], LANGUAGES[i + 1]].filter(Boolean).map((l, offset) => ({
                  text: l.label,
                  callback_data: `rl_lang:${i + offset}`,
                }));
                rows.push(row);
              }
              return rows;
            })(),
          ],
        },
      },
    );
  });

  bot.action(/^rl_lang:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const t = tr(user.lang);
    const idx = parseInt(ctx.match[1]);
    const lang = LANGUAGES[idx];
    if (!lang) return;
    ctx.session.recruiterLeadLanguage = lang.label;
    const typeLabel = ctx.session.recruiterLeadType === "hot" ? t.btnHot : t.btnCold;
    await ctx.editMessageText(
      `${typeLabel} · ${lang.label}\n\n${t.chooseExperience}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: EXPERIENCE_OPTIONS[0], callback_data: "rl_exp:0" },
              { text: EXPERIENCE_OPTIONS[1], callback_data: "rl_exp:1" },
            ],
            [
              { text: EXPERIENCE_OPTIONS[2], callback_data: "rl_exp:2" },
              { text: EXPERIENCE_OPTIONS[3], callback_data: "rl_exp:3" },
            ],
            [{ text: EXPERIENCE_OPTIONS[4], callback_data: "rl_exp:4" }],
          ],
        },
      },
    );
  });

  bot.action(/^rl_exp:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const expIdx = parseInt(ctx.match[1]);
    const exp = EXPERIENCE_OPTIONS[expIdx];
    if (!exp) return;

    // "Other" — ask recruiter to type custom experience
    if (exp === "Other") {
      const t = tr(user.lang);
      const typeLabel = ctx.session.recruiterLeadType === "hot" ? t.btnHot : t.btnCold;
      const lang = ctx.session.recruiterLeadLanguage || "—";
      ctx.session.step = "recruiter_experience_other";
      await ctx.editMessageText(
        `${typeLabel} · ${lang} · Other\n\n${t.enterCustomExperience}`,
        { reply_markup: { inline_keyboard: [] } },
      );
      return;
    }

    ctx.session.recruiterLeadExperience = exp;
    ctx.session.step = "recruiter_upload_parse";
    await showRecruiterTemplate(ctx, exp);
  });

  bot.action("rl_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    const t = tr(user?.lang);
    ctx.session.step = undefined;
    ctx.session.recruiterLeadType = undefined;
    ctx.session.recruiterLeadLanguage = undefined;
    ctx.session.recruiterLeadExperience = undefined;
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(t.leadCancelled);
    await showUserMenu(ctx);
  });

  bot.hears((text) => isMyLeadsBtn(text), async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const t = tr(user.lang);

    const myLeads = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.submittedBy, user.id))
      .orderBy(desc(leadsTable.createdAt));

    if (myLeads.length === 0) {
      await ctx.reply(t.myLeadsNone);
      return;
    }

    ctx.session.myLeadIds = myLeads.map((l) => l.id);
    ctx.session.myLeadIndex = 0;
    await showMyLeadPage(ctx, 0, false);
  });

  bot.action("ml:prev", async (ctx) => {
    await ctx.answerCbQuery();
    await showMyLeadPage(ctx, (ctx.session.myLeadIndex ?? 0) - 1, true);
  });

  bot.action("ml:next", async (ctx) => {
    await ctx.answerCbQuery();
    await showMyLeadPage(ctx, (ctx.session.myLeadIndex ?? 0) + 1, true);
  });

  bot.action("ml:cancel", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.myLeadIds = undefined;
    ctx.session.myLeadIndex = undefined;
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  });

  bot.action(/^ml_edit:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const leadId = parseInt(ctx.match[1]);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.submittedBy, user.id)))
      .limit(1);
    const t = tr(user.lang);
    if (!lead) { await ctx.reply(t.adminLeadNotFound); return; }

    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < LEAD_EDIT_FIELDS.length - 1; i += 2) {
      rows.push([
        { text: LEAD_EDIT_FIELDS[i].label, callback_data: `ml_ef:${leadId}:${LEAD_EDIT_FIELDS[i].code}` },
        { text: LEAD_EDIT_FIELDS[i + 1].label, callback_data: `ml_ef:${leadId}:${LEAD_EDIT_FIELDS[i + 1].code}` },
      ]);
    }
    const last = LEAD_EDIT_FIELDS[LEAD_EDIT_FIELDS.length - 1];
    rows.push([{ text: last.label, callback_data: `ml_ef:${leadId}:${last.code}` }]);
    rows.push([{ text: t.btnCancel, callback_data: "noop" }]);

    await ctx.reply(t.adminChooseEditField, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  });

  bot.action(/^ml_ef:(\d+):(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const leadId = parseInt(ctx.match[1]);
    const code = ctx.match[2];

    if (code === "tp") {
      const [lead] = await db
        .select()
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.submittedBy, user.id)))
        .limit(1);
      if (!lead) return;
      const newType = lead.type === "hot" ? "cold" : "hot";
      await db.update(leadsTable).set({ type: newType }).where(eq(leadsTable.id, leadId));
      const tRecType = tr(user.lang);
      await ctx.reply(tRecType.adminTypeChanged(newType === "hot" ? tRecType.labelHot : tRecType.labelCold));
      await showMyLeadPage(ctx, ctx.session.myLeadIndex ?? 0, false);
      return;
    }

    ctx.session.step = "recruiter_edit_lead_field";
    ctx.session.editLeadId = leadId;
    ctx.session.editLeadField = code;
    const tRecEdit = tr(user.lang);
    await ctx.reply(tRecEdit.adminEnterFieldValue(LEAD_FIELD_NAMES[code] || code), { parse_mode: "HTML" });
  });

  bot.action(/^ml_delete:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const leadId = parseInt(ctx.match[1]);
    const userDel = await getUser(ctx.from!.id);
    const tDel = tr(userDel?.lang);
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [
        [{ text: tDel.confirmDeleteLead, callback_data: `ml_del_ok:${leadId}` }],
        [{ text: tDel.btnBack, callback_data: `ml_del_no:${leadId}` }],
      ],
    }).catch(() => {});
  });

  bot.action(/^ml_del_ok:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const leadId = parseInt(ctx.match[1]);
    const user = await getUser(ctx.from!.id);
    if (!user) return;
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.submittedBy, user.id)))
      .limit(1);
    const t = tr(user.lang);
    if (!lead) { await ctx.editMessageText(t.adminLeadNotFound).catch(() => {}); return; }
    await db.delete(leadsTable).where(eq(leadsTable.id, leadId));
    const newIds = (ctx.session.myLeadIds ?? []).filter((id) => id !== leadId);
    ctx.session.myLeadIds = newIds;
    await ctx.editMessageText(t.leadDeleted).catch(() => {});
    if (newIds.length > 0) {
      await showMyLeadPage(ctx, Math.min(ctx.session.myLeadIndex ?? 0, newIds.length - 1), false);
    }
  });

  bot.action(/^ml_del_no:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showMyLeadPage(ctx, ctx.session.myLeadIndex ?? 0, true);
  });

  // ─── RECRUITER: WITHDRAW BALANCE ─────────────────────────────────────────────
  async function handleWithdrawStart(ctx: BotContext) {
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const t = tr(user.lang);

    const balance = parseFloat(user.balance || "0");
    const fee = WITHDRAWAL_FEE;
    const available = +(balance - fee).toFixed(2);

    if (available < 10) {
      await ctx.reply(
        t.withdrawalMin("10") + `\n\n💰 ${t.balance}: <b>$${balance.toFixed(2)}</b>\n🔸 Комісія мережі TRC20: в середньому <b>$4-5</b>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    ctx.session.step = "withdrawal_amount";
    await ctx.reply(
      t.withdrawal(balance.toFixed(2), fee.toFixed(2)) + `\n💵 Доступно для виводу: <b>$${available.toFixed(2)}</b>\n\nВведіть суму від <b>$10</b> до <b>$${available.toFixed(2)}</b> USDT:`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: t.btnCancel, callback_data: "withdrawal_cancel" }]] },
      },
    );
  }

  bot.hears((text) => isWithdrawBtn(text), (ctx) => handleWithdrawStart(ctx));
  bot.action("withdraw_start", async (ctx) => { await ctx.answerCbQuery(); await handleWithdrawStart(ctx); });

  bot.action("withdrawal_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = undefined;
    ctx.session.withdrawalAmount = undefined;
    const userWd = await getUser(ctx.from!.id);
    await ctx.editMessageText(tr(userWd?.lang).withdrawalCancelled);
  });

  // ─── RECRUITER: MY TRANSACTIONS ──────────────────────────────────────────────
  async function handleRecruiterTxs(ctx: BotContext) {
    const user = await getUser(ctx.from!.id);
    if (!user?.isRecruiter) return;
    const t = tr(user.lang);

    const txs = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.userId, user.id))
      .orderBy(desc(transactionsTable.createdAt))
      .limit(50);

    if (txs.length === 0) {
      await ctx.reply(t.noTransactions);
      return;
    }

    const typeLabel: Record<string, string> = {
      recruiter_earning: t.txRecruiterEarningLabel,
      recruiter_refund: t.txRecruiterRefundLabel,
      recruiter_vested: t.txRecruiterVestedLabel,
      withdrawal: t.txWithdrawalLabel,
      withdrawal_rejected: t.txWithdrawalRejectedLabel,
      lead_purchase: t.txLeadPurchaseFullLabel,
      topup: t.txTopupLabel,
      refund: t.txRefundLabel,
    };

    const lines = txs.map((tx) => {
      const amount = parseFloat(tx.amount);
      const sign = amount >= 0 ? "+" : "";
      return `${typeLabel[tx.type] || tx.type} <b>${sign}$${amount.toFixed(2)}</b> · ${fmtDate(tx.createdAt)}\n📝 ${tx.comment || "—"}`;
    });

    await ctx.reply(
      `${t.transactionsHeader(txs.length)}\n\n` + lines.join("\n\n"),
      { parse_mode: "HTML" },
    );
  }

  bot.hears((text) => isMyTransactionsBtn(text), (ctx) => handleRecruiterTxs(ctx));
  bot.action("recruiter_txs", async (ctx) => { await ctx.answerCbQuery(); await handleRecruiterTxs(ctx); });

  // ─── ADMIN: WITHDRAWAL REQUEST ACTIONS ───────────────────────────────────────
  bot.action(/wd_confirm:(\d+)/, async (ctx) => {
    const wdId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const tUk = tr("uk");
    const [wd] = await db.select().from(withdrawalRequestsTable).where(eq(withdrawalRequestsTable.id, wdId)).limit(1);
    if (!wd || wd.status !== "pending") {
      await ctx.reply(tUk.adminWdNotFound);
      return;
    }
    ctx.session.step = "withdrawal_hash";
    ctx.session.withdrawalId = wdId;
    await ctx.reply(
      tUk.adminWdConfirmPrompt(wdId, parseFloat(wd.amount).toFixed(2), wd.walletAddress),
      { parse_mode: "HTML" },
    );
  });

  bot.action(/wd_reject:(\d+)/, async (ctx) => {
    const wdId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    const tUk = tr("uk");
    const [wd] = await db.select().from(withdrawalRequestsTable).where(eq(withdrawalRequestsTable.id, wdId)).limit(1);
    if (!wd || wd.status !== "pending") {
      await ctx.reply(tUk.adminWdNotFound);
      return;
    }
    await db.update(withdrawalRequestsTable).set({ status: "rejected" }).where(eq(withdrawalRequestsTable.id, wdId));
    const total = +(parseFloat(wd.amount) + parseFloat(wd.fee || "1")).toFixed(2);
    await db.update(usersTable)
      .set({ balance: sql`${usersTable.balance} + ${total}` })
      .where(eq(usersTable.id, wd.recruiterId));
    await db.insert(transactionsTable).values({
      userId: wd.recruiterId,
      type: "withdrawal_rejected",
      amount: total.toFixed(2),
      comment: `Відхилений вивід — повернено $${total.toFixed(2)}`,
    });
    await ctx.editMessageText(tUk.adminWdRejectedMsg(wdId)).catch(() => {});
    const [rec] = await db.select().from(usersTable).where(eq(usersTable.id, wd.recruiterId)).limit(1);
    if (rec?.telegramId) {
      try {
        const recT = tr(rec.lang);
        await bot.telegram.sendMessage(
          rec.telegramId,
          recT.withdrawalRejectedNotify(parseFloat(wd.amount).toFixed(2)),
          { parse_mode: "HTML" },
        );
      } catch {}
    }
  });

  // ─── PHOTO HANDLER ───────────────────────────────────────────────────────────
  bot.on(message("photo"), async (ctx) => {
    const step = ctx.session.step;

    if (step === "refund_screenshot") {
      const user = await getUser(ctx.from!.id);
      if (!user) return;
      const t = tr(user.lang);

      const leadId = ctx.session.refundLeadId;
      if (!leadId) return;

      const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      const description = ctx.session.leadData?.description || "";

      const [newRefund] = await db.insert(refundRequestsTable).values({
        userId: user.id,
        leadId,
        description,
        screenshotFileId: fileId,
        status: "pending",
      }).returning();

      const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);

      // Notify admins
      for (const adminId of ADMIN_IDS) {
        try {
          await bot.telegram.sendMessage(
            adminId,
            `🔄 <b>Новий запит на повернення</b>\n\n👤 @${ctx.from.username || ctx.from.first_name}\n🎯 Лід: ${lead?.fullName}\n💰 Сума: $${lead?.price}\n📝 Причина: ${description}`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  { text: "✅ Повернути кошти", callback_data: `refund_approve:${newRefund.id}` },
                  { text: "❌ Відхилити", callback_data: `refund_reject:${newRefund.id}` },
                ]],
              },
            },
          );
          await bot.telegram.sendPhoto(adminId, fileId, { caption: "📸 Скріншот від клієнта" });
        } catch {}
      }

      ctx.session.step = undefined;
      ctx.session.refundLeadId = undefined;
      ctx.session.leadData = {};

      await ctx.reply(t.refundSubmitted);
      return;
    }

    // Bulk upload via photo — not supported
  });

  // ─── DOCUMENT HANDLER (CSV/Excel bulk upload) ────────────────────────────────
  bot.on(message("document"), async (ctx) => {
    const step = ctx.session.step;
    const user = await getUser(ctx.from!.id);

    if (step !== "upload_file" || !user?.isAdmin) return;

    const doc = ctx.message.document;
    const fileName = doc.file_name || "";
    const isExcel = fileName.endsWith(".xlsx") || fileName.endsWith(".xls");
    const isCsv = fileName.endsWith(".csv");

    if (!isExcel && !isCsv) {
      await ctx.reply(tr("uk").adminBulkInvalidFile);
      return;
    }

    await ctx.reply(tr("uk").adminBulkProcessing);

    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await fetch(fileLink.href);
      const buffer = await response.arrayBuffer();

      // For CSV: decode as UTF-8 string first to preserve Cyrillic characters.
      // For Excel: read raw bytes (encoding is embedded in the file format).
      let workbook: XLSX.WorkBook;
      if (isCsv) {
        const text = new TextDecoder("utf-8").decode(buffer);
        workbook = XLSX.read(text, { type: "string", cellDates: true });
      } else {
        workbook = XLSX.read(buffer, { type: "array", cellDates: true });
      }
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: false, dateNF: "dd.mm.yyyy" });

      let imported = 0;
      let duplicates = 0;
      let errors = 0;

      // Convert any value to a clean string (handles Date objects and numeric serials)
      function cellToStr(val: unknown): string {
        if (val === null || val === undefined) return "";
        if (val instanceof Date) {
          const d = val as Date;
          return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
        }
        return String(val).trim();
      }

      // Parse price: strip currency symbols, spaces; handle comma decimal separator
      function parsePrice(val: unknown): string {
        // Strip everything except digits, dot, comma, minus
        const s = cellToStr(val).replace(/[^\d.,-]/g, "").replace(",", ".");
        const n = parseFloat(s);
        return isNaN(n) ? "0" : String(n);
      }

      for (const row of rows) {
        try {
          // Helper: pick first non-empty value from candidate keys (case-insensitive)
          const g = (...keys: string[]) => {
            for (const k of keys) {
              const found = Object.entries(row).find(([rk]) => rk.trim().toLowerCase() === k.toLowerCase());
              if (found && cellToStr(found[1])) return cellToStr(found[1]);
            }
            return "";
          };

          const phone = g("phone");
          const telegramContact = g("telegram");
          const whatsapp = g("whatsapp");

          const duplicate = await findDuplicateLead(phone, telegramContact, whatsapp);
          if (duplicate) {
            duplicates++;
            continue;
          }

          const rawType = g("type").toLowerCase();
          const type: "hot" | "cold" = rawType === "cold" ? "cold" : "hot";

          const [bulkLead] = await db.insert(leadsTable).values({
            fullName: g("full name", "full_name") || "(без імені)",
            workLanguage: g("work language", "work_language"),
            position: g("position"),
            age: g("age"),
            nationality: g("nationality"),
            currentLocation: g("current location", "current_location"),
            workExperience: g("work experience", "work_experience"),
            monthlyResult: g("average monthly results", "monthly result", "monthly_result"),
            desiredSalary: g("desired salary", "desired_salary"),
            startAvailability: g("availability to start", "start availability", "start_availability"),
            willingToRelocate: g("willingness to relocate", "willing to relocate", "willing_to_relocate"),
            additionalInfo: g("notes", "additional info", "additional_info"),
            phone,
            telegramContact,
            whatsapp,
            price: parsePrice(Object.entries(row).find(([rk]) => ["lead price","price"].includes(rk.trim().toLowerCase()))?.[1]) || "0",
            type,
          }).returning();
          if (bulkLead) await notifySubscribers(bulkLead);
          imported++;
        } catch {
          errors++;
        }
      }

      ctx.session.step = undefined;
      const dupLine = duplicates > 0 ? `\n⚠️ Дублікатів пропущено: ${duplicates}` : "";
      await ctx.reply(
        `✅ Імпорт завершено!\n\n📊 Успішно: ${imported}${dupLine}\n❌ Помилок: ${errors}`,
      );
      await showAdminMenu(ctx);
    } catch (err) {
      logger.error({ err }, "Bulk upload error");
      await ctx.reply(tr("uk").adminBulkParseError);
    }
  });

  return bot;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function getUser(telegramId: number) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);
  return user || null;
}

function parseLeadText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const fieldMap: Array<[RegExp, string]> = [
    // English
    [/^full name\s*:/i, "fullName"],
    [/^work language\s*:/i, "workLanguage"],
    [/^position\s*:/i, "position"],
    [/^age\s*:/i, "age"],
    [/^nationality\s*:/i, "nationality"],
    [/^current location\s*:/i, "currentLocation"],
    [/^work experience\s*:/i, "workExperience"],
    [/^average monthly result\s*:/i, "monthlyResult"],
    [/^desired salary(?: wage)?\s*:/i, "desiredSalary"],
    [/^availability to start(?: work)?\s*:/i, "startAvailability"],
    [/^willingn?ess to relocate\s*:/i, "willingToRelocate"],
    [/^additional info(rmation)?\s*:/i, "additionalInfo"],
    [/^phone\s*:/i, "phone"],
    [/^telegram\s*:/i, "telegramContact"],
    [/^whatsapp\s*:/i, "whatsapp"],
    [/^lead price\s*:/i, "price"],
    [/^type\s*:/i, "type"],
    // Ukrainian
    [/^повне\s*ім'?я\s*:/i, "fullName"],
    [/^вік\s*:/i, "age"],
    [/^громадянство\s*:/i, "nationality"],
    [/^поточна\s*лока[цч]і[яї]\s*:/i, "currentLocation"],
    [/^сер\.\s*результат\s*:/i, "monthlyResult"],
    [/^бажана\s*зарплата\s*:/i, "desiredSalary"],
    [/^досвід\s*роботи\s*:/i, "workExperience"],
    [/^готовий\s*почати\s*:/i, "startAvailability"],
    [/^готовий\s*переїхати\s*:/i, "willingToRelocate"],
    [/^додатково\s*:/i, "additionalInfo"],
    [/^телефон\s*:/i, "phone"],
    [/^посада\s*:/i, "position"],
    // Russian
    [/^полное\s*имя\s*:/i, "fullName"],
    [/^возраст\s*:/i, "age"],
    [/^гражданство\s*:/i, "nationality"],
    [/^текущая\s*лока[цч]ия\s*:/i, "currentLocation"],
    [/^ср\.\s*результат\s*:/i, "monthlyResult"],
    [/^желаемая\s*зарплата\s*:/i, "desiredSalary"],
    [/^опыт\s*работы\s*:/i, "workExperience"],
    [/^готов\s*начать\s*:/i, "startAvailability"],
    [/^готов\s*к\s*релокации\s*:/i, "willingToRelocate"],
    [/^дополнительно\s*:/i, "additionalInfo"],
    [/^должность\s*:/i, "position"],
  ];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const [pattern, field] of fieldMap) {
      if (pattern.test(trimmed)) {
        const value = trimmed.replace(pattern, "").replace(/^\s*/, "").replace(/\$$/, "").trim();
        if (value && value !== "—" && value !== "-") result[field] = value;
        break;
      }
    }
  }
  return result;
}

async function findDuplicateLead(phone?: string, telegramContact?: string, whatsapp?: string) {
  const conditions = [];
  if (phone && phone.trim()) conditions.push(eq(leadsTable.phone, phone.trim()));
  if (telegramContact && telegramContact.trim()) conditions.push(eq(leadsTable.telegramContact, telegramContact.trim()));
  if (whatsapp && whatsapp.trim()) conditions.push(eq(leadsTable.whatsapp, whatsapp.trim()));
  if (conditions.length === 0) return null;
  const [existing] = await db
    .select()
    .from(leadsTable)
    .where(or(...conditions))
    .limit(1);
  return existing || null;
}

function fmtDate(d: any): string {
  if (!d) return "—";
  const dt = new Date(d);
  return (
    `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}.${dt.getFullYear()} ` +
    `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`
  );
}

function formatLeadPreview(lead: any, lang?: string | null): string {
  const lbl = tr(lang);
  const typeLabel = lead.type === "hot" ? lbl.labelHot : lbl.labelCold;
  return (
    `👤 <b>${lead.fullName}</b>\n\n` +
    `${lbl.labelLang}: ${lead.workLanguage || "—"}\n` +
    `${lbl.labelPosition}: ${lead.position || "—"}\n` +
    `${lbl.labelAge}: ${lead.age || "—"}\n` +
    `${lbl.labelNationality}: ${lead.nationality || "—"}\n` +
    `${lbl.labelLocation}: ${lead.currentLocation || "—"}\n` +
    `${lbl.labelExperience}: ${lead.workExperience || "—"}\n` +
    `${lbl.labelMonthlyResult}: ${lead.monthlyResult || "—"}\n` +
    `${lbl.labelSalary}: ${lead.desiredSalary || "—"}\n` +
    `${lbl.labelStartDate}: ${lead.startAvailability || "—"}\n` +
    `${lbl.labelRelocate}: ${lead.willingToRelocate || "—"}\n` +
    `${lbl.labelAdditional}: ${lead.additionalInfo || "—"}\n` +
    `${lbl.labelAdded}: ${fmtDate(lead.createdAt)}\n\n` +
    `${lbl.labelPrice}: <b>$${lead.price}</b> | ${typeLabel}`
  );
}

function formatLeadFull(lead: any, lang?: string | null): string {
  const lbl = tr(lang);
  const typeLabel = lead.type === "hot" ? lbl.labelHot : lbl.labelCold;
  return (
    `👤 <b>${lead.fullName}</b>\n\n` +
    `${lbl.labelLang}: ${lead.workLanguage || "—"}\n` +
    `${lbl.labelPosition}: ${lead.position || "—"}\n` +
    `${lbl.labelAge}: ${lead.age || "—"}\n` +
    `${lbl.labelNationality}: ${lead.nationality || "—"}\n` +
    `${lbl.labelLocation}: ${lead.currentLocation || "—"}\n` +
    `${lbl.labelExperience}: ${lead.workExperience || "—"}\n` +
    `${lbl.labelMonthlyResult}: ${lead.monthlyResult || "—"}\n` +
    `${lbl.labelSalary}: ${lead.desiredSalary || "—"}\n` +
    `${lbl.labelStartDate}: ${lead.startAvailability || "—"}\n` +
    `${lbl.labelRelocate}: ${lead.willingToRelocate || "—"}\n` +
    `${lbl.labelAdditional}: ${lead.additionalInfo || "—"}\n` +
    `${lbl.labelAdded}: ${fmtDate(lead.createdAt)}\n\n` +
    `${lbl.labelPhone}: ${lead.phone || "—"}\n` +
    `${lbl.labelTelegram}: ${lead.telegramContact ? "@" + lead.telegramContact.replace(/^@/, "") : "—"}\n` +
    `${lbl.labelWhatsApp}: ${lead.whatsapp || "—"}\n\n` +
    `${lbl.labelPrice}: <b>$${lead.price}</b> | ${typeLabel}`
  );
}
