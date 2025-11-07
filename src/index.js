import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import FormData from 'form-data';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';

const {
  TELEGRAM_TOKEN,
  QBT_HOST,
  QBT_USERNAME,
  QBT_PASSWORD,
  QBT_CATEGORY,
  QBT_SAVE_PATH,
  QBT_TAGS,
  QBT_PAUSED,
  ALLOWED_USER_IDS
} = process.env;

if (!TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN is required');
if (!QBT_HOST || !QBT_USERNAME || !QBT_PASSWORD) {
  throw new Error('QBT_HOST, QBT_USERNAME, QBT_PASSWORD are required');
}

const allowedIds = (ALLOWED_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const jar = new CookieJar();
const http = wrapper(axios.create({
  baseURL: QBT_HOST.replace(/\/+$/, ''),
  jar,
  withCredentials: true,
  timeout: 20000,
}));

async function qbtLogin() {
  const params = new URLSearchParams();
  params.append('username', QBT_USERNAME);
  params.append('password', QBT_PASSWORD);
  await http.post('/api/v2/auth/login', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
}

async function ensureLoggedIn(fn) {
  try {
    return await fn();
  } catch (e) {
    await qbtLogin();
    return await fn();
  }
}

async function getTorrents(hashes) {
  const query = hashes ? `?hashes=${hashes}` : '';
  return ensureLoggedIn(() =>
    http.get(`/api/v2/torrents/info${query}`).then(r => r.data)
  );
}

function boolParam(val) {
  if (val === undefined || val === null || val === '') return undefined;
  const s = String(val).toLowerCase();
  return s === '1' || s === 'true' ? 'true' : 'false';
}

async function addMagnet({ magnet, category, savepath, tags, paused }) {
  const params = new URLSearchParams();
  params.append('urls', magnet);
  if (category) params.append('category', category);
  if (savepath) params.append('savepath', savepath);
  if (tags) params.append('tags', tags);
  if (paused !== undefined) params.append('paused', paused);

  return ensureLoggedIn(() =>
    http.post('/api/v2/torrents/add', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
  );
}

async function addTorrentFile({ buffer, filename, category, savepath, tags, paused }) {
  const form = new FormData();
  form.append('torrents', buffer, { filename: filename || 'upload.torrent' });
  if (category) form.append('category', category);
  if (savepath) form.append('savepath', savepath);
  if (tags) form.append('tags', tags);
  if (paused !== undefined) form.append('paused', paused);

  return ensureLoggedIn(() =>
    http.post('/api/v2/torrents/add', form, { headers: form.getHeaders() })
  );
}

function isMagnet(text) {
  return /^magnet:\?xt=urn:btih:[a-z0-9]{32,}.*$/i.test(text.trim());
}

function isHttpTorrentUrl(text) {
  return /^https?:\/\/.+\.torrent(\?.*)?$/i.test(text.trim());
}

function parseOptionsFromText(text) {
  const opts = {};
  const regex = /\b(category|savepath|tags|paused)=([^\s]+)/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2];
    opts[key] = val;
  }
  return opts;
}

function checkAccess(msg) {
  if (!allowedIds.length) return true;
  const uid = String(msg.from?.id || '');
  if (!allowedIds.includes(uid)) {
    bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён.');
    return false;
  }
  return true;
}

// === Telegram bot ===
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', err => {
  console.error('Polling error:', err?.response?.body || err.message);
});

bot.setMyCommands([
  { command: 'start', description: 'Показать помощь' },
  { command: 'help', description: 'Как пользоваться' },
  { command: 'status', description: 'Проверить соединение с qBittorrent' },
  { command: 'list', description: 'Список всех торрентов' }
]);

bot.onText(/^\/start|^\/help/, msg => {
  if (!checkAccess(msg)) return;
  bot.sendMessage(msg.chat.id, 
`Отправь:
• magnet-ссылку
• .torrent-файл
• URL на .torrent

Команды:
- /status — проверить соединение
- /list — список всех торрентов
`);
});

bot.onText(/^\/status/, async msg => {
  if (!checkAccess(msg)) return;
  try {
    await qbtLogin();
    const r = await http.get('/api/v2/app/version');
    bot.sendMessage(msg.chat.id, `✅ qBittorrent OK. Версия: ${r.data}`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Нет соединения: ${e.message}`);
  }
});

bot.onText(/^\/list/, async msg => {
  if (!checkAccess(msg)) return;
  try {
    const torrents = await getTorrents();
    if (!torrents.length) return bot.sendMessage(msg.chat.id, '📭 Нет торрентов.');
    let text = torrents.map(t => {
      const percent = (t.progress * 100).toFixed(1);
      return `📄 ${t.name} — ${percent}% (${t.state})`;
    }).join('\n');
    bot.sendMessage(msg.chat.id, text);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`);
  }
});

// === Обновляемое сообщение с прогрессом ===
async function trackProgress(chatId, messageId, hash, name) {
  let lastText = '';
  let lastStatus = '';

  const timer = setInterval(async () => {
    try {
      const [t] = await getTorrents(hash);
      if (!t) {
        clearInterval(timer);
        return;
      }

      const percent = (t.progress * 100).toFixed(1);
      const status = t.state;

      // Определяем кнопки
      const controlButtons = (status === 'stoppedDL')
        ? [{ text: '▶️ Продолжить', callback_data: `resume:${hash}` }]
        : [{ text: '⏸ Пауза', callback_data: `pause:${hash}` }];

      const deleteButtons = [
        { text: '🗑 Удалить', callback_data: `delete:${hash}` },
        { text: '🗑 Удалить с файлами', callback_data: `deletef:${hash}` }
      ];

      if (t.progress >= 1) {
        await bot.editMessageText(
          `✅ Загрузка завершена\n📄 *${name}*`,
          { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
        );
        clearInterval(timer);
        return;
      }

      const text = `⬇️ *${name}*\nПрогресс: ${percent}%\nСтатус: ${status}`;
      const reply_markup = { inline_keyboard: [controlButtons, deleteButtons] };

      // Обновляем только если текст или статус изменились
      if (text !== lastText || status !== lastStatus) {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup
        });
        lastText = text;
        lastStatus = status;
      }
    } catch (e) {
      console.error('Ошибка прогресса:', e.message);
      clearInterval(timer);
    }
  }, 5000);
}


// === Callback-кнопки управления ===
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const [cmd, hash] = query.data.split(':');
  try {
    if (cmd === 'pause') {
      await ensureLoggedIn(() =>
        http.post(
          '/api/v2/torrents/stop',
          new URLSearchParams({ hashes: hash }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        )
      );
      bot.answerCallbackQuery(query.id, { text: 'Поставлено на паузу' });
    }
    if (cmd === 'resume') {
      await ensureLoggedIn(() =>
        http.post(
          '/api/v2/torrents/start',
          new URLSearchParams({ hashes: hash }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        )
      );
      bot.answerCallbackQuery(query.id, { text: 'Продолжено' });
    }
    if (cmd === 'delete') {
      await ensureLoggedIn(() =>
        http.post('/api/v2/torrents/delete', `hashes=${hash}&deleteFiles=false`, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        })
      );
      bot.answerCallbackQuery(query.id, { text: 'Удалено' });
      bot.editMessageText('❌ Торрент удалён', { chat_id: chatId, message_id: query.message.message_id });
    }
    if (cmd === 'deletef') {
      await ensureLoggedIn(() =>
        http.post('/api/v2/torrents/delete', `hashes=${hash}&deleteFiles=true`, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        })
      );
      bot.answerCallbackQuery(query.id, { text: 'Удалено с файлами' });
      bot.editMessageText('❌🗑 Торрент удалён с файлами', { chat_id: chatId, message_id: query.message.message_id });
    }
  } catch (e) {
    bot.answerCallbackQuery(query.id, { text: 'Ошибка: ' + e.message, show_alert: true });
  }
});

// === Приём сообщений с magnet и URL ===
bot.on('message', async msg => {
  if (!checkAccess(msg)) return;
  if (msg.document) return; // .torrent обрабатывается ниже
  if (!msg.text) return;
  const text = msg.text.trim();
  const opts = parseOptionsFromText(text);

  try {
    if (isMagnet(text) || isHttpTorrentUrl(text)) {
      await addMagnet({
        magnet: text,
        category: opts.category ?? QBT_CATEGORY,
        savepath: opts.savepath ?? QBT_SAVE_PATH,
        tags: opts.tags ?? QBT_TAGS,
        paused: boolParam(opts.paused ?? QBT_PAUSED)
      });
      const all = await getTorrents();
      const last = all.sort((a, b) => b.added_on - a.added_on)[0];
      if (last) {
        const sent = await bot.sendMessage(
          msg.chat.id,
          `⬇️ ${last.name}\nПрогресс: 0%`,
          { parse_mode: 'Markdown' }
        );
        trackProgress(msg.chat.id, sent.message_id, last.hash, last.name);
      }
    }
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`);
  }
});

// === Приём .torrent файлов ===
bot.on('document', async msg => {
  if (!checkAccess(msg)) return;
  const file = msg.document;
  if (!/\.torrent$/i.test(file.file_name)) {
    return bot.sendMessage(msg.chat.id, 'Отправьте .torrent-файл или magnet-ссылку.');
  }
  try {
    const link = await bot.getFileLink(file.file_id);
    const res = await axios.get(link, { responseType: 'arraybuffer' });
    const opts = parseOptionsFromText(msg.caption || '');
    await addTorrentFile({
      buffer: Buffer.from(res.data),
      filename: file.file_name,
      category: opts.category ?? QBT_CATEGORY,
      savepath: opts.savepath ?? QBT_SAVE_PATH,
      tags: opts.tags ?? QBT_TAGS,
      paused: boolParam(opts.paused ?? QBT_PAUSED)
    });
    const all = await getTorrents();
    const last = all.sort((a, b) => b.added_on - a.added_on)[0];
    if (last) {
      const sent = await bot.sendMessage(
        msg.chat.id,
        `⬇️ ${last.name}\nПрогресс: 0%`,
        { parse_mode: 'Markdown' }
      );
      trackProgress(msg.chat.id, sent.message_id, last.hash, last.name);
    }
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Ошибка: ${e.message}`);
  }
});

console.log('🤖 Telegram-bot запущен');
