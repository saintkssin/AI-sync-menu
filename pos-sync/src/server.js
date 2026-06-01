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

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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
app.all('/api/choice/*', async (req, res) => {
  const token = req.headers['x-choice-token'];
  if (!token) return res.status(401).json({ error: 'Missing x-choice-token header' });
  const choicePath = req.path.replace('/api/choice', '');
  const url = `https://open-api.choiceqr.com${choicePath}${req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query) : ''}`;
  try {
    const fetchOpts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    };
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      fetchOpts.body = JSON.stringify(req.body);
    }
    const r = await fetch(url, fetchOpts);
    if (r.status === 204) return res.status(204).send();
    const contentType = r.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await r.json();
      return res.status(r.status).json(data);
    }
    const text = await r.text();
    return res.status(r.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Match endpoint (ПАКЕТНА ОБРОБКА) ───────────────────────────────
app.post('/api/match', async (req, res) => {
  const { choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems } = req.body;
  if (!choiceDishes || !posDishes) return res.status(400).json({ error: 'Missing required data' });

  try {
    // 1. Локальний матч
    const { localMatched, localUnmatched } = localExactMatch(choiceDishes, posDishes);
    const { localMatched: localCatMatched, localUnmatched: localCatUnmatched } = localExactMatch(choiceCategories, posCategories, true);
    const { localMatched: localModMatched, localUnmatched: localModUnmatched } = localModMatch(choiceOptionItems, posModifierItems);

    console.log(`[MATCH] Local exact done. Dishes left for AI: ${localUnmatched.length}`);

    let aiDishes = [];
    let aiCategories = [];
    let aiOptionItems = [];

    // 2. Пакетна обробка страв для AI (ріжемо по 25 штук)
    const BATCH_SIZE = 25;
    
    if (localUnmatched.length > 0) {
      for (let i = 0; i < localUnmatched.length; i += BATCH_SIZE) {
        const batch = localUnmatched.slice(i, i + BATCH_SIZE);
        console.log(`[AI PART] Processing dishes batch ${i / BATCH_SIZE + 1}...`);
        const prompt = buildPromptChunk('dishes', batch, posDishes);
        const resChunk = await callGemini(prompt);
        if (resChunk && Array.isArray(resChunk.dishes)) {
          aiDishes.push(...resChunk.dishes);
        }
      }
    }

    // 3. Пакетна обробка категорій
    if (localCatUnmatched.length > 0) {
      const prompt = buildPromptChunk('categories', localCatUnmatched, posCategories);
      const resChunk = await callGemini(prompt);
      if (resChunk && Array.isArray(resChunk.categories)) {
        aiCategories.push(...resChunk.categories);
      }
    }

    // 4. Пакетна обробка опцій
    if (localModUnmatched.unmatched.length > 0) {
      for (let i = 0; i < localModUnmatched.unmatched.length; i += BATCH_SIZE) {
        const batch = localModUnmatched.unmatched.slice(i, i + BATCH_SIZE);
        const prompt = buildPromptChunk('options', batch, posModifierItems);
        const resChunk = await callGemini(prompt);
        if (resChunk && Array.isArray(resChunk.optionItems)) {
          aiOptionItems.push(...resChunk.optionItems);
        }
      }
    }

    // Збираємо все докупи
    const finalDishes = [
      ...localMatched.map(m => ({ ...m, confidence: 'high' })),
      ...aiDishes
    ];
    const finalCategories = [
      ...localCatMatched.map(m => ({ ...m, confidence: 'high' })),
      ...aiCategories
    ];
    const finalOptionItems = [
      ...localModMatched.map(m => ({ ...m, confidence: 'high' })),
      ...aiOptionItems
    ];

    const dedup = (arr, key = 'choiceId') => {
      const seen = new Set();
      return arr.filter(x => {
        const k = x[key] || x.choiceItemId;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    res.json({
      dishes: dedup(finalDishes),
      categories: dedup(finalCategories),
      optionItems: dedup(finalOptionItems, 'choiceItemId')
    });

  } catch (err) {
    console.error('Match error:', err.message);
    res.json({ dishes: [], categories: [], optionItems: [] });
  }
});

// ─── Локальні функції ──────────────────────────────────────────────────
function normalize(str) {
  return String(str || '').toLowerCase().trim().replace(/[-_"'«»]/g, ' ').replace(/\s+/g, ' ').trim();
}

function localExactMatch(choiceItems, posItems, isCat = false) {
  if (!choiceItems || !posItems) return { localMatched: [], localUnmatched: choiceItems || [] };
  const localMatched = []; const localUnmatched = []; const usedPosIds = new Set();
  for (const ci of choiceItems) {
    const cName = normalize(ci.name); const cPrice = ci.price; let bestMatch = null;
    for (const pi of posItems) {
      if (usedPosIds.has(pi.posId)) continue;
      const pName = normalize(pi.name); const nameMatch = cName === pName;
      if (isCat) { if (nameMatch) { bestMatch = pi; break; } } 
      else {
        const priceMatch = Math.abs((pi.price || 0) - (cPrice || 0)) <= 1;
        if (nameMatch && priceMatch) { bestMatch = pi; break; }
        if (nameMatch && !bestMatch) bestMatch = { ...pi, _nameonlymatch: true };
      }
    }
    if (bestMatch && !bestMatch._nameonlymatch) {
      usedPosIds.add(bestMatch.posId);
      localMatched.push({ choiceId: ci.id || ci._id, posId: bestMatch.posId, choiceName: ci.name, posName: bestMatch.name, price: cPrice });
    } else {
      localUnmatched.push({ ...ci, _nameHint: bestMatch ? bestMatch.posId : null });
    }
  }
  return { localMatched, localUnmatched };
}

function localModMatch(choiceOptItems, posModItems) {
  if (!choiceOptItems || !posModItems) return { localMatched: [], localUnmatched: { unmatched: choiceOptItems || [] } };
  const localMatched = []; const unmatched = []; const usedPosIds = new Set();
  for (const ci of choiceOptItems) {
    const cName = normalize(ci.name); const cPrice = ci.price; let bestMatch = null;
    for (const pi of posModItems) {
      if (usedPosIds.has(pi.posId)) continue;
      const pName = normalize(pi.name); const nameMatch = cName === pName;
      const priceMatch = Math.abs((pi.price || 0) - (cPrice || 0)) <= 1;
      if (nameMatch && priceMatch) { bestMatch = pi; break; }
      if (nameMatch && !bestMatch) bestMatch = { ...pi, _nameonly: true };
    }
    if (bestMatch && !bestMatch._nameonly) {
      usedPosIds.add(bestMatch.posId);
      localMatched.push({ choiceGroupId: ci.groupId, choiceItemId: ci.itemId, posItemId: bestMatch.posId, choiceName: ci.name, posName: bestMatch.name, price: cPrice });
    } else {
      unmatched.push({ ...ci, _nameHint: bestMatch ? bestMatch.posId : null });
    }
  }
  return { localMatched, localUnmatched: { unmatched } };
}

// ─── CALL GEMINI ──────────────────────────────────────────────────────
async function callGemini(prompt, isRetry = false) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { 
      temperature: 0.1, maxOutputTokens: 8192, responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          dishes: { type: "array", items: { type: "object", properties: { choiceId: { type: "string" }, posId: { type: "string" }, choiceName: { type: "string" }, posName: { type: "string" }, price: { type: "number" }, confidence: { type: "string" } }, required: ["choiceId", "posId", "choiceName", "posName", "confidence"] } },
          categories: { type: "array", items: { type: "object", properties: { choiceId: { type: "string" }, posId: { type: "string" }, choiceName: { type: "string" }, posName: { type: "string" }, confidence: { type: "string" } }, required: ["choiceId", "posId", "choiceName", "posName", "confidence"] } },
          optionItems: { type: "array", items: { type: "object", properties: { choiceGroupId: { type: "string" }, choiceItemId: { type: "string" }, posItemId: { type: "string" }, choiceName: { type: "string" }, posName: { type: "string" }, price: { type: "number" }, confidence: { type: "string" } }, required: ["choiceGroupId", "choiceItemId", "posItemId", "choiceName", "posName", "confidence"] } }
        },
        required: ["dishes", "categories", "optionItems"]
      }
    }
  };

  try {
    const resp = await fetch(GEMINI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) return { dishes: [], categories: [], optionItems: [] };
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
  } catch (e) {
    return { dishes: [], categories: [], optionItems: [] };
  }
}

// ─── CHUNK PROMPT BUILDER ─────────────────────────────────────────────
function buildPromptChunk(type, choiceItems, posItems) {
  return `Ти — асистент ресторану. Знайди відповідності для списку структур. Шукай нечіткі схожості за назвою.
Поверни результат ТІЛЬКИ у відповідному масиві в об'єкті JSON згідно схеми. Остальні масиви залиш порожніми.

Тип обробки: ${type}
Елементи Choice (знайди для них пару): ${JSON.stringify(choiceItems)}
База для пошуку в POS: ${JSON.stringify(posItems.slice(0, 400))}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ POS-Sync server on http://localhost:${PORT}`));
