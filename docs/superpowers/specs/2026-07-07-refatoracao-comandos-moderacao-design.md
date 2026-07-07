# Refatoração da camada de comandos de moderação (`/ban`, `/admin`) — design

> Spec da refatoração que resolve o feedback de **separation of concerns** no PR #4:
> extrair a casca de orquestração duplicada entre `ban-command.ts` e `admin-command.ts`,
> deixando cada comando só com sua regra de domínio. **Sem mudança de comportamento.**
> Data: 2026-07-07.

---

## Em uma frase

A "casca" que todo comando repete — guarda de grupo/`notify`, loop best-effort do lote, `try/catch`,
factory de `audit`, e o par `groupMetadata` + checagem de admin — passa a viver **num lugar só**
(`command-handler.ts`). Cada comando fica apenas com o seu domínio (o `/ban` resolve alvo + guardrails
+ remoção; o `/admin` resolve `on|off` + troca o setting). **Nenhum rótulo de auditoria, ordem de
validação ou payload observável muda.**

---

## Contexto

O PR #4 introduziu o segundo comando de moderação (`/admin`), seguindo o molde do `/ban`. Isso expôs
o problema apontado na review: o **esqueleto** de cada comando está **copiado** entre os dois arquivos.
Comparando `ban-command.ts:61-126` e `admin-command.ts:35-89`, o único trecho que difere de verdade é
a regra de domínio; todo o resto é idêntico linha a linha:

```
ban-command.ts                          admin-command.ts
─────────────────────────────           ─────────────────────────────
guarda  !groupJid.endsWith('@g.us')  ≡  guarda  !groupJid.endsWith('@g.us')
match do comando → return            ≡  match do comando → return
actor = jidNormalizedUser(...)       ≡  actor = jidNormalizedUser(...)
const audit = (result, extra) => ... ≡  const audit = (result, extra) => ...
try { sock.groupMetadata } catch     ≡  try { sock.groupMetadata } catch
  → 'metadata_error'                       → 'metadata_error'
findP + isAdmin(findP(actor))        ≡  findP + isAdmin(findP(actor))
  → 'not_admin'                            → 'not_admin'
── só AQUI muda: guardrails+remoção ──   ── só AQUI muda: idempotência+setting ──
handle(upsert): notify-guard+loop+catch ≡ handle(upsert): idêntico
```

O `command-core.ts` já extraiu os **primitivos puros** (`parseCommand`, `messageText`, `isAdmin`) —
mas parou nos primitivos. A parte que mais se repete (a orquestração **com efeitos**: socket, logger)
ficou de fora e virou copiar-colar. Esta refatoração fecha essa lacuna.

**O que o problema NÃO é:** não é "tudo num arquivo só". Os arquivos já estão separados por comando.
A separação que falta é **por responsabilidade** (concern), não por arquivo.

### Custo do estado atual (o que a refatoração paga)

| Cenário | Hoje (duplicado) | Depois |
|---|---|---|
| Adicionar um 3º comando | copiar ~40 linhas de casca + editar `core.ts` | escrever só o domínio (~10 linhas) + fiar |
| Nova regra transversal (ex.: "o bot precisa ser admin") | editar em `ban` **e** `admin` (e todo futuro); risco de esquecer um | editar `requireGroupAdmin` **uma vez** |

### Arquivos afetados

| Arquivo | Mudança |
|---|---|
| `src/collector/command-handler.ts` | **novo** — a casca **com efeitos**: `createCommandHandler` (template method) + `requireGroupAdmin` (helper de metadata+autorização). |
| `src/collector/command-core.ts` | **inalterado** — segue puro (primitivos sem rede). Mantém a fronteira pura/efeitos. |
| `src/collector/ban-command.ts` | **refactor** — encolhe para domínio (`banDomain`) + wrapper `createBanHandler`. `parseBanCommand`/`resolveBanTarget` seguem exportados. |
| `src/collector/admin-command.ts` | **refactor** — encolhe para domínio (`adminDomain`) + wrapper `createAdminHandler`. `parseAdminAction` segue exportado. |
| `src/collector/core.ts` | **praticamente inalterado** — segue criando `banHandler`/`adminHandler` e acionando os dois no `messages.upsert`. |
| `tests/collector/command-handler.test.ts` | **novo** — cobre a casca isolada (guardas, best-effort) e `requireGroupAdmin` (metadata_error, not_admin, sucesso). |
| `tests/collector/ban-command.test.ts` | **reescrito** — mesmos casos/asserts de auditoria, exercitando `banDomain`/`createBanHandler`. |
| `tests/collector/admin-command.test.ts` | **reescrito** — idem para o `/admin`. |
| `tests/collector/core.test.ts` | **inalterado** — testemunha de que o comportamento observável não mudou. |

---

## Decisões (tomadas no brainstorming)

| Decisão | Escolha | Alternativa descartada |
|---|---|---|
| **Forma da abstração** | **Helper factory** (`createCommandHandler`, um "template method"). O `core.ts` continua listando e fiando cada handler à mão. | Registry + dispatcher central (indireção extra; só compensa com ~4-5 comandos). |
| **Onde mora a autorização** | **Helper fino**: `requireGroupAdmin` é chamado **pelo domínio**, não pela casca. Preserva a ordem entrada→autorização de hoje. | Casca resolve auth antes do domínio (inverteria a ordem: `not_admin` antes de `no_target`/`no_action`). |
| **Metadata compartilhada** | Cada comando busca a sua via `requireGroupAdmin` quando casa. Não há pré-busca compartilhada entre comandos — na prática já era assim (só um comando casa por mensagem). | Dispatcher pré-busca metadata uma vez (só faz sentido com registry). |
| **Compat da interface** | `createBanHandler`/`createAdminHandler` **mantidos** como wrappers → `core.ts` quase não muda. | Expor só `domain` e mover a fiação (mudaria mais o `core`). |
| **Escopo** | **Refatoração pura** — comportamento observável idêntico. | Aproveitar para mudar regras (fora de escopo). |

Continuamos honrando o YAGNI do spec anterior (`2026-07-06-comando-admin-design.md`): **nada de command
bus / dispatcher genérico**. Um "template method" que extrai a casca **de fato duplicada** não é um
despachante genérico — é a remoção da duplicação que surgiu quando o 2º comando chegou.

---

## Estrutura de código (camadas)

```
                     core.ts  (fiação — praticamente inalterado)
             cria banHandler + adminHandler · void ...handle(upsert) p/ cada
                                    │
              ┌─────────────────────┴─────────────────────┐
              ▼                                            ▼
      createBanHandler                             createAdminHandler
      (wrapper fino)                               (wrapper fino)
      banDomain(ctx):                              adminDomain(ctx):
        resolveBanTarget                             parseAdminAction
        requireGroupAdmin ◄──┐                       requireGroupAdmin ◄──┐
        guardrails+remoção   │                       idempotência+setting │
              │              │ usam a casca                │              │
              └──────────────┴───────────┬────────────────┘──────────────┘
                                          ▼
                 command-handler.ts  (NOVO — casca COM efeitos)
                 ┌───────────────────────────────────────────────────┐
                 │ createCommandHandler({name, sock, logger, domain}) │
                 │   • guarda notify + loop best-effort + try/catch   │
                 │   • guarda @g.us + match do nome (parseCommand)    │
                 │   • resolve actor + factory de audit base          │
                 │   • → chama domain(ctx)                            │
                 │ requireGroupAdmin({sock, groupJid, actor, audit})  │
                 │   • groupMetadata (try/catch → metadata_error)     │
                 │   • findP + isAdmin → not_admin ; retorna meta|null│
                 └───────────────────────────────────────────────────┘
                                          │ usa
                                          ▼
                 command-core.ts  (existente — PURO, sem rede)
                 parseCommand · messageText · isAdmin · tipos Cmd*
```

**Por que arquivo novo (`command-handler.ts`) e não em `command-core.ts`:** o `command-core.ts`
declara no topo "puros e sem dependência de rede — testáveis isoladamente". A casca toca `sock`
(rede) e `logger`. Misturar quebraria essa fronteira — que é, ela mesma, uma separação de concerns
que vale manter.

---

## Antes / depois

### `command-handler.ts` (novo) — a casca (template method + helper de auth)

```ts
import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { messageText, parseCommand, isAdmin, type CmdMessage, type CmdParticipant, type CmdUpsert } from './command-core.js'

export interface CommandLogger { info(obj: Record<string, unknown>, msg?: string): void }
export type Audit = (result: string, extra?: Record<string, unknown>) => void

// contexto entregue ao domínio de cada comando (sock é genérico p/ cada comando ter o seu shape)
export interface CommandContext<S> { msg: CmdMessage; groupJid: string; actor: string; sock: S; audit: Audit }

export function createCommandHandler<S>(deps: {
  name: string
  sock: S
  logger: CommandLogger
  domain: (ctx: CommandContext<S>) => Promise<void>
}) {
  const { name, sock, logger, domain } = deps
  return {
    // best-effort: nunca lança (não pode derrubar a coleta). Cada msg do lote é tratada isolada.
    async handle(upsert: CmdUpsert): Promise<void> {
      if (upsert?.type !== 'notify') return
      for (const msg of upsert.messages || []) {
        try {
          const groupJid = msg.key?.remoteJid
          if (!groupJid || !groupJid.endsWith('@g.us')) continue          // só grupos
          if (parseCommand(messageText(msg))?.name !== name) continue      // é o MEU comando? (/ e !)
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

// autorização + metadata compartilhadas. Chamada PELO domínio → preserva a ordem entrada→auth.
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
    audit('metadata_error', { err: String(err) }); return null
  }
  const me = (meta.participants || []).find((p) => jidNormalizedUser(p.id) === actor)
  if (!isAdmin(me)) { audit('not_admin'); return null }
  return meta
}
```

### `ban-command.ts` — antes (casca + auth + domínio juntos) / depois (só domínio)

```ts
// ANTES — handleMessage mistura casca, auth e domínio (ban-command.ts:61-112);
// + handle(upsert) com notify-guard/loop/try-catch idêntico ao admin.

// DEPOIS — só o domínio; casca e auth vêm da camada compartilhada.
import { createCommandHandler, requireGroupAdmin, type CommandContext } from './command-handler.js'

const banDomain = async ({ msg, groupJid, actor, sock, audit }: CommandContext<BanSocket>) => {
  const targetRaw = resolveBanTarget(msg)
  // audit do ban carrega `target` em todo log (como hoje): embrulha o audit base uma vez.
  const auditBan: typeof audit = (result, extra = {}) => audit(result, { target: targetRaw, ...extra })

  if (!targetRaw) { auditBan('no_target'); return }                      // entrada 1º (ordem preservada)
  const meta = await requireGroupAdmin<BanGroupMetadata>({ sock, groupJid, actor, audit: auditBan })
  if (!meta) return                                                      // já auditou not_admin/metadata_error

  const target = jidNormalizedUser(targetRaw)
  /* self_ban · target_not_member · target_is_admin · target_is_owner · remoção grupo/comunidade */
}

export const createBanHandler = (deps: { sock: BanSocket; logger: CommandLogger }) =>
  createCommandHandler({ name: 'ban', sock: deps.sock, logger: deps.logger, domain: banDomain })
```

### `admin-command.ts` — depois (só domínio)

```ts
import { createCommandHandler, requireGroupAdmin, type CommandContext } from './command-handler.js'

const adminDomain = async ({ msg, groupJid, actor, sock, audit }: CommandContext<AdminSocket>) => {
  const action = parseAdminAction(messageText(msg))
  const auditAdmin: typeof audit = (result, extra = {}) => audit(result, { action, ...extra })

  if (!action) { auditAdmin('no_action'); return }                       // entrada 1º (ordem preservada)
  const meta = await requireGroupAdmin<AdminGroupMetadata>({ sock, groupJid, actor, audit: auditAdmin })
  if (!meta) return

  const wantAnnounce = action === 'on'
  if (Boolean(meta.announce) === wantAnnounce) { auditAdmin(wantAnnounce ? 'already_on' : 'already_off'); return }
  try {
    await sock.groupSettingUpdate(groupJid, wantAnnounce ? 'announcement' : 'not_announcement')
    auditAdmin('applied')
  } catch (err) {
    auditAdmin('setting_error', { err: String(err) })
  }
}

export const createAdminHandler = (deps: { sock: AdminSocket; logger: CommandLogger }) =>
  createCommandHandler({ name: 'admin', sock: deps.sock, logger: deps.logger, domain: adminDomain })
```

### `core.ts` — inalterado

Segue criando `banHandler`/`adminHandler` no `connect()` (cada um com seu `logger.child({ component })`)
e acionando ambos no `messages.upsert`. A fiação explícita que motivou a escolha da Opção 3 permanece.

---

## Comportamento esperado (BDD) — tudo preserva-comportamento

```
Given /ban de admin com alvo por reply
Then groupParticipantsUpdate é chamado com o alvo          (core.test.ts:274 segue verde)

Given /admin on de admin num grupo liberado
Then groupSettingUpdate(jid,'announcement') é chamado      (core.test.ts:309 segue verde)

Given /ban sem alvo (malformado)
Then audita no_target ANTES de checar admin, sem buscar metadata   (ordem preservada)

Given /admin sem argumento válido
Then audita no_action, sem buscar metadata                 (ordem preservada)

Given comando válido de não-admin
Then requireGroupAdmin audita not_admin e o domínio para   (resultado idêntico ao de hoje)

Given groupMetadata lança
Then requireGroupAdmin audita metadata_error e retorna null (coleta não cai)

Given o domínio lança inesperadamente
Then a casca captura → handler_error e o lote segue         (best-effort preservado)

Given uma mensagem que não é comando
Then segue o fluxo de coleta intacto                        (nada muda no data lake)
```

**Critério de sucesso:** os testes de integração de `core.test.ts` passam sem edição, e os asserts de
`result` de auditoria dos testes de comando são idênticos aos atuais.

### Única diferença cosmética (sem impacto funcional)

A **ordem das chaves** no objeto de log pode mudar (ex.: `{actor, group, result, target}` em vez de
`{actor, target, group, result}`), porque o `target`/`action` passa a entrar via `extra`. Logs são
JSON estruturado consumido por chave — queries e o pino não dependem da ordem. Os valores e as chaves
presentes são os mesmos.

---

## Unidades e responsabilidades

| Unidade | O que faz | Depende de | Testável |
|---|---|---|---|
| `createCommandHandler({name,sock,logger,domain})` | Casca: notify-guard, loop best-effort, `try/catch`, guarda `@g.us`, match do nome, resolve actor, audit base; delega ao `domain`. | `command-core` (puro), `sock`/`logger` injetados | sim, com `domain` fake |
| `requireGroupAdmin({sock,groupJid,actor,audit})` | Busca metadata (`metadata_error`), acha o autor, `isAdmin` (`not_admin`); retorna `meta` ou `null`. | `sock.groupMetadata` (injetável) | sim, com `sock` fake |
| `banDomain(ctx)` | Resolve alvo, chama `requireGroupAdmin`, guardrails, remoção grupo/comunidade. | casca, `resolveBanTarget` | sim |
| `adminDomain(ctx)` | Resolve `on/off`, chama `requireGroupAdmin`, idempotência, `groupSettingUpdate`. | casca, `parseAdminAction` | sim |
| `createBanHandler` / `createAdminHandler` | Wrapper: `createCommandHandler` com o `name` e o `domain` do comando. | casca | via testes de handler |

---

## Plano de testes

### `tests/collector/command-handler.test.ts` (novo)

1. `handle`: ignora upsert não-`notify`; ignora DM (não-`@g.us`); ignora mensagem cujo comando não casa o `name`.
2. `handle`: `domain` que lança → capturado, audita `handler_error`, `handle` resolve sem lançar; e uma 2ª mensagem no mesmo lote ainda é processada (isolamento por mensagem).
3. `handle`: `domain` recebe `ctx` com `actor` normalizado e `audit` que loga `{actor, group, result, ...extra}`.
4. `requireGroupAdmin`: `groupMetadata` lança → audita `metadata_error`, retorna `null`.
5. `requireGroupAdmin`: autor não-admin → audita `not_admin`, retorna `null`.
6. `requireGroupAdmin`: autor admin/superadmin → retorna a `meta`, sem auditar.

### `tests/collector/ban-command.test.ts` (reescrito) e `admin-command.test.ts` (reescrito)

Mantêm **os mesmos casos e asserts de `result`** de hoje (parse, autorização, guardrails, idempotência,
robustez, ordem entrada→auth), exercitando `createBanHandler`/`createAdminHandler`. As funções puras
(`parseBanCommand`, `resolveBanTarget`, `parseAdminAction`) seguem testadas isoladas.

### `tests/collector/core.test.ts` (inalterado)

Rodado como está: prova end-to-end de que `/ban` → remoção e `/admin on` → `groupSettingUpdate`
continuam funcionando com a fiação real.

Estilo segue os testes existentes em `tests/collector/*` (`node:test` + `assert/strict`, mesmos fakes).

---

## Riscos e pontos de atenção

1. **Refatoração deve ser invisível:** o critério é `core.test.ts` verde sem edição. Se algum teste de
   integração exigir mudança, é sinal de que o comportamento mudou — investigar antes de "consertar o teste".
2. **Tipagem genérica do socket:** `createCommandHandler<S>` propaga o shape do socket até o `ctx.sock`,
   e `requireGroupAdmin<M>` retorna a metadata no tipo de cada comando (`BanGroupMetadata`/`AdminGroupMetadata`).
   `pnpm typecheck` faz parte da verificação.
3. **`audit` enriquecido:** `target` (ban) e `action` (admin) entram via wrapper local do audit — conferir
   que aparecem em **todos** os logs do respectivo comando, como hoje (inclusive `no_target`/`no_action`).
4. **Best-effort preservado:** a casca captura toda exceção do domínio; os dois handlers seguem rodando
   independentes no `messages.upsert`.

---

## Fora de escopo (YAGNI)

- Command bus / registry / dispatcher genérico (mantém a decisão do spec do `/admin`).
- Qualquer mudança de comportamento: novos rótulos de auditoria, nova ordem de validação, novas regras.
- Declaração de autorização por comando (ex.: `requiresAdmin` configurável) — hoje todo comando exige admin.
- Pré-busca de metadata compartilhada entre comandos (só faria sentido com dispatcher).
- Alias, novos comandos, allowlist, feedback textual no grupo.
