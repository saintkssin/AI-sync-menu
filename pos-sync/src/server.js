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
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── OAuth callback від Choice ───────────────────────────────────
app.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Missing code');
  }

  try {
    const r = await fetch('https://open-api.choiceqr.com/auth/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        clientId: CHOICE_CLIENT_ID,
        secret: CHOICE_CLIENT_SECRET
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(400).send('Token exchange failed: ' + err);
    }

    const data = await r.json();
    const { token, varSymbol, domain } = data;

    // Редиректимо на головну з токеном — користувач побачить його в інтерфейсі
    res.redirect(`/?token=${encodeURIComponent(token)}&domain=${encodeURIComponent(domain)}`);

  } catch (err) {
    console.error('Callback error:', err.message);
    res.status(500).send('Server error: ' + err.message);
  }
});

// ─── Main match endpoint ─────────────────────────────────────────
app.post('/api/match', async (req, res) => {
  const { choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems } = req.body;

  if (!choiceDishes || !posDishes) {
    return res.status(400).json({ error: 'Missing required data' });
  }

  const prompt = buildPrompt(choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems);

  try {
    const parsed = await callGemini(prompt);
    res.json(parsed);
  } catch (err) {
    console.error('Gemini API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Gemini call ─────────────────────────────────────────────────
async function callGemini(prompt, isRetry = false) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    }
  };

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    if (isRetry) throw new Error('Gemini returned invalid JSON after retry');
    return callGemini(prompt + '\n\nВАЖЛИВО: поверни ТІЛЬКИ валідний JSON, без тексту, без markdown, без пояснень.', true);
  }

  return parsed;
}

// ─── Prompt builder ──────────────────────────────────────────────
function buildPrompt(choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems) {
  return `Ти — асистент для матчингу меню між двома системами. Зіставляй позиції за ДВОМА критеріями:

1. ЦІНА: має збігатися точно (±0). Якщо ціна не збігається — не матч.
2. НАЗВА: нечітке співпадіння (скорочення, транслітерація, перестановка слів, схожість, NEW/нова і т.д.).

РІВНІ ВПЕВНЕНОСТІ:
- "high": ціна збігається + назва дуже схожа або ідентична
- "medium": ціна збігається + назва схожа але є суттєві відмінності

ВАЖЛИВО:
- Включай тільки знайдені матчі, нематчі не включай
- Для страв і опцій: ціни в однакових одиницях (гривні)
- Назви можуть мати різний регістр, зайві пробіли, позначки NEW, скорочення

СТРАВИ CHOICE (id, name, price грн, categoryName):
${JSON.stringify(choiceDishes.slice(0, 500))}

СТРАВИ POS (posId, name, price грн):
${JSON.stringify(posDishes.slice(0, 500))}

КАТЕГОРІЇ CHOICE (id, name):
${JSON.stringify(choiceCategories)}

КАТЕГОРІЇ POS (posId, name):
${JSON.stringify(posCategories)}

ОПЦІЇ CHOICE (groupId, itemId, name, price грн):
${JSON.stringify((choiceOptionItems || []).slice(0, 300))}

МОДИФІКАТОРИ POS (posId, name, price грн):
${JSON.stringify((posModifierItems || []).slice(0, 300))}

Поверни ТІЛЬКИ JSON без жодного тексту і без markdown:
{
  "dishes": [
    {"choiceId":"...","posId":"...","choiceName":"...","posName":"...","price":0,"confidence":"high|medium"}
  ],
  "categories": [
    {"choiceId":"...","posId":"...","choiceName":"...","posName":"...","confidence":"high|medium"}
  ],
  "optionItems": [
    {"choiceGroupId":"...","choiceItemId":"...","posItemId":"...","choiceName":"...","posName":"...","price":0,"confidence":"high|medium"}
  ]
}`;
}

// ─── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ POS-Sync server running on http://localhost:${PORT}`);
});
