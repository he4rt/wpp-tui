DATE ?= $(shell date +%Y-%m-%d)

.PHONY: extract-payload headless headless-pretty

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
