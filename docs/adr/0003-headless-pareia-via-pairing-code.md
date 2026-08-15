# Headless pareia via pairing-code (supersede 0002)

**Status:** accepted
**Supersedes:** [0002](0002-headless-pre-provisiona-auth.md)

O **Modo headless** deixa de exigir sessão pré-provisionada. O pareamento passa a ser feito no
próprio server via **pairing-code** (`sock.requestPairingCode`), num **Comando de pareamento**
one-shot dedicado (`--pair <numero>`), separado do serviço 24/7. O operador roda o comando uma vez,
digita o code de 8 caracteres no celular (Aparelhos conectados > Conectar com número), e a sessão é
gravada em `baileys_auth_info/` — sem QR, sem `scp` do diretório de auth a partir da TUI.

O ADR-0002 já registrava pairing-code como "evolução futura" e apontava seu custo — re-parear após
`loggedOut` era manual e dependia de acesso à TUI + cópia de arquivos. Esse ritual é justamente o que
inviabiliza operar em produção; este ADR o remove.

## Escopo

- **Só destrava o login.** A persistência da sessão continua em filesystem (`useMultiFileAuthState`).
  Trocar para um auth store em SQLite é uma decisão ortogonal e futura, fora deste ADR.
- O **serviço headless de longa duração não pareia**: continua fail-fast. Sem sessão válida, loga
  fatal e sai ≠ 0 (o systemd sinaliza). Quem pareia é o Comando de pareamento, um processo à parte.

## Considered Options

- **Pré-provisionar via TUI + `scp` (ADR-0002, agora superseded)** — zero código de pareamento, mas
  exige parear na TUI e copiar `baileys_auth_info` para o server; re-parear após `loggedOut` é um
  procedimento manual multi-passos e dependente da TUI. Inviável como operação de produção.
- **Pairing-code dentro do serviço long-running** — no boot, se `!creds.registered`, o serviço pede o
  code e bloqueia o start até parear. Rejeitado: mistura estado interativo num daemon 24/7 e complica
  o ciclo de `loggedOut`/restart.
- **Comando de pareamento one-shot (escolhido)** — um caminho mínimo dedicado (`makeWASocket` +
  `useMultiFileAuthState` + `requestPairingCode` + `saveCreds`), sem webhook nem coletor. Mantém o
  serviço determinístico (sobe só com sessão válida) e isola o ato interativo de parear.

## Design do Comando de pareamento

- Terceiro branch no entrypoint (`src/index.tsx`): `--pair <numero>` (fallback por env; ausência de
  ambos = erro), com import dinâmico — sem carregar Ink nem o coletor.
- Número: argumento de CLI, validado (apenas dígitos + DDI, sem `+`/`()`/`-`).
- O code sai como **texto puro no stdout** (copiável); estado e logs vão para o stderr.
- Aguarda `connection: 'open'` → grava creds e sai 0. **Timeout de 120s** sem parear → sai ≠ 0.
- Se já existir sessão (`creds.registered === true`): recusa e sai ≠ 0, salvo `--force` explícito
  (evita destruir uma sessão viva por engano).

## Consequences

- O deploy não precisa mais de acesso à TUI nem de `scp` do diretório de auth.
- Recuperação após `loggedOut` continua **manual e explícita**: o serviço sai ≠ 0, o operador roda o
  Comando de pareamento e reinicia o serviço. Não há re-pareamento automático (exigiria persistir o
  número e lidar com code novo sem operador — fora de escopo).
- Pairing-code é single-device, como o QR — não muda o modelo de sessão.
- O runbook de deploy (README + Makefile) ganha o passo de pareamento (`pnpm pair` / `make pair`) no
  lugar do "copie `baileys_auth_info`".
