DATE ?= $(shell date +%Y-%m-%d)

.PHONY: extract-payload headless headless-pretty pair

extract-payload:
	python3 scripts/extract.py $(DATE)

# Sobe o coletor em modo headless (sem TUI), direto do código-fonte via tsx.
# Logs em JSON no stdout. Exige WEBHOOK_URL + WHATSAPP_WEBHOOK_SECRET no .env
# (fail-fast se faltar) e baileys_auth_info pré-provisionado (ADR-0002).
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
