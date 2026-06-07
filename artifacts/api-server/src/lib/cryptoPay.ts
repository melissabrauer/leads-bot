const CRYPTO_PAY_API = "https://pay.crypt.bot/api";
const TOKEN = process.env.CRYPTO_PAY_API_TOKEN || "";

async function callApi<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${CRYPTO_PAY_API}/${method}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Crypto-Pay-API-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; result: T; error?: { code: number; name: string } };
  if (!json.ok) throw new Error(`CryptoPay error: ${json.error?.name ?? "unknown"}`);
  return json.result;
}

export interface CryptoInvoice {
  invoice_id: number;
  status: string;
  pay_url: string;
  amount: string;
  payload?: string;
}

export async function createInvoice(amountUsd: number, payload: string): Promise<CryptoInvoice> {
  return callApi<CryptoInvoice>("createInvoice", {
    currency_type: "fiat",
    fiat: "USD",
    amount: amountUsd.toFixed(2),
    payload,
    allow_comments: false,
    allow_anonymous: true,
    expires_in: 3600,
  });
}

export async function setWebhook(url: string): Promise<boolean> {
  return callApi<boolean>("setWebhook", { url });
}

export function verifyWebhookToken(headerToken: string | undefined): boolean {
  return !!TOKEN && headerToken === TOKEN;
}
