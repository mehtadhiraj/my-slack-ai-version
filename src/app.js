require('dotenv').config();

const { App, LogLevel } = require('@slack/bolt');
const { SocketModeClient } = require('@slack/socket-mode');
const Anthropic = require('@anthropic-ai/sdk').default;
const { spawn } = require('child_process');
const express = require('express');
const { initKnowledge, getRelevantKnowledge } = require('./knowledge');
const { saveLearning, getDynamicContext } = require('./learnings');

/** Env vars for claude-code subprocess — exclude ANTHROPIC_API_KEY so it uses subscription auth */
const claudeCodeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'ANTHROPIC_API_KEY')
);

/** Path to claude binary — use local node_modules first, fall back to global */
const CLAUDE_BIN = require('fs').existsSync(require('path').join(__dirname, '..', 'node_modules', '.bin', 'claude'))
  ? require('path').join(__dirname, '..', 'node_modules', '.bin', 'claude')
  : 'claude';

// ── Initialization ──────────────────────────────────────────────────────────

const socketModeClient = new SocketModeClient({
  appToken: process.env.SLACK_APP_TOKEN,
  clientPingTimeout: 30000,
  serverPingTimeout: 60000,
  pingPongLoggingEnabled: false,
});

// Log WebSocket lifecycle events for debugging connectivity issues
socketModeClient.on('connected', () => console.log('[socket] Connected to Slack'));
socketModeClient.on('connecting', () => console.log('[socket] Connecting to Slack...'));
socketModeClient.on('disconnected', () => console.log('[socket] Disconnected from Slack'));
socketModeClient.on('reconnecting', () => console.log('[socket] Reconnecting to Slack...'));
socketModeClient.on('error', (err) => console.error('[socket] Error:', err.message));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
  socketModeClient,
});

/** Author's Slack user ID and name from env */
const AUTHOR_USER_ID = process.env.AUTHOR_SLACK_USER_ID;
const AUTHOR_NAME = process.env.AUTHOR_NAME || 'Author';

/** Bot's own user ID, resolved at startup */
let BOT_USER_ID = null;

/** Track message timestamps we've already processed to prevent loops */
const processedMessages = new Set();

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts standard Markdown to Slack mrkdwn format.
 *
 * Slack uses its own markup syntax that differs from Markdown:
 * - Bold: *text* (not **text**)
 * - Italic: _text_ (not *text*)
 * - Strikethrough: ~text~ (not ~~text~~)
 * - Links: <url|text> (not [text](url))
 * - Headers: *text* bold on its own line (no # support)
 *
 * @param {string} text - Standard Markdown text
 * @returns {string} Slack mrkdwn formatted text
 */
function toSlackMrkdwn(text) {
  return text
    // Headers → bold lines (must come before bold conversion)
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // Images: ![alt](url) → <url|alt> (already handled by link regex, but strip !)
    .replace(/!<([^>]+)>/g, '<$1>')
    // Bold + italic: ***text*** or ___text___ → *_text_*
    .replace(/\*{3}(.+?)\*{3}/g, '*_$1_*')
    // Bold: **text** → *text*
    .replace(/\*{2}(.+?)\*{2}/g, '*$1*')
    // Italic: *text* → _text_ (only single *, not inside bold)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~(.+?)~~/g, '~$1~')
    // Horizontal rules → divider line
    .replace(/^---+$/gm, '———');
}

/**
 * Runs a quick classification prompt via Claude Code CLI.
 *
 * @param {string} systemPrompt - The classification instruction
 * @param {string} text - The text to classify
 * @returns {Promise<string>} The model's response
 */
async function classifyWithClaudeCode(systemPrompt, text) {
  const model = process.env.CLAUDE_CODE_MODEL || 'sonnet';
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--output-format', 'text', '--model', model,
    ], { env: claudeCodeEnv, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });

    proc.stdin.write(systemPrompt + '\n\nMessage: ' + text);
    proc.stdin.end();

    const timeout = setTimeout(() => { proc.kill(); reject(new Error('claude-code classify timeout')); }, 30000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`claude-code exited ${code}`));
      resolve(stdout.trim());
    });
    proc.on('error', reject);
  });
}

/**
 * Checks whether a message is seeking help/asking a question.
 * Uses the AI provider for a quick yes/no classification.
 *
 * @param {string} text - The cleaned message text
 * @returns {Promise<boolean>} True if the message is seeking help
 */
async function isSeekingHelp(text) {
  const classifyPrompt =
    'You are a message classifier. Determine if the following message is seeking help, asking a question, requesting information, asking someone to share something (like docs, links, APIs, details), or needs a response from a knowledgeable person. Messages like "please share", "can you share", "share the docs", "send me the link" are ALL help requests. Reply with ONLY "yes" or "no", nothing else.';

  const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();

  try {
    if (provider === 'ollama') {
      const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL || 'llama3.2';

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: classifyPrompt },
            { role: 'user', content: text },
          ],
          stream: false,
          keep_alive: '30m',
        }),
      });

      const data = await res.json();
      return data.message.content.trim().toLowerCase().startsWith('yes');
    }

    if (provider === 'claude-code') {
      const result = await classifyWithClaudeCode(classifyPrompt, text);
      return result.trim().toLowerCase().startsWith('yes');
    }

    const anthropic = new Anthropic();
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

    const response = await anthropic.messages.create({
      model,
      max_tokens: 10,
      system: classifyPrompt,
      messages: [{ role: 'user', content: text }],
    });
    return response.content[0].text.trim().toLowerCase().startsWith('yes');
  } catch (error) {
    console.error('[intent] Classification failed, allowing message:', error.message);
    return true; // fail-open: respond if classification fails
  }
}

/**
 * Calls the configured AI provider to answer a billing/subscription question.
 *
 * Provider is selected via the AI_PROVIDER env var (read at call time):
 * - "anthropic" (default) — uses @anthropic-ai/sdk with ANTHROPIC_MODEL
 * - "ollama" — calls the local Ollama HTTP API with OLLAMA_MODEL
 *
 * @param {Array<{role: string, content: string}>} messages - Conversation history (role: 'user' | 'assistant')
 * @param {string} query - The current user question, used to find relevant learnings
 * @returns {Promise<string|null>} The AI response text, or null on error
 */
async function callAI(messages, query) {
  const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  const knowledgeContext = getRelevantKnowledge(query);
  const systemPrompt = knowledgeContext + getDynamicContext(query);

  try {
    if (provider === 'ollama') {
      const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL || 'llama3.2';

      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages,
          ],
          stream: false,
          keep_alive: '30m',
          options: {
            num_ctx: parseInt(process.env.OLLAMA_NUM_CTX, 10) || 16384,
          },
        }),
      });

      const data = await res.json();
      return data.message.content;
    }

    if (provider === 'claude-code') {
      const model = process.env.CLAUDE_CODE_MODEL || 'sonnet';

      // Build full prompt: system context + thread conversation + current question
      const threadContext = messages.length > 1
        ? '\n\n[Previous messages in this thread for context only — do NOT repeat or echo these]\n' + messages.slice(0, -1).map((m) => `[${m.role === 'user' ? 'them' : 'you'}]: ${m.content}`).join('\n') + '\n[End of thread context]\n'
        : '';
      const currentQuestion = messages[messages.length - 1]?.content || query;
      const fullPrompt = systemPrompt + threadContext + '\n\nRespond to this message:\n' + currentQuestion;

      const result = await new Promise((resolve, reject) => {
        const proc = spawn(CLAUDE_BIN, [
          '-p',
          '--output-format', 'json',
          '--model', model,
        ], {
          env: claudeCodeEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        // Pass the full prompt via stdin (avoids arg length limits)
        proc.stdin.write(fullPrompt);
        proc.stdin.end();

        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error('claude-code timed out after 120s'));
        }, 120000);

        proc.on('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0) return reject(new Error(`claude-code exited with code ${code}: ${stderr.slice(0, 200)}`));
          try {
            const parsed = JSON.parse(stdout);
            resolve(parsed.result || parsed.content || stdout);
          } catch {
            resolve(stdout.trim());
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      return result;
    }

    // Default: Anthropic
    const anthropic = new Anthropic();
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

    const response = await anthropic.messages.create({
      model,
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    });
    return response.content[0].text;
  } catch (error) {
    console.error(`AI API error (${provider}):`, error.message);
    return null;
  }
}

/**
 * Shared handler for all incoming messages.
 * Strips mentions, calls the AI provider, and posts the reply in-thread.
 *
 * @param {Object} opts
 * @param {string} opts.text - Raw message text from Slack
 * @param {string} opts.messageTs - Original message timestamp (for dedup)
 * @param {string} opts.threadTs - Thread timestamp to reply in
 * @param {string} opts.channelId - Channel to post in
 * @param {import('@slack/bolt').SayFn} opts.client - Slack Web API client
 * @param {string} [opts.prefix=''] - Optional prefix prepended to the reply
 * @param {boolean} [opts.skipIntentCheck=false] - Skip the isSeekingHelp check (e.g. for DMs)
 */
async function handleMessage({ text, messageTs, threadTs, channelId, client, prefix = '', skipIntentCheck = false }) {
  // Prevent processing the same message twice (e.g. event delivered to multiple listeners)
  if (processedMessages.has(messageTs)) {
    console.log(`[dedup] Already processed message ${messageTs}, skipping`);
    return;
  }
  processedMessages.add(messageTs);

  // Cap the set size to prevent memory leaks
  if (processedMessages.size > 1000) {
    const oldest = processedMessages.values().next().value;
    processedMessages.delete(oldest);
  }

  // Strip all Slack user mentions (<@UXXXXXX>) from the text
  const cleaned = (text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!cleaned) return;

  // Only respond if the message is seeking help (skip for DMs — intent is clear)
  if (!skipIntentCheck) {
    const needsHelp = await isSeekingHelp(cleaned);
    if (!needsHelp) {
      console.log(`[skipped] Not a help request: "${cleaned.slice(0, 80)}"`);
      return;
    }
  }

  console.log(`[request] channel=${channelId} thread=${threadTs} text="${cleaned}"`);

  const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  console.log(`[processing] Calling ${provider}...`);

  let statusMsg;

  try {
    // Fetch thread history to build conversation context
    const messages = [];
    try {
      const history = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 50,
      });

      // Skip status/thinking messages from thread history
      const statusTexts = new Set([
        ':parrot_beer: Thinking...',
      ]);

      for (const msg of history.messages || []) {
        if (msg.subtype) continue;
        if (statusTexts.has(msg.text)) continue;
        const msgText = (msg.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
        if (!msgText) continue;

        // Truncate long messages in thread history to prevent context pollution
        // (e.g., curl commands, code blocks dominating the context)
        const truncated = msgText.length > 500 ? msgText.slice(0, 500) + '...' : msgText;

        if (msg.bot_id || msg.user === BOT_USER_ID) {
          messages.push({ role: 'assistant', content: truncated });
        } else {
          messages.push({ role: 'user', content: truncated });
        }
      }

      // Keep only the last 10 messages to avoid context overload
      if (messages.length > 10) {
        messages.splice(0, messages.length - 10);
      }
    } catch (err) {
      console.error('[warn] Could not fetch thread history:', err.message);
      // Fall back to just the current message
      messages.push({ role: 'user', content: cleaned });
    }

    // Ensure the latest message is included (in case thread fetch missed it)
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.content !== cleaned) {
      messages.push({ role: 'user', content: cleaned });
    }

    statusMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ':parrot_beer: Thinking...',
    });

    const response = await callAI(messages, cleaned);
    console.log(`[ai-response] provider=${provider} length=${response ? response.length : 0} preview="${(response || '').slice(0, 100)}"`);

    if (!response) {
      console.error(`[error] ${provider} returned no response for channel=${channelId} thread=${threadTs}`);
      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: `Sorry, I couldn't generate a response. Please tag <@${AUTHOR_USER_ID}> directly.`,
      });
      return;
    }

    const SLACK_MAX_CHARS = 3900;
    const fullText = prefix + toSlackMrkdwn(response);

    if (fullText.length <= SLACK_MAX_CHARS) {
      const updateResult = await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: fullText,
      });
      if (!updateResult.ok) {
        console.error(`[error] chat.update failed: ${updateResult.error}`);
      }
    } else {
      // Split into chunks at paragraph boundaries, send first as update, rest as new messages
      const chunks = [];
      let remaining = fullText;
      while (remaining.length > 0) {
        if (remaining.length <= SLACK_MAX_CHARS) {
          chunks.push(remaining);
          break;
        }
        // Find last newline within limit to avoid splitting mid-sentence
        let splitAt = remaining.lastIndexOf('\n', SLACK_MAX_CHARS);
        if (splitAt < SLACK_MAX_CHARS * 0.5) splitAt = SLACK_MAX_CHARS;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
      }

      // Update the thinking message with the first chunk
      const updateResult = await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: chunks[0],
      });
      if (!updateResult.ok) {
        console.error(`[error] chat.update (chunk 0) failed: ${updateResult.error}`);
      }

      // Send remaining chunks as follow-up messages in the thread
      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: chunks[i],
        });
      }
    }

    console.log(`[responded] channel=${channelId} thread=${threadTs} provider=${provider} chunks=${Math.ceil(fullText.length / SLACK_MAX_CHARS)}`);
  } catch (error) {
    console.error(`[error] handleMessage failed: ${error.message}`);

    const errorText = `:x: Something went wrong while processing your request. Please tag <@${AUTHOR_USER_ID}> directly.\n_Error: ${error.message.slice(0, 200)}_`;

    try {
      if (statusMsg) {
        await client.chat.update({
          channel: channelId,
          ts: statusMsg.ts,
          text: errorText,
        });
      } else {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: errorText,
        });
      }
    } catch (postErr) {
      console.error(`[error] Failed to post error message to Slack: ${postErr.message}`);
    }
  }
}

// ── Learner: capture author's messages as knowledge ─────────────────────────
app.event('message', async ({ event }) => {
  console.log(`[debug] message event: channel=${event.channel} user=${event.user} type=${event.channel_type} text="${(event.text || '').slice(0, 100)}"`);

  if (event.subtype || event.bot_id) return;

  // Author's messages → save as learning ONLY if they tag the bot and say "store/save/remember/learn/note/add this"
  if (event.user === AUTHOR_USER_ID) {
    const text = event.text || '';
    const mentionsBot = BOT_USER_ID && text.includes(`<@${BOT_USER_ID}>`);
    if (!mentionsBot) return;

    const storeCommands = /\b(store this|save this|remember this|learn this|note this|add this)\b/i;
    if (!storeCommands.test(text)) return;

    // Strip bot mentions, then extract the actual content
    // Supports any format: "save this: text", "text\nsave this.", "save this:\ntext", etc.
    let cleaned = text.replace(/<@[A-Z0-9]+>/g, '');

    // Remove ALL occurrences of the store command (could appear anywhere)
    cleaned = cleaned.replace(/\b(store this|save this|remember this|learn this|note this|add this)\b[.:;,\-—]?\s*/gi, '');

    cleaned = cleaned.trim();

    if (cleaned.length < 10) {
      console.log(`[learnings] Skipped (no content after command): "${cleaned}"`);
      return;
    }

    saveLearning({ text: cleaned, channel: event.channel, ts: event.ts });
    console.log(`[learnings] Stored: "${cleaned.slice(0, 100)}"`);
    return;
  }

  // Instruction capture for @author mentions is handled in Listener 2
});

// ── Listener 1: Bot directly @mentioned in a channel ────────────────────────

/**
 * Fires when the bot is explicitly @mentioned in any channel.
 */
app.event('app_mention', async ({ event, client }) => {
  // Skip store/save commands — these are handled by the learner listener
  const storePattern = /\b(store this|save this|remember this|learn this|note this|add this)\b/i;
  if (storePattern.test(event.text || '')) {
    console.log(`[skipped] Store command, not sending to AI`);
    return;
  }

  await handleMessage({
    text: event.text,
    messageTs: event.ts,
    threadTs: event.thread_ts || event.ts,
    channelId: event.channel,
    client,
    prefix: '',
  });
});

// ── Listener 2: @Author mentioned in any channel or thread ──────────────────

/**
 * Fires when someone mentions the author in a channel.
 * The bot responds on their behalf with a delegation prefix.
 * Skips if the author sent the message, or if it's a DM.
 *
 * NOTE: This must be registered before the catch-all DM listener below,
 * because Bolt stops the middleware chain once a pattern-less app.message
 * listener matches — placing it after would prevent this from ever firing.
 */
app.message(new RegExp(`<@${AUTHOR_USER_ID}>`), async ({ message, client }) => {
  // Skip bot messages, but allow file_share and other user-initiated subtypes
  if (message.bot_id) {
    console.log(`[discarded] @author mention — bot message: channel=${message.channel}`);
    return;
  }
  // Skip system subtypes (edits, joins, etc.) but allow file_share, thread_broadcast
  const allowedSubtypes = new Set(['file_share', 'thread_broadcast', undefined, null]);
  if (message.subtype && !allowedSubtypes.has(message.subtype)) {
    console.log(`[discarded] @author mention — subtype ${message.subtype}: channel=${message.channel}`);
    return;
  }

  const cleaned = (message.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!cleaned) return;

  await handleMessage({
    text: message.text,
    messageTs: message.ts,
    threadTs: message.thread_ts || message.ts,
    channelId: message.channel,
    client,
    prefix: `*${AUTHOR_NAME} Assistant responding on behalf of <@${AUTHOR_USER_ID}> :*\n\n`,
  });
});

// ── Listener 3: Bot receives a Direct Message ───────────────────────────────

/**
 * Fires when someone sends a DM directly to the bot.
 * Skips bot messages and subtypes (edits, joins, etc.).
 */
app.message(async ({ message, client }) => {
  console.log(`[dm-listener] Entered: channel=${message.channel} user=${message.user} type=${message.channel_type} subtype=${message.subtype} bot_id=${message.bot_id} text="${(message.text || '').slice(0, 50)}"`);

  if (message.bot_id) {
    console.log(`[discarded] DM — bot message: channel=${message.channel}`);
    return;
  }
  if (message.subtype && !['file_share', 'thread_broadcast'].includes(message.subtype)) {
    console.log(`[discarded] DM — subtype ${message.subtype}: channel=${message.channel}`);
    return;
  }
  // Accept both 1:1 DMs (im) and group DMs (mpim) where the bot is a participant
  const isDM = message.channel_type === 'im' || message.channel_type === 'mpim';
  if (!isDM) {
    console.log(`[discarded] DM listener — not a DM: channel=${message.channel} type=${message.channel_type}`);
    return;
  }

  await handleMessage({
    text: message.text,
    messageTs: message.ts,
    threadTs: message.thread_ts || message.ts,
    channelId: message.channel,
    client,
    prefix: '',
    skipIntentCheck: true,
  });
});

// ── Health Check ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const healthApp = express();

/**
 * GET /health — simple liveness probe.
 * Returns bot name, status, and uptime in seconds.
 */
healthApp.get('/health', (_req, res) => {
  res.json({ status: 'ok', bot: `${AUTHOR_NAME}-assistant`, uptime: process.uptime() });
});

// ── Start ───────────────────────────────────────────────────────────────────

(async () => {
  // Build page index for knowledge retrieval
  initKnowledge();

  // Verify claude-code auth if using claude-code provider
  if ((process.env.AI_PROVIDER || '').toLowerCase() === 'claude-code') {
    const { execFileSync } = require('child_process');
    try {
      const status = JSON.parse(execFileSync(CLAUDE_BIN, ['auth', 'status', '--json'], {
        env: claudeCodeEnv,
        timeout: 10000,
      }).toString());
      console.log(`[claude-code] Auth: ${status.authMethod} (${status.email || 'no email'}) subscription: ${status.subscriptionType || 'none'}`);
    } catch (err) {
      console.error('[claude-code] Auth check failed — run "claude auth login" on this machine first:', err.message);
    }
  }

  await app.start();

  // Resolve the bot's own user ID for thread history parsing
  const authResult = await app.client.auth.test();
  BOT_USER_ID = authResult.user_id;

  console.log(`⚡️ ${AUTHOR_NAME} Assistant is running in Socket Mode!`);
  console.log('   Active listeners:');
  console.log('   1. Bot @mention in channels');
  console.log('   2. Direct Messages');
  console.log(`   3. @${AUTHOR_NAME} delegation`);
  console.log('   4. Thread replies');

  healthApp.listen(PORT, () => {
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
  });
})();
