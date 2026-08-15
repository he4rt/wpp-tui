DATE ?= $(shell date +%Y-%m-%d)

# ── systemd --user service (deploy/whatsapp-collector.service) ──
# Nome da unit, arquivo-fonte no repo, diretório de units do usuário e
# caminho ABSOLUTO do node resolvido no PATH em que o make roda. Isso
# escreve o node real na unit — evitando o footgun de node-por-nvm/fnm
# em que /usr/bin/node não existe e o systemd --user não herda o PATH do
# shell. Se o node vier de nvm/fnm, rode `make svc-install` com esse node
# ativo no PATH; o guard em svc-install falha claro se não achar node.
SVC        := whatsapp-collector
SVC_FILE   := deploy/$(SVC).service
SVC_DIR    := $(HOME)/.config/systemd/user
NODE_BIN   := $(shell command -v node)
SVC_USER   := $(shell id -un)

.PHONY: extract-payload headless headless-pretty pair \
	svc-install svc-uninstall svc-start svc-stop svc-restart \
	svc-status svc-logs svc-redeploy svc-linger

extract-payload:
	python3 scripts/extract.py $(DATE)

# Sobe o coletor em modo headless (sem TUI), direto do código-fonte via tsx.
# Logs em JSON no stdout. Exige WEBHOOK_URL + WHATSAPP_WEBHOOK_SECRET no .env
# (fail-fast se faltar) e a sessão já pareada via `make pair` (ADR-0003).
headless:
	pnpm exec tsx --env-file-if-exists=.env src/index.tsx --headless

# Igual ao alvo headless, mas com logs legíveis (pino-pretty) para depurar local.
headless-pretty:
	LOG_PRETTY=1 pnpm exec tsx --env-file-if-exists=.env src/index.tsx --headless

# Comando de pareamento one-shot (ADR-0003): estabelece a sessão via pairing-code, sem QR nem TUI.
# Uso: make pair NUMBER=5511999999999 (apenas dígitos com DDI). Re-parear por cima: +FORCE=1.
# O código de 8 caracteres sai no STDOUT; estado/logs no STDERR.
pair:
	pnpm exec tsx --env-file-if-exists=.env src/index.tsx --pair $(NUMBER) $(if $(FORCE),--force,)

# ── Ciclo de vida do serviço systemd --user ──────────────────────
# Nenhum alvo svc-* precisa de sudo, EXCETO svc-linger (isolado abaixo).

# Instala a unit no diretório de units do usuário, trocando o ExecStart
# pelo node ABSOLUTO ($(NODE_BIN)); WorkingDirectory=%h/… fica intacto
# (o systemd expande %h). Depois recarrega e habilita+inicia o serviço.
svc-install:
	@test -n "$(NODE_BIN)" || { echo "node não encontrado no PATH — instale/ative antes de svc-install"; exit 1; }
	mkdir -p "$(SVC_DIR)"
	sed 's|^ExecStart=.*|ExecStart=$(NODE_BIN) dist/index.js --headless|' "$(SVC_FILE)" > "$(SVC_DIR)/$(SVC).service"
	systemctl --user daemon-reload
	systemctl --user enable --now $(SVC)

# Desabilita, para e remove a unit limpo.
svc-uninstall:
	-systemctl --user disable --now $(SVC)
	rm -f "$(SVC_DIR)/$(SVC).service"
	systemctl --user daemon-reload

svc-start:
	systemctl --user start $(SVC)

svc-stop:
	systemctl --user stop $(SVC)

svc-restart:
	systemctl --user restart $(SVC)

svc-status:
	systemctl --user status $(SVC)

# Segue os logs do journald do usuário (JSON na stdout do headless).
svc-logs:
	journalctl --user -u $(SVC) -f

# Build + restart num passo só.
svc-redeploy:
	pnpm build
	systemctl --user restart $(SVC)

# ÚNICO alvo com sudo: permite o serviço rodar sem sessão de login aberta.
svc-linger:
	sudo loginctl enable-linger $(SVC_USER)
