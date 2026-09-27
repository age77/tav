# Die Seite als eigenes Abbild statt als eingehaengte Dateien. Portainer baut
# den Stapel aus seinem eigenen Klon; ein relativer Pfad wie ./webui/index.html
# zeigt dort ins Leere, weil der Docker-Dienst ihn auf dem Wirt sucht. Was der
# Server ausliefert, gehoert also ins Abbild.

# Die Untertitel-Vorschau zeigt die Schrift, die der Videodienst einbrennt -
# dieselben DejaVu-Dateien aus demselben Debian, nicht die aus Alpine, die
# anders gebaut sind. Nur so misst und bricht die Seite wie das Video.
FROM python:3.12-slim-bookworm AS schriften
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

FROM nginx:alpine

COPY webui/nginx.conf /etc/nginx/conf.d/default.conf
COPY webui/index.html /usr/share/nginx/html/index.html
COPY webui/tav.css /usr/share/nginx/html/tav.css
COPY webui/js/ /usr/share/nginx/html/js/
COPY webui/beispiel.txt /usr/share/nginx/html/beispiel.txt
COPY webui/tav.svg webui/tav-180.png webui/favicon.ico /usr/share/nginx/html/
COPY SPRECHTEXT-ANLEITUNG.md /usr/share/nginx/html/SPRECHTEXT-ANLEITUNG.md
COPY --from=schriften /usr/share/fonts/truetype/dejavu/ /usr/share/nginx/html/fonts/
