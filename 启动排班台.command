#!/bin/bash
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo '请先安装 Node.js 22 或 24 LTS'; exit 1; }
if [ ! -d node_modules ]; then npm ci --include=dev; fi
npm run setup
npm run build
npm start
