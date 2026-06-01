require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const CHOICE_CLIENT_ID = process.env.CHOICE_CLIENT_ID;
const CHOICE_CLIENT_SECRET = process.env.CHOICE_CLIENT_SECRET;

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
    if (!r.ok) return res.status(400).send('Token exchange failed');
    const data = await r.json();
    res.redirect(`/?token=${encodeURIComponent(data.token)}&domain=${encodeURIComponent(data.domain)}`);
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
    const fetchOpts = { method: req.method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` } };
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) fetchOpts.body = JSON.stringify(req.body);
    const r = await fetch(url, fetchOpts);
    if (r.status === 204) return res.status(204).send();
    if ((r.headers.get('content-type') || '').includes('application/json')) return res.status(r.status).json(await r.json());
    return res.status(r.status).send(await r.text());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ФУНКЦІЯ НЕЧІТКОГО ПОШУКУ (ЗАМІСТЬ GEMINI) ──────────────────────
function diceCoefficient(str1, str2) {
  const s1 = String(str1 || '').toLowerCase().replace(/\s+/g, '');
  const s2 = String(str2 || '').toLowerCase().replace(/\s+/g, '');
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;
  
  const bigrams1 = new Map();
  for (let i = 0; i < s1.length - 1; i++) {
    const bigram = s1.substring(i, i + 2);
    bigrams1.set(bigram, (bigrams1.get(bigram) || 0) + 1);
  }
  
  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.substring(i, i + 2);
    const count = bigrams1.get(bigram) || 0;
    if (count > 0) {
      intersection++;
      bigrams1.set(bigram, count - 1);
    }
  }
  return (2.0 * intersection) / (s1.length + s2.length - 2);
}

function findBestFuzzyMatch(choiceItem, posItems, isCat = false) {
  let bestMatch = null;
  let maxScore = 0;

  for (const pi of posItems) {
    const score = diceCoefficient(choiceItem.name, pi.name);
    if (score > maxScore) {
      maxScore = score;
      bestMatch = pi;
    }
  }

  // Якщо схожість більше 20%, вважаємо це за матч для ручної перевірки
  if (bestMatch && maxScore > 0.2) {
    const priceMatch = isCat ? true : Math.abs((bestMatch.price || 0) - (choiceItem.price || 0)) <= 15;
    return {
      match: bestMatch,
      confidence: (maxScore > 0.7 && priceMatch) ? 'high' : 'medium'
    };
  }
  return null;
}

// ─── Match endpoint (ЛОКАЛЬНИЙ РОЗУМНИЙ МАТЧИНГ) ───────────────────
app.post('/api/match', async (req, res) => {
  const { choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems } = req.body;

  const dishes = [];
  const categories = [];
  const optionItems = [];

  // Матчимо страви
  (choiceDishes || []).forEach(cd => {
    const fuzzy = findBestFuzzyMatch(cd, posDishes, false);
    if (fuzzy) {
      dishes.push({
        choiceId: cd.id,
        posId: fuzzy.match.posId,
        choiceName: cd.name,
        posName: fuzzy.match.name,
        price: cd.price,
        confidence: fuzzy.confidence
      });
    }
  });

  // Матчимо категорії
  (choiceCategories || []).forEach(cc => {
    const fuzzy = findBestFuzzyMatch(cc, posCategories, true);
    if (fuzzy) {
      categories.push({
        choiceId: cc.id,
        posId: fuzzy.match.posId,
        choiceName: cc.name,
        posName: fuzzy.match.name,
        confidence: fuzzy.confidence
      });
    }
  });

  // Матчимо опції
  (choiceOptionItems || []).forEach(co => {
    const fuzzy = findBestFuzzyMatch(co, posModifierItems, false);
    if (fuzzy) {
      optionItems.push({
        choiceGroupId: co.groupId,
        choiceItemId: co.itemId,
        posItemId: fuzzy.match.posId,
        choiceName: co.name,
        posName: fuzzy.match.name,
        price: co.price,
        confidence: fuzzy.confidence
      });
    }
  });

  res.json({ dishes, categories, optionItems });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Autonomous POS-Sync server on http://localhost:${PORT}`));
