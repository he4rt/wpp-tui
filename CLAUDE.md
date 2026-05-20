# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev                          # dev server with hot reload (tsx --watch)
pnpm build                        # production build (tsup, ESM)
pnpm typecheck                    # type check without emitting
make extract-payload              # extract structured data from logs (today)
make extract-payload DATE=2026-05-20  # specific date
```

Optional: `WEBHOOK_URL=https://... pnpm dev` to forward all events to a webhook.

## Architecture

This is a WhatsApp TUI client — a terminal interface that connects to WhatsApp via Baileys (WhatsApp Web reverse-engineered protocol) and renders with Ink (React for terminal).

### Data flow

```
WhatsApp servers
  ↓ (WebSocket via Baileys)
use-socket.ts hook ← manages connection, auth, reconnect
  ↓ emits events
  ├→ event-logger.ts    → logs/<event>/<date>.json (raw persistence)
  ├→ message-store.ts   → logs/message-store/<id>.json (for poll decryption)
  ├→ React state        → messages[], chats[], pollResults{}, debugEvents[]
  └→ group-cache.ts     → logs/group-metadata.json (fetched once via API)

React state
  ↓
app.tsx (tab router + keyboard)
  ├→ Chat tab:  chat-list.tsx + message-feed.tsx
  ├→ Stats tab: stats-view.tsx (computed from messages[])
  └→ Debug tab: debug-view.tsx (from debugEvents[])
```

### Key design decisions

**History from logs, not Baileys sync**: On startup, `history.ts` reads `logs/messages.upsert/*.json` files to populate messages and chats. This means the app has history across restarts without depending on WhatsApp's history sync. Message deduplication uses a `Set<messageId>` ref.

**Poll decryption is manual**: Baileys' built-in poll decryption via `getMessage()` callback is unreliable. Instead, `poll-decrypt.ts` implements the full AES-256-GCM + HMAC-SHA256 decryption matching Baileys' internal algorithm. The `message-store.ts` persists every message to disk so the `messageSecret` from poll creation messages is always available.

**Group names cascade**: Group names resolve in priority: `group-metadata.json` cache > `groups.upsert` logs > `chats.upsert` logs > member pushNames fallback. On connect, `sock.groupMetadata(jid)` is called for all groups and cached.

**No real scroll in Ink**: Ink doesn't support `overflow: scroll`. Message feed uses `messages.slice(-maxLines)` windowing. Debug tab tracks `scrollOffset` manually with `↑↓` keys.

**Alternate screen**: The Ink app runs in `alternateScreen` mode with `incrementalRendering` — like vim/htop. Pino logger writes to file only, never stdout.

### Extraction pipeline

`scripts/extract.py` is a standalone Python script that reads raw logs and produces structured JSON. It has its own poll decryption implementation (Python, using `cryptography` library for AES-GCM). Run via `make extract-payload`.

### Baileys event types

The most important events for feature work:
- `messages.upsert` (type=notify): incoming messages — the main data source
- `messages.reaction`: emoji reactions (separate from upsert)
- `chats.update`: chat metadata (unread count, last message preview)
- `groups.upsert` / `chats.upsert`: only fired for new groups during initial sync
- `presence.update`: typing indicators (`composing`, `available`)
- `connection.update`: connection lifecycle (`connecting` → `open` → `close`)

### JID types

- `@s.whatsapp.net`: phone number (DM)
- `@g.us`: group
- `@lid`: linked ID (WhatsApp's internal user identifier, independent of phone)
- `@broadcast`: broadcast list
- `@newsletter`: channel/community
