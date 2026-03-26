const fs = require('fs');
const path = require('path');
const { initIndex, retrieveContext } = require('./embeddings');

/** System instructions — always sent to the LLM, never searched */
const SYSTEM_INSTRUCTIONS = fs.readFileSync(
  path.join(__dirname, '..', 'data', 'system-prompt.md'),
  'utf-8'
);

/** Full knowledge base — used as fallback */
const FULL_KNOWLEDGE = fs.readFileSync(
  path.join(__dirname, '..', 'data', 'knowledge.md'),
  'utf-8'
);

/** Legacy export for backward compatibility */
const SYSTEM_PROMPT = SYSTEM_INSTRUCTIONS + '\n\n' + FULL_KNOWLEDGE;

/**
 * Initializes the page index at startup.
 */
function initKnowledge() {
  initIndex();
}

/**
 * Builds the full system prompt: system instructions + relevant knowledge pages + dynamic context.
 * System instructions are ALWAYS included regardless of the query.
 *
 * @param {string} query - The user's question
 * @returns {string} Complete system prompt
 */
function getRelevantKnowledge(query) {
  const relevantPages = retrieveContext(query);
  return SYSTEM_INSTRUCTIONS + '\n\n---\n\n# Knowledge Base (relevant sections)\n\n' + relevantPages;
}

module.exports = { SYSTEM_PROMPT, SYSTEM_INSTRUCTIONS, initKnowledge, getRelevantKnowledge };
