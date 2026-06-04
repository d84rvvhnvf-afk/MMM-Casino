const express = require('express');
const https = require('https');
const redis = require('redis');
const app = express();

app.use(express.json());

/* ── CORS ── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN || '8834152165:AAHTAiBfEa9KO6NFUDPwSmtgSDKgHxb9ivA';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://mmm-casino.vercel.app';

/* ── Redis подключение (Railway автоматически даёт REDIS_URL) ── */
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL
});

redisClient.on('error', err => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('✅ Redis connected'));
redisClient.connect();

/* ── Пакеты пополнения ── */
const PACKAGES = {
  '50':  { real: 50,  bonus: 0,  label: '50 Stars' },
  '100': { real: 100, bonus: 5,  label: '100 Stars + 5 бонус' },
  '250': { real: 250, bonus: 25, label: '250 Stars + 25 бонус' },
  '500': { real: 500, bonus: 75, label: '500 Stars + 75 бонус' },
};

/* ── Telegram API ── */
function tgApi(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── Работа с балансом пользователя ── */
async function getUser(userId) {
  try {
    const data = await redisClient.get(`user:${userId}`);
    if (data) return JSON.parse(data);
    return { stars: 10, totalDeposited: 0, isTestBal: true, fateStage: 0, fateWave: 1 };
  } catch(e) {
    console.error('getUser error:', e);
    return { stars: 10, totalDeposited: 0, isTestBal: true, fateStage: 0, fateWave: 1 };
  }
}

async function saveUser(userId, userData) {
  try {
    await redisClient.set(`user:${userId}`, JSON.stringify(userData));
  } catch(e) {
    console.error('saveUser error:', e);
  }
}

/* ════════════════════════════════════════
   API ENDPOINTS
════════════════════════════════════════ */

/* Health check */
app.get('/', (req, res) => res.json({ status: 'MMM Casino Server OK ✅' }));

/* Получить данные пользователя при входе в казино */
app.get('/user/:userId', async (req, res) => {
  const uid = String(req.params.userId);
  const user = await getUser(uid);
  res.json(user);
});

/* Сохранить состояние игрока (вызывается при выходе/паузе) */
app.post('/save', async (req, res) => {
  try {
    const { userId, stars, totalDeposited, isTestBal, fateStage, fateWave,
            fateSpinsInStage, totalWonFromReal } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const user = await getUser(String(userId));
    const updated = {
      ...user,
      stars: stars !== undefined ? stars : user.stars,
      totalDeposited: totalDeposited !== undefined ? totalDeposited : user.totalDeposited,
      isTestBal: isTestBal !== undefined ? isTestBal : user.isTestBal,
      fateStage: fateStage !== undefined ? fateStage : user.fateStage,
      fateWave: fateWave !== undefined ? fateWave : user.fateWave,
      fateSpinsInStage: fateSpinsInStage !== undefined ? fateSpinsInStage : user.fateSpinsInStage,
      totalWonFromReal: totalWonFromReal !== undefined ? totalWonFromReal : user.totalWonFromReal,
      updatedAt: Date.now()
    };
    await saveUser(String(userId), updated);
    res.json({ ok: true });
  } catch(e) {
    console.error('save error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* Создать инвойс Stars */
app.post('/create-invoice', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId || !amount) return res.status(400).json({ error: 'userId and amount required' });

    const pkg = PACKAGES[String(amount)];
    if (!pkg) return res.status(400).json({ error: 'Invalid package' });

    const result = await tgApi('createInvoiceLink', {
      title: `MMM Casino — ${pkg.label}`,
      description: pkg.bonus > 0
        ? `Пополнение ${pkg.real}★ + ${pkg.bonus}★ бонус`
        : `Пополнение ${pkg.real} Telegram Stars`,
      payload: JSON.stringify({ userId: String(userId), real: pkg.real, bonus: pkg.bonus }),
      currency: 'XTR',
      prices: [{ label: pkg.label, amount: pkg.real }],
    });

    if (!result.ok) {
      console.error('Telegram error:', result);
      return res.status(500).json({ error: result.description });
    }

    res.json({ url: result.result });
  } catch(e) {
    console.error('create-invoice error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ════════════════════════════════════════
   TELEGRAM WEBHOOK
════════════════════════════════════════ */
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update) return;

  try {
    /* /start */
    if (update.message?.text === '/start') {
      const chatId = update.message.chat.id;
      const userId = String(chatId);
      const user = await getUser(userId);

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `🎰 *MMM Casino* — добро пожаловать!\n\n💰 Твой баланс: *${user.stars}★*\n\nНажми кнопку ниже чтобы открыть казино!`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{
            text: '🎰 Открыть казино',
            web_app: { url: WEBAPP_URL }
          }]]
        }
      });
    }

    /* Подтверждение перед оплатой */
    if (update.pre_checkout_query) {
      await tgApi('answerPreCheckoutQuery', {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true
      });
    }

    /* Успешная оплата */
    if (update.message?.successful_payment) {
      const payment = update.message.successful_payment;
      const chatId = update.message.chat.id;
      const userId = String(chatId);

      let payload;
      try { payload = JSON.parse(payment.invoice_payload); }
      catch(e) { payload = { userId, real: payment.total_amount, bonus: 0 }; }

      const realAmt = payload.real || payment.total_amount;
      const bonusAmt = payload.bonus || 0;

      /* Начисляем и сохраняем в Redis */
      const user = await getUser(userId);
      user.stars = (user.stars || 0) + realAmt + bonusAmt;
      user.totalDeposited = (user.totalDeposited || 0) + realAmt;
      user.isTestBal = false;
      user.lastDeposit = Date.now();
      await saveUser(userId, user);

      console.log(`✅ Payment: user=${userId} +${realAmt}★ bonus=${bonusAmt}★ total=${user.stars}★`);

      const msg = bonusAmt > 0
        ? `✅ *Пополнено!*\n+${realAmt}★ и +${bonusAmt}★ бонус\n💰 Баланс: *${user.stars}★*\n\nУдачи! 🎰`
        : `✅ *Пополнено!*\n+${realAmt}★\n💰 Баланс: *${user.stars}★*\n\nУдачи! 🎰`;

      await tgApi('sendMessage', {
        chat_id: chatId,
        text: msg,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{
            text: '🎰 Играть',
            web_app: { url: WEBAPP_URL }
          }]]
        }
      });
    }
  } catch(e) {
    console.error('Webhook error:', e);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MMM Casino Server on port ${PORT}`));
