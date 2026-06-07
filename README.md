# Leads Bot

Telegram marketplace bot for selling leads.

## Deploy on VPS

### Перший запуск
```bash
git clone https://github.com/melissabrauer/leads-bot /root/leads-bot
cd /root/leads-bot
cp ecosystem.config.js.example ecosystem.config.js
nano ecosystem.config.js   # вставте TELEGRAM_BOT_TOKEN і CRYPTO_PAY_API_TOKEN
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Оновлення бота
```bash
cd /root/leads-bot
git pull
pm2 restart leads-bot
```

## Stack
- Node.js + Telegraf v4
- PostgreSQL (sessions + leads)
- Express 5
- CryptoPay
