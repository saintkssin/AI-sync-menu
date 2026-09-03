// Dice Coefficient fuzzy string matching.
// Extracted from server.js so both server.js and ai-match.js can import it
// without circular dependencies.

function diceCoefficient(str1, str2) {
  const s1 = String(str1 || '').toLowerCase().replace(/\s+/g, '');
  const s2 = String(str2 || '').toLowerCase().replace(/\s+/g, '');
  if (!s1 || !s2) return 0;
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
    if (count > 0) { intersection++; bigrams1.set(bigram, count - 1); }
  }
  return (2.0 * intersection) / (s1.length + s2.length - 2);
}

function findBestFuzzyMatch(choiceItem, posItems, isCat = false) {
  let bestMatch = null, maxScore = 0;
  const cName = choiceItem.name || choiceItem.choiceName || '';
  for (const pi of posItems) {
    const score = diceCoefficient(cName, pi.name);
    if (score > maxScore) { maxScore = score; bestMatch = pi; }
  }
  if (bestMatch) {
    const priceMatch = isCat ? true : Math.abs((bestMatch.price || 0) - (choiceItem.price || 0)) <= 50;
    return { match: bestMatch, confidence: (maxScore > 0.4 && priceMatch) ? 'high' : 'medium' };
  }
  return null;
}

module.exports = { diceCoefficient, findBestFuzzyMatch };
