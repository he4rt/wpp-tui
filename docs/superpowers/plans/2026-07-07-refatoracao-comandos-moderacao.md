# Refatoração da camada de comandos de moderação — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extrair a casca de orquestração duplicada entre `ban-command.ts` e `admin-command.ts` para um módulo único (`command-handler.ts`), deixando cada comando só com sua regra de domínio — **sem mudar nenhum comportamento observável**.

**Architecture:** Um "template method" (`createCommandHandler`) embrulha tudo que todo comando repete (guarda de grupo/`notify`, loop best-effort do lote, `try/catch`, factory de `audit`); um helper (`requireGroupAdmin`), **chamado pelo domínio**, encapsula metadata + checagem de admin preservando a ordem entrada→autorização. Os comandos encolhem para uma função de domínio + um wrapper fino que mantém a assinatura pública atual (`createBanHandler`/`createAdminHandler`), então `core.ts` não muda.

**Tech Stack:** TypeScript (ESM, imports com extensão `.js`), `@whiskeysockets/baileys@7.0.0-rc12`, test runner nativo via `tsx --test` (`node:test` + `assert/strict`), `pino` para logs.

## Global Constraints

- **Refatoração preserva-comportamento.** NÃO editar nenhum teste existente (`ban-command.test.ts`, `admin-command.test.ts`, `core.test.ts`, `command-core.test.ts`). Eles são a rede de segurança. Se algum falhar após um refactor, o comportamento mudou → reverter e investigar, **nunca** "consertar o teste".
- **`command-core.ts` permanece puro** — sem imports de rede/`sock`/`logger`. A casca com efeitos vive no novo `command-handler.ts`.
- **Preservar exports públicos** consumidos por testes e por `core.ts`: `ban-command.ts` mantém `parseBanCommand`, `resolveBanTarget`, `messageText`, `createBanHandler` e os tipos `BanMessage`, `BanGroupMetadata`, `BanSocket`, `BanUpdateResult`, `BanParticipant`; `admin-command.ts` mantém `parseAdminAction`, `createAdminHandler` e os tipos `AdminGroupMetadata`, `AdminSocket`.
- **Indentação com TAB** (padrão do projeto). Imports ESM sempre com extensão `.js`.
- **Comandos:** suíte completa `pnpm test`; arquivo único `tsx --test tests/collector/<arquivo>.test.ts`; tipos `pnpm typecheck`.
- **Commits:** Conventional Commits, sem linha de co-autoria.
- **Critério de sucesso final:** `pnpm test` verde (mesma contagem de antes + os testes novos da casca) e `pnpm typecheck` limpo, sem tocar nos testes existentes.

---

### Task 1: Casca compartilhada (`command-handler.ts`)

Cria o módulo novo com `createCommandHandler` + `requireGroupAdmin` e seus testes isolados. É **aditivo**: ban/admin/core seguem usando o código antigo, então a suíte inteira continua verde ao fim desta task.

**Files:**
- Create: `src/collector/command-handler.ts`
- Test: `tests/collector/command-handler.test.ts`

**Interfaces:**
- Consumes (de `command-core.ts`, já existentes): `messageText(msg)`, `parseCommand(text)`, `isAdmin(p)`, e os tipos `CmdMessage`, `CmdParticipant`, `CmdUpsert`.
- Produces (usados nas Tasks 2 e 3):
  - `interface CommandLogger { info(obj: Record<string, unknown>, msg?: string): void }`
  - `type Audit = (result: string, extra?: Record<string, unknown>) => void`
  - `interface CommandContext<S> { msg: CmdMessage; groupJid: string; actor: string; sock: S; audit: Audit }`
  - `createCommandHandler<S>(deps: { name: string; sock: S; logger: CommandLogger; domain: (ctx: CommandContext<S>) => Promise<void> }): { handle(upsert: CmdUpsert): Promise<void> }`
  - `requireGroupAdmin<M extends { participants: CmdParticipant[] }>(deps: { sock: { groupMetadata(jid: string): Promise<M> }; groupJid: string; actor: string; audit: Audit }): Promise<M | null>`

- [ ] **Step 1: Escrever os testes da casca (falhando)**

Create `tests/collector/command-handler.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommandHandler, requireGroupAdmin } from '../../src/collector/command-handler.js'
import type { CommandContext } from '../../src/collector/command-handler.js'
import type { CmdUpsert } from '../../src/collector/command-core.js'

const GROUP = 'g@g.us'
const ACTOR = 'actor@s.whatsapp.net'

function fakeLogger() {
	const logs: Array<Record<string, unknown>> = []
	return { logs, logger: { info: (o: Record<string, unknown>) => { logs.push(o) } } }
}

// upsert com uma única mensagem de comando (texto configurável).
function upsert(opts: { type?: string; group?: string; actor?: string; text?: string } = {}): CmdUpsert {
	return {
		type: opts.type ?? 'notify',
		messages: [{
			key: { remoteJid: opts.group ?? GROUP, participant: opts.actor ?? ACTOR, id: 'CMD1' },
			message: { extendedTextMessage: { text: opts.text ?? '/ping' } },
		}],
	}
}

// ---- createCommandHandler ----

test('createCommandHandler: ignora upsert que não é notify', async () => {
	const { logger } = fakeLogger()
	let called = 0
	const h = createCommandHandler({ name: 'ping', sock: {}, logger, domain: async () => { called++ } })
	await h.handle(upsert({ type: 'append' }))
	assert.equal(called, 0)
})

test('createCommandHandler: ignora DM (não-@g.us)', async () => {
	const { logger } = fakeLogger()
	let called = 0
	const h = createCommandHandler({ name: 'ping', sock: {}, logger, domain: async () => { called++ } })
	await h.handle(upsert({ group: '5511@s.whatsapp.net' }))
	assert.equal(called, 0)
})

test('createCommandHandler: ignora comando que não casa o name', async () => {
	const { logger } = fakeLogger()
	let called = 0
	const h = createCommandHandler({ name: 'ping', sock: {}, logger, domain: async () => { called++ } })
	await h.handle(upsert({ text: '/pong' }))
	assert.equal(called, 0)
})

test('createCommandHandler: casa /ping e !ping e injeta ctx (actor, sock, audit)', async () => {
	const { logs, logger } = fakeLogger()
	const seen: Array<CommandContext<{ tag: string }>> = []
	const h = createCommandHandler({
		name: 'ping',
		sock: { tag: 'S' },
		logger,
		domain: async (ctx) => { seen.push(ctx); ctx.audit('ok', { n: 1 }) },
	})
	await h.handle(upsert({ text: '!ping' }))
	assert.equal(seen.length, 1)
	assert.equal(seen[0].groupJid, GROUP)
	assert.equal(seen[0].actor, ACTOR)
	assert.deepEqual(seen[0].sock, { tag: 'S' })
	// audit base injeta actor + group + result; extra é mesclado
	assert.deepEqual(logs.at(-1), { actor: ACTOR, group: GROUP, result: 'ok', n: 1 })
})

test('createCommandHandler: domain que lança → handler_error (best-effort); 2ª msg do lote ainda roda', async () => {
	const { logs, logger } = fakeLogger()
	const processed: string[] = []
	const u: CmdUpsert = {
		type: 'notify',
		messages: [
			{ key: { remoteJid: GROUP, participant: ACTOR, id: 'M1' }, message: { extendedTextMessage: { text: '/ping' } } },
			{ key: { remoteJid: GROUP, participant: ACTOR, id: 'M2' }, message: { extendedTextMessage: { text: '/ping' } } },
		],
	}
	let n = 0
	const h = createCommandHandler({
		name: 'ping', sock: {}, logger,
		domain: async () => { n++; processed.push('m' + n); if (n === 1) throw new Error('boom') },
	})
	await h.handle(u) // não deve lançar
	assert.equal(processed.length, 2)
	assert.ok(logs.some((l) => l.result === 'handler_error'), 'deveria auditar handler_error')
})

// ---- requireGroupAdmin ----

function auditSpy() {
	const logs: Array<{ result: string; extra: Record<string, unknown> }> = []
	const audit = (result: string, extra: Record<string, unknown> = {}) => { logs.push({ result, extra }) }
	return { logs, audit }
}

test('requireGroupAdmin: groupMetadata lança → metadata_error, retorna null', async () => {
	const { logs, audit } = auditSpy()
	const sock = { groupMetadata: async () => { throw new Error('meta boom') } }
	const meta = await requireGroupAdmin({ sock, groupJid: GROUP, actor: ACTOR, audit })
	assert.equal(meta, null)
	assert.equal(logs.at(-1)?.result, 'metadata_error')
})

test('requireGroupAdmin: autor não-admin → not_admin, retorna null', async () => {
	const { logs, audit } = auditSpy()
	const sock = { groupMetadata: async () => ({ id: GROUP, participants: [{ id: ACTOR, admin: null }] }) }
	const meta = await requireGroupAdmin({ sock, groupJid: GROUP, actor: ACTOR, audit })
	assert.equal(meta, null)
	assert.equal(logs.at(-1)?.result, 'not_admin')
})

test('requireGroupAdmin: autor admin → retorna a meta, sem auditar', async () => {
	const { logs, audit } = auditSpy()
	const expected = { id: GROUP, participants: [{ id: ACTOR, admin: 'admin' as const }] }
	const sock = { groupMetadata: async () => expected }
	const meta = await requireGroupAdmin({ sock, groupJid: GROUP, actor: ACTOR, audit })
	assert.deepEqual(meta, expected)
	assert.equal(logs.length, 0)
})
```

- [ ] **Step 2: Rodar o teste novo e confirmar que falha**

Run: `tsx --test tests/collector/command-handler.test.ts`
Expected: FAIL — `Cannot find module '../../src/collector/command-handler.js'`.

- [ ] **Step 3: Implementar `command-handler.ts`**

Create `src/collector/command-handler.ts`:

```ts
// Casca compartilhada dos comandos de moderação do coletor (/ban, /admin) — a parte COM efeitos
// (socket + logger). Complementa o command-core.ts (primitivos puros). Aqui vive a orquestração que
// todo comando repete: guarda de grupo/notify, loop best-effort do lote, try/catch e factory de
// audit (createCommandHandler), mais o par metadata + autorização de admin (requireGroupAdmin).

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage, type CmdParticipant, type CmdUpsert } from './command-core.js'

export interface CommandLogger {
	info(obj: Record<string, unknown>, msg?: string): void
}

// audit(result, extra?): registra uma tentativa. A casca injeta { actor, group }; cada comando pode
// embrulhar para acrescentar campos fixos (o /ban acrescenta `target`, o /admin `action`).
export type Audit = (result: string, extra?: Record<string, unknown>) => void

// Contexto entregue ao domínio de cada comando. Genérico no socket (S) para cada comando expor o
// seu próprio shape de sock (BanSocket / AdminSocket) já tipado dentro do ctx.
export interface CommandContext<S> {
	msg: CmdMessage
	groupJid: string
	actor: string
	sock: S
	audit: Audit
}

// Fábrica da casca: nome do comando (sem prefixo) + socket + logger + a regra de domínio.
// Retorna { handle(upsert) } best-effort — nunca lança (não pode derrubar a coleta).
export function createCommandHandler<S>(deps: {
	name: string
	sock: S
	logger: CommandLogger
	domain: (ctx: CommandContext<S>) => Promise<void>
}) {
	const { name, sock, logger, domain } = deps
	return {
		async handle(upsert: CmdUpsert): Promise<void> {
			if (upsert?.type !== 'notify') return
			for (const msg of upsert.messages || []) {
				try {
					const groupJid = msg.key?.remoteJid
					if (!groupJid || !groupJid.endsWith('@g.us')) continue // só grupos
					if (parseCommand(messageText(msg))?.name !== name) continue // é o meu comando? (/ e !)
					const actor = msg.key?.participant ? jidNormalizedUser(msg.key.participant) : ''
					const audit: Audit = (result, extra = {}) =>
						logger.info({ actor, group: groupJid, result, ...extra }, `${name}: tentativa`)
					await domain({ msg, groupJid, actor, sock, audit })
				} catch (err) {
					logger.info({ result: 'handler_error', err: String(err) }, `${name}: erro inesperado`)
				}
			}
		},
	}
}

// Autorização compartilhada: busca a metadata do grupo e confirma que o autor é admin/superadmin.
// Chamada PELO domínio (não pela casca) — assim cada comando valida a própria entrada ANTES da
// autorização, exatamente como era antes da refatoração.
// Retorna a metadata (tipada por comando) se autorizado; senão audita e retorna null.
export async function requireGroupAdmin<M extends { participants: CmdParticipant[] }>(deps: {
	sock: { groupMetadata(jid: string): Promise<M> }
	groupJid: string
	actor: string
	audit: Audit
}): Promise<M | null> {
	const { sock, groupJid, actor, audit } = deps
	let meta: M
	try {
		meta = await sock.groupMetadata(groupJid)
	} catch (err) {
		audit('metadata_error', { err: String(err) })
		return null
	}
	const me = (meta.participants || []).find((p) => jidNormalizedUser(p.id) === actor)
	if (!isAdmin(me)) {
		audit('not_admin')
		return null
	}
	return meta
}
```

- [ ] **Step 4: Rodar o teste novo e confirmar que passa**

Run: `tsx --test tests/collector/command-handler.test.ts`
Expected: PASS — todos os testes de `command-handler` verdes.

- [ ] **Step 5: Rodar a suíte completa + typecheck (nada pode quebrar)**

Run: `pnpm test`
Expected: PASS — todos os testes anteriores + os novos da casca. (Ban/admin/core ainda usam o código antigo; o módulo novo é aditivo.)

Run: `pnpm typecheck`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/collector/command-handler.ts tests/collector/command-handler.test.ts
git commit -m "refactor: cria command-handler (casca compartilhada dos comandos)"
```

---

### Task 2: `ban-command.ts` passa a usar a casca

Reescreve o `ban-command.ts` para conter só o domínio (`banDomain`) + wrapper `createBanHandler`. **Os testes de ban NÃO são tocados** — eles provam que o comportamento não mudou.

**Files:**
- Modify: `src/collector/ban-command.ts` (arquivo inteiro)
- Safety net (NÃO editar): `tests/collector/ban-command.test.ts`, `tests/collector/core.test.ts`

**Interfaces:**
- Consumes: `createCommandHandler`, `requireGroupAdmin`, `CommandContext`, `CommandLogger` (Task 1); `messageText`, `parseCommand`, `isAdmin`, `CmdMessage` (`command-core.ts`).
- Produces (inalterado — contrato público preservado): `parseBanCommand`, `resolveBanTarget`, `messageText` (re-export), `createBanHandler`, e os tipos `BanMessage`, `BanParticipant`, `BanGroupMetadata`, `BanUpdateResult`, `BanSocket`.

- [ ] **Step 1: Reescrever `src/collector/ban-command.ts`**

Substituir o conteúdo inteiro por:

```ts
// Comando de moderação /ban: parse do comando, resolução do alvo e execução da remoção.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.
// A casca (loop best-effort, guarda de grupo/notify, audit, autorização) vem de command-handler.

import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage } from './command-core.js'
import { createCommandHandler, requireGroupAdmin, type CommandContext, type CommandLogger } from './command-handler.js'

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

// Domínio do /ban: resolve o alvo (entrada) → autoriza → guardrails → remoção. A ordem entrada→auth
// é preservada porque requireGroupAdmin é chamado só depois de resolver/validar o alvo.
const banDomain = async ({ msg, groupJid, actor, sock, audit }: CommandContext<BanSocket>): Promise<void> => {
	const targetRaw = resolveBanTarget(msg)
	// o audit do ban carrega `target` em todo log (como antes): embrulha o audit base uma vez.
	const auditBan: typeof audit = (result, extra = {}) => audit(result, { target: targetRaw, ...extra })

	if (!targetRaw) { auditBan('no_target'); return }
	const meta = await requireGroupAdmin<BanGroupMetadata>({ sock, groupJid, actor, audit: auditBan })
	if (!meta) return // já auditou not_admin / metadata_error

	const target = jidNormalizedUser(targetRaw)
	const participants = meta.participants || []
	const findP = (jid: string) => participants.find((p) => jidNormalizedUser(p.id) === jid)

	// guardrails
	if (target === actor) { auditBan('self_ban'); return }
	const targetP = findP(target)
	if (!targetP) { auditBan('target_not_member'); return }
	if (isAdmin(targetP)) { auditBan('target_is_admin'); return }
	if (meta.owner && jidNormalizedUser(meta.owner) === target) { auditBan('target_is_owner'); return }

	// remoção
	try {
		let res: BanUpdateResult[]
		if (meta.linkedParent) {
			// proteção extra: o dono da COMUNIDADE pode diferir do owner do subgrupo
			try {
				const parent = await sock.groupMetadata(meta.linkedParent)
				if (parent.owner && jidNormalizedUser(parent.owner) === target) { auditBan('target_is_owner'); return }
			} catch { /* sem a metadata do pai, segue sem essa checagem extra */ }
			// communityParticipantsUpdate com 'remove' manda linked_groups:true → sai da comunidade + subgrupos
			res = await sock.communityParticipantsUpdate(meta.linkedParent, [targetP.id], 'remove')
		} else {
			res = await sock.groupParticipantsUpdate(groupJid, [targetP.id], 'remove')
		}
		auditBan('removed', { status: res?.[0]?.status ?? 'unknown', community: meta.linkedParent ?? null })
	} catch (err) {
		auditBan('remove_error', { err: String(err) })
	}
}

// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
export const createBanHandler = (deps: { sock: BanSocket; logger: CommandLogger }) =>
	createCommandHandler({ name: 'ban', sock: deps.sock, logger: deps.logger, domain: banDomain })
```

- [ ] **Step 2: Rodar os testes do ban (rede de segurança) — SEM editá-los**

Run: `tsx --test tests/collector/ban-command.test.ts`
Expected: PASS — todos os casos (parse, no_target, not_admin, self_ban, target_not_member, target_is_admin, target_is_owner, removed grupo/comunidade, metadata_error, remove_error) verdes, sem qualquer mudança no arquivo de teste.

- [ ] **Step 3: Rodar os testes de integração do core**

Run: `tsx --test tests/collector/core.test.ts`
Expected: PASS — em especial `messages.upsert com /ban de admin aciona a remoção`.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: sem erros (os tipos `Ban*` seguem exportados; `createBanHandler` mantém a assinatura `{ sock, logger }`).

- [ ] **Step 5: Commit**

```bash
git add src/collector/ban-command.ts
git commit -m "refactor: ban-command usa a casca compartilhada (command-handler)"
```

---

### Task 3: `admin-command.ts` passa a usar a casca

Reescreve o `admin-command.ts` para conter só o domínio (`adminDomain`) + wrapper `createAdminHandler`. **Os testes de admin NÃO são tocados.** Fecha com a suíte completa + typecheck provando o critério de sucesso.

**Files:**
- Modify: `src/collector/admin-command.ts` (arquivo inteiro)
- Safety net (NÃO editar): `tests/collector/admin-command.test.ts`, `tests/collector/core.test.ts`

**Interfaces:**
- Consumes: `createCommandHandler`, `requireGroupAdmin`, `CommandContext`, `CommandLogger` (Task 1); `messageText`, `parseCommand`, `CmdParticipant` (`command-core.ts`).
- Produces (inalterado — contrato público preservado): `parseAdminAction`, `createAdminHandler`, e os tipos `AdminGroupMetadata`, `AdminSocket`.

- [ ] **Step 1: Reescrever `src/collector/admin-command.ts`**

Substituir o conteúdo inteiro por:

```ts
// Comando de moderação /admin on|off: liga/desliga o modo "somente admins falam" do grupo.
// Vive no núcleo do coletor (roda em produção headless). Bot 100% silencioso: nunca responde —
// o único feedback é a mensagem de sistema nativa do WhatsApp. Toda tentativa é auditada via log.
// Escopo: só o grupo onde o comando foi digitado (sem cascata pra comunidade).
// A casca (loop best-effort, guarda de grupo/notify, audit, autorização) vem de command-handler.

import { messageText, parseCommand, type CmdParticipant } from './command-core.js'
import { createCommandHandler, requireGroupAdmin, type CommandContext, type CommandLogger } from './command-handler.js'

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

// Domínio do /admin: resolve on/off (entrada) → autoriza → idempotência → troca o setting. A ordem
// entrada→auth é preservada porque requireGroupAdmin é chamado só depois de validar o argumento.
const adminDomain = async ({ msg, groupJid, actor, sock, audit }: CommandContext<AdminSocket>): Promise<void> => {
	const action = parseAdminAction(messageText(msg))
	// o audit do admin carrega `action` em todo log (como antes): embrulha o audit base uma vez.
	const auditAdmin: typeof audit = (result, extra = {}) => audit(result, { action, ...extra })

	if (!action) { auditAdmin('no_action'); return } // /admin sem on|off válido
	const meta = await requireGroupAdmin<AdminGroupMetadata>({ sock, groupJid, actor, audit: auditAdmin })
	if (!meta) return // já auditou not_admin / metadata_error

	// idempotência: se o grupo já está no estado alvo, não chama a API
	const wantAnnounce = action === 'on'
	if (Boolean(meta.announce) === wantAnnounce) {
		auditAdmin(wantAnnounce ? 'already_on' : 'already_off'); return
	}

	// aplica o setting no grupo
	try {
		await sock.groupSettingUpdate(groupJid, wantAnnounce ? 'announcement' : 'not_announcement')
		auditAdmin('applied')
	} catch (err) {
		auditAdmin('setting_error', { err: String(err) })
	}
}

// best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
export const createAdminHandler = (deps: { sock: AdminSocket; logger: CommandLogger }) =>
	createCommandHandler({ name: 'admin', sock: deps.sock, logger: deps.logger, domain: adminDomain })
```

- [ ] **Step 2: Rodar os testes do admin (rede de segurança) — SEM editá-los**

Run: `tsx --test tests/collector/admin-command.test.ts`
Expected: PASS — todos os casos (parseAdminAction, no_action, not_admin, applied on/off, already_on/off, metadata_error, setting_error, guardas notify/DM/não-comando) verdes, sem qualquer mudança no arquivo de teste.

- [ ] **Step 3: Rodar a suíte completa + typecheck (critério de sucesso)**

Run: `pnpm test`
Expected: PASS — **todos** os testes: `command-core`, `command-handler` (novos), `ban-command`, `admin-command`, `core`. Confirmar que a contagem = (contagem anterior) + (os testes novos da casca), sem nenhuma regressão.

Run: `pnpm typecheck`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/collector/admin-command.ts
git commit -m "refactor: admin-command usa a casca compartilhada (command-handler)"
```

---

## Notas de verificação (todas as tasks)

- Se **qualquer** teste existente falhar após um refactor (Tasks 2/3), o comportamento mudou. Reverter o arquivo-fonte e comparar linha a linha com o original — **não** editar o teste.
- `core.ts` **não** deve precisar de nenhuma mudança. Se o typecheck reclamar de `core.ts`, é sinal de que uma assinatura pública mudou (ex.: `createBanHandler`/`createAdminHandler` deixaram de aceitar `{ sock, logger }`); corrigir o arquivo-fonte para restaurar a assinatura, não o `core.ts`.
- A única diferença observável aceitável é a **ordem das chaves** no objeto de log (JSON estruturado consumido por chave) — os testes verificam por chave, então isso não os afeta.

## Self-review (feito pelo autor do plano)

- **Cobertura do spec:** casca (`createCommandHandler` + `requireGroupAdmin`) → Task 1; encolhimento de `ban-command`/`admin-command` para domínio + wrapper → Tasks 2/3; `command-core.ts` puro e `core.ts` inalterado → garantidos pelas constraints e pelas Notas de verificação; testes novos da casca + rede de segurança dos existentes → cobertos.
- **Sem placeholders:** todo passo tem código/comando completo.
- **Consistência de tipos:** `createCommandHandler`/`requireGroupAdmin`/`CommandContext`/`CommandLogger`/`Audit` definidos na Task 1 são usados com as mesmas assinaturas nas Tasks 2/3; os tipos `Ban*`/`Admin*` exportados batem com o que os testes importam.
