#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 18 or newer."
  exit 1
fi
if ! node -e "for (const name of Object.keys(require('./package.json').dependencies || {})) require.resolve(name)" >/dev/null 2>&1; then
  command -v npm >/dev/null 2>&1 || { echo "npm is required to install dependencies."; exit 1; }
  echo "Installing dependencies..."
  npm ci --omit=dev || { echo "Dependency installation failed."; exit 1; }
fi
node launch.js
