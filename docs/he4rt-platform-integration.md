# Integração com a plataforma He4rt

> Contexto de produto/plataforma do `wpp-tui` — por que ele existe e como conversa com o monolito
> Laravel da He4rt. O `CLAUDE.md` cobre a arquitetura técnica do TUI; este arquivo cobre o "porquê"
> e o **contrato vigente** com o `integration-whatsapp`.
>
> **Atualizado em 2026-06-12** para o desenho resistente a falhas (ADR-0003). O desenho antigo
> (3 tabelas, `collection_policy`, hash de telefone, envelope com `group_jid/occurred_at`,
> endpoint `/api/integrations/whatsapp/events`) foi **superado** — não use como referência.

## O que este projeto é, no contexto maior

A He4rt mantém um **monolito-modular Laravel** (`he4rt-bot-api`) e quer enxergar o engajamento dos
**três grupos no WhatsApp** (Geral, He4rt Delas, Vagas), como já faz no Discord.

O `wpp-tui` é o **coletor / runtime do WhatsApp**: segura a sessão (via Baileys) e, além da TUI, é a
ponte que envia os eventos ao monolito. A analogia: assim como o Discord tem o `bot-discord` (runtime)
separado do `integration-discord` (ingest), o WhatsApp tem o **`wpp-tui` (runtime, este repo)**
separado do **`integration-whatsapp` (ingest, no monolito)**.

```
WhatsApp servers
   ↓ WebSocket (Baileys)
[ wpp-tui ]  ← ESTE REPO · sessão · filtro · event_id determinístico · outbox durável
   ↓ POST /api/webhooks/whatsapp
   │  Headers: X-Signature = HMAC(event_id + body) · X-Event-Id = UUIDv5 determinístico
   │  Body: { type, chat_jid, payload }   ← CRU
[ he4rt-bot-api · app-modules/integration-whatsapp ]  ← ingest síncrono no Laravel
   ↓ (futuro) [ activity ] agrega · [ identity ] vincula
```

## Onde mora o desenho completo

No repo do monolito (`he4rt-bot-api`), em `app-modules/integration-whatsapp/`:

- `CONTEXT.md` — visão do módulo de ingest (estado atual).
- `docs/adr/0003-deterministic-id-and-synchronous-ingest.md` — **decisão vigente** (id determinístico + ingest síncrono resistente a falhas).
- `docs/adr/0002-minimal-single-table-lake.md` — tabela única raw (partes superadas pelo 0003).
- `docs/plans/0002-fault-tolerant-lake-replan.md` — o replan completo com BDD e sequência.

## O contrato do webhook (vigente)

```
POST /api/webhooks/whatsapp
Headers:
  X-Signature: hmac-sha256(`${eventId}.${rawBody}`, WHATSAPP_WEBHOOK_SECRET)
  X-Event-Id:  <UUIDv5 determinístico, por conteúdo>
Body (JSON, CRU):
  { "type": "messages.upsert", "chat_jid": "120363xxx@g.us" | null, "payload": { ...evento Baileys cru... } }
```

O monolito valida HMAC (sobre `event_id`+corpo) → checa `event_id` (UUID) → **sanitiza** o payload
(`\0`/UTF-8) → `firstOrCreate(event_id)` **síncrono** → responde `2xx` **só após o commit**.

## Decisões que afetam este repo (ADR-0003)

1. **Filtro de borda, não parsing.** Só grupos (`@g.us`) + **denylist** dos firehoses/sessão
   (`creds.update`, `*.set`, `message-receipt.update`, `presence.update`). Payload cru.
2. **`event_id` determinístico (UUIDv5) por tipo**, computado aqui. Revive o `INSERT OR IGNORE` do
   outbox (dedup na origem) e casa com o `firstOrCreate` do backend (dedup no destino).
3. **Dedup por conteúdo**: re-emit idêntico deduplica; mudança real (troca de emoji, roster mudou) =
   linha nova. Snapshots (`groups.metadata`) são canonicalizados antes do hash.
4. **Backfill via `append`** (idempotente). `messaging-history.set` segue denylistado.
5. **Outbox resiliente**: classifica a resposta (5xx=retry · 401=retry+alerta · 422=dead-letter local);
   nunca descarta; timeout no envio.
6. **HMAC cobre o `event_id`**; segredo alinhado entre os dois repos com fail-loud no `401`.
7. **Observabilidade mínima**: heartbeat (conexão, tamanho do outbox, item mais antigo) + alerta de desconexão.

## Vinculação de identidade (flow futuro — inalterado)

Associar "fulano do WhatsApp" ao perfil He4rt: usuário informa o número no perfil web → Laravel busca
no payload → gera código `HE4RT-VERIFY-XXXXX` → usuário envia em DM ao bot → este serviço detecta o
prefixo localmente e chama um endpoint de verificação → Laravel vincula. Não implementado.

## Pontos adiados (não implementar ainda)

Hospedagem/deploy deste serviço; backfill profundo de histórico (limitado pelo WhatsApp em dispositivo
acompanhante); detecção de risco de ban e healthcheck HTTP; governança/LGPD e retenção; onboarding/
consentimento dos membros; endurecimento de segurança além do mínimo (janela anti-replay, throttle, rotação).
