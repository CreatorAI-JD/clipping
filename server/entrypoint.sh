#!/bin/sh
# One machine: the worker (restarted if it ever exits) + the API behind gunicorn.
set -e
mkdir -p "$AC_DATA_DIR"
( while true; do python -m autoclipper worker || true; echo "worker exited, restarting in 5s"; sleep 5; done ) &
exec gunicorn -w 1 --threads 8 --timeout 600 -b "0.0.0.0:${PORT:-8080}" autoclipper.api:app
