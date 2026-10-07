#!/bin/bash
# DSH daemon starter with token URL capture
LOG_DIR="$HOME/Library/Logs/DeepSeekHarness"
mkdir -p "$LOG_DIR"
SERVER_URL_FILE="$LOG_DIR/server.url"
SERVER_LOG="$LOG_DIR/server.log"

# Clean locks if any
rm -f "$HOME/.dsh/profiles/node_modules.lock" 2>/dev/null
rm -f "$HOME/.dsh/settings.yaml.lock" 2>/dev/null

# Check if already running on 3080
if lsof -iTCP:3080 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "$(date): DSH already running on 3080" >> "$SERVER_LOG"
  exit 0
fi

# Locate npm global bin
NPM_GLOBAL="$(npm prefix -g 2>/dev/null)/bin"
export PATH="$NPM_GLOBAL:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Run DSH web in background
dsh web --port 3080 --no-open >> "$SERVER_LOG" 2>&1 &
DSH_PID=$!

# Wait for token in log and extract URL
for i in {1..30}; do
  TOKEN_LINE=$(grep -E "dsh web: https?://[^\s]+" "$SERVER_LOG" | tail -n 1)
  if [ -n "$TOKEN_LINE" ]; then
    URL=$(echo "$TOKEN_LINE" | sed -n 's/.*\(https\{0,1\}:\/\/[^ ]*\).*/\1/p')
    if [ -n "$URL" ]; then
      echo "$URL" > "$SERVER_URL_FILE"
      echo "$(date): DSH started, URL captured: $URL" >> "$SERVER_LOG"
      break
    fi
  fi
  sleep 0.5
done
