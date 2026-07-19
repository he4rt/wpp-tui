# Comando `/ban` — design

> Spec de implementação do comando de moderação `/ban` no coletor de WhatsApp.
> Data: 2026-06-30.

---

## Em uma frase

Admins de um grupo passam a poder remover um membro da **comunidade inteira** (grupo + todos os
subgrupos) respondendo a uma mensagem dele — ou mencionando — com `/ban`. O bot executa a remoção
de forma **totalmente silenciosa**; o único feedback é a mensagem de sistema nativa do WhatsApp.

---

## Contexto

Hoje o bot é um **coletor silencioso**: `src/collector/core.ts` recebe os eventos do Baileys
(`messages.upsert`, etc.), persiste em log bruto, roteia pro outbox/webhook e repassa pra UI —
**nunca responde nem age**. Toda a operação de produção roda **headless** (`src/headless.ts` →
`startCollectorCore`).

O `/ban` introduz a **primeira ação** do bot. Por isso o handler vive no **núcleo do coletor**
(roda em produção headless) e reaproveita o `sock` do Baileys que já existe em `core.ts`. Colocar
na TUI (`src/hooks/use-socket.ts`) foi descartado: não rodaria em produção.

### Arquivos afetados

| Arquivo | Mudança |
|---|---|
| `src/collector/ban-command.ts` | **novo** — toda a lógica do comando (parse, resolução de alvo, autorização, guardrails, remoção). Injetável/testável. |
| `src/collector/core.ts` | **+1 gancho** no loop `activeSock.ev.process`, chamando o handler em `messages.upsert`. |
| `tests/collector/ban-command.test.ts` | **novo** — cobre parse, resolução, autorização, cada guardrail, caminho de sucesso (grupo e comunidade). |
| `docs/coletor-whatsapp-overview.md` | atualização opcional, citando o novo comando. |

### Pré-requisito operacional (fora do código)

Para a remoção funcionar, a **conta do bot precisa ser admin** do grupo/comunidade. A permissão de
quem digita `/ban` serve só pra **autorização**; quem executa a remoção é o bot. Se o bot não for
admin, a API retorna erro — registrado no log de auditoria, sem nenhum feedback no grupo.

---

## Decisões (tomadas no brainstorming)

| Decisão | Escolha |
|---|---|
| **Identificação do alvo** | Reply (autor da msg citada) **ou** menção `@`. Resolve por reply, senão por menção. Sem nome/número. |
| **Feedback do bot** | **100% silencioso** — nunca responde, nem em erro/falta de permissão. Único sinal = msg de sistema nativa do WhatsApp quando o ban ocorre. |
| **Autorização** | Admin/superadmin **do subgrupo onde o comando foi digitado**. |
| **Guardrails** | Não banir outros admins; não banir o dono; ignorar auto-ban; log de auditoria de toda tentativa. |
| **Escopo** | Ativo em qualquer grupo onde o bot é admin **e** quem digita é admin. Sem allowlist, sem env. |
| **Comando** | Só `/ban` (sem alias, sem env de kill-switch). |

---

## APIs do Baileys (confirmadas — `@whiskeysockets/baileys@7.0.0-rc12`)

Verificadas direto na instalação (`lib/Socket/groups.d.ts`, `communities.d.ts`, `Types/GroupMetadata.d.ts`)
e na implementação (`communities.js`).

- `makeWASocket` === `makeCommunitiesSocket` (camada externa) → o `sock` de `core.ts` **já expõe**
  `groupMetadata`, `groupParticipantsUpdate`, `communityParticipantsUpdate` e
  `communityFetchLinkedGroups`. **Nenhuma dependência nova.**
- `sock.groupMetadata(jid): Promise<GroupMetadata>`.
- `GroupMetadata.linkedParent?: string` — *"if this group is part of a community, it returns the
  jid of the community to which it belongs"*. É como detecto/obtenho a comunidade pai.
- `GroupMetadata.participants[]: { id, admin: 'admin' | 'superadmin' | null }` e
  `GroupMetadata.owner: string | undefined`.
- `GroupMetadata.addressingMode: 'lid' | 'pn'` — o grupo pode endereçar por `@lid` ou telefone.
- `sock.groupParticipantsUpdate(jid, jids[], action)` — `action ∈ 'add'|'remove'|'promote'|'demote'|'modify'`.
- `sock.communityParticipantsUpdate(jid, jids[], 'remove')` — **a cascata é nativa**: a
  implementação adiciona `attrs: { linked_groups: 'true' }` quando `action === 'remove'`, ou seja
  o WhatsApp remove da comunidade **e de todos os subgrupos vinculados** numa única chamada.
- Ambos retornam `{ status, jid, content }[]`, onde `status` é `'200'` ou um código de erro
  (ex.: `'403'` quando o bot não tem permissão) — registro esse `status` no log de auditoria.

> **Consequência de design:** banir "do grupo E da comunidade ao mesmo tempo" = **uma** chamada a
> `communityParticipantsUpdate` no `linkedParent`. Não é preciso iterar subgrupo por subgrupo.

---

## Fluxo

```
messages.upsert (type=notify)
        │
        ▼
  é grupo (@g.us) e texto == "/ban"? ───não──► ignora (segue coleta normal)
        │ sim
        ▼
  resolve ALVO:
   ├─ reply?  → message.extendedTextMessage.contextInfo.participant
   └─ menção? → message.extendedTextMessage.contextInfo.mentionedJid[0]
   └─ nenhum  → aborta SILENCIOSO (log: no_target)
        │
        ▼
  metadata = sock.groupMetadata(remoteJid)
        │
        ▼
  AUTORIZAÇÃO: autor (key.participant) é admin/superadmin no grupo? ──não──► aborta (log: not_admin)
        │ sim
        ▼
  GUARDRAILS sobre o alvo (todos abortam SILENCIOSO + log):
   ├─ alvo == autor?                      → log: self_ban
   ├─ alvo é admin/superadmin do grupo?   → log: target_is_admin
   ├─ alvo é owner (grupo/comunidade)?    → log: target_is_owner
   └─ alvo não está na lista do grupo?    → log: target_not_member
        │ ok
        ▼
  REMOÇÃO:
   ├─ metadata.linkedParent existe?  (subgrupo de comunidade)
   │     → sock.communityParticipantsUpdate(linkedParent, [alvo], 'remove')
   │       └─ linked_groups:true → remove da comunidade + TODOS os subgrupos
   └─ senão (grupo standalone):
         → sock.groupParticipantsUpdate(remoteJid, [alvo], 'remove')
        │
        ▼
  log de auditoria SEMPRE: { actor, target, group, community, status, result }
  sucesso → WhatsApp emite a msg de sistema nativa ("Fulano foi removido") — único feedback
```

---

## Comportamento esperado (BDD)

### Happy path — comunidade

- **Dado** que um admin de "Vagas" (subgrupo da comunidade He4rt) responde a uma mensagem do Fulano
  com `/ban`, **e** o bot é admin da comunidade,
- **Quando** o `messages.upsert` chega,
- **Então** o bot chama `communityParticipantsUpdate(<comunidade>, [<fulano>], 'remove')`, o Fulano
  é removido da comunidade e de todos os subgrupos, o bot **não** responde nada, e uma linha de
  auditoria com `status: '200'` é registrada.

### Happy path — grupo standalone

- **Dado** um grupo sem `linkedParent` e um admin que menciona `/ban @Fulano`,
- **Então** o bot chama `groupParticipantsUpdate(<grupo>, [<fulano>], 'remove')` e remove só desse grupo.

### Autorização

- **Dado** que um membro comum (não-admin) manda `/ban`,
- **Então** o bot **não** remove ninguém e **não** responde; registra auditoria `result: not_admin`.

### Guardrails (todos silenciosos)

- **Dado** que o alvo também é admin/superadmin → não remove; auditoria `target_is_admin`.
- **Dado** que o alvo é o owner (grupo ou comunidade) → não remove; auditoria `target_is_owner`.
- **Dado** que o admin dá `/ban` em reply à própria mensagem → ignora; auditoria `self_ban`.
- **Dado** que o alvo não está mais no grupo → não tenta; auditoria `target_not_member`.

### Bordas

- **Dado** `/ban` sem reply e sem menção → aborta silencioso; auditoria `no_target`.
- **Dado** que o bot **não** é admin → a chamada retorna erro; auditoria com o `status` retornado
  (ex.: `'403'`), sem feedback.
- **Endereçamento `@lid`:** o alvo (de `contextInfo`) e os `participants[].id` da metadata vêm no
  mesmo `addressingMode` do grupo; a comparação normaliza ambos com `jidNormalizedUser` e o `remove`
  passa o JID como está na lista de participantes.
- **Compatibilidade:** mensagens que **não** começam com `/ban` seguem o fluxo de coleta intacto —
  nada muda no data lake. O gancho é `void`/best-effort: uma exceção no handler é capturada e
  logada, **nunca** derruba nem atrasa a coleta.

---

## Antes / depois

### `core.ts` — gancho no loop de eventos

```ts
// ANTES — dentro de activeSock.ev.process
for (const [eventName, eventData] of Object.entries(events)) {
  saveEvent(eventName, eventData)
  router?.handleEvent(eventName, eventData)
  deps.onEvent?.(eventName, eventData)
}

// DEPOIS — adiciona o gancho do comando (best-effort, não bloqueia a coleta)
for (const [eventName, eventData] of Object.entries(events)) {
  saveEvent(eventName, eventData)
  router?.handleEvent(eventName, eventData)
  deps.onEvent?.(eventName, eventData)
}
if (events['messages.upsert']) {
  // erros são capturados e logados dentro do handler; nunca propagam pro loop de coleta
  void banHandler.handle(events['messages.upsert'])
}
```

O `banHandler` é criado uma vez por `connect()`, recebendo o `activeSock` e um logger filho
(`deps.logger.child({ component: 'ban' })`).

### `ban-command.ts` — esboço das unidades (novo)

```ts
// interface mínima do socket que o handler precisa — facilita teste sem rede
export interface BanSocket {
  groupMetadata(jid: string): Promise<GroupMetadata>
  groupParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<{ status: string; jid?: string }[]>
  communityParticipantsUpdate(jid: string, jids: string[], action: 'remove'): Promise<{ status: string; jid?: string }[]>
}

// puro — detecta o comando: true se o PRIMEIRO token do texto é "/ban" (case-insensitive).
// Precisa ser por token, não match exato: na menção o texto vem como "/ban @Fulano".
export function parseBanCommand(text: string): boolean

// puro — extrai o JID alvo do reply ou da menção
export function resolveBanTarget(msg: WAMessage): string | null

// orquestra: autorização → guardrails → remoção → auditoria
export function createBanHandler(deps: { sock: BanSocket; logger: Logger }): {
  handle(upsert: { type: string; messages: WAMessage[] }): Promise<void>
}
```

---

## Unidades e responsabilidades

| Unidade | O que faz | Depende de | Testável |
|---|---|---|---|
| `parseBanCommand(text)` | Detecta se o texto é o comando `/ban`. | — (puro) | sim, trivial |
| `resolveBanTarget(msg)` | Extrai o JID do alvo via `contextInfo.participant` (reply) ou `contextInfo.mentionedJid[0]` (menção). | — (puro) | sim, com fixtures |
| `createBanHandler({sock, logger})` | Orquestra autorização, guardrails, remoção (grupo vs comunidade) e auditoria. | `BanSocket` (injetável), `logger` | sim, com `sock` fake |

O texto do comando é lido de `message.conversation` **ou** `message.extendedTextMessage.text`
(reply/menção sempre usam `extendedTextMessage`). O autor é `key.participant`; o grupo é
`key.remoteJid`.

---

## Plano de testes (`tests/collector/ban-command.test.ts`)

1. `parseBanCommand`: `'/ban'`, `' /ban '`, `'/BAN'`, `'/ban @Fulano'`, `'/BAN @x'` → `true`;
   `'/bandido'`, `'ban'`, `'oi /ban'`, `'oi'` → `false`.
2. `resolveBanTarget`: reply → `contextInfo.participant`; menção → `mentionedJid[0]`; sem nenhum → `null`.
3. Autorização: autor não-admin → não chama nenhum `*ParticipantsUpdate`; loga `not_admin`.
4. Guardrails: alvo admin / alvo owner / auto-ban / alvo fora do grupo → não remove; loga o motivo.
5. Sucesso comunidade: `linkedParent` presente → chama `communityParticipantsUpdate(parent, [alvo], 'remove')`.
6. Sucesso standalone: sem `linkedParent` → chama `groupParticipantsUpdate(grupo, [alvo], 'remove')`.
7. Robustez: exceção do `sock` é capturada e logada; `handle` resolve sem lançar.
8. Não-comando: msg comum não dispara nenhuma chamada de remoção.

Estilo de teste segue os existentes em `tests/collector/*` (mesma stack/convenção do projeto).

---

## Riscos e pontos de atenção

1. **Permissão do bot na comunidade:** `communityParticipantsUpdate` exige que o bot seja admin da
   **comunidade pai**, não só do subgrupo. Sem isso, retorna erro (registrado, silencioso).
2. **`@lid` vs telefone:** confiar no `addressingMode` da metadata e comparar JIDs já normalizados.
   O alvo do `contextInfo` e os participantes da metadata vêm no mesmo modo do grupo.
3. **Owner da comunidade:** no caminho de comunidade, além do owner do subgrupo, comparo também
   contra o owner da comunidade pai (uma metadata extra só no caminho de comunidade — bans são
   raros, correção > micro-otimização).
4. **Best-effort:** o handler nunca pode derrubar a coleta — toda exceção é capturada e logada.

---

## Fora de escopo (YAGNI)

- Command bus genérico para futuros comandos (`/stats`, `/help`).
- Comando de unban / reversão.
- Allowlist de grupos ou de moderadores; qualquer configuração via env.
- Alias `/banir` ou argumentos extras (motivo, duração).
- Qualquer feedback textual no grupo (sucesso ou erro).
