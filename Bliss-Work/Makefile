# Task-Board — local dev orchestration.
# On Windows run via Git Bash, or use the npm-script equivalents (npm run up/down/...).
SHELL := bash

.PHONY: help keys env up down reset logs ps seed demo wait test check-migrations

help:
	@echo "Task-Board targets:"
	@echo "  make env     - create .env from .env.example (if missing)"
	@echo "  make keys    - generate dev Ed25519 JWT keypair into ./keys"
	@echo "  make up      - env + keys + build & start the full stack + wait + seed"
	@echo "  make wait    - block until all services are healthy"
	@echo "  make seed    - load demo org + users + sample data"
	@echo "  make demo    - run the end-to-end demo (message ignore + task ack/complete)"
	@echo "  make logs    - tail all container logs"
	@echo "  make down    - stop the stack"
	@echo "  make reset   - stop + delete volumes (fresh DB)"

env:
	@test -f .env || cp .env.example .env

keys:
	@npm run gen:keys --silent

up: env keys
	docker compose up -d --build
	$(MAKE) wait
	$(MAKE) seed
	@echo "Stack is up. Web: run 'npm run web'  |  Desktop: run 'npm run desktop'"

wait:
	@bash scripts/wait-for.sh

seed:
	@npm run seed --silent

demo:
	@npm run demo --silent

logs:
	docker compose logs -f

ps:
	docker compose ps

down:
	docker compose down

reset:
	docker compose down -v

test:
	npm test --silent
	node scripts/check-migrations.mjs

check-migrations:
	node scripts/check-migrations.mjs
