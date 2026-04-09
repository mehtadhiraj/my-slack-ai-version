const fs = require('fs');
const path = require('path');

const KNOWLEDGE_FILE = path.join(__dirname, '..', 'data', 'knowledge.md');

/** Indexed pages with pre-computed term frequencies */
let pages = [];

/** Full knowledge base content (fallback) */
let FULL_KNOWLEDGE = '';

/** Inverted index: term → [{ pageIdx, tf }] */
const invertedIndex = new Map();

/** Total number of content pages (for IDF calculation) */
let totalPages = 0;

// ── Stop words ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has',
  'her', 'was', 'one', 'our', 'out', 'how', 'what', 'when', 'where',
  'who', 'why', 'which', 'this', 'that', 'with', 'from', 'have', 'been',
  'does', 'will', 'about', 'would', 'could', 'should', 'there', 'their',
  'please', 'thanks', 'thank', 'tell', 'know', 'like', 'just', 'also',
  'into', 'only', 'your', 'them', 'than', 'then', 'each', 'more', 'some',
  'such', 'here', 'very', 'after', 'above', 'between', 'being', 'before',
  'below', 'these', 'those', 'other',
]);

// ── Domain expansions ───────────────────────────────────────────────────────

const DOMAIN_EXPANSIONS = [
  { triggers: ['meter', 'metering', 'usage'], terms: ['metering', 'integration', 'events', 'api', 'endpoints', 'payload', 'aggregation', 'usage', 'calculation', 'ingestion', 'openmeter'] },
  { triggers: ['subscription', 'subscribe'], terms: ['subscription', 'lifecycle', 'states', 'active', 'past_due', 'expired', 'cancelled', 'events', 'webhook', 'create', 'cancel', 'upgrade', 'downgrade'] },
  { triggers: ['billing', 'invoice', 'payment'], terms: ['billing', 'cycle', 'payment', 'invoice', 'postpaid', 'prepaid', 'wallet', 'charge', 'cron', 'gst', 'settlement'] },
  { triggers: ['discount', 'coupon', 'promo'], terms: ['discount', 'configuration', 'public', 'private', 'recurring', 'coupon', 'code', 'plan', 'addon', 'mapping'] },
  { triggers: ['addon', 'add-on', 'add on'], terms: ['addon', 'metric', 'behavior', 'one-time', 'recurring', 'plan', 'subscription', 'checkout'] },
  { triggers: ['webhook', 'event', 'pub/sub', 'pubsub'], terms: ['webhook', 'events', 'subscription', 'billing', 'payload', 'signature', 'validation', 'endpoint'] },
  { triggers: ['api', 'endpoint', 'integration'], terms: ['api', 'endpoint', 'base', 'url', 'authentication', 'headers', 'request', 'response', 'payload', 'credentials'] },
  { triggers: ['postpaid', 'order form', 'wallet'], terms: ['postpaid', 'order', 'form', 'wallet', 'icici', 'virtual', 'account', 'billing', 'cron', 'invoice', 'settlement'] },
  { triggers: ['upgrade', 'downgrade', 'cancel'], terms: ['upgrade', 'downgrade', 'cancellation', 'change_now', 'change_on_cycle_end', 'subscription', 'state', 'transition'] },
  { triggers: ['plan', 'pricing'], terms: ['plan', 'pricing', 'features', 'billing', 'cycle', 'custom', 'organisation', 'addon'] },
  { triggers: ['document', 'documentation', 'docs', 'guide', 'link'], terms: ['documentation', 'link', 'integration', 'guide', 'endpoints', 'payload', 'examples', 'implementation', 'api'] },
  { triggers: ['productaccount', 'productaccounts', 'product account'], terms: ['productaccounts', 'product', 'accounts', 'orgid', 'org', 'console', 'slug', 'payment', 'api', 'get', 'products'] },
  { triggers: ['tokyo'], terms: ['tokyo', 'integration', 'server', 'organization', 'authentication', 'encrypted', 'token', 'bearer', 'aes', 'crypto'] },
  { triggers: ['token', 'generate token', 'api token', 'encrypted token', 'script'], terms: ['token', 'encrypted', 'generate', 'script', 'api', 'key', 'authentication', 'bearer', 'integration', 'server', 'aes', 'crypto', 'secret', 'iv', 'organization'] },
  { triggers: ['faq', 'question', 'common'], terms: ['faq', 'frequently', 'asked', 'questions', 'common'] },
];

// ── Tokenizer ───────────────────────────────────────────────────────────────

/**
 * Tokenizes text into searchable terms (lowercase, 2+ chars, no stop words).
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Computes term frequency map for a list of tokens.
 *
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  // Normalize by total tokens
  const total = tokens.length || 1;
  for (const [term, count] of tf) {
    tf.set(term, count / total);
  }
  return tf;
}

// ── Section parsing ─────────────────────────────────────────────────────────

/**
 * Splits knowledge.md into pages by `#` (h1) headings only.
 * `##` (h2) subsections are kept within their parent `#` section.
 * This ensures related content (e.g., "Subscription GET API" + its endpoints,
 * base URLs, auth headers) stays together in one searchable page.
 */
function parseSections() {
  FULL_KNOWLEDGE = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8');
  const lines = FULL_KNOWLEDGE.split('\n');

  const allSections = [];
  let current = null;

  for (const line of lines) {
    // Split only on # (h1) headings — keep ## as part of parent
    if (/^# /.test(line) && !/^## /.test(line)) {
      if (current) allSections.push(current);
      current = { title: line.replace(/^#\s+/, ''), body: line + '\n' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) allSections.push(current);

  return allSections;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Builds the page index at startup. Parses sections, tokenizes each,
 * builds an inverted index for fast TF-IDF retrieval. No external services needed.
 */
function initIndex() {
  const contentSections = parseSections();
  totalPages = contentSections.length;

  pages = contentSections.map((section, idx) => {
    // Tokenize title (weighted heavier) and body
    const titleTokens = tokenize(section.title);
    const bodyTokens = tokenize(section.body);
    // Title terms count 3x for relevance
    const allTokens = [...titleTokens, ...titleTokens, ...titleTokens, ...bodyTokens];
    const tf = termFrequency(allTokens);

    return { idx, title: section.title, body: section.body, tf, tokenCount: allTokens.length };
  });

  // Build inverted index: term → list of { pageIdx, tf }
  invertedIndex.clear();
  for (const page of pages) {
    for (const [term, freq] of page.tf) {
      if (!invertedIndex.has(term)) invertedIndex.set(term, []);
      invertedIndex.get(term).push({ pageIdx: page.idx, tf: freq });
    }
  }

  console.log(`[index] Built page index: ${pages.length} pages, ${invertedIndex.size} unique terms`);
}

/**
 * Expands a query with domain-specific terms for better matching.
 *
 * @param {string} query
 * @returns {string[]} Expanded list of search terms
 */
function expandQuery(query) {
  const lower = query.toLowerCase();
  const baseTerms = tokenize(query);

  const expanded = new Set(baseTerms);
  for (const { triggers, terms } of DOMAIN_EXPANSIONS) {
    if (triggers.some((t) => lower.includes(t))) {
      for (const term of terms) expanded.add(term.toLowerCase());
    }
  }

  return [...expanded];
}

/**
 * Retrieves the most relevant pages for a query using TF-IDF scoring.
 *
 * @param {string} query - The user's question
 * @param {number} [topK=8] - Number of top pages to return
 * @param {number} [maxChars=20000] - Max total characters to return
 * @returns {string} System instructions + relevant pages
 */
function retrieveContext(query, topK = 8, maxChars = 20000) {
  if (!pages.length) return FULL_KNOWLEDGE;

  const queryTerms = expandQuery(query);
  if (!queryTerms.length) return FULL_KNOWLEDGE;

  console.log(`[index] Search terms: ${queryTerms.slice(0, 15).join(', ')}${queryTerms.length > 15 ? '...' : ''}`);

  // Score each page using TF-IDF
  const scores = new Float64Array(pages.length);

  for (const term of queryTerms) {
    const postings = invertedIndex.get(term);
    if (!postings) continue;

    // IDF: log(totalPages / docs containing term)
    const idf = Math.log(totalPages / postings.length);

    for (const { pageIdx, tf } of postings) {
      scores[pageIdx] += tf * idf;
    }
  }

  // Title-match bonus: boost pages whose title directly contains query terms
  // This ensures "billing documentation" ranks "Subscription & Billing Integration" higher
  const originalTerms = tokenize(query);
  for (let i = 0; i < pages.length; i++) {
    const titleLower = pages[i].title.toLowerCase();
    let titleBonus = 0;
    for (const term of originalTerms) {
      if (titleLower.includes(term)) titleBonus += 2.0;
    }
    scores[i] += titleBonus;
  }

  // Rank pages by score
  const ranked = pages
    .map((page, idx) => ({ ...page, score: scores[idx] }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (!ranked.length) {
    console.log('[index] No matching pages found, using full knowledge base');
    return FULL_KNOWLEDGE;
  }

  console.log(`[index] Top matches: ${ranked.map((p) => `"${p.title.slice(0, 50)}" (${p.score.toFixed(3)})`).join(', ')}`);

  // Collect pages within char budget
  let result = '';
  for (const page of ranked) {
    if (result.length + page.body.length > maxChars) break;
    result += page.body + '\n';
  }

  return result;
}

module.exports = { initIndex, retrieveContext };
