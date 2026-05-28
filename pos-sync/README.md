# POS → Choice Sync

Інструмент для автоматичного зіставлення меню з POS-системи (Syrve/Poster) з меню в Choice QR.

## Локальний запуск

```bash
# 1. Встанови залежності
npm install

# 2. Скопіюй .env.example → .env і встав API ключ
cp .env.example .env

# 3. Запуск
npm start
# або в dev режимі з auto-reload:
npm run dev

# 4. Відкрий http://localhost:3000
```

## Деплой на Railway

1. Зареєструйся на https://railway.app
2. "New Project" → "Deploy from GitHub repo"
3. У налаштуваннях проекту додай змінну середовища:
   - `ANTHROPIC_API_KEY` = твій ключ
4. Railway автоматично визначить Node.js і запустить `npm start`

## Деплой на Render

1. Зареєструйся на https://render.com
2. "New" → "Web Service" → підключи GitHub repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Додай Environment Variable: `ANTHROPIC_API_KEY`

## Деплой на VPS (Ubuntu)

```bash
# Клонуй репо
git clone <repo> pos-sync && cd pos-sync

# Встанови Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

npm install

# Створи .env
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
echo "PORT=3000" >> .env

# Запуск через pm2
npm install -g pm2
pm2 start src/server.js --name pos-sync
pm2 save && pm2 startup
```

## Структура проекту

```
pos-sync/
├── src/
│   └── server.js      # Express сервер + Claude API проксі
├── public/
│   └── index.html     # Фронтенд додатку
├── .env.example
├── package.json
└── README.md
```
