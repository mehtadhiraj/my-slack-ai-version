const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEARNINGS_FILE = path.join(DATA_DIR, 'learnings.md');
const MAX_ENTRIES = 500;

// ── File helpers ────────────────────────────────────────────────────────────

function ensureFile(filePath, header) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, header + '\n\n');
}

/**
 * Parses a markdown file into entries.
 * Each entry is a line: - [date] [ts] text
 */
function readEntries(filePath, header) {
  ensureFile(filePath, header);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      const match = line.match(/^- \[(\d{4}-\d{2}-\d{2})\] \[(.+?)\] (.+)$/);
      if (match) {
        // Restore newlines from ␤ delimiter used during save
        entries.push({ date: match[1], ts: match[2], text: match[3].replace(/␤/g, '\n') });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function appendEntry(filePath, header, entries, newEntry) {
  if (entries.length >= MAX_ENTRIES) {
    const trimmed = entries.slice(-(MAX_ENTRIES - 1)).concat(newEntry);
    const body = trimmed.map((l) => `- [${l.date}] [${l.ts}] ${l.text}`).join('\n');
    fs.writeFileSync(filePath, header + '\n\n' + body + '\n');
  } else {
    fs.appendFileSync(filePath, `- [${newEntry.date}] [${newEntry.ts}] ${newEntry.text}\n`);
  }
}

// ── Learnings (Author's own messages → knowledge base) ──────────────────────

const AUTHOR_NAME = process.env.AUTHOR_NAME || 'Author';
const LEARNINGS_HEADER = `# ${AUTHOR_NAME} — Knowledge Base\n\nMessages from ${AUTHOR_NAME} captured across Slack. Treated as authoritative knowledge.`;

function readLearnings() {
  return readEntries(LEARNINGS_FILE, LEARNINGS_HEADER);
}

/**
 * Saves a message from the author as knowledge.
 */
function saveLearning({ text, channel, ts }) {
  const learnings = readLearnings();
  if (learnings.some((l) => l.ts === ts)) return;

  // Replace newlines with ␤ so multi-line messages fit in a single entry line
  const cleaned = (text || '').replace(/<@[A-Z0-9]+>/g, '').trim().replace(/\n/g, '␤');
  if (cleaned.length < 10) return;

  const entry = { date: new Date().toISOString().split('T')[0], ts, text: cleaned };
  learnings.push(entry);
  appendEntry(LEARNINGS_FILE, LEARNINGS_HEADER, learnings, entry);
  console.log(`[learnings] Saved: "${cleaned.slice(0, 80)}" (${learnings.length} total)`);
}

// ── Retrieval ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has',
  'her', 'was', 'one', 'our', 'out', 'how', 'what', 'when', 'where',
  'who', 'why', 'which', 'this', 'that', 'with', 'from', 'have', 'been',
  'does', 'will', 'about', 'would', 'could', 'should', 'there', 'their',
  'please', 'thanks', 'thank',
]);

function extractKeywords(text) {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function findRelevant(entries, query, limit = 10) {
  if (!entries.length) return [];

  const queryWords = extractKeywords(query);
  if (!queryWords.length) return entries.slice(-limit);

  const scored = entries.map((entry) => {
    const lowerText = entry.text.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      if (lowerText.includes(word)) score++;
    }
    return { ...entry, score };
  });

  const relevant = scored
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return relevant.length > 0 ? relevant : entries.slice(-limit);
}

/**
 * Builds the dynamic context string (learnings) to append to the system prompt.
 *
 * @param {string} query - The user's question
 * @returns {string} Learnings context string
 */
function getDynamicContext(query) {
  const relevantLearnings = findRelevant(readLearnings(), query);
  if (!relevantLearnings.length) return '';

  const entries = relevantLearnings.map((l) => `- [${l.date}] ${l.text}`).join('\n');
  return `\n\n---\n**KNOWLEDGE FROM ${AUTHOR_NAME.toUpperCase()} (treat as authoritative):**\nThese are ${AUTHOR_NAME}'s own messages across Slack. Use them to inform your answers — they reflect his latest thinking, decisions, and domain knowledge.\n${entries}\n---`;
}

module.exports = { saveLearning, getDynamicContext };
