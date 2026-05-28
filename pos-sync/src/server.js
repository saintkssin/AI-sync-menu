require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHOICE_CLIENT_ID = process.env.CHOICE_CLIENT_ID;
const CHOICE_CLIENT_SECRET = process.env.CHOICE_CLIENT_SECRET;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── OAuth callback від Choice ───────────────────────────────────
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const r = await fetch('https://open-api.choiceqr.com/auth/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, clientId: CHOICE_CLIENT_ID, secret: CHOICE_CLIENT_SECRET })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(400).send('Token exchange failed: ' + err);
    }

    const data = await r.json();
    const { token, domain } = data;
    res.redirect(`/?token=${encodeURIComponent(token)}&domain=${encodeURIComponent(domain)}`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// ─── Choice API proxy ─────────────────────────────────────────────
// Фронтенд викликає /api/choice/* з токеном в хедері
// Бекенд проксює запит до open-api.choiceqr.com без CORS проблем
app.all('/api/choice/*', async (req, res) => {
  const token = req.headers['x-choice-token'];
  if (!token) return res.status(401).json({ error: 'Missing x-choice-token header' });

  // Вирізаємо /api/choice/ і отримуємо решту шляху
  const choicePath = req.path.replace('/api/choice', '');
  const url = `https://open-api.choiceqr.com${choicePath}${req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query) : ''}`;

  console.log(`[PROXY] ${req.method} ${url} token=${token.substring(0,8)}...`);
  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const r = await fetch(url, fetchOpts);
    const contentType = r.headers.get('content-type') || '';

    console.log(`[PROXY] Response: ${r.status}`);
    if (r.status === 204) return res.status(204).send();

    if (contentType.includes('application/json')) {
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    const text = await r.text();
    return res.status(r.status).send(text);
  } catch (err) {
    console.error('Choice proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Gemini match endpoint ────────────────────────────────────────
app.post('/api/match', async (req, res) => {
  const { choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems } = req.body;
  if (!choiceDishes || !posDishes) return res.status(400).json({ error: 'Missing required data' });

  const prompt = buildPrompt(choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems);

  try {
    const parsed = await callGemini(prompt);
    res.json(parsed);
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Gemini call ──────────────────────────────────────────────────
async function callGemini(prompt, isRetry = false) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
  };

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    if (isRetry) throw new Error('Gemini returned invalid JSON after retry');
    return callGemini(prompt + '\n\nВАЖЛИВО: поверни ТІЛЬКИ валідний JSON.', true);
  }
}

// ─── Prompt builder ───────────────────────────────────────────────
function buildPrompt(choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems) {
  return `Ти — асистент для матчингу меню між двома системами. Зіставляй позиції за ДВОМА критеріями:

1. ЦІНА: має збігатися точно (±0). Якщо ціна не збігається — не матч.
2. НАЗВА: нечітке співпадіння (скорочення, транслітерація, перестановка слів, схожість, NEW/нова і т.д.).

РІВНІ ВПЕВНЕНОСТІ:
- "high": ціна збігається + назва дуже схожа або ідентична
- "medium": ціна збігається + назва схожа але є суттєві відмінності

ВАЖЛИВО: включай тільки знайдені матчі. Ціни в гривнях.

СТРАВИ CHOICE: ${JSON.stringify(choiceDishes.slice(0, 500))}
СТРАВИ POS: ${JSON.stringify(posDishes.slice(0, 500))}
КАТЕГОРІЇ CHOICE: ${JSON.stringify(choiceCategories)}
КАТЕГОРІЇ POS: ${JSON.stringify(posCategories)}
ОПЦІЇ CHOICE: ${JSON.stringify((choiceOptionItems || []).slice(0, 300))}
МОДИФІКАТОРИ POS: ${JSON.stringify((posModifierItems || []).slice(0, 300))}

Поверни ТІЛЬКИ JSON:
{
  "dishes": [{"choiceId":"...","posId":"...","choiceName":"...","posName":"...","price":0,"confidence":"high|medium"}],
  "categories": [{"choiceId":"...","posId":"...","choiceName":"...","posName":"...","confidence":"high|medium"}],
  "optionItems": [{"choiceGroupId":"...","choiceItemId":"...","posItemId":"...","choiceName":"...","posName":"...","price":0,"confidence":"high|medium"}]
}`;
}

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ POS-Sync server on http://localhost:${PORT}`));
