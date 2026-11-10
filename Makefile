.PHONY: up down migrate seed test test-db test-service test-workflows demo eval lint build-workflows import-workflows

COMPOSE ?= docker compose

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

migrate:
	$(COMPOSE) exec -T postgres sh -c 'psql -U $$POSTGRES_USER -d $$POSTGRES_DB -v ON_ERROR_STOP=1' < db/migrations/0001_init.sql

seed:
	for f in db/seeds/*.sql; do $(COMPOSE) exec -T postgres sh -c 'psql -U $$POSTGRES_USER -d $$POSTGRES_DB -v ON_ERROR_STOP=1' < $$f; done

test: test-db test-service test-workflows

test-db:
	bash scripts/db-test.sh

test-service:
	cd services/rg-tools && npm test

test-workflows:
	cd workflows && npm test

build-workflows:
	cd workflows && npm run build

import-workflows:
	node scripts/import-workflows.mjs

lint:
	cd services/rg-tools && npm run lint
	cd workflows && npm run lint

demo:
	@echo "Open n8n, run 'WF-14 Sandbox Demo Runner'. See docs/DEMO_SCRIPT.md"

eval:
	cd eval && npm run eval
