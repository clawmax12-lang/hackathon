#!/usr/bin/env bash
# One-shot local dev setup: system dependencies (Postgres 16, ffmpeg,
# poppler-utils, Liberation Sans, the reshape migration CLI), npm install,
# database creation + migration. Safe to re-run — every step checks whether
# its target already exists before doing anything.
#
# Usage: bash scripts/setup-local-dev.sh
#
# After this finishes: fill in ANTHROPIC_API_KEY / ELEVENLABS_API_KEY in
# .env, then run the two servers (see the printed instructions at the end).

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1" >&2; }

OS="$(uname -s)"
case "$OS" in
  Linux)
    if command -v apt-get >/dev/null 2>&1; then PKG=apt; else
      warn "No apt-get found. This script only automates Debian/Ubuntu and macOS (Homebrew)."
      warn "Install manually: PostgreSQL 16, ffmpeg (with drawtext/libfreetype), poppler-utils, Liberation Sans, Rust+cargo."
      PKG=unknown
    fi
    ;;
  Darwin)
    if command -v brew >/dev/null 2>&1; then PKG=brew; else
      warn "Homebrew not found. Install it from https://brew.sh first, then re-run this script."
      exit 1
    fi
    ;;
  *)
    warn "Unrecognized OS '$OS'. Install manually: PostgreSQL 16, ffmpeg, poppler-utils, Liberation Sans, Rust+cargo."
    PKG=unknown
    ;;
esac

# --- Node ---------------------------------------------------------------
log "Checking Node.js version (need 22+)"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -lt 22 ]; then
    warn "Node $(node -v) found, but this project needs 22+. Install Node 22 (nvm, fnm, or your OS package manager) and re-run."
    exit 1
  fi
  echo "Node $(node -v) OK."
else
  warn "Node.js not found. Install Node 22+ (e.g. via nvm: https://github.com/nvm-sh/nvm) and re-run."
  exit 1
fi

# --- System packages ------------------------------------------------------
log "Installing system dependencies (Postgres 16, ffmpeg, poppler-utils, Liberation Sans, Rust)"
case "$PKG" in
  apt)
    # A stray unreachable third-party repo in sources.list (common on real
    # machines) makes `apt-get update` exit non-zero even though the Ubuntu
    # archives it actually needs came through fine — don't abort on that;
    # `apt-get install` below fails loudly on its own if a needed package
    # genuinely can't be found.
    sudo apt-get update -y || warn "apt-get update reported errors (often a stray third-party repo) — continuing."
    sudo apt-get install -y postgresql-16 postgresql-client-16 ffmpeg poppler-utils fonts-liberation curl build-essential pkg-config libssl-dev
    ;;
  brew)
    brew install postgresql@16 ffmpeg poppler
    brew install --cask font-liberation || warn "font-liberation cask failed — install Liberation Sans manually if video rendering complains about missing fonts."
    ;;
  *)
    warn "Skipping automated package install — install the listed dependencies manually."
    ;;
esac

# --- Postgres service -------------------------------------------------
log "Starting PostgreSQL"
case "$PKG" in
  apt) sudo service postgresql start ;;
  brew) brew services start postgresql@16 ;;
  *) warn "Start PostgreSQL 16 manually." ;;
esac

log "Waiting for PostgreSQL to accept connections"
for _ in $(seq 1 15); do
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then break; fi
  sleep 1
done

# Find whichever local connection is already an admin: Debian/Ubuntu installs
# a "postgres" OS user you reach via sudo; Homebrew's postgresql@16 makes the
# current OS user the initial superuser instead, with no "postgres" role at
# all yet. Whichever one works, use it once to guarantee a postgres/postgres
# role exists — after that .env's DATABASE_URL is identical on every platform.
ADMIN_PSQL=""
if command -v sudo >/dev/null 2>&1 && sudo -n -u postgres psql -tAc "SELECT 1" >/dev/null 2>&1; then
  # Local Unix-socket connection (peer auth as the postgres OS user) — no
  # -h flag, which would force TCP and therefore password auth instead.
  ADMIN_PSQL="sudo -u postgres psql"
elif psql -h 127.0.0.1 -U postgres -tAc "SELECT 1" >/dev/null 2>&1; then
  ADMIN_PSQL="psql -h 127.0.0.1 -U postgres"
elif psql -h 127.0.0.1 -tAc "SELECT 1" >/dev/null 2>&1; then
  ADMIN_PSQL="psql -h 127.0.0.1"
else
  warn "Could not connect to PostgreSQL as any admin role. If this isn't Debian/Ubuntu or a fresh Homebrew install, create a superuser role named 'postgres' with password 'postgres' manually, then re-run."
fi

if [ -n "$ADMIN_PSQL" ]; then
  HAS_ROLE="$($ADMIN_PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='postgres'" 2>/dev/null || echo "")"
  if [ -z "$HAS_ROLE" ]; then
    log "Creating the 'postgres' superuser role (matches this project's DATABASE_URL default)"
    $ADMIN_PSQL -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres'"
  else
    $ADMIN_PSQL -c "ALTER ROLE postgres WITH PASSWORD 'postgres'" >/dev/null
  fi
fi

# --- Rust + reshape CLI -------------------------------------------------
log "Checking for the reshape migration CLI"
if ! command -v reshape >/dev/null 2>&1; then
  if ! command -v cargo >/dev/null 2>&1; then
    log "Installing Rust (needed to build reshape)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
  fi
  log "Building reshape (cargo install reshape) — this compiles from source, a couple minutes"
  cargo install reshape --locked
  export PATH="$PATH:$HOME/.cargo/bin"
else
  echo "reshape already installed."
fi

# --- .env -----------------------------------------------------------------
if [ ! -f .env ]; then
  log "Creating .env from .env.example — fill in ANTHROPIC_API_KEY and ELEVENLABS_API_KEY before running the app"
  cp .env.example .env
  {
    echo ""
    echo "DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/catalog"
    echo "STORAGE_DIR=$(pwd)/var/storage"
    echo "PORT=3002"
  } >> .env
else
  echo ".env already exists — leaving it as is."
fi
mkdir -p var/storage

# --- npm install ------------------------------------------------------
log "Installing npm dependencies"
npm install

# --- Database + migrations -------------------------------------------
# The 'postgres' role now exists with a known password on every platform
# (created above), so a plain PGPASSWORD-authenticated connection works
# identically whether Postgres came from apt or Homebrew.
export PGPASSWORD=postgres
log "Creating the catalog database (if it doesn't already exist)"
DB_EXISTS="$(psql -h 127.0.0.1 -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='catalog'" 2>/dev/null || echo "")"
if [ -z "$DB_EXISTS" ]; then
  createdb -h 127.0.0.1 -U postgres catalog
  echo "Created database 'catalog'."
else
  echo "Database 'catalog' already exists."
fi

log "Running Reshape migrations (db/migrations)"
export PATH="$PATH:$HOME/.cargo/bin"
DB_URL="postgres://postgres:postgres@127.0.0.1:5432/catalog?sslmode=disable"
reshape migrate --url "$DB_URL" --dirs db/migrations
reshape migration complete --url "$DB_URL"

log "Setup complete."
cat <<'EOF'

Next steps:
  1. Open .env and fill in ANTHROPIC_API_KEY and ELEVENLABS_API_KEY.
  2. Seed the catalog (does not happen automatically at API boot, by design —
     that's a one-off job, not startup work):
       npx tsx scripts/seed-ikea-cloud-metadata.ts
       npx tsx scripts/seed-hero-product.ts
       npx tsx scripts/seed-hero-guide.ts
     (Optional, slower — downloads and verifies all 71 real manual PDFs:
       npx tsx scripts/import-ikea-cloud-seed.ts)
  3. Start the API:
       npx tsx server/src/index.ts
  4. In a second terminal, start the web app:
       npm run dev
  5. Open http://localhost:5173

EOF
