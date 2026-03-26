# AI Assistant Slack Bot

An AI-powered Slack bot that acts as your AI version on Slack — answering questions from your team on your behalf using a knowledge base and learnings you provide. Supports three AI providers: Anthropic Claude, Ollama (local/free), and Claude Code.

---

## How the Bot Behaves

The bot responds to messages in four scenarios:

1. **Direct @mention** — Someone @mentions the bot in any channel
2. **Direct Message** — Someone DMs the bot directly (skips intent check — always responds)
3. **Author delegation** — Someone @mentions the author (configured via `AUTHOR_SLACK_USER_ID`) in any channel; the bot responds on their behalf
4. **Thread replies** — All of the above work within threads, maintaining conversation context

### Intent Classification

For channel messages (not DMs), the bot first checks if the message is seeking help using the AI provider. If the message is casual or not a question, the bot stays silent.

### Learnings — How Data is Saved

The bot can learn from the author's messages. To save a learning, the author must:

1. Tag the bot in a message
2. Include a save command: `store this`, `save this`, `remember this`, `learn this`, `note this`, or `add this`

**Supported formats:**
```
@Bot save this: billing cron runs at 2am IST daily
@Bot save this:
line 1
line 2
line 3
some context here @Bot store this
@Bot remember this - wallet auto-recharge threshold is 500 INR
```

The bot strips the command and bot mention, then saves the actual content to `data/learnings.md`. Multi-line messages are preserved.

Learnings are read fresh from disk on every query — no restart needed after saving new learnings.

### Fallback Behavior

If the bot cannot find relevant information in the knowledge base or learnings, it tags the author and says it doesn't have relevant context. It never guesses or gives partial answers, this behaviour depends on how you add system prompts.

---

## Project Structure

```
.
├── src/
│   ├── app.js          # Main bot — Slack listeners, message handling, AI calls
│   ├── knowledge.js    # Loads system prompt + knowledge, provides getRelevantKnowledge()
│   ├── embeddings.js   # Page indexing engine — TF-IDF search over knowledge base
│   └── learnings.js    # Read/write learnings from data/learnings.md
├── data/
│   ├── system-prompt.md  # AI system instructions (always sent to LLM)
│   ├── knowledge.md      # Domain knowledge base (indexed and searched per query)
│   ├── learnings.md      # Author's saved learnings (runtime, created automatically)
│   └── samples/          # Sample files for reference
│       ├── system-prompt.sample.md
│       ├── knowledge.sample.md
│       └── learnings.sample.md
├── .env.example
├── package.json
└── README.md
```

---

## Data Files (`data/` folder)

### `data/system-prompt.md` — AI Instructions

The system prompt is **always** sent to the LLM on every request. It defines:
- Bot identity and behavior rules
- Response style (short, concise, no documentation references)
- Fallback rules (when to tag the author)
- Answering strategy and edge case handling

Edit this file to change how the bot behaves. See `data/samples/system-prompt.sample.md` for a template.

### `data/knowledge.md` — Knowledge Base

The domain knowledge base. Contains all the technical documentation the bot should know — APIs, endpoints, payloads, business logic, FAQs, etc.

**How it's indexed:** At startup, the file is split into sections by `#` (h1) headings. Each section (including its `##` subsections) becomes a searchable "page". When a query comes in, TF-IDF scoring finds the most relevant pages and only those are sent to the LLM.

**Best practices:**
- Use `#` headings to separate major topics (e.g., `# Subscription API`, `# Billing Logic`)
- Use `##` for subsections within a topic — they stay grouped with their parent
- Keep each `#` section focused on one topic for better retrieval
- Include FAQs only if they add info not already in the main content

See `data/samples/knowledge.sample.md` for a template.

### `data/learnings.md` — Author's Learnings

Runtime file that stores learnings saved by the author via Slack. Created automatically on first save. Each entry is a single line:

```
- [2026-03-25] [1774426628.561909] The actual learning content here
```

Multi-line learnings use `␤` as a newline delimiter (restored when read).

See `data/samples/learnings.sample.md` for a template.

---

## Indexing & Retrieval — How It Works

The bot uses **TF-IDF (Term Frequency-Inverse Document Frequency)** for knowledge retrieval. No external services or embedding models required.

### How it works:

1. **Startup** — `knowledge.md` is split into pages by `#` headings. Each page is tokenized and an inverted index is built in memory.
2. **Query time** — The user's question is tokenized, expanded with domain-specific terms, and scored against the index.
3. **Scoring** — TF-IDF scores + title-match bonus (pages whose title contains query terms get boosted).
4. **Result** — Top 8 pages (up to 20K chars) are returned as context to the LLM.

### Domain expansions

Vague queries are expanded with related terms. For example, "billing docs" expands to include `billing, cycle, payment, invoice, prepaid, postpaid, wallet, charge`. Edit the `DOMAIN_EXPANSIONS` array in `src/embeddings.js` to customize.

### Customizing the indexing

To implement your own retrieval method:

1. **`src/embeddings.js`** — Replace `parseSections()`, `initIndex()`, and `retrieveContext()` with your own logic. The contract is:
   - `initIndex()` — called once at startup
   - `retrieveContext(query)` — called per query, returns a string of relevant knowledge
2. **`src/knowledge.js`** — `getRelevantKnowledge(query)` assembles the final prompt. Modify this if you want to change how system instructions + knowledge + learnings are combined.

---

## Slack App Setup

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app from scratch.

### 2. Enable Socket Mode

- Go to **Socket Mode** in the sidebar and toggle it on
- Generate an **App-Level Token** with `connections:write` scope — this is your `SLACK_APP_TOKEN`

### 3. Add Bot Token Scopes

Under **OAuth & Permissions -> Scopes -> Bot Token Scopes**, add:

- `app_mentions:read`
- `chat:write`
- `channels:history`
- `groups:history`
- `mpim:history`
- `im:history`
- `im:write`
- `files:read`

### 4. Subscribe to Events

Under **Event Subscriptions**, enable events and subscribe to:

- `app_mention`
- `message.im`
- `message.channels`
- `message.groups`
- `message.mpim`

### 5. Install the App

Install the app to your workspace. Copy the **Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN`. The **Signing Secret** is on the **Basic Information** page.

### 6. Add Bot to Channels

The bot can only see messages in channels it's a member of. Invite it:
```
/invite @YourBotName
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required | Description | Where to get it |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (`xoxb-...`) | Slack App -> OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | Yes | Signing secret for request verification | Slack App -> Basic Information |
| `SLACK_APP_TOKEN` | Yes | App-level token for Socket Mode (`xapp-...`) | Slack App -> Basic Information -> App-Level Tokens |
| `ANTHROPIC_API_KEY` | If using Anthropic | API key for Claude | [console.anthropic.com](https://console.anthropic.com) -> API Keys |
| `AUTHOR_SLACK_USER_ID` | Yes | Slack user ID of the person the bot delegates for | Slack -> Click on profile -> Copy member ID |
| `AUTHOR_NAME` | Yes | Display name used in bot responses | Your name (e.g., `Dhiraj`) |
| `AI_PROVIDER` | No | AI provider: `anthropic`, `ollama`, or `claude-code` | Default: `anthropic` |
| `ANTHROPIC_MODEL` | No | Anthropic model ID | Default: `claude-sonnet-4-20250514` |
| `OLLAMA_MODEL` | No | Ollama model name | Default: `llama3.2` |
| `OLLAMA_BASE_URL` | No | Ollama server URL | Default: `http://localhost:11434` |
| `OLLAMA_NUM_CTX` | No | Ollama context window size | Default: `16384` |
| `CLAUDE_CODE_MODEL` | No | Claude Code model (`sonnet`, `opus`, `haiku`) | Default: `sonnet` |
| `PORT` | No | Health check server port | Default: `3000` |

---

## AI Providers

### Anthropic Claude (default)

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

Requires an API key with credits from [console.anthropic.com](https://console.anthropic.com).

### Ollama (free, local)

```
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.2:latest
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_NUM_CTX=16384
```

Setup:
```bash
brew install ollama
ollama pull llama3.2
ollama serve
```

### Claude Code (uses your Claude Code subscription)

```
AI_PROVIDER=claude-code
CLAUDE_CODE_MODEL=sonnet
```

Requires `@anthropic-ai/claude-code` installed globally (`npm install -g @anthropic-ai/claude-code`) and authenticated (`claude` CLI must be logged in).

---

## Running Locally

```bash
npm install
cp .env.example .env
# Fill in .env with your values
npm run dev
```

Health check: `http://localhost:3000/health`

---

## Source Files Reference

| File | Purpose |
|---|---|
| `src/app.js` | Main bot — Slack listeners, message handling, AI provider calls, learning capture |
| `src/knowledge.js` | Loads system prompt and knowledge base, assembles the final LLM prompt |
| `src/embeddings.js` | TF-IDF page indexing — section parsing, tokenization, query expansion, retrieval |
| `src/learnings.js` | Read/write learnings from `data/learnings.md`, build dynamic context |
