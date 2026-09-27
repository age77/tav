#!/bin/sh
# Prueft die Seite, wie sie gerade im Arbeitsverzeichnis steht, in einem
# eigenen Teststapel neben den laufenden Diensten: eigenes Netz "tavtest",
# eigene Volumes, die Seite auf 127.0.0.1:18884. Die Dienste dahinter laufen
# aus den vorhandenen Abbildern unter den Namen, die nginx.conf erwartet.
#
#   sh tests/ui/run.sh [gruppe ...]    bauen, starten, pruefen
#   sh tests/ui/run.sh --weg           Teststapel samt Volumes abraeumen
#
# Gebaut wird nur die Seite, mit "docker build" unter eigenem Namen - nie mit
# "docker compose build", das wuerde die Abbilder der laufenden Dienste neu
# taggen.
set -eu

ONNX=${TAV_ONNX_IMAGE:-tav-tav-onnx:latest}
VIDEO=${TAV_VIDEO_IMAGE:-tav-video:1}
WHISPER=${TAV_WHISPER_IMAGE:-tav-whisper:1}
PLAYWRIGHT=mcr.microsoft.com/playwright:v1.56.0-noble
NET=tavtest
PORT=18884

cd "$(git rev-parse --show-toplevel)"
HIER=tests/ui

if [ "${1:-}" = "--weg" ]; then
  docker rm -f tavtest-webui tavtest-onnx tavtest-video tavtest-whisper >/dev/null 2>&1 || true
  docker volume rm tavtest-onnx-data tavtest-video-data tavtest-whisper-data >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm tavtest-webui:dev >/dev/null 2>&1 || true
  echo "Teststapel abgeraeumt."
  exit 0
fi

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

# Die Dienste laufen weiter, wenn sie schon laufen - nur die Seite wird neu gebaut.
dienst() {
  name=$1; alias=$2; shift 2
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" --network "$NET" --network-alias "$alias" "$@" >/dev/null
  fi
}
dienst tavtest-onnx tav-onnx -v tavtest-onnx-data:/data -e KOKORO_WORKERS=1 -e KOKORO_ONNX_THREADS=2 \
  -e OMP_NUM_THREADS=2 -e KOKORO_ONNX_SPEED=1.125 -e KOKORO_ONNX_TRIM=true -e KOKORO_ONNX_VOICE=martin \
  -e KOKORO_ONNX_LANG=de -e KOKORO_DATA=/data -e KOKORO_CACHE_GB=1 "$ONNX"
dienst tavtest-video tav-video -v tavtest-video-data:/data -e VIDEO_THREADS=2 -e VIDEO_KEEP_HOURS=0 "$VIDEO"
# Die Modelle kommen nur lesend aus dem Volume der laufenden Abschrift: kein Download.
dienst tavtest-whisper tav-whisper -v tavtest-whisper-data:/data -v tav-whisper-models:/models:ro \
  -e HF_HUB_OFFLINE=1 -e WHISPER_THREADS=2 -e WHISPER_MODELS=tiny,base,small -e WHISPER_MODEL=small "$WHISPER"

echo "Baue die Seite …"
docker build -q -f webui/Dockerfile -t tavtest-webui:dev . >/dev/null
docker rm -f tavtest-webui >/dev/null 2>&1 || true
docker run -d --name tavtest-webui --network "$NET" --network-alias tav-webui \
  -p 127.0.0.1:$PORT:80 tavtest-webui:dev >/dev/null

i=0
until curl -sf "http://127.0.0.1:$PORT/v1/audio/voices" >/dev/null; do
  i=$((i + 1)); [ $i -lt 90 ] || { echo "Der Sprachdienst antwortet nicht." >&2; exit 1; }
  sleep 2
done

# Testmaterial: zwei kurze Clips als WebM - das Chromium von Playwright spielt
# kein H.264 ab - und zwei Textdateien fuer den Stapel.
mkdir -p "$HIER/.media"
if [ ! -f "$HIER/.media/clip-b.webm" ]; then
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/$HIER/.media:/out:z" "$VIDEO" sh -c '
    ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 4 -c:v libvpx-vp9 -b:v 400k -deadline realtime -c:a libopus -b:a 48k /out/clip-a.webm &&
    ffmpeg -loglevel error -y -f lavfi -i smptebars=size=640x360:rate=25 -t 3 -c:v libvpx-vp9 -b:v 400k -deadline realtime -an /out/clip-b.webm'
  printf '# Kapitel eins\n\nDas ist die erste Datei im Stapel.\n' > "$HIER/.media/stapel-1.md"
  printf '# Kapitel zwei\n\nUnd hier kommt die zweite Datei.\n' > "$HIER/.media/stapel-2.md"
fi

rm -rf "$HIER/.raus"
# --ipc=host: grosse Dateien im Browser brachten sonst den Renderer um.
# ":z": SELinux gibt das Verzeichnis sonst nicht frei.
docker run --rm --network host --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e TAV_URL="http://127.0.0.1:$PORT/" -v "$PWD/$HIER:/work:z" -w /work "$PLAYWRIGHT" \
  sh -c '[ -d node_modules/playwright ] || npm i -s --no-save playwright@1.56.0 >/dev/null 2>&1; node smoke.mjs "$@"' sh "$@"
