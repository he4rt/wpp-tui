DATE ?= $(shell date +%Y-%m-%d)

extract-payload:
	python3 scripts/extract.py $(DATE)
