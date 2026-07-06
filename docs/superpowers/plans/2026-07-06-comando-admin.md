# Comando `/admin on|off` (+ prefixo `!`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar o comando de moderação `/admin on|off` (liga/desliga "somente admins falam" no grupo) e fazer `/ban` e `/admin` aceitarem também o prefixo `!`.

**Architecture:** Extrair os primitivos compartilhados dos comandos (`messageText`, parser de comando com prefixo `/`+`!`, `isAdmin`, tipos de mensagem) para um novo `command-core.ts`. O `/ban` é refatorado para usar esse módulo; um novo `admin-command.ts` implementa o `/admin` no mesmo molde silencioso/auditado; `core.ts` aciona os dois handlers no `messages.upsert`.

**Tech Stack:** TypeScript (ESM), Baileys 7.0.0-rc12, runner de testes `node:test` via `tsx --test`, logger Pino.

## Global Constraints

- **Bot 100% silencioso:** nenhum handler envia mensagem ao grupo — nunca. Único feedback é a msg de sistema nativa do WhatsApp. Toda tentativa gera uma linha de auditoria via `logger.info`.
- **Best-effort:** handlers nunca lançam para fora — cada mensagem do lote é tratada em `try/catch`; exceção vira log, jamais derruba a coleta. O gancho em `core.ts` é `void` (fire-and-forget).
- **Só grupos:** ignora qualquer `remoteJid` que não termine em `@g.us`.
- **Autorização:** apenas `admin`/`superadmin` do grupo onde o comando foi digitado (comparação de JID sempre via `jidNormalizedUser`).
- **Escopo do `/admin`:** só o grupo atual (sem cascata pra comunidade).
- **Convenção de import ESM:** imports relativos usam sufixo `.js` (ex.: `./command-core.js`), como no resto de `src/collector/`.
- **Estilo de teste:** `node:test` + `node:assert/strict`, tabs para indentação, fakes locais (espelhar `tests/collector/ban-command.test.ts`).
- **Sem co-autoria** em commits.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/collector/command-core.ts` | **novo** — primitivos puros e compartilhados: tipos de mensagem (`CmdMessage` etc.), `messageText`, `parseCommand` (prefixo `/` ou `!`), `isAdmin`. |
| `tests/collector/command-core.test.ts` | **novo** — testes puros de `parseCommand`, `messageText`, `isAdmin`. |
| `src/collector/ban-command.ts` | **refactor** — importa de `command-core`; `parseBanCommand` passa a reconhecer `!ban`; re-exporta `messageText` e `BanMessage` p/ compat. |
| `tests/collector/ban-command.test.ts` | **+casos** — `!ban`/`!BAN` reconhecidos. |
| `src/collector/admin-command.ts` | **novo** — `parseAdminAction` + `createAdminHandler` (autorização → idempotência via `meta.announce` → `groupSettingUpdate` → auditoria). |
| `tests/collector/admin-command.test.ts` | **novo** — parse, autorização, idempotência, sucesso, robustez. |
| `src/collector/core.ts` | **+1 handler** — cria `adminHandler` no `connect()` e o aciona no `messages.upsert` junto do `banHandler`. |
| `tests/collector/core.test.ts` | **+1 método no fake sock + 1 teste** — fiação `core → admin-command`. |

---

### Task 1: `command-core.ts` — primitivos compartilhados

**Files:**
- Create: `src/collector/command-core.ts`
- Test: `tests/collector/command-core.test.ts`

**Interfaces:**
- Consumes: nada (módulo puro).
- Produces:
  - `interface CmdContextInfo { participant?: string | null; stanzaId?: string | null; mentionedJid?: string[] | null }`
  - `interface CmdMessageContent { conversation?: string | null; extendedTextMessage?: { text?: string | null; contextInfo?: CmdContextInfo | null } | null }`
  - `interface CmdMessageKey { remoteJid?: string | null; participant?: string | null; id?: string | null }`
  - `interface CmdMessage { key?: CmdMessageKey | null; message?: CmdMessageContent | null }`
  - `interface CmdParticipant { id: string; admin?: 'admin' | 'superadmin' | null }`
  - `interface CmdUpsert { type: string; messages: CmdMessage[] }`
  - `interface ParsedCommand { name: string; args: string[] }`
  - `function messageText(msg: CmdMessage): string`
  - `function parseCommand(text: string): ParsedCommand | null`
  - `function isAdmin(p?: { admin?: 'admin' | 'superadmin' | null } | null): boolean`

- [ ] **Step 1: Escrever os testes que falham**

Create `tests/collector/command-core.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, messageText, isAdmin } from '../../src/collector/command-core.js'
import type { CmdMessage } from '../../src/collector/command-core.js'

test('parseCommand: aceita prefixo / e !, normaliza nome e args', () => {
	assert.deepEqual(parseCommand('/ban'), { name: 'ban', args: [] })
	assert.deepEqual(parseCommand('!ban'), { name: 'ban', args: [] })
	assert.deepEqual(parseCommand('/admin on'), { name: 'admin', args: ['on'] })
	assert.deepEqual(parseCommand('!admin OFF'), { name: 'admin', args: ['off'] })
	assert.deepEqual(parseCommand(' /BAN @Fulano '), { name: 'ban', args: ['@fulano'] })
})

test('parseCommand: rejeita o que não é comando', () => {
	for (const t of ['ban', 'oi /ban', '', 'oi', '#ban', '/']) {
		assert.equal(parseCommand(t), null, `deveria rejeitar: "${t}"`)
	}
})

test('messageText: conversation, extendedTextMessage e vazio', () => {
	assert.equal(messageText({ message: { conversation: '/ban' } }), '/ban')
	assert.equal(messageText({ message: { extendedTextMessage: { text: '/admin on' } } }), '/admin on')
	assert.equal(messageText({}), '')
	assert.equal(messageText({ message: {} } as CmdMessage), '')
})

test('isAdmin: admin/superadmin true; resto false', () => {
	assert.equal(isAdmin({ admin: 'admin' }), true)
	assert.equal(isAdmin({ admin: 'superadmin' }), true)
	assert.equal(isAdmin({ admin: null }), false)
	assert.equal(isAdmin(undefined), false)
})
```

- [ ] **Step 2: Rodar os testes e ver falhar**

Run: `pnpm exec tsx --test tests/collector/command-core.test.ts`
Expected: FAIL — `Cannot find module '.../src/collector/command-core.js'`.

- [ ] **Step 3: Implementar `command-core.ts`**

Create `src/collector/command-core.ts`:

```ts
// Primitivos compartilhados pelos comandos de moderação do coletor (/ban, /admin).
// Puros e sem dependência de rede — testáveis isoladamente.

// Shapes mínimos das mensagens do Baileys que os comandos precisam — mantidos locais para os
// testes usarem objetos simples. A WAMessage real do Baileys é estruturalmente compatível.
export interface CmdContextInfo {
	participant?: string | null // autor da msg citada (presente em replies)
	stanzaId?: string | null // id da msg citada (presente em replies)
	mentionedJid?: string[] | null // JIDs mencionados com @
}
export interface CmdMessageContent {
	conversation?: string | null
	extendedTextMessage?: { text?: string | null; contextInfo?: CmdContextInfo | null } | null
}
export interface CmdMessageKey {
	remoteJid?: string | null
	participant?: string | null
	id?: string | null
}
export interface CmdMessage {
	key?: CmdMessageKey | null
	message?: CmdMessageContent | null
}
export interface CmdParticipant {
	id: string
	admin?: 'admin' | 'superadmin' | null
}
export interface CmdUpsert {
	type: string
	messages: CmdMessage[]
}

// Texto da mensagem: conversation (texto puro) ou extendedTextMessage.text (reply/menção).
export function messageText(msg: CmdMessage): string {
	const m = msg.message
	if (!m) return ''
	if (typeof m.conversation === 'string') return m.conversation
	const ext = m.extendedTextMessage?.text
	return typeof ext === 'string' ? ext : ''
}

// Comando parseado: nome (sem prefixo, lowercase) + argumentos (lowercase).
export interface ParsedCommand {
	name: string
	args: string[]
}

// Detecta o comando pelo PRIMEIRO token, com prefixo "/" OU "!" (case-insensitive).
// Por token, não match exato: na menção o texto vem como "/ban @Fulano".
export function parseCommand(text: string): ParsedCommand | null {
	const tokens = text.trim().split(/\s+/).filter(Boolean)
	const m = /^[/!](\w+)$/.exec(tokens[0] ?? '')
	if (!m) return null
	return { name: m[1].toLowerCase(), args: tokens.slice(1).map((t) => t.toLowerCase()) }
}

export function isAdmin(p?: { admin?: 'admin' | 'superadmin' | null } | null): boolean {
	return p?.admin === 'admin' || p?.admin === 'superadmin'
}
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm exec tsx --test tests/collector/command-core.test.ts`
Expected: PASS — 4 testes.

- [ ] **Step 5: Commit**

```bash
git add src/collector/command-core.ts tests/collector/command-core.test.ts
git commit -m "feat: command-core com parseCommand (prefixo / e !), messageText e isAdmin"
```

---

### Task 2: refatorar `ban-command.ts` para usar `command-core`

**Files:**
- Modify: `src/collector/ban-command.ts`
- Test: `tests/collector/ban-command.test.ts` (adiciona casos `!ban`)

**Interfaces:**
- Consumes: `messageText`, `parseCommand`, `isAdmin`, `CmdMessage` de `command-core`.
- Produces (mantém a API pública existente): `parseBanCommand(text): boolean` (agora cobre `/ban` **e** `!ban`), `messageText` (re-export), `resolveBanTarget`, `createBanHandler`, e os tipos `BanMessage`, `BanGroupMetadata`, `BanSocket`, `BanUpdateResult`, `BanParticipant`.

- [ ] **Step 1: Adicionar os casos `!ban` ao teste do ban (devem falhar)**

Em `tests/collector/ban-command.test.ts`, logo após o teste `parseBanCommand: rejeita o que não é o comando` (por volta da linha 16), inserir:

```ts
test('parseBanCommand: aceita ! como prefixo', () => {
	for (const t of ['!ban', '!BAN', '!ban @Fulano']) {
		assert.equal(parseBanCommand(t), true, `deveria aceitar: "${t}"`)
	}
	assert.equal(parseBanCommand('!bandido'), false)
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec tsx --test --test-name-pattern='aceita ! como prefixo' tests/collector/ban-command.test.ts`
Expected: FAIL — `parseBanCommand('!ban')` retorna `false` (impl atual só reconhece `/ban`).

- [ ] **Step 3: Refatorar `ban-command.ts`**

Substituir o topo do arquivo (linhas 5–53 atuais: import do baileys, as interfaces `BanContextInfo`/`BanMessageContent`/`BanMessageKey`/`BanMessage`, `messageText`, `parseBanCommand`, `resolveBanTarget`) por:

```ts
import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage } from './command-core.js'

// Compat: BanMessage é o shape genérico de mensagem compartilhado (command-core).
export type BanMessage = CmdMessage
export { messageText }

// Detecta o comando /ban — aceita "/ban" e "!ban" (case-insensitive) pelo primeiro token.
export function parseBanCommand(text: string): boolean {
	return parseCommand(text)?.name === 'ban'
}

// Alvo do ban: reply (autor da msg citada) tem prioridade; senão, o primeiro mencionado.
// Reply é detectado por stanzaId + participant juntos (evita falsos positivos de contextInfo).
export function resolveBanTarget(msg: BanMessage): string | null {
	const ctx = msg.message?.extendedTextMessage?.contextInfo
	if (!ctx) return null
	if (ctx.stanzaId && ctx.participant) return ctx.participant
	const mentioned = ctx.mentionedJid
	if (mentioned && mentioned.length > 0) return mentioned[0]
	return null
}
```

No bloco do handler, remover a closure local `isAdmin` (linhas 88–90 atuais):

```ts
// REMOVER isto de dentro de createBanHandler:
function isAdmin(p?: BanParticipant): boolean {
	return p?.admin === 'admin' || p?.admin === 'superadmin'
}
```

O `isAdmin` importado de `command-core` cobre `BanParticipant` (estruturalmente compatível). O restante de `createBanHandler` (guardrails, remoção, auditoria) **não muda**. Manter as interfaces `BanParticipant`, `BanGroupMetadata`, `BanUpdateResult`, `BanSocket`, `BanLogger`, `BanUpsert` como estão.

- [ ] **Step 4: Rodar o arquivo de teste do ban inteiro e ver passar**

Run: `pnpm exec tsx --test tests/collector/ban-command.test.ts`
Expected: PASS — todos os testes anteriores + o novo `!ban` (nenhuma regressão).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sem erros (o re-export e o alias de tipo compilam).

- [ ] **Step 6: Commit**

```bash
git add src/collector/ban-command.ts tests/collector/ban-command.test.ts
git commit -m "refactor: ban-command usa command-core e reconhece prefixo !ban"
```

---

### Task 3: `admin-command.ts` — parse + handler

**Files:**
- Create: `src/collector/admin-command.ts`
- Test: `tests/collector/admin-command.test.ts`

**Interfaces:**
- Consumes: `messageText`, `parseCommand`, `isAdmin`, `CmdMessage`, `CmdParticipant`, `CmdUpsert` de `command-core`; `jidNormalizedUser` do baileys.
- Produces:
  - `function parseAdminAction(text: string): 'on' | 'off' | null`
  - `interface AdminGroupMetadata { id: string; announce?: boolean | null; participants: CmdParticipant[] }`
  - `interface AdminSocket { groupMetadata(jid: string): Promise<AdminGroupMetadata>; groupSettingUpdate(jid: string, setting: 'announcement' | 'not_announcement'): Promise<void> }`
  - `interface AdminLogger { info(obj: Record<string, unknown>, msg?: string): void }`
  - `function createAdminHandler(deps: { sock: AdminSocket; logger: AdminLogger }): { handle(upsert: CmdUpsert): Promise<void> }`

- [ ] **Step 1: Escrever os testes que falham**

Create `tests/collector/admin-command.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAdminAction, createAdminHandler } from '../../src/collector/admin-command.js'
import type { AdminGroupMetadata, AdminSocket } from '../../src/collector/admin-command.js'
import type { CmdMessage } from '../../src/collector/command-core.js'

test('parseAdminAction: on/off com prefixo / e !', () => {
	for (const t of ['/admin on', '!admin on', '/ADMIN ON']) assert.equal(parseAdminAction(t), 'on', t)
	for (const t of ['/admin off', '!admin off']) assert.equal(parseAdminAction(t), 'off', t)
})

test('parseAdminAction: sem/argumento inválido/não-comando → null', () => {
	for (const t of ['/admin', '!admin xyz', 'admin on', 'oi /admin on', '/ban on']) {
		assert.equal(parseAdminAction(t), null, t)
	}
})

// ---- helpers do handler ----
const ADMIN = 'admin@s.whatsapp.net'
const MEMBER = 'member@s.whatsapp.net'
const GROUP = 'g@g.us'

function fakeLogger() {
	const logs: Array<Record<string, unknown>> = []
	return { logs, logger: { info: (o: Record<string, unknown>) => { logs.push(o) } } }
}

// sock fake: captura chamadas de setting e serve metadata do grupo.
function fakeSock(meta: Partial<AdminGroupMetadata>, opts: { throwMeta?: boolean; throwSetting?: boolean } = {}) {
	const calls: Array<{ jid: string; setting: string }> = []
	const sock: AdminSocket = {
		async groupMetadata(jid: string): Promise<AdminGroupMetadata> {
			if (opts.throwMeta) throw new Error('meta boom')
			return { id: jid, announce: meta.announce ?? false, participants: meta.participants ?? [] }
		},
		async groupSettingUpdate(jid, setting) {
			if (opts.throwSetting) throw new Error('setting boom')
			calls.push({ jid, setting })
		},
	}
	return { sock, calls }
}

// monta um messages.upsert com um único comando /admin.
function adminUpsert(opts: { group?: string; actor?: string; text?: string } = {}) {
	const msg: CmdMessage = {
		key: { remoteJid: opts.group ?? GROUP, participant: opts.actor ?? ADMIN, id: 'CMD1' },
		message: { extendedTextMessage: { text: opts.text ?? '/admin on' } },
	}
	return { type: 'notify', messages: [msg] }
}

const ADMIN_MEMBER = [{ id: ADMIN, admin: 'admin' as const }, { id: MEMBER, admin: null }]

test('handler: ignora mensagem que não é /admin', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: 'oi pessoal' }))
	assert.equal(calls.length, 0)
})

test('handler: ignora DM (não-grupo)', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ group: '5511@s.whatsapp.net' }))
	assert.equal(calls.length, 0)
})

test('handler: ignora upsert que não é notify', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	const u = adminUpsert({}); u.type = 'append'
	await h.handle(u)
	assert.equal(calls.length, 0)
})

test('handler: /admin sem argumento válido → no_action', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin' }))
	assert.equal(calls.length, 0)
	assert.equal(logs.at(-1)?.result, 'no_action')
})

test('handler: autor não-admin → not_admin, sem alteração', async () => {
	const { sock, calls } = fakeSock({ participants: [{ id: ADMIN, admin: null }, { id: MEMBER, admin: null }] })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin on' }))
	assert.equal(calls.length, 0)
	assert.equal(logs.at(-1)?.result, 'not_admin')
})

test('handler: on aplica announcement', async () => {
	const { sock, calls } = fakeSock({ announce: false, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '!admin on' }))
	assert.deepEqual(calls, [{ jid: GROUP, setting: 'announcement' }])
	assert.equal(logs.at(-1)?.result, 'applied')
})

test('handler: off aplica not_announcement', async () => {
	const { sock, calls } = fakeSock({ announce: true, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin off' }))
	assert.deepEqual(calls, [{ jid: GROUP, setting: 'not_announcement' }])
	assert.equal(logs.at(-1)?.result, 'applied')
})

test('handler: on num grupo já announce → already_on, sem chamada', async () => {
	const { sock, calls } = fakeSock({ announce: true, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin on' }))
	assert.equal(calls.length, 0)
	assert.equal(logs.at(-1)?.result, 'already_on')
})

test('handler: off num grupo já liberado → already_off, sem chamada', async () => {
	const { sock, calls } = fakeSock({ announce: false, participants: ADMIN_MEMBER })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin off' }))
	assert.equal(calls.length, 0)
	assert.equal(logs.at(-1)?.result, 'already_off')
})

test('handler: groupMetadata falha → metadata_error, sem lançar', async () => {
	const { sock } = fakeSock({ participants: ADMIN_MEMBER }, { throwMeta: true })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin on' }))
	assert.equal(logs.at(-1)?.result, 'metadata_error')
})

test('handler: groupSettingUpdate falha → setting_error, sem lançar', async () => {
	const { sock } = fakeSock({ announce: false, participants: ADMIN_MEMBER }, { throwSetting: true })
	const { logs, logger } = fakeLogger()
	const h = createAdminHandler({ sock, logger })
	await h.handle(adminUpsert({ text: '/admin on' }))
	assert.equal(logs.at(-1)?.result, 'setting_error')
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec tsx --test tests/collector/admin-command.test.ts`
Expected: FAIL — `Cannot find module '.../src/collector/admin-command.js'`.

- [ ] **Step 3: Implementar `admin-command.ts`**

Create `src/collector/admin-command.ts`:

```ts
// Comando de moderação /admin on|off: liga/desliga o modo "somente admins falam" do grupo.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.
// Escopo: só o grupo onde o comando foi digitado (sem cascata pra comunidade).

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage, type CmdParticipant, type CmdUpsert } from './command-core.js'

// 'on' | 'off' se for o comando /admin (ou !admin) com argumento válido; senão null.
export function parseAdminAction(text: string): 'on' | 'off' | null {
	const cmd = parseCommand(text)
	if (cmd?.name !== 'admin') return null
	const arg = cmd.args[0]
	return arg === 'on' || arg === 'off' ? arg : null
}

// Shape mínimo da metadata que o handler precisa (announce p/ idempotência + participants p/ auth).
export interface AdminGroupMetadata {
	id: string
	announce?: boolean | null
	participants: CmdParticipant[]
}
// Interface mínima do socket do Baileys que o handler precisa (injetável p/ testes sem rede).
export interface AdminSocket {
	groupMetadata(jid: string): Promise<AdminGroupMetadata>
	groupSettingUpdate(jid: string, setting: 'announcement' | 'not_announcement'): Promise<void>
}
export interface AdminLogger {
	info(obj: Record<string, unknown>, msg?: string): void
}

export function createAdminHandler(deps: { sock: AdminSocket; logger: AdminLogger }) {
	const { sock, logger } = deps

	async function handleMessage(msg: CmdMessage): Promise<void> {
		const groupJid = msg.key?.remoteJid
		if (!groupJid || !groupJid.endsWith('@g.us')) return // só grupos

		const text = messageText(msg)
		if (parseCommand(text)?.name !== 'admin') return // só o comando /admin (aceita ! e /)

		const action = parseAdminAction(text)
		const actor = msg.key?.participant ? jidNormalizedUser(msg.key.participant) : ''
		const audit = (result: string, extra: Record<string, unknown> = {}) =>
			logger.info({ actor, group: groupJid, action, result, ...extra }, 'admin: tentativa')

		if (!action) { audit('no_action'); return } // /admin sem on|off válido

		let meta: AdminGroupMetadata
		try {
			meta = await sock.groupMetadata(groupJid)
		} catch (err) {
			audit('metadata_error', { err: String(err) }); return
		}

		const participants = meta.participants || []
		const findP = (jid: string) => participants.find((p) => jidNormalizedUser(p.id) === jid)

		// autorização: quem mandou precisa ser admin/superadmin do grupo
		if (!isAdmin(findP(actor))) { audit('not_admin'); return }

		// idempotência: se o grupo já está no estado alvo, não chama a API
		const wantAnnounce = action === 'on'
		if (Boolean(meta.announce) === wantAnnounce) {
			audit(wantAnnounce ? 'already_on' : 'already_off'); return
		}

		// aplica o setting no grupo
		try {
			await sock.groupSettingUpdate(groupJid, wantAnnounce ? 'announcement' : 'not_announcement')
			audit('applied')
		} catch (err) {
			audit('setting_error', { err: String(err) })
		}
	}

	return {
		// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
		async handle(upsert: CmdUpsert): Promise<void> {
			if (upsert?.type !== 'notify') return
			for (const msg of upsert.messages || []) {
				try {
					await handleMessage(msg)
				} catch (err) {
					logger.info({ result: 'handler_error', err: String(err) }, 'admin: erro inesperado')
				}
			}
		},
	}
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm exec tsx --test tests/collector/admin-command.test.ts`
Expected: PASS — 13 testes.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/collector/admin-command.ts tests/collector/admin-command.test.ts
git commit -m "feat: createAdminHandler (/admin on|off) com autorização, idempotência e auditoria"
```

---

### Task 4: acoplar `adminHandler` ao loop de eventos do coletor

**Files:**
- Modify: `src/collector/core.ts` (import ~linha 18; criação do handler ~linhas 186–189; gancho ~linhas 202–204)
- Test: `tests/collector/core.test.ts` (fake sock ~linhas 36–69; novo teste ao final)

**Interfaces:**
- Consumes: `createAdminHandler` de `admin-command`.
- Produces: nada novo (fiação interna).

- [ ] **Step 1: Adicionar o teste de fiação (deve falhar)**

Em `tests/collector/core.test.ts`, no objeto `calls` do `makeFakeSocket` (perto da linha 41), adicionar o campo:

```ts
		settingUpdates: [] as Array<{ jid: string; setting: string }>,
```

E no objeto `sock` (junto dos outros métodos de grupo, perto da linha 62), adicionar o método:

```ts
		async groupSettingUpdate(jid: string, setting: string) {
			calls.settingUpdates.push({ jid, setting })
		},
```

Ao final do arquivo, adicionar o teste:

```ts
test('messages.upsert com /admin on de admin aciona groupSettingUpdate (fiação core → admin-command)', async () => {
	const fake = makeFakeSocket({
		user: { id: '55@s.whatsapp.net', name: 'Bot' },
		groups: {
			'g1@g.us': {
				id: 'g1@g.us',
				announce: false,
				participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }],
			},
		},
	})
	const handle = startCollectorCore({
		authDir: 'baileys_auth_info',
		outboxPath: 'outbox.db',
		logger: silentLogger,
		baileysLogger: silentLogger,
		webhook: null,
		makeSocket: makeFakeMakeSocket(fake.sock),
	})

	await fake.emit({
		'messages.upsert': {
			type: 'notify',
			messages: [{
				key: { remoteJid: 'g1@g.us', participant: 'admin@s.whatsapp.net', id: 'CMD1' },
				message: { extendedTextMessage: { text: '!admin on' } },
			}],
		},
	})
	await flush()

	assert.deepEqual(fake.calls.settingUpdates, [{ jid: 'g1@g.us', setting: 'announcement' }])

	await handle.stop()
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec tsx --test --test-name-pattern='fiação core → admin-command' tests/collector/core.test.ts`
Expected: FAIL — `settingUpdates` fica vazio (o `core.ts` ainda não aciona o `adminHandler`).

- [ ] **Step 3: Acoplar no `core.ts`**

Adicionar o import (junto do import do ban, ~linha 18):

```ts
import { createAdminHandler } from './admin-command.js'
```

Logo após a criação do `banHandler` (~linhas 186–189), adicionar:

```ts
		// handler do comando /admin — usa o socket ativo; silencioso, erros vão pro log de auditoria.
		const adminHandler = createAdminHandler({
			sock: activeSock,
			logger: deps.logger.child({ component: 'admin' }),
		})
```

No bloco do gancho de `messages.upsert` (~linhas 202–204), adicionar a chamada do admin ao lado da do ban:

```ts
		// comandos /ban e /admin: best-effort, não bloqueiam nem derrubam a coleta (handlers nunca lançam).
		if (events['messages.upsert']) {
			void banHandler.handle(events['messages.upsert'] as Parameters<typeof banHandler.handle>[0])
			void adminHandler.handle(events['messages.upsert'] as Parameters<typeof adminHandler.handle>[0])
		}
```

- [ ] **Step 4: Rodar o arquivo de teste do core inteiro e ver passar**

Run: `pnpm exec tsx --test tests/collector/core.test.ts`
Expected: PASS — todos os testes anteriores (incluindo o do `/ban`) + o novo do `/admin`.

- [ ] **Step 5: Verificação final — typecheck + suíte completa**

Run: `pnpm typecheck`
Expected: sem erros.

Run: `pnpm test`
Expected: PASS — toda a suíte (`tests/**/*.test.ts`), sem regressões.

- [ ] **Step 6: Commit**

```bash
git add src/collector/core.ts tests/collector/core.test.ts
git commit -m "feat: acopla o comando /admin ao loop de eventos do coletor"
```

---

## Notas de execução

- **Ordem obrigatória:** Task 1 → 2 → 3 → 4 (Task 2/3 dependem do `command-core`; Task 4 depende do `admin-command`).
- **Rodar um teste único por nome:** `pnpm exec tsx --test --test-name-pattern='<trecho do nome>' tests/collector/<arquivo>.test.ts`.
- **Sem husky/pest neste projeto** (é TS, não Laravel): a bateria pré-push é `pnpm typecheck` + `pnpm test`. Se for pushar, rode as duas antes.
```
