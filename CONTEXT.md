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
Modo de execução do processo que sobe apenas o **Núcleo do coletor** (sem TUI/Ink), pensado para rodar como serviço de longa duração (systemd, 24/7, sem TTY). Exige `WEBHOOK_URL` + `WHATSAPP_WEBHOOK_SECRET` (fail-fast) e exige **auth pré-provisionado** (não pareia via QR). Logs em JSON no stdout.
_Avoid_: modo daemon, modo server.

**Pré-provisionamento**:
Parear a sessão localmente no **Modo TUI** e copiar o diretório `baileys_auth_info` para o server. O **Modo headless** nunca exibe QR; sem sessão válida, ele loga erro fatal e sai.

**Modo TUI**:
Modo de execução atual: o **Núcleo do coletor** mais a interface de terminal (Ink/React) com abas Chat/Stats/Debug e envio de mensagens.

**Evento de grupo**:
Evento do WhatsApp originado de um JID `@g.us` — a única coisa que o **Coletor** entrega. DMs e dados de sessão nunca saem do processo.

## Relationships

- O **Núcleo do coletor** roda em ambos os modos; **Modo TUI** e **Modo headless** são duas formas de embrulhá-lo.
- O **Modo headless** entrega **Eventos de grupo** (incluindo `groups.metadata`) ao sistema central; não renderiza nem envia mensagens.
- O **Coletor** só liga quando há `WEBHOOK_URL` + `WHATSAPP_WEBHOOK_SECRET`.

## Flagged ambiguities

- "headless" poderia sugerir "sem nenhuma saída"; aqui significa **sem TUI**, mas **com** logs ricos no stdout — a observabilidade é justamente o ponto.
- "QR no headless": não há. QR só existe no **Modo TUI**; no headless, receber um QR significa "sem sessão" → erro fatal (ver **Pré-provisionamento**).
- Dois loggers: o logger do **app/coletor** (`LOG_LEVEL`, default `info`) é distinto do logger do **Baileys** (`BAILEYS_LOG_LEVEL`, default `warn`) — separa sinal de ruído de protocolo.
