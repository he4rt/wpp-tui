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

## Modo headless

Para rodar o coletor como serviço 24/7 (sem TUI, ex.: num server via systemd),
use o **Modo headless**. Ele reaproveita o mesmo núcleo de conexão da TUI
(`startCollectorCore`, ver [`docs/adr/0001`](docs/adr/0001-collector-core-extraido-do-react.md)):
uma única fonte de verdade para os dois modos.

```bash
pnpm build              # gera dist/
pnpm start:headless     # = node --env-file-if-exists=.env dist/index.js --headless
```

O modo é ativado por `--headless` na linha de comando **ou** pela env
`HEADLESS=1` (aceita `1`/`true`/`yes`). Sem nenhum dos dois, o `dist/index.js`
sobe a TUI normalmente.

### Pré-provisionar a sessão (sem QR)

O headless **não exibe QR** nem faz pairing-code (ver
[`docs/adr/0002`](docs/adr/0002-headless-pre-provisiona-auth.md)). Ele exige uma
sessão já pareada:

1. Pareie **uma vez** no Modo TUI (`pnpm dev`) lendo o QR no celular.
2. Copie a pasta `baileys_auth_info/` para o `WorkingDirectory` do server:
   ```bash
   scp -r ./baileys_auth_info usuario@server:/opt/wpp-tui/baileys_auth_info
   ```

Se o headless receber um evento de QR (sinal de que não há sessão válida), ele
loga **FATAL** (`sem sessão válida; pré-provisione baileys_auth_info`) e sai com
código ≠ 0 — em vez de ficar gerando QRs num loop. Um `loggedOut` no server
também derruba o coletor: é preciso re-provisionar a sessão manualmente.

### Variáveis obrigatórias

No headless, `WEBHOOK_URL` **e** `WHATSAPP_WEBHOOK_SECRET` são **obrigatórias**.
Se faltar qualquer uma, o processo loga FATAL e sai com código ≠ 0 **antes** de
conectar (fail-fast). No Modo TUI o coletor continua opcional. Veja o
[`.env.example`](.env.example) para todas as variáveis.

### Logs (JSON na stdout)

O headless emite logs em **JSON na stdout** por padrão (ideal para journald).
Defina `LOG_PRETTY=1` para formato legível via `pino-pretty` (debug local).
Não escreve `wa-logs.txt` a menos que `WA_LOG_FILE` seja definido explicitamente.

Há **dois loggers**, controlados separadamente, e toda linha carrega um campo
`component` (`whatsapp` / `collector` / `retention` / `baileys`):

| Variável | Logger | Padrão |
|---|---|---|
| `LOG_LEVEL` | app / coletor | `info` |
| `BAILEYS_LOG_LEVEL` | protocolo Baileys (barulhento) | `warn` |

Se `LOG_RETENTION_DAYS` estiver ausente/0, o boot emite um **WARN** alertando
sobre crescimento ilimitado de disco.

### Deploy via systemd

Há uma unit pronta em [`deploy/whatsapp-collector.service`](deploy/whatsapp-collector.service)
(com comentários explicando cada diretiva e o passo de pré-provisionamento):

```bash
sudo cp deploy/whatsapp-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-collector

# Ler os logs (a saída JSON cai no journald):
journalctl -u whatsapp-collector -f
```

O sinal de saúde é a linha de **heartbeat** dos logs (não há endpoint HTTP
`/health` nesta versão).

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
pnpm start            # run production build (TUI)
pnpm start:headless   # run production build in headless mode (collector, no TUI)
pnpm typecheck        # type check without emitting
make extract-payload  # extract structured data from logs
```

## Project Structure

```
src/
├── index.tsx              # entry point — routes to TUI or headless (dynamic import)
├── app.tsx                # tab system, keyboard handling, layout
├── app-render.tsx         # TUI renderer (extracted from index.tsx for dynamic import)
├── headless.ts            # headless runner — bootstraps the collector core without UI
├── logging.ts             # logger factory (app + baileys loggers with component tags)
├── logger.ts              # legacy pino logger (file output, used by the TUI)
├── types.ts               # shared TypeScript types
├── event-logger.ts        # persists raw events to disk + optional webhook
├── history.ts             # loads message history from logs on startup
├── message-store.ts       # persists raw messages for poll decryption (TUI-only)
├── group-cache.ts         # caches group metadata to disk
├── poll-decrypt.ts        # AES-256-GCM poll vote decryption
├── retention.ts           # periodic cleanup of old raw logs
├── collector/
│   ├── core.ts            # collector core (connection, auth, routing) — shared by TUI + headless
│   ├── headless-config.ts # environment resolution for headless mode (fail-fast validation)
│   ├── shutdown.ts        # graceful shutdown handler (SIGTERM/SIGINT + force-exit timeout)
│   ├── outbox.ts          # SQLite event queue
│   ├── event-router.ts    # routes events to the collector outbox
│   ├── webhook-sender.ts  # sends queued events to the webhook
│   ├── heartbeat.ts       # periodic health signal
│   ├── extractors.ts      # event data extraction helpers
│   ├── helpers.ts         # collector utility functions
│   └── types.ts           # collector-specific types
├── hooks/
│   └── use-socket.ts      # React hook wrapping the collector core (TUI-only: storeMessage, parseContent, dedup)
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
