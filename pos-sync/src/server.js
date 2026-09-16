require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

// Dice logic extracted to shared module (imported by ai-match.js too — avoid duplication)
const { findBestFuzzyMatch } = require('./dice');
// AI semantic layer — second pass for medium/unmatched items. Gracefully disabled if no API key.
const { aiMatchItem, ENABLED: AI_ENABLED } = require('./ai-match');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const CHOICE_CLIENT_ID     = process.env.CHOICE_CLIENT_ID;
const CHOICE_CLIENT_SECRET = process.env.CHOICE_CLIENT_SECRET;

app.get('/health', (req, res) => res.json({ ok: true, aiEnabled: AI_ENABLED }));

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

app.all('/api/choice/*', async (req, res) => {
  const token = req.headers['x-choice-token'];
  if (!token) return res.status(401).json({ error: 'Missing x-choice-token header' });
  const choicePath = req.path.replace('/api/choice', '');
  const url = `https://open-api.choiceqr.com${choicePath}${req.query && Object.keys(req.query).length ? '?' + new URLSearchParams(req.query) : ''}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const fetchOpts = { method: req.method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, signal: controller.signal };
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) fetchOpts.body = JSON.stringify(req.body);
    const r = await fetch(url, fetchOpts);
    clearTimeout(timer);
    if (r.status === 204) return res.status(204).send();
    if ((r.headers.get('content-type') || '').includes('application/json')) return res.status(r.status).json(await r.json());
    return res.status(r.status).send(await r.text());
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Choice API timeout' });
    res.status(500).json({ error: err.message });
  }
});

// /api/match: cascade matching — Dice first, then AI for uncertain results.
//
// Flow:
//   1. Dice pass → high confidence items go directly to matched (auto-apply).
//      Medium confidence items go to review. No-match items are unmatched.
//   2. AI pass (if enabled) → runs on medium + unmatched items.
//      AI suggestions ALWAYS go to review (aiSuggested=true), never auto-apply.
//      If AI fails or returns null → item stays unmatched. No corruption risk.
//
// Why run AI on medium-confidence Dice items too?
// Medium means Dice found something, but isn't sure. AI can confirm or improve
// the suggestion using semantic understanding (synonyms, abbreviations, Ukrainian
// transliterations) that bigram-based Dice can't see.
app.post('/api/match', async (req, res) => {
  const { choiceDishes, posDishes, choiceCategories, posCategories, choiceOptionItems, posModifierItems, categoryBoost } = req.body;
  const diceOpts = { categoryBoost: !!categoryBoost };

  // ── Step 1: Dice matching ─────────────────────────────────────────────────
  const dishes      = [];
  const categories  = [];
  const optionItems = [];

  // Track which Choice items Dice matched, so we know the unmatched set for AI.
  const matchedDishIds = new Set();
  const matchedCatIds  = new Set();
  const matchedOptIds  = new Set();

  (choiceDishes || []).forEach(cd => {
    const fuzzy = findBestFuzzyMatch(cd, posDishes, false, diceOpts);
    if (fuzzy) {
      matchedDishIds.add(cd.id);
      dishes.push({ choiceId: cd.id, posId: fuzzy.match.posId, choiceName: cd.name || 'Без назви', posName: fuzzy.match.name, price: cd.price, posPrice: fuzzy.match.price, confidence: fuzzy.confidence, _diceScore: fuzzy.score, choiceCategoryName: cd.categoryName || '', posCategoryName: fuzzy.match.category || '' });
    }
  });

  (choiceCategories || []).forEach(cc => {
    const fuzzy = findBestFuzzyMatch(cc, posCategories, true, diceOpts);
    if (fuzzy) {
      matchedCatIds.add(cc.id);
      categories.push({ choiceId: cc.id, posId: fuzzy.match.posId, choiceName: cc.name || 'Без назви', posName: fuzzy.match.name, confidence: fuzzy.confidence });
    }
  });

  (choiceOptionItems || []).forEach(co => {
    const fuzzy = findBestFuzzyMatch(co, posModifierItems, false, diceOpts);
    if (fuzzy) {
      matchedOptIds.add(co.itemId);
      optionItems.push({ choiceGroupId: co.groupId, choiceItemId: co.itemId, posItemId: fuzzy.match.posId, choiceName: co.name || 'Без назви', posName: fuzzy.match.name, price: co.price, posPrice: fuzzy.match.price, confidence: fuzzy.confidence, _diceScore: fuzzy.score, choiceGroupName: co.groupName || '', posGroupName: fuzzy.match.groupName || '' });
    }
  });

  // ── Steps 2 + 3: AI pass (run in parallel) ───────────────────────────────
  // Step 2: fill in medium-confidence Dice results and unmatched items.
  // Step 3: verify high-confidence Dice matches where score < 0.8 (catches
  //         false positives like "Dr. Pepper" → "Чай" matched by shared suffix).
  if (AI_ENABLED) {
    const VERIFY_THRESHOLD = 0.8;

    // Step 2 targets
    const dishTargets = [
      ...dishes.filter(d => d.confidence === 'medium').map(d => ({ ...d, _fromReview: true })),
      ...(choiceDishes || []).filter(cd => !matchedDishIds.has(cd.id)).map(cd => ({
        choiceId: cd.id, choiceName: cd.name || 'Без назви', choiceCategoryName: cd.categoryName || '', price: cd.price, _fromReview: false
      }))
    ];
    const catTargets = [
      ...categories.filter(c => c.confidence === 'medium').map(c => ({ ...c, _fromReview: true })),
      ...(choiceCategories || []).filter(cc => !matchedCatIds.has(cc.id)).map(cc => ({
        choiceId: cc.id, choiceName: cc.name || 'Без назви', _fromReview: false
      }))
    ];
    const optTargets = [
      ...optionItems.filter(o => o.confidence === 'medium').map(o => ({ ...o, _fromReview: true })),
      ...(choiceOptionItems || []).filter(co => !matchedOptIds.has(co.itemId)).map(co => ({
        choiceGroupId: co.groupId, choiceItemId: co.itemId, choiceName: co.name || 'Без назви', choiceGroupName: co.groupName || '', price: co.price, _fromReview: false
      }))
    ];

    // Step 3 targets — high Dice matches that aren't near-exact (score < threshold)
    const verifyDishTargets = dishes.filter(d => d.confidence === 'high' && (d._diceScore || 1) < VERIFY_THRESHOLD);
    const verifyCatTargets  = categories.filter(c => c.confidence === 'high' && (c._diceScore || 1) < VERIFY_THRESHOLD);
    const verifyOptTargets  = optionItems.filter(o => o.confidence === 'high' && (o._diceScore || 1) < VERIFY_THRESHOLD);

    // ponytail: no concurrency limit; add p-limit if menus exceed ~150 unmatched items
    const [dishAI, catAI, optAI, verifyDish, verifyCat, verifyOpt] = await Promise.all([
      Promise.all(dishTargets      .map(t => aiMatchItem(t.choiceName, t.price, posDishes        || [], false, t.choiceCategoryName || '').then(r => ({ t, r })))),
      Promise.all(catTargets       .map(t => aiMatchItem(t.choiceName, null,    posCategories    || [], true                            ).then(r => ({ t, r })))),
      Promise.all(optTargets       .map(t => aiMatchItem(t.choiceName, t.price, posModifierItems || [], false, t.choiceGroupName    || '').then(r => ({ t, r })))),
      Promise.all(verifyDishTargets.map(d => aiMatchItem(d.choiceName, d.price, posDishes        || [], false, d.choiceCategoryName || '').then(r => ({ d, r })))),
      Promise.all(verifyCatTargets .map(d => aiMatchItem(d.choiceName, null,    posCategories    || [], true                            ).then(r => ({ d, r })))),
      Promise.all(verifyOptTargets .map(d => aiMatchItem(d.choiceName, d.price, posModifierItems || [], false, d.choiceGroupName    || '').then(r => ({ d, r }))))
    ]);

    // ── Merge Step 2 results ──────────────────────────────────────────────
    for (const { t, r } of dishAI) {
      if (!r) continue;
      if (t._fromReview) {
        const existing = dishes.find(d => d.choiceId === t.choiceId);
        if (existing) Object.assign(existing, { posId: r.match.posId, posName: r.match.name, posPrice: r.match.price, posCategoryName: r.match.category || '', aiSuggested: true, aiReason: r.reason, aiConfidence: r.confidence });
      } else {
        dishes.push({ choiceId: t.choiceId, posId: r.match.posId, choiceName: t.choiceName, posName: r.match.name, price: t.price, posPrice: r.match.price, confidence: 'medium', choiceCategoryName: t.choiceCategoryName || '', posCategoryName: r.match.category || '', aiSuggested: true, aiReason: r.reason, aiConfidence: r.confidence });
      }
    }
    for (const { t, r } of catAI) {
      if (!r) continue;
      if (t._fromReview) {
        const existing = categories.find(c => c.choiceId === t.choiceId);
        if (existing) Object.assign(existing, { posId: r.match.posId, posName: r.match.name, aiSuggested: true, aiReason: r.reason, aiConfidence: r.confidence });
      } else {
        categories.push({ choiceId: t.choiceId, posId: r.match.posId, choiceName: t.choiceName, posName: r.match.name, confidence: 'medium', aiSuggested: true, aiReason: r.reason, aiConfidence: r.confidence });
      }
    }
    for (const { t, r } of optAI) {
      if (!r) continue;
      if (t._fromReview) {
        const existing = optionItems.find(o => o.choiceItemId === t.choiceItemId);
        if (existing) Object.assign(existing, { posItemId: r.match.posId, posName: r.match.name, posPrice: r.match.price, posGroupName: r.match.groupName || '', aiSuggested: true, aiReason: r.reason, aiConfidence: r.confidence });
      } else {
        optionItems.push({ choiceGroupId: t.choiceGroupId, choiceItemId: t.choiceItemId, posItemId: r.match.posId, choiceName: t.choiceName, posName: r.match.name, price: t.price, posPrice: r.match.price, confidence: 'medium', choiceGroupName: t.choiceGroupName || '', posGroupName: r.match.groupName || '', aiSuggested: true, aiReason: r.reason, aiConfidence: r.confidence });
      }
    }

    // ── Step 3: downgrade high-confidence Dice matches AI disagrees with ──
    for (const { d, r } of verifyDish) {
      if (r && r.match.posId === d.posId) continue; // AI confirms — keep high
      d.confidence = 'medium';
      d.aiSuggested = true;
      d.aiReason = r ? `AI: можливо "${r.match.name}"` : 'AI: схожість підозріла';
      d.aiConfidence = r ? r.confidence : 'low';
    }
    for (const { d, r } of verifyCat) {
      if (r && r.match.posId === d.posId) continue;
      d.confidence = 'medium';
      d.aiSuggested = true;
      d.aiReason = r ? `AI: можливо "${r.match.name}"` : 'AI: схожість підозріла';
      d.aiConfidence = r ? r.confidence : 'low';
    }
    for (const { d, r } of verifyOpt) {
      if (r && r.match.posId === d.posItemId) continue;
      d.confidence = 'medium';
      d.aiSuggested = true;
      d.aiReason = r ? `AI: можливо "${r.match.name}"` : 'AI: схожість підозріла';
      d.aiConfidence = r ? r.confidence : 'low';
    }
  }

  res.json({ dishes, categories, optionItems });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ POS-Sync server on http://localhost:${PORT}`);
  console.log(`  AI matching: ${AI_ENABLED ? 'enabled (claude-haiku)' : 'disabled (set ANTHROPIC_API_KEY to enable)'}`);
});
