FROM python:3.12-slim-bookworm

# ffmpeg aus Debian bringt libx264, libx265, libvpx und libopus mit. Die
# Intel-GPU des NUC (Skylake) kodiert per VA-API nur mit festem QP, ohne
# Zielbitrate liesse sich die Dateigroesse nicht schaetzen - daher nur CPU.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Pillow misst die Untertitel mit denselben DejaVu-Dateien, die libass setzt -
# daran haengt die Groesse des Kastens hinter dem Text.
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" pillow

WORKDIR /app
COPY video-docker/app.py /app/app.py

ENV VIDEO_DATA=/data
VOLUME /data
EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
