# LLM Quota Tracker & Smart Switcher

A real-time Web & Desktop Tray application for tracking usage limits (`% used`) across **Antigravity (Google Gemini)**, **Claude (Anthropic)**, and **Codex (OpenAI)**, with automatic rate-limit header syncing, local log watching, smart model routing, and 429 auto-failover proxy.

## Features

- **Unified `% used` Progress Bars:** All 3 providers normalized to Claude-style horizontal bars that shift **Blue → Amber → Red** as usage approaches 100%.
- **Real Account Connectors (`src/connectors.js`):**
  - **Claude (Anthropic):** Connects via `ANTHROPIC_API_KEY`, validates models, and parses `anthropic-ratelimit-*` headers + watches `~/.claude`.
  - **Codex (OpenAI):** Connects via `OPENAI_API_KEY`, validates models, and parses `x-ratelimit-*` headers + tracks `Full reset` tickets + watches `~/.codex`.
  - **Antigravity (Google Gemini):** Connects via `GEMINI_API_KEY` + watches `~/.gemini` JSONL transcripts for 5-hour and 7-day activity.
- **Unified Local LLM Proxy (`/proxy/v1/chat/completions`):**
  - Point Cursor, Continue, Cline, or any OpenAI-compatible client to `http://localhost:3456/proxy/v1/chat/completions`.
  - Automatically routes to the healthiest provider, updates `% used` live from real HTTP response headers, and **auto-fails over** on `HTTP 429`.
- **Smart Auto-Router & Context Handoff:** Recommends the best model for your task type and generates a copy-ready Markdown Handoff Prompt when switching mid-task.

## Quick Start (Web App)

```bash
node server.js
# Open http://localhost:3456
```

Click **Connect Accounts & Proxy** in the top bar to enter your API keys (stored locally in `data/accounts.json` and masked in the UI) and click **Sync Now**.

## Optional: Run as Desktop Tray App (Electron)

```bash
npm install --save-dev electron
npx electron desktop/electron-main.js
```

## Run Tests

```bash
npm test
```
