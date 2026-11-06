# HIKOYA PRO — common commands
COMPOSE = docker compose -f deploy/docker-compose.yml --env-file deploy/.env

up:            ## build and start the whole stack (one command)
	$(COMPOSE) up -d --build
down:
	$(COMPOSE) down
logs:
	$(COMPOSE) logs -f --tail=100 api worker
demo:          ## load original demo content (marked «demo»)
	$(COMPOSE) exec api python -m app.cli demo
demo-remove:
	$(COMPOSE) exec api python -m app.cli demo-remove
bot-setup:     ## set bot commands, menu button and webhook
	$(COMPOSE) exec api python -m app.bot setup
backup:
	sh deploy/backup.sh
test:          ## backend tests (needs local PostgreSQL, see docs/DEVELOPMENT.md)
	cd backend && .venv/bin/python -m pytest -q
web-check:
	cd frontend/miniapp && npx tsc --noEmit && npx vite build
