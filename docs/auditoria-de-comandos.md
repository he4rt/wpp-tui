# Auditoria dos comandos de moderação

O que fica registrado quando alguém usa um comando: **quem**, **onde**, **o quê**, **quando**,
**qual alvo** e **qual resultado**. A remoção em si não persiste nada, então esta trilha é a única
memória do que a moderação fez — é ela que responde "quem tirou o Fulano?" e "por que meu `/ban`
não funcionou?".

Comandos existentes: **`/ban`** (remove da comunidade inteira), **`/kick`** (remove só do grupo onde
foi digitado), **`/admin on|off`** (liga/desliga "somente admins falam" no grupo). Prefixo `/` ou `!`.

## Duas vias, mesmo conteúdo

```
mensagem "/ban 5500900000001 spam" num grupo
        │
        ▼
 quem digitou é admin no grupo? ──┬── sim ──► apaga a mensagem (fora dos grupos de admin),
        │                         │           mesmo que o comando seja recusado
        │                         └── não ──► mensagem INTACTA
        ▼
 o comando age (ou é recusado)
        │
        ├──► journal (pino)              ──► journalctl --user -u whatsapp-collector
        │    1 linha JSON por tentativa       (ou wa-logs.txt no Modo TUI)
        │
        └──► relatório no grupo de log   ──► LOG_GROUP_JID (texto legível)
             (no-op se a env não existir)
```

**Apagar segue o status de quem digitou, não o veredito do comando.** Quem tem galão de admin no
grupo — da comunidade ou só daquele subgrupo — tem a mensagem apagada inclusive quando o comando é
recusado: moderação, ainda que negada, não é assunto público. Já a mensagem de quem não é admin fica
onde está — o bot não mexe em quem não manda, e o que houve vive aqui na trilha, não no silêncio.

Toda **tentativa** entra nas duas — inclusive as negadas, as recusadas pelo WhatsApp e as que nem
tinham alvo. O relatório é o que o moderador lê; o journal é o que o operador consulta quando o
WhatsApp está fora do ar ou quando é preciso correlacionar com o evento cru.

### "Journal" = log da aplicação, não o log de eventos

Termo herdado do journald e usado em todo o código; vale desfazer a confusão:

| | O que é | Onde fica |
|---|---|---|
| **Log de eventos** | dump cru do que o WhatsApp manda | `logs/<evento>/<dia>.json` (arquivo no projeto) |
| **Journal** | o que o nosso código escreve via `logger.info(...)` — a auditoria mora aqui | Modo TUI: `wa-logs.txt` · Modo headless: stdout → **journald** do systemd |

No server o serviço não mantém arquivo de log próprio: o pino imprime JSON no stdout e o systemd
captura (`journalctl --user -u whatsapp-collector`). Logo **a retenção da auditoria é a do journald
do usuário**, não a do `LOG_RETENTION_DAYS` — que só poda `logs/<evento>/`.

## Campos de toda linha (a identidade da tentativa)

Injetados pela casca (`command-handler.ts`) em **todas** as linhas daquela mensagem:

| Campo | O que responde | Nota |
|---|---|---|
| `command` | qual comando | `ban`, `kick`, `admin` (sem prefixo) |
| `actor` | quem usou | `@lid` normalizado de quem digitou |
| `actorName` | quem usou, legível | `pushName` da mensagem; `null` se não veio |
| `group` | onde usou | JID do grupo do comando |
| `groupName` | onde usou, legível | do cache `logs/group-metadata.json`; ausente se desconhecido |
| `messageId` | qual mensagem | ponte para `logs/messages.upsert/<dia>.json` — a forma de reencontrar o comando depois que o bot apagou a mensagem |
| `sentAt` | quando foi digitado | ISO; difere do horário do log quando o lote chega atrasado (reconexão) |
| `text` | o que foi digitado | comando cru, truncado em 200 chars |
| `result` | o que aconteceu | ver as tabelas abaixo |
| `deleted` | a mensagem foi apagada? | só quando há grupos de admin configurados |
| `deleteSkip` | por que não apagou | `not_authorized` (não passou pela autorização, ou parou antes dela), `private_admin_group`, `moderation_group_unset`, `delete_failed` |

O `component` do pino repete o comando (`component: 'ban'`), e o `time` do pino é o **processamento**
— para o horário de quem digitou, use `sentAt`.

## Campos do alvo (`/ban` e `/kick`)

Presentes em **todas** as linhas desses comandos, mesmo nas recusas:

| Campo | Significado |
|---|---|
| `target` | `@lid` do alvo, ou `null` se não resolveu |
| `phone` | telefone do alvo, só dígitos |
| `via` | como o alvo foi identificado: `reply`, `mention`, `phone`, `phone_suffix`, `phone_not_member`, `phone_ambiguous`, `phone_incomplete` |
| `reason` | o motivo digitado depois do alvo |
| `scope` | `community` (autoridade e alcance na comunidade) ou `group` (grupo standalone) |
| `community` | JID da comunidade pai, ou `null` |

No sucesso entram também `status` (resposta do WhatsApp), `reach` (`community`/`group`) e
`removedFrom` (grupos de onde a pessoa saiu).

## Resultados possíveis

### `/ban` e `/kick`

| `result` | Significado |
|---|---|
| `removed` | removido (status 200) |
| `remove_rejected` | o WhatsApp recusou; `status: '403'` = o bot não é admin da comunidade |
| `remove_error` | exceção na chamada de remoção (`err` no log) |
| `not_authorized` | quem digitou não é admin do topo; `groupAdmin`/`member` dizem se era admin do subgrupo ou membro comum |
| `group_unknown` | o grupo não está no snapshot do diretório |
| `directory_error` | falhou buscar os grupos (`groupFetchAllParticipating`) |
| `no_target` | nenhum alvo: sem reply, sem menção, sem número |
| `phone_ambiguous` | final de número casou com N membros (`candidates`) |
| `phone_incomplete` | número parcial que não casou com ninguém — quase sempre erro de digitação |
| `target_not_found` | número completo que não está em nenhum grupo do escopo |
| `target_not_member` | alvo identificado, mas fora dos grupos do escopo |
| `target_not_in_group` | só `/kick`: o alvo está na comunidade, mas não neste grupo |
| `self_ban` | o autor tentou remover a si mesmo |
| `target_is_community_admin` / `target_is_admin` | alvo é admin do topo (protegido) |
| `target_is_owner` | alvo é owner do grupo ou da comunidade (protegido) |

### `/admin on|off`

| `result` | Significado |
|---|---|
| `applied` | trocou o setting; `action`, `announceBefore`, `announceAfter` dizem o quê |
| `already_on` / `already_off` | já estava no estado pedido; nenhuma chamada feita |
| `no_action` | `/admin` sem `on|off` válido (o `text` mostra o que foi digitado) |
| `not_admin` | quem digitou não é admin **deste grupo** (autorização deliberadamente diferente do `/ban` — ver o cabeçalho de `admin-command.ts`); `member` diz se estava na lista do grupo |
| `metadata_error` | falhou buscar a metadata do grupo |
| `setting_error` | o WhatsApp recusou a troca do setting |

### Comuns à casca

| `result` | Significado |
|---|---|
| `delete_error` | não deu para apagar a mensagem do comando (bot sem admin no grupo). Vai ao journal **e** ao grupo de log |
| `handler_error` | exceção inesperada; carrega `command`, `group`, `actor`, `messageId` e `err` |

## Mensagem apagada por outra pessoa

Nem toda moderação passa por comando: um admin apagar a mensagem de um membro é ato de moderação e
não deixava rastro nenhum — o conteúdo saía do grupo e ninguém mais sabia o que havia sido dito nem
quem tirou. O gancho é o `messages.update` com `messageStubType: 1` (`REVOKE`), que traz as duas
pontas: `key.participant` é o autor da mensagem e `update.key.participant` é quem apagou.

| Campo | Significado |
|---|---|
| `event` | sempre `message_deleted` (não é comando, não tem `result`) |
| `deletedBy` | quem apagou |
| `author` / `authorName` | de quem era a mensagem (nome vem do log da mensagem original) |
| `group` / `groupName` | onde |
| `messageId` | id da mensagem apagada |
| `sentAt` | quando a mensagem apagada havia sido enviada |
| `kind` | o que era: `conversation`, `imageMessage`, `audioMessage`… |
| `text` | o conteúdo apagado, truncado em 300 chars |
| `recovered` | o conteúdo foi encontrado na trilha crua? |

O conteúdo **não vem no evento** — é recuperado de `logs/messages.upsert/<dia>.json` pelo id,
varrendo até 3 dias para trás. Se o log já foi podado (`LOG_RETENTION_DAYS`), o registro sai com
`recovered: false`: ainda diz quem apagou o quê de quem, sem o teor.

Dois casos **não** entram na trilha, deliberadamente:

- **quem apaga a própria mensagem** — é arrependimento, não moderação; vigiar isso transformaria a
  trilha em vigilância de conversa;
- **o apagamento que o próprio bot faz** ao esconder um comando de moderação — aquilo já é auditado
  como comando, e registrar de novo duplicaria cada `/ban`.

## Como consultar

```bash
# tudo de moderação, ao vivo
journalctl --user -u whatsapp-collector -f | grep -E '"component":"(ban|kick|admin)"'

# só o que foi executado hoje
journalctl --user -u whatsapp-collector --since today -o cat \
  | jq -c 'select(.result=="removed" or .result=="applied") | {sentAt,command,actorName,groupName,target,reason}'

# o que um moderador específico fez
journalctl --user -u whatsapp-collector -o cat | jq -c 'select(.actor=="100000000000001@lid")'

# a mensagem crua do comando, pelo messageId do log
grep '"CMD_ID_AQUI"' logs/messages.upsert/2026-08-19.json | jq .

# mensagens apagadas por admins hoje
journalctl --user -u whatsapp-collector --since today -o cat \
  | jq -c 'select(.event=="message_deleted") | {deletedBy,author:.authorName,groupName,text}'
```

## Limites conhecidos

Os três primeiros são **escolhas**, avaliadas e recusadas em 2026-08-19 — não lacunas por
esquecimento. Rever exige decisão nova, não um "conserto".

- **Comando que não existe não gera log — deliberado.** `/bam`, `/kik`, `/banir` não casam nenhum
  handler: a mensagem não é apagada, nada é registrado. Cada handler procura só o próprio nome, e
  ninguém conhece a lista completa; registrar exigiria um router de comandos. Recusado: qualquer
  mensagem começando com `/palavra` viraria linha de log, e o ganho (flagrar erro de digitação) não
  paga o ruído. **Efeito prático:** quem digita errado não recebe nada e não fica rastro — se um
  moderador reclamar que "o bot ignorou", a resposta está no `logs/messages.upsert/` do dia, não aqui.
- **A trilha vive só no journal — deliberado.** Não existe `logs/commands/<dia>.json`. A auditoria
  depende da retenção do journald do usuário no server; um journald apertado engole o histórico
  antigo sem avisar. Recusado por ora: mais um artefato em disco para manter, e a consulta via
  `journalctl` atende.
- **`/ban` e `/kick` mantêm os nomes — deliberado.** `/ban` não impede a volta de ninguém: é
  remoção com alcance de comunidade, e `/kick` é a mesma remoção limitada ao grupo. Os
  nomes ficaram por continuidade com quem já usa. Ao explicar para um moderador novo, a diferença a
  dizer é **alcance**, nunca permanência.
- **Comando em DM não gera log.** A casca só age em `@g.us`; um `/ban` no privado do bot é ignorado
  em silêncio.
- **Nome do alvo não é registrado** — só `@lid` e telefone. A metadata de participantes do Baileys
  não traz nome, e o `pushName` só existe para quem enviou a mensagem.
