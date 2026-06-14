# Núcleo do coletor extraído do React (`startCollectorCore`)

**Status:** accepted

Para viabilizar o **Modo headless** (rodar o coletor como serviço systemd, sem TUI), a lógica de
conexão Baileys + auth + reconexão + coletor (outbox/router/webhook/heartbeat) + retention + logs
crus foi extraída do hook React `useSocket` para um módulo agnóstico de UI: `startCollectorCore(...)`,
que expõe callbacks (`onStatus`, `onQr`, `onEvent`) e retorna `{ stop() }`. O `useSocket` passa a ser
um wrapper fino que mapeia esses callbacks para estado React; o headless chama o núcleo direto e só
loga. O que é puramente de exibição (`parseContent`, dedup, decrypt inline de enquete, `storeMessage`,
`messages[]`/`chats[]`) fica na camada TUI.

## Considered Options

- **Renderizar Ink num stdout falso/sem TTY** — rejeitado: React/Ink continuam montando estado e
  tentando renderizar sem TTY; frágil e desperdício de recurso num server 24/7.
- **Duplicar o setup do socket num arquivo headless próprio** — rejeitado: cria dois caminhos de
  código que divergem a cada mudança futura.
- **Extrair um núcleo único (escolhido)** — uma fonte de verdade para ambos os modos; o custo é uma
  refatoração no `useSocket`, que não tem teste unitário direto hoje.

## Consequences

- O núcleo deve receber suas dependências por injeção (loggers, paths) para ser testável sem rede.
- Toda nova feature de coleta entra no núcleo e é herdada pelos dois modos automaticamente.
