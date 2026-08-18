# `/ban` em escopo de comunidade — design

> Evolução dos comandos de moderação: alvo fora do grupo do comando, denylist persistente,
> `/kick`, `/unban`, apagamento do comando e relatório rico em grupo de log.
> Data: 2026-08-18. Sucede [`2026-06-30-comando-ban-design.md`](./2026-06-30-comando-ban-design.md).

---

## Em uma frase

Admins **da comunidade** passam a banir de qualquer grupo, identificando o alvo por **telefone**
além de reply/menção, com o ban valendo para a comunidade inteira e **persistindo** — quem voltar
pelo link é removido de novo. Fora dos grupos privados de admin, o comando é **apagado**, e todo
resultado vira **relatório rico** no grupo de log e no journal do servidor.

---

## Contexto — o que quebrou em produção

Linha do journal que motivou esta spec (identificadores substituídos):

```json
{"component":"ban","actor":"100000000000002@lid","group":"120363000000000002@g.us",
 "result":"no_target","target":null,"msg":"ban: tentativa"}
```

Um admin tentou banir alguém que estava em **outro** subgrupo da comunidade. O comando morreu no
primeiro passo. Três defeitos independentes explicam isso:

| # | Defeito | Onde | Efeito |
|---|---|---|---|
| 1 | Alvo só é resolvível por reply ou menção | `ban-command.ts:24-32` | Quem não está no grupo não pode ser mencionado → `no_target`. **É o log acima.** |
| 2 | Guardrail exige o alvo no grupo do comando | `ban-command.ts:83` | Mesmo com o alvo resolvido, `target_not_member` aborta antes da chamada. |
| 3 | `removed` é logado com qualquer `status` | `ban-command.ts:92` | Bot sem admin na comunidade → WhatsApp devolve `403`, auditoria diz `removed`. Falha silenciosa. |

### Topologia (a real, com identificadores substituídos)

```
  Comunidade Exemplo   120363000000000001@g.us   ◄── comunidade (isCommunity: true)
    │                                              groupMetadata() devolve só os admins,
    │                                              prontos como lista de autorização
    ├── Grupo de Avisos     120363000000000005@g.us   [isCommunityAnnounce]
    ├── Grupo Geral         120363000000000002@g.us   ◄── grupo do log acima
    ├── Moderação           120363000000000004@g.us
    └── Grupo Secundário    120363000000000003@g.us
```

O `actor` do log é um dos admins da comunidade — a autorização nova
o aprovaria. O problema era só chegar ao alvo.

### O que já estava certo

`communityParticipantsUpdate(parent, [alvo], 'remove')` manda `linked_groups: 'true'`
(`lib/Socket/communities.js:260`): o WhatsApp remove da comunidade **e de todos os subgrupos** numa
chamada. A cascata nunca foi o problema — não muda.

---

## Decisões

| Decisão | Escolha | Nota |
|---|---|---|
| **Autorização** | Admin/superadmin **no JID da comunidade pai**, de qualquer grupo. | Substitui "admin do grupo onde digitou". |
| **Grupo sem comunidade** | Sem `linkedParent` → cai para admin **do próprio grupo**, ban limitado ao grupo. | Preserva o comportamento atual para grupos standalone. |
| **Identificação do alvo** | Reply · menção · **telefone** (`/ban 5500900000002`). Um alvo por comando. | JID cru e lote ficam fora. |
| **Escopo de busca do alvo** | Todos os subgrupos da comunidade, não só o grupo do comando. | Corrige o defeito 2. |
| **Motivo** | Texto livre após o alvo: `/ban 5500900000002 spam de cripto`. | Entra no relatório e na denylist. |
| **Ban persiste** | Denylist em disco; reentrada por link **ou por convite de admin** → remoção automática. | É o que separa "remoção" de "ban". |
| **Pré-ban** | Telefone que não está em nenhum grupo → só grava na denylist. | Remove na hora em que entrar. |
| **`/kick`** | Remove **só do grupo atual**, sem cascata e sem denylist. | Membro legítimo que aprontou num grupo. |
| **`/unban`** | Só tira da denylist. Não readiciona (WhatsApp não permite). | Retorno é sempre por link. |
| **Apagar comando** | Todo comando reconhecido — autorizado **ou não** — é apagado fora dos grupos privados de admin. | Membro comum não descobre os comandos testando. |
| **Feedback** | Relatório rico no grupo de log **e** no journal, em **toda** tentativa. | Operador vê tudo pelo `journalctl`; moderação vê pelo WhatsApp. |
| **Silêncio nos grupos comuns** | Mantido: nenhuma resposta fora do grupo de log. | Só a msg de sistema nativa do WhatsApp. |
| **Alvo admin de subgrupo** | **Pode** ser banido por admin da comunidade. | Hierarquia: comunidade > subgrupo. Ver *Riscos*. |
| **Configuração** | `MODERATION_GROUP_JID` e `LOG_GROUP_JID` por env, ambos opcionais. | Reverte o "sem env" da spec original — o caso de uso exige. |

### Degradação quando a env falta

| Faltando | Comportamento |
|---|---|
| `LOG_GROUP_JID` | Relatório só no journal. Comandos seguem funcionando. |
| `MODERATION_GROUP_JID` | **Nada é apagado** em lugar nenhum (fail-safe: na dúvida, não mexer em mensagem alheia). |

---

## APIs do Baileys (confirmadas em `@whiskeysockets/baileys@7.0.0-rc13`)

Nenhuma dependência nova; tudo já exposto pelo `sock` de `core.ts`.

| API | Uso | Confirmação |
|---|---|---|
| `groupMetadata(communityJid)` | Lista de admins da comunidade. | Devolveu 12/12 admins para o He4rt (`logs/group-metadata.json`). |
| `groupFetchAllParticipating()` | Diretório: todos os grupos com `participants[]` e `linkedParent`, numa chamada. | `lib/Socket/groups.js:23`. Já usado em `core.ts:144`. |
| `participants[].phoneNumber` | Casar telefone → `@lid` sem rede extra. | `lib/Socket/groups.js:337` — preenchido quando o grupo endereça por LID. |
| `signalRepository.lidMapping.getLIDForPN(pn)` | Fallback do telefone → LID. | `lib/Signal/lid-mapping.d.ts`. |
| `communityParticipantsUpdate(parent, [jid], 'remove')` | Ban em cascata. | `lib/Socket/communities.js:256-272` (`linked_groups: 'true'`). |
| `groupParticipantsUpdate(grupo, [jid], 'remove')` | `/kick` e grupos standalone. | `lib/Socket/groups.d.ts`. |
| `sendMessage(jid, { delete: key })` | Apagar o comando / a mensagem ofensiva. | `lib/Utils/messages.js:327` → `protocolMessage` tipo `REVOKE`. |
| `group-participants.update` | Gatilho da denylist. Traz `id`, `action` e `participants[].phoneNumber`. | Shape real em `logs/group-participants.update/2026-07-18.json`. |

> **Nota sobre o revoke:** quando o bot (admin) apaga mensagem de terceiro, o WhatsApp deixa o
> placeholder *"Esta mensagem foi apagada"*. Some o conteúdo, não o rastro.

---

## Fluxo

```
messages.upsert (type=notify)
   │
   ▼  parseCommand → ban | kick | unban | admin ?  ──não──► ignora (coleta segue intacta)
   │
   ├─────────────────────────────────────────────────────────────┐
   │  APAGAR: grupo ∉ {MODERATION_GROUP_JID, LOG_GROUP_JID}?     │  ◄── acontece SEMPRE,
   │          → sendMessage(grupo, { delete: msg.key })          │      antes de autorizar
   └─────────────────────────────────────────────────────────────┘
   │
   ▼  DIRETÓRIO DA COMUNIDADE  (cache TTL 60s)
   │  groupFetchAllParticipating() → grupos + participantes + linkedParent
   │  groupMetadata(linkedParent) → admins da comunidade
   │
   ▼  AUTORIZAÇÃO: autor ∈ admins da comunidade? ──não──► report(not_authorized) ✖
   │  (grupo standalone: autor é admin do próprio grupo?)
   │
   ▼  RESOLVE ALVO
   ├─ reply    → contextInfo.participant
   ├─ menção   → contextInfo.mentionedJid[0]
   ├─ telefone → varre participantes de TODOS os subgrupos (phoneNumber)
   │             └─ não achou → lidMapping.getLIDForPN() → não achou → PRÉ-BAN
   └─ nada     → report(no_target) ✖
   │
   ▼  GUARDRAILS
   ├─ alvo == autor                    → report(self_ban) ✖
   ├─ alvo ∈ admins da comunidade      → report(target_is_community_admin) ✖
   ├─ alvo == owner (grupo/comunidade) → report(target_is_owner) ✖
   └─ /kick e alvo ∉ grupo atual       → report(target_not_in_group) ✖
   │
   ▼  AÇÃO
   ├─ /ban   → denylist.add + (comunidade ? communityParticipantsUpdate : groupParticipantsUpdate)
   ├─ /kick  → groupParticipantsUpdate(grupo atual)     [sem denylist, sem cascata]
   └─ /unban → denylist.remove                          [sem rede]
   │
   ▼  status === '200' ? report(removed) : report(remove_rejected, { status })   ◄── corrige defeito 3
   │
   ▼  RELATÓRIO RICO  →  journal (pino)  +  sendMessage(LOG_GROUP_JID)
```

```
group-participants.update (action = 'add')
   │
   ▼  algum participante ∈ denylist (por @lid OU por phoneNumber)?
   │        └─ não ──► ignora
   ▼  sim → remove de novo (comunidade se houver linkedParent, senão do grupo)
   ▼  relatório: 'denylist_enforced' → journal + grupo de log
```

---

## Antes / depois

### 1. Resolução do alvo — o defeito que gerou o log

```ts
// ANTES — ban-command.ts:24-32 · só enxerga quem está ao alcance de um reply/menção
export function resolveBanTarget(msg: BanMessage): string | null {
	const ctx = msg.message?.extendedTextMessage?.contextInfo
	if (!ctx) return null
	if (ctx.stanzaId && ctx.participant) return ctx.participant
	const mentioned = ctx.mentionedJid
	if (mentioned && mentioned.length > 0) return mentioned[0]
	return null
}

// DEPOIS — target-resolver.ts · reply/menção continuam, e o telefone alcança a comunidade inteira
export interface ResolvedTarget {
	lid: string | null // null no pré-ban (número ainda sem conta conhecida na comunidade)
	phone: string | null // só dígitos, ex.: "5500900000002"
	foundIn: string[] // JIDs dos grupos onde o alvo está — vai pro relatório
	via: 'reply' | 'mention' | 'phone' | 'phone_pre_ban'
}

export function resolveTarget(msg: CmdMessage, args: string[], dir: CommunityDirectory): ResolvedTarget | null {
	const ctx = msg.message?.extendedTextMessage?.contextInfo
	if (ctx?.stanzaId && ctx.participant) return describe(ctx.participant, 'reply', dir)
	if (ctx?.mentionedJid?.length) return describe(ctx.mentionedJid[0], 'mention', dir)

	const phone = normalizePhone(args[0]) // "+55 00 90000-0002" → "5500900000002"
	if (!phone) return null

	const hit = dir.findByPhone(phone) // varre participants[].phoneNumber de TODOS os subgrupos
	return hit
		? { lid: hit.id, phone, foundIn: dir.groupsOf(hit.id), via: 'phone' }
		: { lid: null, phone, foundIn: [], via: 'phone_pre_ban' }
}
```

### 2. Autorização — do grupo para a comunidade

```ts
// ANTES — command-handler.ts:67 · o poder vinha do grupo onde o comando foi digitado
const meta = await requireGroupAdmin<BanGroupMetadata>({ sock, groupJid, actor, audit })
if (!meta) return

// DEPOIS — command-handler.ts · o poder vem do topo da comunidade
const auth = await requireCommunityAdmin({ sock, groupJid, actor, audit })
if (!auth) return
// auth: { group, community: GroupMetadata | null, scope: 'community' | 'group' }
// scope === 'group' só quando o grupo não tem linkedParent (standalone)
```

### 3. Auditoria honesta

```ts
// ANTES — ban-command.ts:92 · "removed" mesmo com 403
audit('removed', { status: res?.[0]?.status ?? 'unknown', community: meta.linkedParent ?? null })

// DEPOIS · o status decide o veredito
const status = res?.[0]?.status ?? 'unknown'
report(status === '200' ? 'removed' : 'remove_rejected', { status })
```

### 4. Relatório no grupo de log

```
🔨 BAN executado
por: Clinton · 100000000000001@lid (admin da comunidade)
em: Grupo Geral
alvo: +55 00 90000-0002 · 100000000000002@lid
estava em: Grupo Geral, Grupo Secundário
removido de: comunidade Comunidade Exemplo + 4 subgrupos (status 200)
motivo: spam de cripto
denylist: adicionado · comando apagado do Grupo Geral ✓
```

```
🚫 BAN negado
por: Fulano · 100000000000004@lid (não é admin da comunidade)
em: Grupo Geral · comando apagado ✓
alvo: +55 00 90000-0002
resultado: not_authorized
```

---

## Comportamento esperado (BDD)

### Happy path — o caso que falhou em produção

- **Dado** que Clinton é admin da comunidade de exemplo e digita `/ban 5500900000002 spam` no `Grupo Geral`,
  **e** o alvo está só no `Grupo Secundário`,
- **Quando** o `messages.upsert` chega,
- **Então** o bot resolve o `@lid` do alvo pelo `phoneNumber` do `Grupo Secundário`, chama
  `communityParticipantsUpdate` na comunidade, o alvo sai da comunidade e de todos os subgrupos,
  o comando é apagado do `Grupo Geral`, o alvo entra na denylist com o motivo `spam`, e o relatório
  rico aparece no grupo de log e no journal.

### Happy path — reply com mensagem ofensiva

- **Dado** um admin da comunidade que responde a uma mensagem de spam com `/ban`,
- **Então** o alvo é removido da comunidade, **a mensagem de spam é apagada**, o comando é apagado,
  e o relatório registra ambos os revokes.

### Pré-ban

- **Dado** `/ban 5500900000004` de um número que não está em nenhum grupo da comunidade,
- **Então** nenhuma chamada de remoção acontece, o número entra na denylist como pré-ban, e o
  relatório diz `pre_banned`.
- **Quando** esse número entrar por link, **então** o `group-participants.update` casa o
  `phoneNumber` com a denylist e ele é removido na hora (`denylist_enforced`).

### Reentrada

- **Dado** um alvo na denylist que volta pelo link de convite **ou** é adicionado por um admin,
- **Então** o bot remove de novo e reporta `denylist_enforced` com quem adicionou (`author`).

### `/kick`

- **Dado** `/kick @Fulano` no `Grupo Geral` por admin da comunidade,
- **Então** o alvo sai **só do Grupo Geral**, continua na comunidade e nos outros subgrupos, e **não**
  entra na denylist — pode voltar.

### `/unban`

- **Dado** `/unban 5500900000002` de um número na denylist,
- **Então** ele é removido da denylist, nenhuma chamada de rede acontece, e o relatório diz que o
  retorno depende de link de convite (o bot não readiciona).

### Autorização

- **Dado** um admin de subgrupo que **não** é admin da comunidade, digitando `/ban`,
- **Então** ninguém é removido, o comando é apagado, e o relatório registra `not_authorized`.
- **Dado** um membro comum digitando `/ban`, **então** idem — e ele não vê nenhum sinal de que o
  comando existe, porque a mensagem some sem resposta.

### Guardrails

- Alvo == autor → `self_ban`. Alvo ∈ admins da comunidade → `target_is_community_admin`.
- Alvo == owner do grupo ou da comunidade → `target_is_owner`.
- `/kick` de quem não está no grupo atual → `target_not_in_group`.

### Bordas e compatibilidade

- **Grupo standalone** (sem `linkedParent`): autorização cai para admin do próprio grupo e o ban
  remove só daquele grupo — igual ao comportamento de hoje.
- **Bot sem admin na comunidade**: `communityParticipantsUpdate` devolve `403` → relatório
  `remove_rejected` com o status, **não** `removed`.
- **Grupo de moderação e grupo de log**: comandos **não** são apagados neles.
- **`LOG_GROUP_JID` ausente**: relatório só no journal, nada quebra.
- **`MODERATION_GROUP_JID` ausente**: nada é apagado em lugar nenhum.
- **Coleta**: mensagens que não são comando seguem o fluxo intacto. Todos os handlers continuam
  best-effort — exceção é capturada e logada, nunca derruba nem atrasa a coleta.
- **Loop de remoção**: o `group-participants.update` de `action: 'remove'` não dispara nada, então
  a remoção feita pelo próprio bot não se realimenta.

---

## Unidades e responsabilidades

| Unidade | Arquivo | O que faz | Puro? |
|---|---|---|---|
| `normalizePhone` | `command-core.ts` | `"+55 00 90000-0002"` → `"5500900000002"`; valida 8–15 dígitos. | sim |
| `resolveTarget` | `target-resolver.ts` | reply · menção · telefone → `ResolvedTarget`. | sim (diretório injetado) |
| `CommunityDirectory` | `community-directory.ts` | Snapshot com TTL: grupos, participantes, `phoneNumber`, admins da comunidade. `findByPhone`, `findByLid`, `groupsOf`. | não (1 chamada de rede por TTL) |
| `ModerationDenylist` | `moderation-denylist.ts` | `logs/denylist.json`; índice duplo por `@lid` e por telefone; `add`/`remove`/`match`. | não (I/O) |
| `buildReport` / `formatReport` | `moderation-report.ts` | Monta o objeto do relatório e o texto do grupo de log. | sim |
| `requireCommunityAdmin` | `command-handler.ts` | View do escopo + confirma admin no topo. | não |
| visibilidade | `command-handler.ts` | Revoga o comando fora dos grupos privados de admin e publica o relatório. Vive na casca → vale para todo comando. | não |
| `resolveModerationConfig` | `moderation-config.ts` | Lê `MODERATION_GROUP_JID` / `LOG_GROUP_JID`; decide onde apagar. | sim |
| `removalDomain` | `removal-command.ts` | Regra compartilhada de remoção, parametrizada por alcance. | não |
| `createBanHandler` | `ban-command.ts` | Casca: alcance `community` + denylist. | não |
| `createKickHandler` | `kick-command.ts` | Casca: alcance `group`, sem denylist. | não |
| `createUnbanHandler` | `unban-command.ts` | Domínio de `/unban` (só denylist, sem rede). | não |
| `createDenylistEnforcer` | `denylist-enforcer.ts` | `group-participants.update` `add` → remoção automática, com dedupe de 10s. | não |

### Divergências da implementação

Registradas aqui para a spec continuar descrevendo o que existe:

- **`normalizePhone` mora em `command-core.ts`**, não no resolver: o diretório da comunidade também precisa dele para indexar `participants[].phoneNumber`.
- **`removal-command.ts` não estava previsto.** Surgiu ao implementar o `/kick`: os dois comandos diferem só no alcance, e duplicar a regra convidaria a divergência silenciosa.
- **`moderation-config.ts` não estava previsto** — a resolução das duas envs virou unidade pura própria, testável sem socket.
- **Telefone multi-token.** `/ban +55 00 90000-0001 spam` chega ao parser como tokens separados. `takePhone` junta o maior prefixo telefônico que forma um número válido, e só tenta isso quando o primeiro token sozinho não serve — senão `/ban 5500900000002 2024` engoliria o ano no número.
- **Fallback `lidMapping.getLIDForPN` não foi implementado.** Mostrou-se desnecessário: o `group-participants.update` já traz `phoneNumber` junto do `@lid` (confirmado nos logs reais), então o pré-ban casa pelo telefone sem consulta extra. Fica disponível caso apareça um caso que o telefone não resolva.
- **`/kick` usa a mesma autorização do `/ban`** (admin da comunidade). Graduar poder por tipo de comando deixaria a regra imprevisível para os moderadores.

### Ajuste em `command-core.ts`

`parseCommand` hoje faz `.toLowerCase()` em todos os args, o que destruiria o motivo
(`"Spam De Cripto"` → `"spam de cripto"`). Passa a devolver também `rest: string` com o texto
original após o comando. `args` continua em lowercase — o `/admin on|off` não muda.

### Persistência — `logs/denylist.json`

```json
{
  "entries": [
    {
      "lid": "100000000000002@lid",
      "phone": "5500900000002",
      "reason": "spam de cripto",
      "by": "100000000000001@lid",
      "at": "2026-08-18T13:17:59.895Z",
      "community": "120363000000000001@g.us"
    }
  ]
}
```

`lid` é `null` no pré-ban; `phone` é `null` quando o alvo veio de reply/menção num grupo que não
expõe telefone. O casamento na reentrada tenta os dois campos. Fica na raiz de `logs/` — o
`retention.ts:19` só desce em subdiretórios com nome de data, então não é podado (mesma garantia
do `group-metadata.json`).

---

## Plano de testes

Estilo dos `tests/collector/*` existentes: `node:test` + socket falso injetado, sem rede.

| Arquivo | Cobre |
|---|---|
| `target-resolver.test.ts` | `normalizePhone` (com `+`, espaços, hífen, parênteses, inválidos); precedência reply > menção > telefone; achado por `phoneNumber` em outro subgrupo; pré-ban quando não acha. |
| `community-directory.test.ts` | Monta índices a partir de `groupFetchAllParticipating` falso; TTL não rebate na rede; grupo sem `linkedParent` fica fora da comunidade. |
| `moderation-denylist.test.ts` | Add/remove/match por lid, por telefone, e pré-ban (lid nulo) casando na entrada; persistência round-trip. |
| `ban-command.test.ts` | Reescrito: autorização por comunidade; cada guardrail; `/ban` com telefone de outro grupo; `/kick` sem cascata e sem denylist; `remove_rejected` no status 403; grupo standalone. |
| `unban-command.test.ts` | Remove da denylist; alvo que não está na lista; nenhuma chamada de rede. |
| `denylist-enforcer.test.ts` | `action: 'add'` com alvo na denylist → remove; casamento por telefone (pré-ban); `action: 'remove'` não faz nada; alvo fora da denylist é ignorado. |
| `command-handler.test.ts` | `requireCommunityAdmin` (comunidade, standalone, erro de metadata); `deleteCommandMessage` respeita os dois grupos privados e a env ausente. |
| `moderation-report.test.ts` | Formatação de cada `result`; relatório sem `LOG_GROUP_JID`. |
| `core.test.ts` | Wiring: `messages.upsert` e `group-participants.update` chamam os handlers; exceção não derruba a coleta. |

---

## Riscos e pontos de atenção

1. **Admin de subgrupo virou alvo banível.** Hoje `target_is_admin` protege qualquer admin do
   grupo; a regra nova só protege admins **da comunidade**. É deliberado — admin da comunidade é
   hierarquicamente superior —, mas significa que um dos 12 pode remover um admin do `Grupo Secundário`.
   Se preferir manter a proteção antiga, é uma linha a mais no guardrail.
2. **`phoneNumber` pode faltar.** É preenchido quando o grupo endereça por LID
   (`lib/Socket/groups.js:337`). Confirmado presente nos eventos reais de 18/07, mas o fallback
   `lidMapping.getLIDForPN()` cobre o caso de não vir.
3. **Custo do diretório.** `groupFetchAllParticipating()` traz todos os grupos do bot (o maior com centenas de membros) e
   emite `groups.update` como efeito colateral (`lib/Socket/groups.js:56`) — o que gera tráfego no
   outbox. TTL de 60s mantém isso em 1 chamada por rajada de comandos.
4. **Apagar comando exige bot admin.** Sem isso o revoke falha; o relatório registra, mas a
   mensagem fica visível.
5. **Mass-ban por conta comprometida.** A denylist torna o ban difícil de reverter em lote. O
   `/unban` cobre o desfazer individual; rate limit ficou fora de escopo.
7. **Denylist gravada antes da remoção.** Num 403 a pessoa fica registrada como banida sem ter
   saído — e só será removida quando reentrar. É o trade-off escolhido: perder a decisão de
   moderação por falha de permissão seria pior. O log registra os dois fatos
   (`remove_rejected` + `denylisted: true`), então a inconsistência fica visível.
6. **Migração.** A denylist nasce vazia: bans anteriores a esta versão não são retroativos.

---

## Fora de escopo (YAGNI)

- Ban em lote (`/ban @a @b @c`) e alvo por JID/LID cru.
- `/ban` por DM com o bot.
- Rate limit, cooldown ou confirmação em duas etapas.
- Ban temporário (duração) e agendamento de `/unban`.
- Comando de listagem da denylist (`/banlist`) — o grupo de log já é o histórico.
- Qualquer feedback textual em grupo que não seja o de log.
