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

// Стабільний платний шлюз
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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
app.all('/api/choice/*', async (req, res) => {
  const token = req.headers['x-choice-token'];
  if (!token) return res.status(401).json({ error: 'Missing x-choice-token header' });

  const choicePath = req.path.replace('/api/choice', '');
  const url = `https://open-api.choiceqr.com${choicePath}${req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query) : ''}`;

  console.log(`[PROXY] ${req.method} ${url} token=${token.substring(0, 8)}...`);
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

// ─── Match endpoint ───────────────────────────────────────────────
app.post('/api/match', async (req, res) => {
  const { choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems } = req.body;
  if (!choiceDishes || !posDishes) return res.status(400).json({ error: 'Missing required data' });

  try {
    // ЕТАП 1: локальний точний матч (назва + ціна)
    const { localMatched, localUnmatched } = localExactMatch(choiceDishes, posDishes);
    const { localMatched: localCatMatched, localUnmatched: localCatUnmatched } = localExactMatch(choiceCategories, posCategories, true);
    const { localMatched: localModMatched, localUnmatched: localModUnmatched } = localModMatch(choiceOptionItems, posModifierItems);

    console.log(`[MATCH] Local exact: dishes=${localMatched.length}/${choiceDishes.length}, cats=${localCatMatched.length}/${choiceCategories.length}, mods=${localModMatched.length}/${choiceOptionItems.length}`);

    // ЕТАП 2: AI матч для решти (якщо є що матчити)
    let aiResult = { dishes: [], categories: [], optionItems: [] };
    const needsAI = localUnmatched.length > 0 || localCatUnmatched.length > 0 || localModUnmatched.unmatched.length > 0;

    if (needsAI) {
      const prompt = buildPrompt(
        localUnmatched,
        posDishes,
        localCatUnmatched,
        posCategories,
        localModUnmatched.unmatched,
        posModifierItems
      );
      aiResult = await callGemini(prompt);
    }

    // ЗАХИСТ НА БЕКЕНДІ: гарантуємо, що об'єкти точно існують як масиви і не будуть undefined
    aiResult = aiResult || {};
    aiResult.dishes = aiResult.dishes || [];
    aiResult.categories = aiResult.categories || [];
    aiResult.optionItems = aiResult.optionItems || [];

    // Об'єднуємо: локальні high + AI результати
    const finalDishes = [
      ...localMatched.map(m => ({ ...m, confidence: 'high' })),
      ...aiResult.dishes
    ];
    const finalCategories = [
      ...localCatMatched.map(m => ({ ...m, confidence: 'high' })),
      ...aiResult.categories
    ];
    const finalOptionItems = [
      ...localModMatched.map(m => ({ ...m, confidence: 'high' })),
      ...aiResult.optionItems
    ];

    // Дедуп по choiceId
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
    // Якщо навіть все впало, віддаємо порожню структуру, щоб фронтенд не падав!
    res.json({ dishes: [], categories: [], optionItems: [] });
  }
});

// ─── Вспомогательные функции этапа 1 (Локальный матч) ─────────────────

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[-_"'«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function localExactMatch(choiceItems, posItems, isCat = false) {
  if (!choiceItems || !posItems) return { localMatched: [], localUnmatched: choiceItems || [] };

  const localMatched = [];
  const localUnmatched = [];
  const usedPosIds = new Set();

  for (const ci of choiceItems) {
    const cName = normalize(ci.name);
    const cPrice = ci.price;

    let bestMatch = null;

    for (const pi of posItems) {
      if (usedPosIds.has(pi.posId)) continue;

      const pName = normalize(pi.name);
      const nameMatch = cName === pName;

      if (isCat) {
        if (nameMatch) {
          bestMatch = pi;
          break;
        }
      } else {
        const priceMatch = Math.abs((pi.price || 0) - (cPrice || 0)) <= 1;

        if (nameMatch && priceMatch) {
          bestMatch = pi;
          break;
        }
        if (nameMatch && !bestMatch) {
          bestMatch = { ...pi, _nameonlymatch: true };
        }
      }
    }

    if (bestMatch && !bestMatch._nameonlymatch) {
      usedPosIds.add(bestMatch.posId);
      localMatched.push({
        choiceId: ci.id || ci._id,
        posId: bestMatch.posId,
        choiceName: ci.name,
        posName: bestMatch.name,
        price: cPrice
      });
    } else {
      localUnmatched.push({
        ...ci,
        _nameHint: bestMatch ? bestMatch.posId : null
      });
    }
  }

  return { localMatched, localUnmatched };
}

function localModMatch(choiceOptItems, posModItems) {
  if (!choiceOptItems || !posModItems) return { localMatched: [], localUnmatched: { unmatched: choiceOptItems || [] } };

  const localMatched = [];
  const unmatched = [];
  const usedPosIds = new Set();

  for (const ci of choiceOptItems) {
    const cName = normalize(ci.name);
    const cPrice = ci.price;

    let bestMatch = null;

    for (const pi of posModItems) {
      if (usedPosIds.has(pi.posId)) continue;
      const pName = normalize(pi.name);
      const nameMatch = cName === pName;
      const priceMatch = Math.abs((pi.price || 0) - (cPrice || 0)) <= 1;

      if (nameMatch && priceMatch) { bestMatch = pi; break; }
      if (nameMatch && !bestMatch) bestMatch = { ...pi, _nameonly: true };
    }

    if (bestMatch && !bestMatch._nameonly) {
      usedPosIds.add(bestMatch.posId);
      localMatched.push({
        choiceGroupId: ci.groupId,
        choiceItemId: ci.itemId,
        posItemId: bestMatch.posId,
        choiceName: ci.name,
        posName: bestMatch.name,
        price: cPrice
      });
    } else {
      unmatched.push({ ...ci, _nameHint: bestMatch ? bestMatch.posId : null });
    }
  }

  return { localMatched, localUnmatched: { unmatched } };
}

// ─── ЕТАП 2: Gemini для решти ─────────────────────────────────────

async function callGemini(prompt, isRetry = false) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { 
      temperature: 0.1, 
      maxOutputTokens: 8192,
      responseMimeType: "application/json"
    }
  };

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  try {
    let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const startIdx = clean.indexOf('{');
    const endIdx = clean.lastIndexOf('}');
    
    if (startIdx !== -1 && endIdx !== -1) {
      clean = clean.substring(startIdx, endIdx + 1);
    }
    
    const parsed = JSON.parse(clean);
    return parsed;
  } catch (e) {
    if (isRetry) {
      return { dishes: [], categories: [], optionItems: [] };
    }
    return callGemini(prompt + '\n\nУВАГА: Поверни тільки валідний JSON-код з полями {"dishes":[], "categories":[], "optionItems":[]} без маркдаун кавичок!', true);
  }
}

// ─── Prompt builder (тільки для немачених) ────────────────────────
function buildPrompt(unmatchedDishes, posDishes, unmatchedCats, posCategories, unmatchedMods, posModifierItems) {
  const cleanChoiceDishes = unmatchedDishes.map(d => ({ choiceId: d.id || d._id, name: d.name, price: d.price, hintPosId: d._nameHint })).slice(0, 300);
  const cleanPosDishes = posDishes.map(d => ({ posId: d.posId, name: d.name, price: d.price })).slice(0, 500);

  const cleanChoiceCats = unmatchedCats.map(c => ({ choiceId: c.id || c._id, name: c.name })).slice(0, 100);
  const cleanPosCats = posCategories.map(c => ({ posId: c.posId, name: c.name })).slice(0, 200);

  const cleanChoiceMods = (unmatchedMods || []).map(m => ({ choiceGroupId: m.groupId || m.choiceGroupId, choiceItemId: m.itemId || m.choiceItemId, name: m.name, price: m.price })).slice(0, 200);
  const cleanPosMods = (posModifierItems || []).map(m => ({ posId: m.posId, name: m.name, price: m.price })).slice(0, 400);

  return `Ти — асистент для матчингу menu між двома системами.
ПОВЕРНИ ВІДПОВІДЬ ВИКЛЮЧНО У ФОРМАТІ JSON ОБ'ЄКТА З ПОЛЯМИ: "dishes", "categories", "optionItems". Не додавай жодних маркдаун тегів чи тексту навколо.

ЗАВДАННЯ: знайди відповідності між позиціями Choice і POS.

СТРАВИ Choice: ${JSON.stringify(cleanChoiceDishes)}
СТРАВИ POS: ${JSON.stringify(cleanPosDishes)}

КАТЕГОРІЇ Choice: ${JSON.stringify(cleanChoiceCats)}
КАТЕГОРІЇ POS: ${JSON.stringify(cleanPosCats)}

ОПЦІЇ Choice: ${JSON.stringify(cleanChoiceMods)}
МОДИФІКАТОРИ POS: ${JSON.stringify(cleanPosMods)}`;
}

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ POS-Sync server on http://localhost:${PORT}`));
