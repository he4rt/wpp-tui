# Comando `/admin on|off` (+ prefixo `!`) — design

> Spec de implementação do comando de moderação `/admin on|off` no coletor de WhatsApp
> e da extensão do prefixo `!` para os comandos existentes.
> Data: 2026-07-06.

---

## Em uma frase

Admins de um grupo passam a poder ligar/desligar o modo **"somente admins falam"** do grupo
digitando `!admin on` / `!admin off` (ou `/admin on` / `/admin off`). O bot executa de forma
**totalmente silenciosa**; o único feedback é a mensagem de sistema nativa do WhatsApp. No mesmo
trabalho, o `/ban` e o `/admin` passam a aceitar **ambos os prefixos** `/` e `!`.

---

## Contexto

O `/ban` (implementado nesta mesma branch, `feat/comando-ban`, ainda não mergeada) introduziu a
**primeira ação** do bot: vive no núcleo do coletor (`src/collector/core.ts`, que roda headless em
produção via `src/headless.ts`), reaproveita o `sock` do Baileys, é **100% silencioso** e só é
autorizado por admin/superadmin do grupo, com auditoria de toda tentativa.

O `/admin on|off` segue **exatamente** esse molde, mudando apenas a ação: em vez de remover um
membro, liga/desliga o modo "somente admins falam" do grupo. No Baileys 7.0.0-rc12 isso é o setting
de **announcement** do grupo:

- `sock.groupSettingUpdate(jid, 'announcement')` → só admins podem enviar mensagens.
- `sock.groupSettingUpdate(jid, 'not_announcement')` → todos podem enviar.
- O estado atual vem em `GroupMetadata.announce: boolean` (já lido em `core.ts` no `toGroupInfo`).

**Escopo (decidido no brainstorming): só o grupo atual.** Diferente do `/ban` — cuja remoção
cascateia pra comunidade inteira via `communityParticipantsUpdate` (`linked_groups:true`, nativo) —
o announcement é um setting **por grupo** e **não** tem cascata nativa. `communitySettingUpdate`
afetaria apenas o grupo de avisos da comunidade, não os subgrupos. Mutar uma comunidade inteira
exigiria iterar cada subgrupo com o bot admin em todos — maior escopo e risco. Fica só o grupo onde
o comando foi digitado, que é o comportamento nativo do WhatsApp e o mais previsível.

Junto vem a extensão de prefixo: `/ban` e `/admin` passam a reconhecer também `!`
(`!ban`, `!admin on`, `!admin off`). A lógica de prefixo é centralizada num parser único
compartilhado, para os dois comandos herdarem o comportamento de um lugar só.

### Arquivos afetados

| Arquivo | Mudança |
|---|---|
| `src/collector/command-core.ts` | **novo** — primitivos compartilhados: tipos de mensagem, `messageText`, `parseCommand` (prefixo `/` ou `!`), `isAdmin`. |
| `src/collector/admin-command.ts` | **novo** — `parseAdminAction` (`on`/`off`) + `createAdminHandler` (autorização → idempotência via `meta.announce` → `groupSettingUpdate` → auditoria). |
| `src/collector/ban-command.ts` | **refactor** — importa de `command-core`; `parseBanCommand` passa a reconhecer `!ban`. Exports públicos preservados (compat com `core.ts` e testes). |
| `src/collector/core.ts` | **+1 handler** — cria `adminHandler` no `connect()` e o aciona no `messages.upsert` junto do `banHandler`. |
| `tests/collector/admin-command.test.ts` | **novo** — parse on/off, prefixos `/` e `!`, autorização, idempotência, sucesso, robustez. |
| `tests/collector/ban-command.test.ts` | **+casos** — `!ban`/`!BAN` reconhecidos. |

### Pré-requisito operacional (fora do código)

Para o setting funcionar, a **conta do bot precisa ser admin** do grupo. A permissão de quem digita
`/admin` serve só pra **autorização**; quem executa a mudança é o bot. Se o bot não for admin, a API
retorna erro — registrado no log de auditoria, sem nenhum feedback no grupo.

---

## Decisões (tomadas no brainstorming)

| Decisão | Escolha |
|---|---|
| **Ação** | Liga/desliga o modo "somente admins falam" via `groupSettingUpdate('announcement'\|'not_announcement')`. |
| **Escopo** | **Só o grupo atual** (sem cascata pra comunidade — não há API nativa). |
| **Argumento** | `on` / `off` obrigatório e explícito. Sem argumento ou argumento inválido → no-op silencioso (`no_action`). Sem toggle. |
| **Prefixo** | `/admin` **e** `!admin`; `/ban` **e** `!ban`. Centralizado num parser compartilhado. |
| **Feedback do bot** | **100% silencioso** — nunca responde, nem em erro/falta de permissão. Único sinal = msg de sistema nativa do WhatsApp. |
| **Autorização** | Admin/superadmin **do grupo onde o comando foi digitado** (mesma regra do `/ban`). |
| **Idempotência** | Se o grupo já está no estado alvo (`meta.announce` == alvo), não chama a API; audita `already_on`/`already_off`. |
| **Reuso de código** | Extrair primitivos compartilhados para `command-core.ts` (abordagem A). Sem command bus genérico (YAGNI). |

---

## APIs do Baileys (confirmadas — `@whiskeysockets/baileys@7.0.0-rc12`)

Verificadas direto na instalação (`lib/Socket/groups.d.ts`, `Types/GroupMetadata.d.ts`).

- `sock.groupSettingUpdate(jid, setting): Promise<void>`, com
  `setting ∈ 'announcement' | 'not_announcement' | 'locked' | 'unlocked'`.
  - `'announcement'` → só admins falam. `'not_announcement'` → todos falam.
- `GroupMetadata.announce?: boolean` — estado atual do modo announce (usado na idempotência).
- `GroupMetadata.participants[]: { id, admin: 'admin' | 'superadmin' | null }` e
  `GroupMetadata.owner` — usados na autorização (mesma metadata que o `/ban` já busca).
- `communitySettingUpdate` **existe** mas afeta só o grupo de avisos da comunidade, **não** cascateia
  pros subgrupos — por isso ficou fora de escopo.

---

## Estrutura de código (abordagem A — primitivos compartilhados)

```
  ┌────────────────────────┐
  │   command-core.ts      │  tipos de msg · messageText · parseCommand(/,!) · isAdmin
  └───────────┬────────────┘
              │ importado por
      ┌───────┴────────┐
      ▼                ▼
┌───────────────┐  ┌────────────────┐
│ ban-command.ts│  │admin-command.ts│  cada um com sua orquestração própria
└───────┬───────┘  └───────┬────────┘
        │ createBanHandler │ createAdminHandler
        ▼                  ▼
     ┌──────────────────────────┐
     │        core.ts           │  cria os 2 handlers, aciona ambos no messages.upsert
     └──────────────────────────┘
```

O `command-core.ts` guarda **só o que é genuinamente comum e estável**. Cada comando mantém a
própria lógica de domínio (o ban resolve alvo + guardrails + remoção; o admin resolve on/off + troca
o setting). Sem despachante genérico — para 2 comandos seria abstração prematura.

---

## Antes / depois

### `command-core.ts` (novo) — parser único com os dois prefixos

```ts
// ANTES (em ban-command.ts): só "/ban", boolean.
export function parseBanCommand(text: string): boolean {
  const first = text.trim().split(/\s+/)[0]
  return first?.toLowerCase() === '/ban'
}

// DEPOIS (command-core.ts): parser genérico, aceita "/" e "!".
export interface ParsedCommand { name: string; args: string[] }
export function parseCommand(text: string): ParsedCommand | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const m = /^[/!](\w+)$/.exec(tokens[0] ?? '')   // 1º token começa com / ou !
  if (!m) return null
  return { name: m[1].toLowerCase(), args: tokens.slice(1).map((t) => t.toLowerCase()) }
}
```

### `ban-command.ts` — passa a usar o parser compartilhado

```ts
// ANTES
export function parseBanCommand(text: string): boolean {
  const first = text.trim().split(/\s+/)[0]
  return first?.toLowerCase() === '/ban'
}

// DEPOIS — cobre "/ban" E "!ban"; messageText/isAdmin/tipos vêm de command-core
import { parseCommand } from './command-core.js'
export function parseBanCommand(text: string): boolean {
  return parseCommand(text)?.name === 'ban'
}
```

### `admin-command.ts` (novo) — esboço das unidades

```ts
import { parseCommand } from './command-core.js'

// puro — "on" | "off" se for o comando /admin (ou !admin) com argumento válido; senão null.
export function parseAdminAction(text: string): 'on' | 'off' | null {
  const cmd = parseCommand(text)
  if (cmd?.name !== 'admin') return null
  const arg = cmd.args[0]
  return arg === 'on' || arg === 'off' ? arg : null
}

// interface mínima do socket (injetável p/ testes sem rede)
export interface AdminSocket {
  groupMetadata(jid: string): Promise<AdminGroupMetadata>
  groupSettingUpdate(jid: string, setting: 'announcement' | 'not_announcement'): Promise<void>
}

// orquestra: autorização → idempotência (meta.announce) → groupSettingUpdate → auditoria
export function createAdminHandler(deps: { sock: AdminSocket; logger: AdminLogger }): {
  handle(upsert: { type: string; messages: AdminMessage[] }): Promise<void>
}
```

### `core.ts` — gancho no loop de eventos

```ts
// ANTES — dentro de activeSock.ev.process
if (events['messages.upsert']) {
  void banHandler.handle(events['messages.upsert'])
}

// DEPOIS — mesmo padrão best-effort; admin roda ao lado do ban
if (events['messages.upsert']) {
  void banHandler.handle(events['messages.upsert'])
  void adminHandler.handle(events['messages.upsert'])
}
```

O `adminHandler` é criado uma vez por `connect()`, recebendo o `activeSock` e um logger filho
(`deps.logger.child({ component: 'admin' })`), espelhando o `banHandler`.

---

## Fluxo (`/admin on|off`)

```
  [messages.upsert]     [filtro]              [autorização]        [ação]
        │                   │                     │                  │
   msg notify ──────► é @g.us e cmd ──────► autor é admin? ──────► groupSettingUpdate
   "!admin on"        name=='admin'         (key.participant       (announcement /
                      arg on|off?            na metadata)           not_announcement)
        │                   │                     │                  │
        │              não ├─ ignora         não ├─ audit         idempotência:
        │              arg inválido ┘         not_admin           meta.announce já
        │              → audit no_action                          == alvo? → audit
        │                                                         already_on/off,
        │                                                         sem chamada
        ▼
   auditoria SEMPRE: { actor, group, action, result }
   sucesso → WhatsApp emite a msg de sistema nativa (único feedback)
```

---

## Comportamento esperado (BDD)

### Happy path — ligar

- **Dado** que um admin do grupo digita `!admin on` (ou `/admin on`), **e** o bot é admin do grupo,
- **Quando** o `messages.upsert` chega,
- **Então** o bot chama `groupSettingUpdate(<grupo>, 'announcement')`, o grupo fica só-admin, o bot
  **não** responde nada, e uma linha de auditoria com `result: applied` e `action: on` é registrada.

### Happy path — desligar

- **Dado** `!admin off` (ou `/admin off`) de um admin,
- **Então** o bot chama `groupSettingUpdate(<grupo>, 'not_announcement')`; auditoria `applied`, `action: off`.

### Idempotência

- **Dado** `!admin on` num grupo **já** em modo announce (`meta.announce === true`),
- **Então** o bot **não** chama a API; auditoria `already_on`, sem alteração.
- **Análogo** para `!admin off` com `meta.announce === false` → `already_off`.

### Autorização (silenciosa)

- **Dado** que um membro comum (não-admin) manda `!admin on`,
- **Então** o bot **não** altera nada e **não** responde; auditoria `result: not_admin`.

### Bordas (todas silenciosas)

- **Dado** `!admin` sem argumento, ou `!admin xyz` (argumento inválido) → aborta silencioso;
  auditoria `no_action`.
- **Dado** um DM (não-`@g.us`) → ignora totalmente (nem chega a buscar metadata).
- **Dado** que o bot **não** é admin → `groupSettingUpdate` lança/retorna erro; auditoria
  `setting_error` com o erro, sem feedback.
- **Compatibilidade:** mensagens que **não** são o comando seguem o fluxo de coleta intacto — nada
  muda no data lake. O gancho é `void`/best-effort: exceção no handler é capturada e logada, **nunca**
  derruba nem atrasa a coleta.

### Prefixo `!` no `/ban`

- **Dado** `!ban` (ou `!BAN`) em reply/menção de um admin,
- **Então** o comportamento é idêntico ao `/ban` (remoção + auditoria). Nada mais do `/ban` muda.

---

## Unidades e responsabilidades

| Unidade | O que faz | Depende de | Testável |
|---|---|---|---|
| `parseCommand(text)` | Extrai `{ name, args }` do 1º token com prefixo `/` ou `!` (case-insensitive); `null` se não for comando. | — (puro) | sim, trivial |
| `messageText(msg)` | Lê `conversation` ou `extendedTextMessage.text`. | — (puro) | sim |
| `isAdmin(p)` | `true` se `admin === 'admin' \| 'superadmin'`. | — (puro) | sim |
| `parseAdminAction(text)` | `'on' \| 'off' \| null` p/ o comando `/admin` (ou `!admin`). | `parseCommand` | sim, trivial |
| `createAdminHandler({sock, logger})` | Orquestra autorização, idempotência, `groupSettingUpdate` e auditoria. | `AdminSocket` (injetável), `logger` | sim, com `sock` fake |
| `parseBanCommand(text)` (refactor) | `parseCommand(text)?.name === 'ban'` — agora cobre `!ban`. | `parseCommand` | sim |

---

## Plano de testes

### `tests/collector/admin-command.test.ts` (novo)

1. `parseAdminAction`: `'/admin on'`, `'!admin on'`, `'/ADMIN ON'` → `'on'`; `'/admin off'`,
   `'!admin off'` → `'off'`; `'/admin'`, `'!admin xyz'`, `'admin on'`, `'oi /admin on'` → `null`.
2. Handler ignora: não-comando, DM, upsert não-`notify`.
3. Autorização: autor não-admin → não chama `groupSettingUpdate`; audita `not_admin`.
4. Sucesso ligar: admin + `on` + grupo não-announce → `groupSettingUpdate(grupo, 'announcement')`; audita `applied`.
5. Sucesso desligar: admin + `off` + grupo announce → `groupSettingUpdate(grupo, 'not_announcement')`; audita `applied`.
6. Idempotência: `on` num grupo já announce → não chama API; audita `already_on`. (e o análogo `already_off`.)
7. Argumento ausente/inválido → não chama API; audita `no_action`.
8. Robustez: `groupMetadata`/`groupSettingUpdate` lançam → capturado, audita `metadata_error`/`setting_error`; `handle` resolve sem lançar.

### `tests/collector/ban-command.test.ts` (+casos)

9. `parseBanCommand`: `'!ban'`, `'!BAN'`, `'!ban @Fulano'` → `true`; segue rejeitando `'!bandido'`, `'ban'`.

Estilo de teste segue os existentes em `tests/collector/*` (mesma stack `node:test` + `assert/strict`,
mesmas convenções de fakes/fixtures do `ban-command.test.ts`).

---

## Riscos e pontos de atenção

1. **Permissão do bot:** `groupSettingUpdate` exige o bot admin do grupo. Sem isso, erro registrado
   (silencioso). Mesmo pré-requisito operacional do `/ban`.
2. **Refactor do `ban-command.ts`:** o ban já está testado e verde. A extração para `command-core.ts`
   preserva os exports públicos (`messageText`, `parseBanCommand`, `resolveBanTarget`,
   `createBanHandler` e tipos) para não quebrar `core.ts` nem os testes existentes — rodar a bateria
   do ban após o refactor é parte do plano.
3. **`@lid` vs telefone:** autorização compara JIDs normalizados com `jidNormalizedUser` (idêntico ao
   `/ban`). O admin não tem alvo de membro, então não há resolução de `contextInfo` — só o autor.
4. **Best-effort:** o handler nunca pode derrubar a coleta — toda exceção é capturada e logada. Os
   dois handlers (ban + admin) rodam independentes no `messages.upsert`.

---

## Fora de escopo (YAGNI)

- Cascata do `/admin` pra comunidade inteira (todos os subgrupos).
- Toggle sem argumento (`/admin` alterna sozinho) — argumento `on`/`off` é obrigatório.
- Command bus / dispatcher genérico para futuros comandos.
- Allowlist de grupos/moderadores; qualquer configuração via env; kill-switch.
- Alias extras (`/somenteadmins`) ou argumentos adicionais.
- Qualquer feedback textual no grupo (sucesso ou erro).
