# Comando `/ban` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que admins de um grupo removam um membro da comunidade inteira (grupo + todos os subgrupos) com `/ban` em reply ou menção, de forma 100% silenciosa.

**Architecture:** Um módulo novo `src/collector/ban-command.ts` (funções puras de parse/resolução + um handler injetável) é acoplado ao loop de eventos do núcleo (`src/collector/core.ts`), que já roda em produção headless e já tem o `sock` do Baileys. O handler usa `groupMetadata` para autorizar/aplicar guardrails e `communityParticipantsUpdate` (cascata nativa) ou `groupParticipantsUpdate` para remover.

**Tech Stack:** TypeScript (ESM), `@whiskeysockets/baileys@7.0.0-rc12`, runner de teste `node:test` + `node:assert/strict`, pino (logger).

## Global Constraints

- **Runner de teste:** `node:test` com `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`. Rodar tudo: `pnpm test`. Rodar um arquivo: `pnpm exec tsx --test <arquivo>`. (Se `pnpm` não estiver no PATH, prefixe com `corepack`, ex.: `corepack pnpm test`.)
- **Imports ESM com extensão `.js`** mesmo para arquivos `.ts` (ex.: `'../../src/collector/ban-command.js'`).
- **Typecheck:** `pnpm typecheck` (`tsc --noEmit -p tsconfig.test.json`) deve passar limpo.
- **Comentários e logs em Português (pt-BR)**, seguindo o padrão do repositório.
- **Bot 100% silencioso:** o caminho do `/ban` NUNCA chama `sendMessage`/reply. Sucesso e erro são silenciosos; o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa vira uma linha de log de auditoria via `logger.info`.
- **Commits sem `Co-Authored-By`** e sem qualquer referência a co-autoria.
- **APIs do Baileys 7.0.0-rc12 (confirmadas na instalação):** `sock.groupMetadata(jid)`, `sock.groupParticipantsUpdate(jid, jids[], 'remove')`, `sock.communityParticipantsUpdate(jid, jids[], 'remove')` (adiciona `linked_groups:true` → remove da comunidade + todos os subgrupos), `GroupMetadata.linkedParent` (JID da comunidade pai), `participants[].admin: 'admin'|'superadmin'|null`, `GroupMetadata.owner`, e `jidNormalizedUser` exportado do pacote.

---

### Task 1: Scaffold do módulo + `parseBanCommand` + `messageText`

**Files:**
- Create: `src/collector/ban-command.ts`
- Test: `tests/collector/ban-command.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - Tipos `BanContextInfo`, `BanMessageContent`, `BanMessageKey`, `BanMessage`.
  - `messageText(msg: BanMessage): string` — extrai o texto de `conversation` ou `extendedTextMessage.text`.
  - `parseBanCommand(text: string): boolean` — `true` se o primeiro token (case-insensitive) é `/ban`.

- [ ] **Step 1: Escrever os testes que falham**

Criar `tests/collector/ban-command.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBanCommand, messageText } from '../../src/collector/ban-command.js'
import type { BanMessage } from '../../src/collector/ban-command.js'

test('parseBanCommand: aceita /ban como primeiro token (com reply ou menção)', () => {
	for (const t of ['/ban', ' /ban ', '/BAN', '/ban @Fulano', '/BAN @x']) {
		assert.equal(parseBanCommand(t), true, `deveria aceitar: "${t}"`)
	}
})

test('parseBanCommand: rejeita o que não é o comando', () => {
	for (const t of ['/bandido', 'ban', 'oi /ban', '', 'oi', '/banir']) {
		assert.equal(parseBanCommand(t), false, `deveria rejeitar: "${t}"`)
	}
})

test('messageText: lê conversation', () => {
	const msg: BanMessage = { message: { conversation: '/ban' } }
	assert.equal(messageText(msg), '/ban')
})

test('messageText: lê extendedTextMessage.text', () => {
	const msg: BanMessage = { message: { extendedTextMessage: { text: '/ban @x' } } }
	assert.equal(messageText(msg), '/ban @x')
})

test('messageText: sem texto → string vazia', () => {
	assert.equal(messageText({}), '')
	assert.equal(messageText({ message: {} }), '')
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `pnpm exec tsx --test tests/collector/ban-command.test.ts`
Expected: FAIL — o módulo `ban-command.ts` ainda não existe (erro de import / "Cannot find module").

- [ ] **Step 3: Criar o módulo com os tipos e as duas funções puras**

Criar `src/collector/ban-command.ts`:

```ts
// Comando de moderação /ban: parse do comando, resolução do alvo e execução da remoção.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.

// Shapes mínimos das mensagens do Baileys que o comando precisa — mantidos locais para os testes
// usarem objetos simples. A WAMessage real do Baileys é estruturalmente compatível.
export interface BanContextInfo {
	participant?: string | null // autor da msg citada (presente em replies)
	stanzaId?: string | null // id da msg citada (presente em replies)
	mentionedJid?: string[] | null // JIDs mencionados com @
}
export interface BanMessageContent {
	conversation?: string | null
	extendedTextMessage?: { text?: string | null; contextInfo?: BanContextInfo | null } | null
}
export interface BanMessageKey {
	remoteJid?: string | null
	participant?: string | null
	id?: string | null
}
export interface BanMessage {
	key?: BanMessageKey | null
	message?: BanMessageContent | null
}

// Texto da mensagem: conversation (texto puro) ou extendedTextMessage.text (reply/menção).
export function messageText(msg: BanMessage): string {
	const m = msg.message
	if (!m) return ''
	if (typeof m.conversation === 'string') return m.conversation
	const ext = m.extendedTextMessage?.text
	return typeof ext === 'string' ? ext : ''
}

// Detecta o comando pelo PRIMEIRO token (case-insensitive). Por token, não match exato,
// porque na menção o texto vem como "/ban @Fulano".
export function parseBanCommand(text: string): boolean {
	const first = text.trim().split(/\s+/)[0]
	return first?.toLowerCase() === '/ban'
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `pnpm exec tsx --test tests/collector/ban-command.test.ts`
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/collector/ban-command.ts tests/collector/ban-command.test.ts
git commit -m "feat: parseBanCommand e messageText do comando /ban"
```

---

### Task 2: `resolveBanTarget` (reply ou menção)

**Files:**
- Modify: `src/collector/ban-command.ts`
- Test: `tests/collector/ban-command.test.ts`

**Interfaces:**
- Consumes: `BanMessage`, `BanContextInfo` (Task 1).
- Produces: `resolveBanTarget(msg: BanMessage): string | null` — JID do alvo via reply (prioridade) ou menção; `null` se nenhum.

- [ ] **Step 1: Adicionar os testes que falham**

Acrescentar a `tests/collector/ban-command.test.ts` (e atualizar o import do topo para incluir `resolveBanTarget`):

```ts
import { parseBanCommand, messageText, resolveBanTarget } from '../../src/collector/ban-command.js'

test('resolveBanTarget: reply usa contextInfo.participant', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban', contextInfo: { participant: 'victim@s.whatsapp.net', stanzaId: 'S1' } } },
	}
	assert.equal(resolveBanTarget(msg), 'victim@s.whatsapp.net')
})

test('resolveBanTarget: menção usa o primeiro mentionedJid', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban @x', contextInfo: { mentionedJid: ['victim@s.whatsapp.net'] } } },
	}
	assert.equal(resolveBanTarget(msg), 'victim@s.whatsapp.net')
})

test('resolveBanTarget: reply tem prioridade sobre menção', () => {
	const msg: BanMessage = {
		message: { extendedTextMessage: { text: '/ban @y', contextInfo: { participant: 'reply@s.whatsapp.net', stanzaId: 'S1', mentionedJid: ['mention@s.whatsapp.net'] } } },
	}
	assert.equal(resolveBanTarget(msg), 'reply@s.whatsapp.net')
})

test('resolveBanTarget: sem reply e sem menção → null', () => {
	assert.equal(resolveBanTarget({ message: { conversation: '/ban' } }), null)
	assert.equal(resolveBanTarget({ message: { extendedTextMessage: { text: '/ban', contextInfo: {} } } }), null)
	// participant sem stanzaId não conta como reply
	assert.equal(resolveBanTarget({ message: { extendedTextMessage: { text: '/ban', contextInfo: { participant: 'x@s.whatsapp.net' } } } }), null)
})
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `pnpm exec tsx --test tests/collector/ban-command.test.ts`
Expected: FAIL — `resolveBanTarget` não exportado ("resolveBanTarget is not a function" / erro de import).

- [ ] **Step 3: Implementar `resolveBanTarget`**

Acrescentar ao final de `src/collector/ban-command.ts`:

```ts
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

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm exec tsx --test tests/collector/ban-command.test.ts`
Expected: PASS — `# pass 9`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/collector/ban-command.ts tests/collector/ban-command.test.ts
git commit -m "feat: resolveBanTarget (reply ou menção) do comando /ban"
```

---

### Task 3: `createBanHandler` (autorização, guardrails, remoção, auditoria)

**Files:**
- Modify: `src/collector/ban-command.ts`
- Test: `tests/collector/ban-command.test.ts`

**Interfaces:**
- Consumes: `BanMessage`, `messageText`, `parseBanCommand`, `resolveBanTarget` (Tasks 1-2); `jidNormalizedUser` de `@whiskeysockets/baileys`.
- Produces:
  - `BanParticipant`, `BanGroupMetadata`, `BanUpdateResult`, `BanSocket`, `BanLogger`, `BanUpsert`.
  - `createBanHandler(deps: { sock: BanSocket; logger: BanLogger }): { handle(upsert: BanUpsert): Promise<void> }`.
  - Strings de auditoria (campo `result`): `no_target`, `metadata_error`, `not_admin`, `self_ban`, `target_not_member`, `target_is_admin`, `target_is_owner`, `removed`, `remove_error`, `handler_error`.

- [ ] **Step 1: Escrever o conjunto de testes do handler (todos falham)**

Acrescentar a `tests/collector/ban-command.test.ts` (e incluir `createBanHandler` no import + os tipos usados):

```ts
import { parseBanCommand, messageText, resolveBanTarget, createBanHandler } from '../../src/collector/ban-command.js'
import type { BanMessage, BanGroupMetadata, BanSocket, BanUpdateResult } from '../../src/collector/ban-command.js'

// ---- helpers do handler ----
const ADMIN = 'admin@s.whatsapp.net'
const VICTIM = 'victim@s.whatsapp.net'
const OWNER = 'owner@s.whatsapp.net'
const GROUP = 'g@g.us'
const COMMUNITY = 'community@g.us'

function fakeLogger() {
	const logs: Array<Record<string, unknown>> = []
	return { logs, logger: { info: (o: Record<string, unknown>) => { logs.push(o) } } }
}

// sock fake: captura chamadas de remoção e serve metadata do grupo (e opcionalmente do pai).
function fakeSock(meta: Partial<BanGroupMetadata>, opts: { parent?: BanGroupMetadata; result?: BanUpdateResult[]; throwMeta?: boolean; throwRemove?: boolean } = {}) {
	const calls = { group: [] as Array<{ jid: string; jids: string[] }>, community: [] as Array<{ jid: string; jids: string[] }> }
	const sock: BanSocket = {
		async groupMetadata(jid: string): Promise<BanGroupMetadata> {
			if (opts.throwMeta) throw new Error('meta boom')
			if (opts.parent && jid === opts.parent.id) return opts.parent
			return { id: jid, owner: meta.owner ?? null, linkedParent: meta.linkedParent ?? null, participants: meta.participants ?? [] }
		},
		async groupParticipantsUpdate(jid, jids) {
			if (opts.throwRemove) throw new Error('remove boom')
			calls.group.push({ jid, jids }); return opts.result ?? [{ status: '200', jid: jids[0] }]
		},
		async communityParticipantsUpdate(jid, jids) {
			if (opts.throwRemove) throw new Error('remove boom')
			calls.community.push({ jid, jids }); return opts.result ?? [{ status: '200', jid: jids[0] }]
		},
	}
	return { sock, calls }
}

// monta um messages.upsert com um único comando /ban (reply por padrão).
function banUpsert(opts: { group?: string; actor?: string; text?: string; reply?: string; mention?: string } = {}) {
	const ctx: Record<string, unknown> = {}
	if (opts.reply) { ctx.participant = opts.reply; ctx.stanzaId = 'S1' }
	if (opts.mention) ctx.mentionedJid = [opts.mention]
	const msg: BanMessage = {
		key: { remoteJid: opts.group ?? GROUP, participant: opts.actor ?? ADMIN, id: 'CMD1' },
		message: { extendedTextMessage: { text: opts.text ?? '/ban', contextInfo: Object.keys(ctx).length ? ctx : undefined } },
	}
	return { type: 'notify', messages: [msg] }
}

const ADMIN_VICTIM = [{ id: ADMIN, admin: 'admin' as const }, { id: VICTIM, admin: null }]

test('handler: ignora mensagem que não é /ban', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ text: 'oi pessoal', reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
})

test('handler: ignora DM (não-grupo)', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ group: '5511@s.whatsapp.net', reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
})

test('handler: ignora upsert que não é notify', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	const u = banUpsert({ reply: VICTIM }); u.type = 'append'
	await h.handle(u)
	assert.equal(calls.group.length + calls.community.length, 0)
})

test('handler: /ban sem reply e sem menção → no_target', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({})) // /ban puro
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'no_target')
})

test('handler: autor não-admin → not_admin, sem remoção', async () => {
	const { sock, calls } = fakeSock({ participants: [{ id: ADMIN, admin: null }, { id: VICTIM, admin: null }] })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'not_admin')
})

test('handler: auto-ban → self_ban, sem remoção', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: ADMIN }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'self_ban')
})

test('handler: alvo fora do grupo → target_not_member', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: 'stranger@s.whatsapp.net' }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'target_not_member')
})

test('handler: alvo é admin → target_is_admin', async () => {
	const { sock, calls } = fakeSock({ participants: [{ id: ADMIN, admin: 'admin' }, { id: VICTIM, admin: 'admin' }] })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'target_is_admin')
})

test('handler: alvo é owner do grupo → target_is_owner', async () => {
	const { sock, calls } = fakeSock({ owner: VICTIM, participants: ADMIN_VICTIM })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'target_is_owner')
})

test('handler: sucesso em grupo standalone → groupParticipantsUpdate', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM }) // sem linkedParent
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.community.length, 0)
	assert.deepEqual(calls.group, [{ jid: GROUP, jids: [VICTIM] }])
	assert.equal(logs.at(-1)?.result, 'removed')
	assert.equal(logs.at(-1)?.status, '200')
})

test('handler: sucesso em comunidade → communityParticipantsUpdate no pai', async () => {
	const { sock, calls } = fakeSock(
		{ linkedParent: COMMUNITY, participants: ADMIN_VICTIM },
		{ parent: { id: COMMUNITY, owner: OWNER, participants: [] } },
	)
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length, 0)
	assert.deepEqual(calls.community, [{ jid: COMMUNITY, jids: [VICTIM] }])
	assert.equal(logs.at(-1)?.result, 'removed')
	assert.equal(logs.at(-1)?.community, COMMUNITY)
})

test('handler: protege o owner da COMUNIDADE → target_is_owner, sem remoção', async () => {
	const { sock, calls } = fakeSock(
		{ linkedParent: COMMUNITY, participants: [{ id: ADMIN, admin: 'admin' }, { id: VICTIM, admin: null }] },
		{ parent: { id: COMMUNITY, owner: VICTIM, participants: [] } },
	)
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(calls.group.length + calls.community.length, 0)
	assert.equal(logs.at(-1)?.result, 'target_is_owner')
})

test('handler: menção também resolve e bane', async () => {
	const { sock, calls } = fakeSock({ participants: ADMIN_VICTIM })
	const { logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ text: '/ban @v', mention: VICTIM }))
	assert.deepEqual(calls.group, [{ jid: GROUP, jids: [VICTIM] }])
})

test('handler: groupMetadata falha → metadata_error, sem lançar', async () => {
	const { sock } = fakeSock({ participants: ADMIN_VICTIM }, { throwMeta: true })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM })) // não deve lançar
	assert.equal(logs.at(-1)?.result, 'metadata_error')
})

test('handler: falha na remoção → remove_error, sem lançar', async () => {
	const { sock } = fakeSock({ participants: ADMIN_VICTIM }, { throwRemove: true })
	const { logs, logger } = fakeLogger()
	const h = createBanHandler({ sock, logger })
	await h.handle(banUpsert({ reply: VICTIM }))
	assert.equal(logs.at(-1)?.result, 'remove_error')
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm exec tsx --test tests/collector/ban-command.test.ts`
Expected: FAIL — `createBanHandler` não exportado (erro de import / "is not a function").

- [ ] **Step 3: Implementar `createBanHandler` + tipos**

Acrescentar ao topo de `src/collector/ban-command.ts` (logo após o comentário de cabeçalho), o import do Baileys:

```ts
import { jidNormalizedUser } from '@whiskeysockets/baileys'
```

Acrescentar ao final de `src/collector/ban-command.ts`:

```ts
// ---- handler ----

export interface BanParticipant {
	id: string
	admin?: 'admin' | 'superadmin' | null
}
export interface BanGroupMetadata {
	id: string
	owner?: string | null
	linkedParent?: string | null // JID da comunidade pai, se o grupo for subgrupo de uma comunidade
	participants: BanParticipant[]
}
export interface BanUpdateResult {
	status: string
	jid?: string
}
// Interface mínima do socket do Baileys que o handler precisa (injetável p/ testes sem rede).
export interface BanSocket {
	groupMetadata(jid: string): Promise<BanGroupMetadata>
	groupParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<BanUpdateResult[]>
	communityParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<BanUpdateResult[]>
}
export interface BanLogger {
	info(obj: Record<string, unknown>, msg?: string): void
}
export interface BanUpsert {
	type: string
	messages: BanMessage[]
}

export function createBanHandler(deps: { sock: BanSocket; logger: BanLogger }) {
	const { sock, logger } = deps

	function isAdmin(p?: BanParticipant): boolean {
		return p?.admin === 'admin' || p?.admin === 'superadmin'
	}

	async function handleMessage(msg: BanMessage): Promise<void> {
		const groupJid = msg.key?.remoteJid
		if (!groupJid || !groupJid.endsWith('@g.us')) return // só grupos
		if (!parseBanCommand(messageText(msg))) return // só o comando /ban

		const actor = msg.key?.participant ? jidNormalizedUser(msg.key.participant) : ''
		const targetRaw = resolveBanTarget(msg)
		const audit = (result: string, extra: Record<string, unknown> = {}) =>
			logger.info({ actor, target: targetRaw, group: groupJid, result, ...extra }, 'ban: tentativa')

		if (!targetRaw) { audit('no_target'); return }
		const target = jidNormalizedUser(targetRaw)

		let meta: BanGroupMetadata
		try {
			meta = await sock.groupMetadata(groupJid)
		} catch (err) {
			audit('metadata_error', { err: String(err) }); return
		}

		const participants = meta.participants || []
		const findP = (jid: string) => participants.find((p) => jidNormalizedUser(p.id) === jid)

		// autorização: quem mandou precisa ser admin/superadmin do grupo
		if (!isAdmin(findP(actor))) { audit('not_admin'); return }

		// guardrails
		if (target === actor) { audit('self_ban'); return }
		const targetP = findP(target)
		if (!targetP) { audit('target_not_member'); return }
		if (isAdmin(targetP)) { audit('target_is_admin'); return }
		if (meta.owner && jidNormalizedUser(meta.owner) === target) { audit('target_is_owner'); return }

		// remoção
		try {
			let res: BanUpdateResult[]
			if (meta.linkedParent) {
				// proteção extra: o dono da COMUNIDADE pode diferir do owner do subgrupo
				try {
					const parent = await sock.groupMetadata(meta.linkedParent)
					if (parent.owner && jidNormalizedUser(parent.owner) === target) { audit('target_is_owner'); return }
				} catch { /* sem a metadata do pai, segue sem essa checagem extra */ }
				// communityParticipantsUpdate com 'remove' manda linked_groups:true → sai da comunidade + subgrupos
				res = await sock.communityParticipantsUpdate(meta.linkedParent, [targetP.id], 'remove')
			} else {
				res = await sock.groupParticipantsUpdate(groupJid, [targetP.id], 'remove')
			}
			audit('removed', { status: res?.[0]?.status ?? 'unknown', community: meta.linkedParent ?? null })
		} catch (err) {
			audit('remove_error', { err: String(err) })
		}
	}

	return {
		// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
		async handle(upsert: BanUpsert): Promise<void> {
			if (upsert?.type !== 'notify') return
			for (const msg of upsert.messages || []) {
				try {
					await handleMessage(msg)
				} catch (err) {
					logger.info({ result: 'handler_error', err: String(err) }, 'ban: erro inesperado')
				}
			}
		},
	}
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `pnpm exec tsx --test tests/collector/ban-command.test.ts`
Expected: PASS — `# pass 24`, `# fail 0`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sem erros (exit 0).

- [ ] **Step 6: Commit**

```bash
git add src/collector/ban-command.ts tests/collector/ban-command.test.ts
git commit -m "feat: createBanHandler com autorização, guardrails e remoção (grupo/comunidade)"
```

---

### Task 4: Fiação no núcleo do coletor (`core.ts`)

**Files:**
- Modify: `src/collector/core.ts`
- Test: `tests/collector/core.test.ts`

**Interfaces:**
- Consumes: `createBanHandler` (Task 3); o `activeSock` do Baileys (estruturalmente compatível com `BanSocket`); `deps.logger.child(...)` (pino, compatível com `BanLogger`).
- Produces: comportamento — quando chega `messages.upsert` com `/ban` válido, o núcleo aciona a remoção via socket.

- [ ] **Step 1: Adicionar o teste de fiação que falha**

Primeiro, estender o `makeFakeSocket` em `tests/collector/core.test.ts` para expor os métodos de grupo/comunidade. Substituir o objeto `sock` (linhas ~41-58) acrescentando os três métodos e os campos de captura em `calls`:

No objeto `calls` (após `fetchedGroups: 0,`) adicionar:

```ts
		removedGroup: [] as Array<{ jid: string; jids: string[] }>,
		removedCommunity: [] as Array<{ jid: string; jids: string[] }>,
```

No objeto `sock`, adicionar (ao lado de `groupFetchAllParticipating`):

```ts
		async groupMetadata(jid: string) {
			return (opts.groups ?? {})[jid] ?? { id: jid, participants: [] }
		},
		async groupParticipantsUpdate(jid: string, jids: string[]) {
			calls.removedGroup.push({ jid, jids }); return [{ status: '200', jid: jids[0] }]
		},
		async communityParticipantsUpdate(jid: string, jids: string[]) {
			calls.removedCommunity.push({ jid, jids }); return [{ status: '200', jid: jids[0] }]
		},
```

Depois, adicionar este teste ao final de `tests/collector/core.test.ts`:

```ts
test('messages.upsert com /ban de admin aciona a remoção (fiação core → ban-command)', async () => {
	const fake = makeFakeSocket({
		user: { id: '55@s.whatsapp.net', name: 'Bot' },
		groups: {
			'g1@g.us': {
				id: 'g1@g.us',
				participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }, { id: 'victim@s.whatsapp.net', admin: null }],
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
				message: { extendedTextMessage: { text: '/ban', contextInfo: { participant: 'victim@s.whatsapp.net', stanzaId: 'S1' } } },
			}],
		},
	})
	await flush()

	assert.deepEqual(fake.calls.removedGroup, [{ jid: 'g1@g.us', jids: ['victim@s.whatsapp.net'] }])

	await handle.stop()
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `pnpm exec tsx --test tests/collector/core.test.ts`
Expected: FAIL — o novo teste falha porque `core.ts` ainda não chama o handler (`removedGroup` fica vazio).

- [ ] **Step 3: Acoplar o handler no `core.ts`**

Adicionar o import no topo de `src/collector/core.ts` (junto aos outros imports do collector):

```ts
import { createBanHandler } from './ban-command.js'
```

Dentro de `connect()`, logo após `sock = activeSock` (linha ~182), criar o handler:

```ts
		// handler do comando /ban — usa o socket ativo; silencioso, erros vão pro log de auditoria.
		const banHandler = createBanHandler({
			sock: activeSock,
			logger: deps.logger.child({ component: 'ban' }),
		})
```

Dentro de `activeSock.ev.process(async (events) => { ... })`, logo APÓS o `for (const [eventName, eventData] ...)` que faz saveEvent/router/onEvent (linha ~192), adicionar:

```ts
			// comando /ban: best-effort, não bloqueia nem derruba a coleta (handler nunca lança).
			if (events['messages.upsert']) {
				void banHandler.handle(events['messages.upsert'] as Parameters<typeof banHandler.handle>[0])
			}
```

- [ ] **Step 4: Rodar o arquivo de teste do core e confirmar que passa**

Run: `pnpm exec tsx --test tests/collector/core.test.ts`
Expected: PASS — incluindo o novo teste e todos os antigos (`# fail 0`).

- [ ] **Step 5: Typecheck + suíte completa**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck sem erros; `pnpm test` com todos os testes passando (`# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add src/collector/core.ts tests/collector/core.test.ts
git commit -m "feat: acopla o comando /ban ao loop de eventos do coletor"
```

---

## Self-Review

**1. Cobertura do spec:**
- Identificação por reply/menção → Task 2 (`resolveBanTarget`) + testes de reply/menção/prioridade.
- Bot 100% silencioso (nenhum `sendMessage`) → Task 3: o handler só chama `groupMetadata`/`*ParticipantsUpdate` e `logger.info`; `BanSocket` nem expõe `sendMessage`. Global Constraints reforça.
- Autorização = admin do grupo onde digitou → Task 3, teste `not_admin` + checagem `isAdmin(findP(actor))`.
- Guardrails (não banir admin, não banir owner do grupo e da comunidade, ignorar auto-ban, auditoria) → Task 3, testes `self_ban`/`target_is_admin`/`target_is_owner` (grupo e comunidade) + `audit(...)` em todo caminho.
- Escopo (qualquer grupo, sem env) → Task 3/4: nenhum gate de env; só os portões de admin (autor) e a permissão do bot (implícita no status retornado).
- Ban do grupo E da comunidade ao mesmo tempo → Task 3: `communityParticipantsUpdate` no `linkedParent` (cascata nativa) com teste dedicado; standalone usa `groupParticipantsUpdate`.
- `@lid`/endereçamento → Task 3: comparações via `jidNormalizedUser` e remoção usando `targetP.id` (JID exato da lista de participantes).
- Compatibilidade/robustez (não derruba a coleta) → Task 3 testes `metadata_error`/`remove_error`/`handler_error` + `void`/try-catch na Task 4.
- Detecção por token (menção `/ban @x`) → Task 1, testes de `parseBanCommand`.

**2. Placeholders:** nenhum "TBD"/"TODO"/"handle edge cases" — todo passo traz o código completo e o comando exato com saída esperada.

**3. Consistência de tipos:** `BanMessage`/`BanContextInfo`/`BanMessageContent`/`BanMessageKey` (Task 1) → usados em `resolveBanTarget` (Task 2) e no handler (Task 3). `BanSocket`/`BanGroupMetadata`/`BanParticipant`/`BanUpdateResult`/`BanUpsert`/`BanLogger` definidos na Task 3 e consumidos pela fiação na Task 4 (via compatibilidade estrutural do `activeSock` e do `logger.child`). Nomes de função (`parseBanCommand`, `messageText`, `resolveBanTarget`, `createBanHandler`) idênticos em definição, testes e import. Strings de `result` da auditoria conferem entre o handler e as asserções dos testes.
