# Headless pré-provisiona a sessão (não pareia via QR)

**Status:** accepted

O **Modo headless** não exibe QR nem implementa pairing-code: ele exige que `baileys_auth_info` já
exista, copiado de um pareamento feito no **Modo TUI** ("pré-provisionamento"). Se o headless receber
um evento de QR (sinal de que não há sessão válida), ele loga um erro fatal e sai com código ≠ 0 —
deixando o systemd sinalizar o problema em vez de entrar em loop gerando QRs.

## Considered Options

- **QR ASCII no stderr** — rejeitado por ora: funciona via console, mas o caso de uso é server sem
  console acessível, e poluiria o fluxo de logs.
- **Pairing-code por telefone (`requestPairingCode`)** — melhor UX para server, mas é um fluxo novo;
  fica como evolução futura.
- **Pré-provisionar (escolhido)** — zero código de pareamento no headless; o operador pareia uma vez
  na TUI e faz `scp` do `baileys_auth_info`. Custo: re-parear após `loggedOut` é manual.

## Consequences

- Um `loggedOut` no server derruba o coletor até o operador re-provisionar a sessão.
- A doc de deploy precisa descrever o passo de copiar `baileys_auth_info` para o `WorkingDirectory`.
