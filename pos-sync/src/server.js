require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── Main match endpoint ─────────────────────────────────────────
app.post('/api/match', async (req, res) => {
  const { choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems } = req.body;

  if (!choiceDishes || !posDishes) {
    return res.status(400).json({ error: 'Missing required data' });
  }

  const prompt = buildPrompt(choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content.map(c => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      // retry once with explicit re-prompt
      const retry = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
          { role: 'user', content: 'Поверни ТІЛЬКИ валідний JSON, без тексту, без markdown.' }
        ]
      });
      const retryText = retry.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
      parsed = JSON.parse(retryText);
    }

    res.json(parsed);
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
