# WhatsApp Collector

Cliente de WhatsApp (via Baileys) que coleta o engajamento dos grupos da He4rt e entrega
os eventos ao sistema central. Hoje roda como TUI (Ink); está ganhando um modo de operação
sem interface para rodar como serviço.

## Language

**Coletor**:
O conjunto de peças que filtra, enfileira e entrega eventos de grupo ao sistema central — outbox, router, webhook-sender e heartbeat.
_Avoid_: bot (o "bot" é o processo inteiro; o coletor é só a parte de coleta/entrega).

**Núcleo do coletor** (_collector core_):
A lógica de operação que independe de interface: conexão Baileys + auth + reconexão, persistência de logs crus, e o **Coletor**. É o que precisa rodar em qualquer modo.
_Avoid_: backend, engine.

**Modo headless**:
Modo de execução do processo que sobe apenas o **Núcleo do coletor** (sem TUI/Ink), pensado para rodar como serviço de longa duração (systemd, 24/7, sem TTY). Exige `WEBHOOK_URL` + `WHATSAPP_WEBHOOK_SECRET` (fail-fast). O serviço em si **não pareia**: sem sessão válida, loga fatal e sai ≠ 0. O pareamento é feito à parte pelo **Comando de pareamento**. Logs em JSON no stdout.
_Avoid_: modo daemon, modo server.

**Comando de pareamento**:
Processo one-shot dedicado (`--pair <numero>` / `pnpm pair`) que estabelece a sessão no server via **pairing-code** do Baileys, sem QR e sem TUI. Imprime o code de 8 caracteres, aguarda a conexão abrir, grava `baileys_auth_info` e sai. É o caminho recomendado de deploy (ADR-0003); roda separado do **Modo headless**.
_Avoid_: modo pair, login headless (o serviço headless nunca pareia).

**Pré-provisionamento** (_fallback legado_):
Parear a sessão localmente no **Modo TUI** e copiar o diretório `baileys_auth_info` para o server. Era o caminho de deploy original (ADR-0002), hoje **superseded** pelo **Comando de pareamento** (ADR-0003); permanece só como fallback.

**Modo TUI**:
Modo de execução atual: o **Núcleo do coletor** mais a interface de terminal (Ink/React) com abas Chat/Stats/Debug e envio de mensagens.

**Comando de moderação**:
Mensagem de texto num grupo que o bot interpreta como ordem (`/ban`, `/kick`, `/admin`; prefixo `/` ou `!`). É a única coisa que faz o bot **agir** em vez de só coletar. Silencioso por natureza: o feedback é a mensagem de sistema nativa do WhatsApp, e o resultado de toda tentativa vai para o log de auditoria.
_Avoid_: comando do bot (o processo tem outros comandos de CLI — `--pair` —, que não são estes).

**Escopo de comunidade**:
O alcance de um **Comando de moderação** num grupo que pertence a uma comunidade: a autoridade vem de ser admin no JID da comunidade pai, o alvo pode estar em **qualquer** subgrupo, e a remoção cascateia para a comunidade inteira (`linked_groups`). Grupo sem comunidade degrada para **escopo de grupo** — autoridade e alcance limitados a ele mesmo.
_Avoid_: escopo global (nada atravessa comunidades diferentes).

**Diretório da comunidade**:
Snapshot em memória de quem está em quais grupos, quem são os admins do topo e qual telefone corresponde a qual `@lid`. É o que permite ao **Comando de moderação** alcançar alguém que não está no grupo onde o comando foi digitado. Vem de uma chamada `groupFetchAllParticipating`, cacheada por TTL e invalidada por entrada/saída de membro.
_Avoid_: cache de grupos (`group-metadata.json` é outro artefato, de UI/coleta).

**Remoção**:
O efeito dos comandos `/ban` e `/kick`: tirar alguém de grupo(s). É um **ato, não um estado** — nada é persistido sobre quem saiu e a reentrada não é barrada. A diferença entre os dois comandos é só o **alcance**: `/ban` alcança a comunidade inteira, `/kick` só o grupo onde foi digitado.
_Avoid_: ban permanente, blocklist (o `updateBlockStatus` do WhatsApp é outra coisa e não impede entrar em grupo); quem volta pelo link entra, e o controle é o convite.

**Trilha de auditoria de moderação**:
O registro de todo ato de moderação: toda tentativa de **Comando de moderação** — executada, negada ou recusada pelo WhatsApp — e todo **apagamento de mensagem de terceiro** (que não passa por comando). Sai em duas vias com o mesmo conteúdo: o **journal** do servidor (pino, uma linha por tentativa, com `component` do comando) e o **relatório** no grupo de log (`LOG_GROUP_JID`, legível por humano). É a única memória do que a moderação fez.
_Avoid_: log de eventos (`logs/<evento>/<dia>.json` é a trilha crua do Baileys, outra coisa).
Campos, resultados e consultas: [`docs/auditoria-de-comandos.md`](docs/auditoria-de-comandos.md).

**Evento de grupo**:
Evento do WhatsApp originado de um JID `@g.us` — a única coisa que o **Coletor** entrega. DMs e dados de sessão nunca saem do processo.

## Relationships

- O **Núcleo do coletor** roda em ambos os modos; **Modo TUI** e **Modo headless** são duas formas de embrulhá-lo.
- O **Modo headless** entrega **Eventos de grupo** (incluindo `groups.metadata`) ao sistema central; não renderiza nem envia mensagens.
- O **Coletor** só liga quando há `WEBHOOK_URL` + `WHATSAPP_WEBHOOK_SECRET`.
- **Comandos de moderação** vivem no **Núcleo do coletor** — precisam rodar em produção, que é o **Modo headless**. Eles leem o **Diretório da comunidade** para decidir autoridade e alcance.

## Flagged ambiguities

- "headless" poderia sugerir "sem nenhuma saída"; aqui significa **sem TUI**, mas **com** logs ricos no stdout — a observabilidade é justamente o ponto.
- "QR no headless": não há. QR só existe no **Modo TUI**; no headless, receber um QR significa "sem sessão" → erro fatal. O pareamento no server é sem QR, via **Comando de pareamento** (pairing-code).
- "pareamento no headless": o **serviço** headless nunca pareia (fail-fast se sem sessão). Quem pareia é o **Comando de pareamento**, um processo one-shot à parte — não confundir os dois.
- Dois loggers: o logger do **app/coletor** (`LOG_LEVEL`, default `info`) é distinto do logger do **Baileys** (`BAILEYS_LOG_LEVEL`, default `warn`) — separa sinal de ruído de protocolo.
