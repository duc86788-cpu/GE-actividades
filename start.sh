#!/bin/bash
# GE Actividades — start script (Linux/macOS)
cd "$(dirname "$0")"
PORT=${PORT:-8080}
echo "Starting GE Actividades on port $PORT..."
node ge-server.js
