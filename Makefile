# Node is only needed for tests. The app itself is static files.
NODE ?= node
PYTHON ?= python3
PORT ?= 8773

.PHONY: test test-js test-py lint sample run

test: test-js test-py

test-js:
	$(NODE) --test

test-py:
	$(PYTHON) -m unittest discover -s tests -p "test_*.py"

lint:
	uvx ruff check .
	uvx ruff format --check .

sample:
	$(NODE) scripts/make_sample.mjs

run:
	@echo "Open http://localhost:$(PORT)"
	$(PYTHON) -m http.server $(PORT)
