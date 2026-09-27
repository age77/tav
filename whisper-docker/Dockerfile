FROM python:3.12-slim-bookworm

# ffmpeg loest den Ton aus jedem Container heraus, ffprobe liest die Dauer.
# Gerechnet wird auf der CPU: die Intel-GPU des NUC (Skylake) kann kein
# CTranslate2, und eine Grafikkarte gibt es nicht.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper zieht CTranslate2 und onnxruntime (fuer die Stilleerkennung)
# mit. Die Modelle selbst bleiben aussen vor - sie liegen im Volume /models
# und werden beim ersten Gebrauch geholt.
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" faster-whisper

WORKDIR /app
COPY whisper-docker/app.py /app/app.py

ENV WHISPER_DATA=/data \
    HF_HOME=/models
VOLUME /data /models
EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
