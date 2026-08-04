# FlyThai AI Database Assistant

A chat-based web app that reads directly from your live SQL Server database
(`arkinfo1_flythai`) and answers questions — Quotations, Bookings, Hotels, Job Sheets,
Accounts, Agents, Inquiries — all of it. It never makes up data; every answer is based
on a real SQL query result from the database.

## How it works
1. You ask a question in the chat.
2. The AI (via Groq's free API, running the open-source `qwen/qwen3.6-27b` model) converts that question into a safe `SELECT` query.
3. The server only allows `SELECT` queries — `INSERT/UPDATE/DELETE/DROP/ALTER/EXEC` etc.
   are blocked at the code level (`src/db.js`, `assertSafeSelect`), so the database stays 100% read-only.
4. The real query result is sent back to the AI, which writes a natural-language answer from that data.

## Setup (first time)

```bash
npm install
```

Database credentials are already in the `.env` file. One thing left to do:

### Add your Groq API key
1. Create an account at https://console.groq.com and generate an API key from "API Keys".
2. Open the `.env` file and paste your key after `GROQ_API_KEY=`.
3. `GROQ_MODEL` defaults to `qwen/qwen3.6-27b` — an open-source model with a generous free
   daily limit (~14,400 requests/day, no cost). You can swap in any other Groq model id if you like.

## Running it

```bash
npm start
```

Then open: **http://localhost:3500**

## Files
- `server.js` — Express server, `/api/chat` endpoint
- `src/db.js` — SQL Server connection + read-only safety guard
- `src/schema.js` — Database schema description given to the AI as context
- `src/llm.js` — Groq API caller
- `src/chat.js` — The full question → SQL → result → answer pipeline
- `public/` — Chat UI (plain HTML/CSS/JS, no framework)

## Notes
- This is a brand new, standalone page — completely separate from the existing admin
  panel shown earlier; nothing there was touched.
- This tool only reads data (read-only) — it never writes or changes anything in the database.
- Conversation history lives in server memory (cleared on restart) — fine for an internal tool.
