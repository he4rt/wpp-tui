# Coletor de WhatsApp — o que esta entrega faz

> Documento de visão geral do PR `feat/whatsapp-collector`. Escrito para ser entendido por
> qualquer pessoa do time (não só engenharia), com diagramas e a motivação por trás de cada decisão.

---

## Em uma frase

O bot do WhatsApp passa a **coletar o engajamento dos grupos da He4rt e entregar esses dados ao
sistema central de forma confiável** — sem perder eventos quando algo falha e sem vazar dados
sensíveis da sessão.

---

## O problema (por que mexer nisso)

A He4rt quer enxergar o engajamento dos três grupos de WhatsApp (Geral, He4rt Delas, Vagas), do
mesmo jeito que já enxerga o Discord. O bot já recebia os eventos do WhatsApp, mas a forma de
**mandar** esses eventos para o sistema central era frágil:

```
  ANTES
  ─────
  WhatsApp ──► bot ──► "atira e esquece" ──► sistema central
                          │
                          ├─ se o sistema estava fora do ar  → EVENTO PERDIDO PARA SEMPRE
                          ├─ mandava TUDO, inclusive a chave  → RISCO DE SEGURANÇA
                          │  da sessão do WhatsApp
                          └─ mandava conversas privadas (DM)  → coleta desnecessária
```

Três buracos: **perda de dados**, **risco de segurança** e **coleta de coisa que não interessa**.

---

## O que muda

```
  DEPOIS
  ──────
  WhatsApp ──► bot ──► [ filtro ] ──► [ fila segura ] ──► [ entregador ] ──► sistema central
                          │               │                    │
                  só o que interessa   guarda em disco    reenvia até
                  (grupos, sem          até confirmar     confirmar (não
                  credenciais, sem DM)  a entrega         perde nada)
```

Agora cada evento relevante é **filtrado**, **guardado com segurança** e **entregue com garantia** —
mesmo que o sistema central caia, os eventos esperam e são reenviados quando ele volta.

---

## Como um evento viaja (o caminho completo)

Pense num funil: muita coisa entra, só o que importa chega ao destino.

```
  Todos os eventos do WhatsApp
        │
        ▼
  ┌─────────────────────────────────────┐
  │ 1. É dado de sessão/credencial?      │ ── sim ──► descarta (nunca sai do bot 🔒)
  └─────────────────────────────────────┘
        │ não
        ▼
  ┌─────────────────────────────────────┐
  │ 2. É de um grupo?                    │ ── não ──► descarta (DM não é coletada)
  └─────────────────────────────────────┘
        │ sim
        ▼
  ┌─────────────────────────────────────┐
  │ 3. Quebra eventos "em lote"          │  ex: 3 reações numa mensagem
  │    em itens individuais              │      viram 3 registros separados
  └─────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────┐
  │ 4. Guarda na fila em disco           │  com um carimbo único por evento
  └─────────────────────────────────────┘
        │
        ▼
  ┌─────────────────────────────────────┐
  │ 5. Entregador envia ao sistema       │  assinado (autenticidade) + carimbo
  │    central                           │  (evita registro duplicado)
  └─────────────────────────────────────┘
```

---

## Confiabilidade: o "entregador" nunca desiste

A peça central é a **fila em disco** (o "outbox"). Cada evento fica nela até ser confirmado:

```
  [na fila] ──► entregador pega ──► envia ──┬── deu certo ──► some da fila ✓
                    ▲                       │
                    │                       └── falhou ──► continua na fila
                    │                                       e tenta de novo mais tarde
                    └───────────── espera crescente ───────┘
                       (1s, 2s, 4s… até no máx. 5 min)
```

**Motivação:** o sistema central pode estar reiniciando, a rede pode oscilar. Sem essa fila, qualquer
soluço viraria evento perdido. Com ela, o pior caso é o dado chegar **um pouco depois** — nunca
sumir. E o "carimbo único" garante que, se um evento for reenviado, o sistema central **não registra
duplicado**.

---

## As decisões e o porquê de cada uma

| Decisão | O que significa | Por que |
|---|---|---|
| **Mandar o dado cru, o sistema central decide o que guardar** | O bot não tenta ser "inteligente"; manda o evento como veio e o lado central filtra/transforma | Mantém o bot simples e confiável; a inteligência de análise fica num só lugar |
| **Nunca enviar dados de sessão** | Credenciais/chaves do WhatsApp ficam só no bot | Se vazassem, alguém poderia sequestrar a conta — risco inaceitável |
| **Coletar só grupos, ignorar DM** | Conversa privada 1:1 com o bot não é coletada | O objetivo é engajamento de comunidade, não conversa privada; menos invasivo |
| **Fila em disco que sobrevive a quedas** | Eventos esperam em disco até a entrega ser confirmada | Não perder dado é o requisito número um |
| **Logs locais mais leves (NDJSON)** | O bot grava os eventos de um jeito que não trava com volume alto | Eventos de "digitando/online" são muitos; o jeito antigo reescrevia o arquivo inteiro a cada evento e não aguentaria |

---

## O que ficou de fora (de propósito)

```
  ✅ NESTA ENTREGA            ⏳ PRÓXIMA RODADA
  ──────────────             ──────────────────
  Coleta confiável           Vincular "fulano do WhatsApp"
  Filtro de segurança        ao perfil dele na He4rt
  Filtro de escopo (grupos)  (via um código enviado em DM)
  Fila + reenvio
                             Deploy/hospedagem, alertas de
                             desconexão, retenção de dados
```

A vinculação de identidade e a operação (deploy, monitoramento) são uma rodada à parte, para esta
entrega focar em **coletar bem** primeiro.

---

## Como conferir que funciona

Com um receptor de teste local, sobe-se o bot apontando para ele e observa-se:

- ✅ Chegam eventos **de grupo** (mensagens, reações, presença).
- ✅ **Não** chega nada de DM nem de dados de sessão.
- ✅ Várias reações na mesma mensagem chegam como **eventos separados**.
- ✅ Ao **derrubar e subir** o receptor, os eventos atrasados chegam depois — nada se perde.

Por baixo, há **24 testes automatizados** cobrindo o filtro, a quebra de lotes, a fila, o reenvio e a
leitura dos logs.

---

## Detalhes técnicos

Para quem for mexer no código: o contrato vigente e as decisões estão em
`docs/he4rt-platform-integration.md` (neste repo) e, no monolito, em
`app-modules/integration-whatsapp/docs/adr/0003-deterministic-id-and-synchronous-ingest.md`
+ `docs/plans/0002-fault-tolerant-lake-replan.md`.

> **Nota (2026-06-12):** o desenho de confiabilidade evoluiu — o "carimbo único" agora é um
> `event_id` **determinístico por conteúdo** (deduplica re-emit na origem e no destino), e o
> sistema central confirma a gravação **antes** de o entregador apagar da fila (`2xx` = persistido).
> Ver ADR-0003.
