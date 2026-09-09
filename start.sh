#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

MIN_NODE_MAJOR=18

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but wasn't found on your PATH."
  echo "Install it via nvm (https://github.com/nvm-sh/nvm) or from https://nodejs.org, then run this again."
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  echo "This tool needs Node.js $MIN_NODE_MAJOR or newer (found $(node -v))."
  echo "Install a newer version via nvm (https://github.com/nvm-sh/nvm) or https://nodejs.org, then run this again."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but wasn't found on your PATH."
  echo "On macOS, running 'git' once will usually offer to install the Xcode Command Line Tools."
  exit 1
fi

exec node server.js
