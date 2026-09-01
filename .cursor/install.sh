#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for local development.
#
# This project is run with Specific (`specific dev`), which starts the local
# Postgres, api, and web services on the host. In production the api image
# (Dockerfile.api) installs the PDF/media system tools, but `specific dev`
# runs on the host, so those tools must be present here too.
set -euo pipefail

# System tools used by the manual pipeline in local dev.
# - poppler-utils: pdfinfo / pdftoppm (manual verification + page rendering)
# - ffmpeg: audio duration probing and step-video rendering
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends poppler-utils ffmpeg

# Specific CLI (self-updating; install only when missing).
if ! command -v specific >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/specific" ]; then
  curl -fsSL https://specific.dev/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

# Node dependencies.
npm install

# Validate the Specific configuration.
specific check
