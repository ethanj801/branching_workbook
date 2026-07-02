# Branching Workbook — dev recipes

# Show available recipes
default:
    @just --list

# Install server + client dependencies
install:
    cd server && uv sync
    cd client && npm install

# Run FastAPI server + Vite client in parallel
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    (cd server && uv run uvicorn bwbk.main:app --reload --port 8000) &
    (cd client && npm run dev) &
    wait

# Run only the FastAPI server
server:
    cd server && uv run uvicorn bwbk.main:app --reload --port 8000

# Run only the Vite client
client:
    cd client && npm run dev

# Download the local backend's GGUF model into server/models (needs the `local` extra)
download-model:
    cd server && uv run --extra local python scripts/download_model.py

# Run with the local real-model backend. First: `cd server && uv sync --extra local`,
# then `just download-model`.
dev-local:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    (cd server && BWBK_BACKEND=local uv run --extra local uvicorn bwbk.main:app --reload --port 8000) &
    (cd client && npm run dev) &
    wait

# Lint Python code with ruff
lint:
    cd server && uv run ruff check .

# Format Python code with ruff
fmt:
    cd server && uv run ruff format .

# Run server pytest suite
test-server:
    cd server && uv run pytest -q

# Run client vitest suite
test-client:
    cd client && npm run test --silent

# Run both test suites
test: test-server test-client

# Run lint + format checks + tests + client build
check: lint test
    cd client && npm run lint --silent
    cd client && npm run format:check --silent
    cd client && npm run build --silent

# Capture UI screenshots for visual iteration
# Requires `just dev` running in another shell.
shots:
    cd client && node scripts/screenshots.mjs
