// AI semantic matching — second layer on top of Dice Coefficient.
//
// Architecture decision: AI never replaces Dice, it only runs as a FALLBACK
// for items Dice couldn't confidently match (medium confidence or unmatched).
// This keeps high-confidence Dice matches fast and deterministic, while AI
// handles edge cases like transliterations, abbreviations, or renamed dishes.
//
// Feature flag: set AI_MATCH_ENABLED=false in .env to disable (pure Dice mode).
// System never breaks without AI — worst case items stay in unmatched.

require('dotenv').config();
const { diceCoefficient } = require('./dice');

const ENABLED     = !!(process.env.ANTHROPIC_API_KEY) && process.env.AI_MATCH_ENABLED !== 'false';
const API_KEY     = process.env.ANTHROPIC_API_KEY || '';
// Haiku: fast, cheap, good enough for structured output tasks like this.
// Use claude-sonnet-4-6 or higher only if Haiku misses semantically obvious matches.
const MODEL       = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 2;
const TOP_N       = 5;

// Why TOP_N=5? Sending all POS items to the LLM would waste tokens and increase
// hallucination risk. Top 5 by Dice gives the model the most plausible candidates
// while keeping the prompt short. If the real match isn't in top 5, Dice score
// is so low that a match likely doesn't exist at all.
function topNCandidates(choiceName, posItems) {
  return posItems
    .map(p => ({ ...p, _score: diceCoefficient(choiceName, p.name || '') }))
    .sort((a, b) => b._score - a._score)
    .slice(0, TOP_N);
}

function buildPrompt(choiceName, choicePrice, candidates, isCat, groupContext = '') {
  const priceStr = !isCat && choicePrice != null ? ` (${choicePrice} грн)` : '';

  // Why enumerate valid posIds in the Rules? LLMs sometimes generate ids that look
  // plausible (e.g. slightly modified) but aren't in the list. Explicit enumeration
  // in the prompt catches most hallucinations before they pass JSON validation.
  const validIds = candidates.map(c => `"${c.posId}"`).join(', ');

  const candidateLines = candidates.map((c, i) => {
    const price = !isCat && c.price != null ? ` (${c.price} грн)` : '';
    const grp = c.groupName ? `  group="${c.groupName}"` : '';
    const cat = c.category ? `  category="${c.category}"` : '';
    return `  ${i + 1}. posId="${c.posId}"  name="${c.name}"${grp}${cat}${price}  dice=${c._score.toFixed(2)}`;
  });

  const lines = [
    'You are a restaurant menu matching assistant. Reply ONLY with a single JSON object — no markdown, no extra text.',
    '',
    `Menu item to match: "${choiceName}"${priceStr}`,
  ];
  if (groupContext) lines.push(`Context: this item belongs to group/category "${groupContext}". Prefer candidates with the same or similar group name.`);
  lines.push(
    '',
    'POS candidates (pick one posId or return null):',
    ...candidateLines,
    '',
    'Rules:',
    `- posId MUST be one of [${validIds}] or null — never invent a posId.`,
    '- null means none of the candidates is a reasonable match.',
    '- confidence: "high" = clearly the same dish, "medium" = likely match, "low" = uncertain guess.',
    '- reason: max 8 words, Ukrainian or English.',
    '',
    'Output (JSON only):',
    '{"posId": "<value or null>", "confidence": "high|medium|low", "reason": "<text>"}'
  );
  return lines.join('\n');
}

// Why validate posId membership explicitly?
// A hallucinated posId that slips through would corrupt POS data: the apply
// step sends it to the Choice API, which would link a dish to a nonexistent
// POS item, silently breaking the sync. This is a data integrity guard.
function validateResponse(rawText, candidates) {
  let parsed;
  try {
    // Defensive: extract JSON even if model wraps it in backticks or adds text
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON object in response');
    parsed = JSON.parse(m[0]);
  } catch (e) {
    return { ok: false, error: 'JSON parse failed: ' + e.message };
  }
  if (!parsed || typeof parsed !== 'object')   return { ok: false, error: 'not an object' };
  if (!('posId' in parsed))                    return { ok: false, error: 'missing posId field' };
  if (!('confidence' in parsed))               return { ok: false, error: 'missing confidence field' };
  if (!['high', 'medium', 'low'].includes(parsed.confidence)) {
    return { ok: false, error: `invalid confidence: "${parsed.confidence}"` };
  }
  if (parsed.posId !== null) {
    const validIds = new Set(candidates.map(c => c.posId));
    if (!validIds.has(parsed.posId)) {
      // Most important guard: LLM fabricated a posId not in the shortlist
      return { ok: false, error: `posId "${parsed.posId}" not in candidate list` };
    }
  }
  return { ok: true, data: parsed };
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 120, // JSON response is tiny, 120 is more than enough
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content?.[0]?.text || '').trim();
}

// Main export. Returns { match: posItem, confidence, reason } on success, null on failure.
//
// Why does AI result ALWAYS go to review — even when confidence="high"?
// Dice "high" is deterministic: same name + price → same result every time.
// LLM "high" means "the model is confident" — but models can be confidently wrong,
// especially with similar names in Ukrainian menus. The review step is the
// non-negotiable human safety gate for all AI output.
//
// null return means: item stays in unmatched, no UI noise for hopeless cases.
async function aiMatchItem(choiceName, choicePrice, posItems, isCat = false, groupContext = '') {
  if (!ENABLED) return null;

  const candidates = topNCandidates(choiceName, posItems);
  if (!candidates.length) return null;

  const basePrompt = buildPrompt(choiceName, choicePrice, candidates, isCat, groupContext);
  const logCtx     = { item: choiceName, candidates: candidates.map(c => `${c.posId}(${c._score.toFixed(2)})`) };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // On retry: prepend explicit format reminder. Models often fix format errors
    // on a second pass when reminded of the constraint that failed.
    const prompt = attempt === 0
      ? basePrompt
      : `[RETRY ${attempt}/${MAX_RETRIES}: previous response was invalid — posId must come from the candidate list, reply with ONLY the JSON object]\n\n${basePrompt}`;

    let rawText;
    try {
      rawText = await callClaude(prompt);
    } catch (err) {
      console.error('[ai-match] API call failed', { ...logCtx, attempt, error: err.message });
      continue; // try again if retries remain
    }

    const validation = validateResponse(rawText, candidates);
    // Log every call: input context, raw response, validation result — for debugging
    console.log('[ai-match]', {
      ...logCtx,
      attempt,
      rawText: rawText.slice(0, 200),
      valid: validation.ok,
      ...(validation.error ? { error: validation.error } : {})
    });

    if (validation.ok) {
      const { data } = validation;
      if (!data.posId) {
        console.log('[ai-match] no match (posId=null)', logCtx);
        return null;
      }
      const match = candidates.find(c => c.posId === data.posId);
      console.log('[ai-match] matched', { item: choiceName, posId: data.posId, confidence: data.confidence, reason: data.reason });
      return { match, confidence: data.confidence, reason: data.reason };
    }

    console.warn('[ai-match] invalid response, will retry:', { error: validation.error, rawText: rawText.slice(0, 200) });
  }

  // All retries exhausted — fallback: item stays in unmatched, no corruption risk
  console.error('[ai-match] all retries failed, item stays unmatched', logCtx);
  return null;
}

module.exports = { aiMatchItem, ENABLED };
