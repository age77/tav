FROM python:3.11-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget curl espeak-ng libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi \
    "uvicorn[standard]" \
    numpy \
    kokoro-onnx==0.5.0

# Die beiden Modelldateien liegen nicht im Git, sondern auf Hugging Face. So
# baut auch Portainer den Stapel aus seinem eigenen Klon, ohne dass 325 MB in
# der Versionsverwaltung liegen. Eigene Schicht vor dem Programmtext, damit
# eine Aenderung am Code den Download nicht wiederholt. Die Pruefsummen sind
# festgenagelt: liefert die Gegenstelle etwas anderes, bricht der Bau ab,
# statt ein falsches Modell einzubacken.
ARG MODEL_BASE_URL=https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin/resolve/main
RUN set -eu; \
    curl -fsSL -o /app/kokoro-martin.onnx "$MODEL_BASE_URL/kokoro-martin.onnx"; \
    curl -fsSL -o /app/voices-martin.npz  "$MODEL_BASE_URL/voices-martin.npz"; \
    echo "c302f1d8bc7adf40a842cb550e18c39a5026bdb1afdd29dbb700b501cb49276b  /app/kokoro-martin.onnx" | sha256sum -c -; \
    echo "5b9c8553398d7abf67498ce500c186cefaa7b68fed3e3d415da5380670105acd  /app/voices-martin.npz"  | sha256sum -c -

COPY german_text_rules.py /app/german_text_rules.py
COPY onnx-docker/main.py /app/main.py
COPY onnx-docker/tts_normalizer.py /app/tts_normalizer.py

EXPOSE 8881

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8881", "--loop", "uvloop", "--http", "httptools"]
