# wpp-tui

WhatsApp TUI client built with [Baileys](https://github.com/WhiskeySockets/Baileys) + [Ink](https://github.com/vadimdemedes/ink) (React for terminal).

Real-time chat, poll vote decryption, event logging, and payload extraction.

## Quick Start

```bash
pnpm install
pnpm dev
```

Scan the QR code with WhatsApp > Settings > Linked Devices. On subsequent runs it reconnects automatically.

## Screenshots

```
┌─ WA Bot | [1:Chat]  2:Stats   3:Debug ──── ● danielzin ─┐
├─ CHATS ──────────────────────┐┌─ MESSAGES — General ─────┐
│ > # General            (343) ││ 18:36 danielhe4rt  eae   │
│   # He4rt Delas 💕      (52) ││ 18:37 Clinton      oi    │
│   # Vagas             (343) ││ 18:37 Bruna     🖼️ sticker│
│   # He4rt Developers   (89) ││ 18:38 danielhe4rt  📊 PHP │
│   @ danielhe4rt              ││   ■ Sim!! (3)            │
│                              ││   □ Não (correto) (5)    │
│                              ││ 18:39 Mina    🗳️ → Sim   │
└──────────────────────────────┘└──────────────────────────┘
┌─ > Message General... or /help ──────────────────────────┐
```

## Features

### TUI (Ink + React)

- **3 tabs**: Chat, Stats, Debug — cycle with `Tab` or `/chat`, `/stats`, `/debug`
- **Chat tab**: sidebar with groups (`#`) and DMs (`@`), message feed with auto-scroll
- **Stats tab**: top senders bar chart, message type distribution, group activity
- **Debug tab**: real-time event stream with scroll, connection info, store counters
- **QR code** rendered inline in the terminal
- **Message history** loaded from logs on startup
- **Group metadata** fetched via WhatsApp API and cached to disk
- **Poll decryption**: votes decrypted with AES-256-GCM + HMAC-SHA256, shown per-user

### Event Logging

Every WhatsApp event is persisted to `logs/<event>/<date>.json` with timestamps. Supported events:

| Event | Description |
|---|---|
| `messages.upsert` | Incoming/outgoing messages |
| `messages.update` | Delivery/read status changes |
| `messages.reaction` | Emoji reactions |
| `chats.update` | Chat metadata changes |
| `presence.update` | Typing/online indicators |
| `message-receipt.update` | Read receipts |
| `contacts.update` | Contact name changes |
| `group.member-tag.update` | Group member tags/roles |
| `connection.update` | Connection state changes |
| `creds.update` | Auth credential updates |

### Payload Extraction (`make extract-payload`)

Parses raw logs into structured JSON files in `extracted/<date>/`:

| File | Content |
|---|---|
| `messages.json` | All messages with parsed content |
| `users.json` | Users with phone, name, groups |
| `groups-full.json` | Group metadata, admins, description, member tags |
| `reactions.json` | Emoji reactions per message, top emojis, top reactors |
| `threads.json` | Reply chains, most quoted messages |
| `polls.json` | Decrypted poll results with voter names |
| `member-profiles.json` | Users with group tags, admin status, activity breakdown |
| `activity.json` | Messages per hour, media breakdown, conversation starters |
| `stickers.json` | Sticker metadata (animated, AI, lottie) |
| `receipts.json` | Read/delivery timestamps |
| `presence.json` | Typing/online events |
| `timeline.json` | Unified chronological feed |
| `stats.json` | Summary statistics |

### Webhook Proxy

Optionally forward all events to an external webhook:

```bash
WEBHOOK_URL=https://your-webhook.example.com pnpm dev
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Tab` | Cycle tabs |
| `↑↓` | Navigate chats (Chat tab) / Scroll (Debug tab) |
| `Ctrl+Q` | Quit |
| `/chat` | Switch to Chat tab |
| `/stats` | Switch to Stats tab |
| `/debug` | Switch to Debug tab |
| `/quit` | Quit |

## Scripts

```bash
pnpm dev              # dev server with hot reload
pnpm build            # production build with tsup
pnpm start            # run production build
pnpm typecheck        # type check without emitting
make extract-payload  # extract structured data from logs
```

## Project Structure

```
src/
├── index.tsx              # entry point — renders Ink app
├── app.tsx                # tab system, keyboard handling, layout
├── types.ts               # shared TypeScript types
├── logger.ts              # pino logger (file output)
├── event-logger.ts        # persists raw events to disk + optional webhook
├── history.ts             # loads message history from logs on startup
├── message-store.ts       # persists raw messages for poll decryption
├── group-cache.ts         # caches group metadata to disk
├── poll-decrypt.ts        # AES-256-GCM poll vote decryption
├── hooks/
│   └── use-socket.ts      # React hook wrapping Baileys socket
└── components/
    ├── header.tsx          # status bar with tab navigation
    ├── chat-list.tsx       # sidebar with groups/DMs
    ├── message-feed.tsx    # message display with poll results
    ├── input-bar.tsx       # text input with commands
    ├── qr-view.tsx         # QR code renderer
    ├── stats-view.tsx      # statistics dashboard
    └── debug-view.tsx      # real-time event log

scripts/
└── extract.py             # payload extraction with poll decryption
```

## Tech Stack

- **Runtime**: Node.js 24+ / tsx
- **WhatsApp**: [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) 7.0
- **TUI**: [Ink](https://github.com/vadimdemedes/ink) 7 + React 19 + [@inkjs/ui](https://github.com/vadimdemedes/ink-ui)
- **Build**: tsup + TypeScript 6
- **Logging**: pino
- **Extraction**: Python 3

## License

ISC
