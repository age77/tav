"""Videodienst fuer die Kokoro-Weboberflaeche.

Nimmt mehrere Videoclips und die fertige Sprachausgabe entgegen, haengt die
Clips aneinander, legt den Ton darunter und kodiert das Ergebnis mit ffmpeg.

Hochgeladen wird in Stuecken, weil Traefik jede Anfrage nach 60 Sekunden
Lesezeit abbricht. Auftraege laufen nacheinander und mit niedriger Prioritaet,
damit Sprachsynthese und Home Assistant auf demselben Rechner fluessig bleiben.
Alle Dateien sind voruebergehend und verschwinden nach VIDEO_KEEP_HOURS.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import time
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from PIL import ImageFont, features

DATA = Path(os.getenv("VIDEO_DATA", "/data"))
CLIPS = DATA / "clips"
VOICES = DATA / "voices"
OUTPUT = DATA / "output"
THREADS = max(1, int(os.getenv("VIDEO_THREADS", "4")))
# 0 heisst: nichts verschwindet von selbst. Was auf dem Server liegt, bleibt
# liegen, bis es in der Seite geloescht wird.
KEEP_HOURS = float(os.getenv("VIDEO_KEEP_HOURS", "24"))
MAX_UPLOAD = int(float(os.getenv("VIDEO_MAX_UPLOAD_GB", "8")) * 1024**3)
MAX_PART = 64 * 1024**2
FREE_RESERVE = 2 * 1024**3

ID = re.compile(r"^[0-9a-f]{24}$")

app = FastAPI()


# ====================== Exportoptionen ======================

# Bits pro Bildpunkt je Bild bei H.264, 1080p und 30 Bildern pro Sekunde.
# Kleinere Bilder und niedrigere Bildraten brauchen je Bildpunkt mehr, darum
# die Korrekturen in video_kbps().
QUALITIES = [
    ("small", "Klein", 0.045),
    ("medium", "Mittel", 0.075),
    ("high", "Hoch", 0.11),
    ("max", "Sehr hoch", 0.17),
]

# factor: Bitrate im Verhaeltnis zu H.264 bei gleichem Eindruck.
CODECS = {
    "h264": {"label": "MP4 · H.264 — überall abspielbar", "ext": "mp4", "factor": 1.0,
             "audio": "aac", "mime": "video/mp4"},
    "hevc": {"label": "MP4 · H.265 — kleiner, neuere Geräte", "ext": "mp4", "factor": 0.6,
             "audio": "aac", "mime": "video/mp4"},
    "vp9": {"label": "WebM · VP9 — für Webseiten", "ext": "webm", "factor": 0.65,
            "audio": "opus", "mime": "video/webm"},
}

SPEEDS = [("fast", "Schnell"), ("balanced", "Ausgewogen"), ("thorough", "Gründlich")]
PRESETS = {
    "h264": {"fast": "veryfast", "balanced": "medium", "thorough": "slow"},
    "hevc": {"fast": "superfast", "balanced": "fast", "thorough": "medium"},
    "vp9": {"fast": "6", "balanced": "4", "thorough": "2"},
}

# Aufloesung meint die kurze Bildseite, damit "1080p" auch hochkant passt.
HEIGHTS = [(0, "Original"), (2160, "2160p — 4K"), (1440, "1440p"), (1080, "1080p — Full HD"),
           (720, "720p — HD"), (480, "480p")]
ASPECTS = [("auto", "Wie die meisten Clips"), ("16:9", "16:9 — quer"), ("9:16", "9:16 — hochkant"),
           ("1:1", "1:1 — quadratisch"), ("4:3", "4:3")]
FPS = [(0, "Original"), (60, "60"), (50, "50"), (30, "30"), (25, "25"), (24, "24")]
AUDIO_KBPS = [(96, "96 kbit/s"), (128, "128 kbit/s — Standard"), (192, "192 kbit/s")]
CLIP_AUDIO = [(0.0, "Weglassen"), (0.25, "Leise darunter"), (0.5, "Halb laut"), (1.0, "Voll")]
TRANSITIONS = [(0.0, "Harter Schnitt"), (0.5, "Überblenden 0,5 s"), (1.0, "Überblenden 1 s")]
# Vor- und Nachspann aus dem stehenden ersten und letzten Bild, ohne Ton.
STILL_MAX = 30.0
LENGTHS = [
    ("longer", "Das Längere zählt — letztes Bild halten oder Stille anhängen"),
    ("voice", "Sprachausgabe zählt — Video kürzen oder letztes Bild halten"),
    ("video", "Video zählt — Ton kürzen oder Stille anhängen"),
]


@app.get("/api/info")
async def info():
    return {
        "codecs": [{"id": k, "label": v["label"], "ext": v["ext"]} for k, v in CODECS.items()],
        "qualities": [{"id": k, "label": label} for k, label, _ in QUALITIES],
        "speeds": [{"id": k, "label": label} for k, label in SPEEDS],
        "heights": [{"id": k, "label": label} for k, label in HEIGHTS],
        "aspects": [{"id": k, "label": label} for k, label in ASPECTS],
        "fps": [{"id": k, "label": label} for k, label in FPS],
        "audio_kbps": [{"id": k, "label": label} for k, label in AUDIO_KBPS],
        "clip_audio": [{"id": k, "label": label} for k, label in CLIP_AUDIO],
        "transitions": [{"id": k, "label": label} for k, label in TRANSITIONS],
        "lengths": [{"id": k, "label": label} for k, label in LENGTHS],
        "sub_fonts": [{"id": k, "label": label} for k, label in SUB_FONTS],
        "sub_positions": [{"id": k, "label": label} for k, label, _ in SUB_POSITIONS],
        "sub_defaults": SUB_DEFAULTS,
        "max_cues": MAX_CUES,
        "max_upload": MAX_UPLOAD,
        "part_size": 32 * 1024**2,
    }


def pick(value, choices, name):
    for c in choices:
        if c[0] == value:
            return c[0]
    raise HTTPException(422, f"Ungültiger Wert für {name}: {value!r}")


def even(x: float) -> int:
    return max(2, int(round(x / 2)) * 2)


def video_kbps(bpp: float, width: int, height: int, fps: float, factor: float) -> int:
    pixels = width * height
    kbps = bpp * pixels * fps / 1000 * (2073600 / pixels) ** 0.25 * (30 / fps) ** 0.4 * factor
    return max(100, int(round(kbps / 10) * 10))


# ====================== Projekte und Platz auf dem Server ======================

# Ein Projekt ist die Arbeitsfassung, die sonst als Datei heruntergeladen wird:
# Sprechertext, Pausen, Einstellungen und die Kennungen der Clips. Hier liegt
# sie auf dem Server, damit sie an jedem Platz und ohne Umweg ueber den
# Download-Ordner wieder aufgeht. Die Dateien selbst bleiben, wo sie sind - das
# Projekt verweist nur auf sie.
PROJECTS = DATA / "projects"
MAX_PROJECTS = 200
MAX_PROJECT_BYTES = 8 * 1024**2
NAME_MAX = 120


def projekt_pfad(pid: str) -> Path:
    if not ID.match(pid or ""):
        raise HTTPException(404, "Projekt unbekannt.")
    return PROJECTS / f"{pid}.json"


def projekt_name(roh, ersatz: str = "Projekt") -> str:
    name = re.sub(r"[\x00-\x1f]", " ", str(roh or "")).strip()[:NAME_MAX]
    return name or ersatz


def projekt_lesen(pfad: Path) -> dict:
    try:
        return json.loads(pfad.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(404, "Projekt ist nicht mehr lesbar.")


def projekt_kurz(pfad: Path) -> dict:
    p = projekt_lesen(pfad)
    return {"id": p.get("id"), "name": p.get("name"), "updated": p.get("updated"),
            "created": p.get("created"), "size": pfad.stat().st_size,
            "clips": len((p.get("data") or {}).get("videoclips") or [])}


def projekt_schreiben(pid: str, name: str, data, created: float | None) -> dict:
    roh = json.dumps(data, ensure_ascii=False)
    if len(roh.encode()) > MAX_PROJECT_BYTES:
        raise HTTPException(413, f"Das Projekt ist größer als {MAX_PROJECT_BYTES // 1024**2} MB.")
    jetzt = time.time()
    projekt = {"id": pid, "name": name, "created": created or jetzt, "updated": jetzt, "data": data}
    PROJECTS.mkdir(parents=True, exist_ok=True)
    tmp = projekt_pfad(pid).with_suffix(".neu")
    tmp.write_text(json.dumps(projekt, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, projekt_pfad(pid))
    return {k: v for k, v in projekt.items() if k != "data"} | {"size": projekt_pfad(pid).stat().st_size}


@app.get("/api/projects")
async def list_projects():
    PROJECTS.mkdir(parents=True, exist_ok=True)
    raus = []
    for pfad in PROJECTS.glob("*.json"):
        try:
            raus.append(projekt_kurz(pfad))
        except HTTPException:
            continue
    raus.sort(key=lambda p: p.get("updated") or 0, reverse=True)
    return {"projects": raus, "max": MAX_PROJECTS}


@app.post("/api/projects")
async def create_project(request: Request):
    body = await request.json()
    PROJECTS.mkdir(parents=True, exist_ok=True)
    if len(list(PROJECTS.glob("*.json"))) >= MAX_PROJECTS:
        raise HTTPException(409, f"Mehr als {MAX_PROJECTS} Projekte sind nicht vorgesehen.")
    pid = secrets.token_hex(12)
    return projekt_schreiben(pid, projekt_name(body.get("name")), body.get("data"), None)


@app.get("/api/projects/{pid}")
async def get_project(pid: str):
    pfad = projekt_pfad(pid)
    if not pfad.exists():
        raise HTTPException(404, "Projekt unbekannt.")
    return projekt_lesen(pfad)


@app.put("/api/projects/{pid}")
async def put_project(pid: str, request: Request):
    pfad = projekt_pfad(pid)
    if not pfad.exists():
        raise HTTPException(404, "Projekt unbekannt.")
    alt = projekt_lesen(pfad)
    body = await request.json()
    name = projekt_name(body.get("name"), alt.get("name") or "Projekt")
    return projekt_schreiben(pid, name, body.get("data"), alt.get("created"))


@app.delete("/api/projects/{pid}")
async def delete_project(pid: str):
    projekt_pfad(pid).unlink(missing_ok=True)
    return {"ok": True}


# ---------------------- Der Sprechertext als Datei ----------------------

# Der Sprechertext kam bisher nur als Text im Projekt auf den Server und war
# darum im Bereich "Auf dem Server" nicht zu sehen. Hier liegt er zusaetzlich
# als Datei - dieselbe Markdown-Datei, die auch heruntergeladen wird. So steht
# sie in der Liste, laesst sich einzeln holen und einzeln loeschen, und ein
# Projekt verweist ueber "textid" darauf.
TEXTS = DATA / "texts"
MAX_TEXTS = 500
MAX_TEXT_BYTES = 2 * 1024**2


def text_name(roh) -> str:
    """Pfad weg, Steuerzeichen weg, Endung immer .md - so wie die Seite den
    Text auch herunterlaedt."""
    name = re.sub(r"[\x00-\x1f]", " ", str(roh or "")).strip()
    name = re.split(r"[\\/]", name)[-1][:NAME_MAX].strip()
    name = re.sub(r"\.(md|markdown|txt|text)$", "", name, flags=re.I).strip()
    return (name or "sprechertext") + ".md"


@app.post("/api/texts")
async def create_text(request: Request):
    body = await request.json()
    roh = str(body.get("text") or "").encode("utf-8")
    if not roh.strip():
        raise HTTPException(422, "Leerer Text.")
    if len(roh) > MAX_TEXT_BYTES:
        raise HTTPException(413, f"Der Text ist größer als {MAX_TEXT_BYTES // 1024**2} MB.")
    name = text_name(body.get("name"))
    sha = hashlib.sha256(roh).hexdigest()
    TEXTS.mkdir(parents=True, exist_ok=True)

    # Derselbe Text unter demselben Namen liegt nur einmal: wer zweimal
    # dieselbe Datei einliest, soll sie nicht zweimal in der Liste finden.
    for pfad in TEXTS.glob("*.json"):
        try:
            meta = json.loads(pfad.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if meta.get("sha") == sha and meta.get("name") == name:
            jetzt = time.time()
            os.utime(pfad, (jetzt, jetzt))
            return meta | {"created": pfad.stat().st_mtime}

    if len(list(TEXTS.glob("*.json"))) >= MAX_TEXTS:
        raise HTTPException(409, f"Mehr als {MAX_TEXTS} Sprechertexte sind nicht vorgesehen.")
    tid = secrets.token_hex(12)
    meta = {"id": tid, "name": name, "size": len(roh), "file": f"{tid}.md", "done": True, "sha": sha}
    (TEXTS / meta["file"]).write_bytes(roh)
    save_meta(TEXTS, meta)
    return meta | {"created": (TEXTS / f"{tid}.json").stat().st_mtime}


@app.get("/api/texts/{tid}")
async def get_text(tid: str):
    meta = load_meta(TEXTS, tid)
    pfad = TEXTS / meta["file"]
    if not pfad.exists():
        raise HTTPException(404, "Der Sprechertext ist nicht mehr auf dem Server.")
    return meta | {"text": pfad.read_text(encoding="utf-8")}


# Zum Herunterladen - mit Dateinamen im Kopf, anders als bei Clips: eine
# Markdown-Datei soll im Download-Ordner landen, nicht im Browserfenster.
@app.get("/api/texts/{tid}/file")
async def text_file(tid: str):
    meta = load_meta(TEXTS, tid)
    pfad = TEXTS / meta["file"]
    if not pfad.exists():
        raise HTTPException(404, "Der Sprechertext ist nicht mehr auf dem Server.")
    return FileResponse(pfad, media_type="text/markdown; charset=utf-8", filename=meta["name"])


@app.delete("/api/texts/{tid}")
async def delete_text(tid: str):
    meta_path(TEXTS, tid)
    remove(TEXTS, tid)
    return {"ok": True}


# ---------------------- Was auf dem Server liegt ----------------------

# Die Seite zeigt es in einem eigenen Bereich: was liegt hier, wie gross ist
# es, und wird es noch von einem Projekt gebraucht? Geloescht wird nur auf
# Zuruf - aufgeraeumt wird hier nichts von selbst, solange VIDEO_KEEP_HOURS
# auf 0 steht.
LAGER = {"clips": lambda: CLIPS, "voices": lambda: VOICES, "output": lambda: OUTPUT,
         "texts": lambda: TEXTS}


def benutzte_kennungen() -> dict[str, int]:
    """Welche Clips und Sprechertexte in Projekten vorkommen - und in wie vielen."""
    zaehler: dict[str, int] = {}
    PROJECTS.mkdir(parents=True, exist_ok=True)
    for pfad in PROJECTS.glob("*.json"):
        try:
            data = (projekt_lesen(pfad).get("data") or {})
        except HTTPException:
            continue
        for c in data.get("videoclips") or []:
            kid = str((c or {}).get("id") or "")
            if kid:
                zaehler[kid] = zaehler.get(kid, 0) + 1
        tid = str(data.get("textid") or "")
        if tid:
            zaehler[tid] = zaehler.get(tid, 0) + 1
    return zaehler


@app.get("/api/storage")
async def storage():
    benutzt = benutzte_kennungen()
    raus: dict[str, list] = {}
    for art, hole in LAGER.items():
        ordner = hole()
        ordner.mkdir(parents=True, exist_ok=True)
        eintraege = []
        if art == "output":
            for f in ordner.iterdir():
                if f.suffix in (".log", ".ass", ".json") or not f.is_file():
                    continue
                # Gezeigt wird der Name, unter dem es heruntergeladen wird. Er
                # steht neben dem Video, damit er einen Neustart uebersteht -
                # ebenso Bildgroesse und Dauer, die zum Zusammenfuegen taugen.
                meta = await output_meta(f.name)
                eintraege.append({"id": f.name, "name": meta.get("name") or f.name,
                                  "size": f.stat().st_size, "created": f.stat().st_mtime, "used": 0,
                                  "duration": meta.get("duration"), "width": meta.get("width"),
                                  "height": meta.get("height"), "fps": meta.get("fps"),
                                  "has_audio": meta.get("has_audio")})
        else:
            for f in ordner.glob("*.json"):
                try:
                    meta = json.loads(f.read_text())
                except (OSError, ValueError):
                    continue
                datei = ordner / meta.get("file", "")
                eintraege.append({"id": meta.get("id"), "name": meta.get("name"),
                                  "size": datei.stat().st_size if datei.exists() else 0,
                                  "created": f.stat().st_mtime, "done": bool(meta.get("done")),
                                  "duration": meta.get("duration"),
                                  "used": benutzt.get(str(meta.get("id")), 0)})
        eintraege.sort(key=lambda e: e.get("created") or 0, reverse=True)
        raus[art] = eintraege

    platte = shutil.disk_usage(DATA)
    return {"items": raus, "free": platte.free, "total": platte.total,
            "used": sum(e["size"] for liste in raus.values() for e in liste),
            "keep_hours": KEEP_HOURS}


@app.delete("/api/storage/{art}/{name}")
async def delete_storage(art: str, name: str):
    if art not in LAGER:
        raise HTTPException(404, "Unbekannte Art.")
    ordner = LAGER[art]()
    if art == "output":
        if "/" in name or "\\" in name or name.startswith("."):
            raise HTTPException(422, "Ungültiger Name.")
        pfad = ordner / name
        if pfad.exists():
            pfad.unlink()
            for zusatz in (".log", ".ass", ".json"):
                (ordner / (pfad.stem + zusatz)).unlink(missing_ok=True)
    else:
        remove(ordner, name)
    return {"ok": True}


# ====================== Untertitel ======================

# Der Sprechertext kann ins Bild: die Seite kennt zu jedem Abschnitt seine
# Stelle auf der Tonspur und schickt ihn als Liste von Einblendungen mit. Hier
# wird daraus eine ASS-Datei - libass ist in ffmpeg eingebaut und kann
# zeichnen, so liegt ein Kasten mit runden Ecken und einstellbarer Deckkraft
# hinter dem Text (siehe "Der Kasten hinter dem Text"). Die Schriften kommen
# mit ffmpeg aus Debian (DejaVu).
SUB_FONTS = [("sans", "DejaVu Sans"), ("serif", "DejaVu Serif"), ("mono", "DejaVu Sans Mono")]
SUB_POSITIONS = [("bottom", "Unten", 2), ("middle", "Mitte", 5), ("top", "Oben", 8)]
MAX_CUES = 2000
MAX_CUE_CHARS = 400

SUB_DEFAULTS = {
    "on": False, "font": "sans", "size": 5.0, "bold": True, "color": "#ffffff",
    "outline": 0.0, "box": "#000000", "box_alpha": 55, "position": "bottom", "margin": 6.0,
}


def hex_to_ass(farbe: str, alpha_prozent: float = 100.0) -> str:
    """#rrggbb wird zu &HAABBGGRR. In ASS heisst 00 deckend und FF durchsichtig,
    darum wird die Deckkraft umgedreht."""
    s = str(farbe or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6 or any(c not in "0123456789abcdefABCDEF" for c in s):
        s = "ffffff"
    r, g, b = s[0:2], s[2:4], s[4:6]
    a = 255 - int(round(max(0.0, min(100.0, alpha_prozent)) * 255 / 100))
    return f"&H{a:02X}{b}{g}{r}".upper()


def ass_time(t: float) -> str:
    t = max(0.0, t)
    h, rest = divmod(t, 3600)
    m, s = divmod(rest, 60)
    return f"{int(h)}:{int(m):02d}:{int(s):02d}.{int(round((s - int(s)) * 100)) % 100:02d}"


def ass_text(text: str) -> str:
    """Zeilenumbruch wird zu \\N; die Zeichen, mit denen ASS selbst Befehle
    schreibt, verlieren ihre Bedeutung."""
    t = str(text or "").replace("\\", "\\\\").replace("{", "(").replace("}", ")")
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    return "\\N".join(zeile.strip() for zeile in t.split("\n") if zeile.strip())


def text_zeilen(text: str) -> list[str]:
    """Die Zeilen so, wie sie im Bild stehen - Klammern statt geschweifter,
    wie ass_text sie schreibt. Daran wird gemessen."""
    t = str(text or "").replace("{", "(").replace("}", ")").replace("\r\n", "\n").replace("\r", "\n")
    return [z.strip() for z in t.split("\n") if z.strip()]


# ---------------------- Der Kasten hinter dem Text ----------------------

# libass legt einen Kasten nur mit BorderStyle 3 hinter den Text, und der nimmt
# die Farbe des Umrisses und dessen Breite als Rand: mit Umriss 0 blieb der
# Kasten ganz weg, und die eingestellte Kastenfarbe wurde nie benutzt. Ausserdem
# ist er immer eckig. Darum zeichnet der Dienst den Kasten selbst - ein Rechteck
# mit runden Ecken als ASS-Zeichnung auf einer Ebene unter dem Text.
#
# Dafuer muss er wissen, wie gross der Text wird. Pillow misst mit denselben
# DejaVu-Dateien und derselben Formung (HarfBuzz) wie libass; nachgemessen
# liegen die Breiten keine 0,5 % auseinander. In libass ist die Schriftgroesse
# die Hoehe einer Zeile, Ober- plus Unterlaenge - nicht das Geviert.
SCHRIFTEN = Path("/usr/share/fonts/truetype/dejavu")
SCHRIFT_DATEI = {"sans": "DejaVuSans", "serif": "DejaVuSerif", "mono": "DejaVuSansMono"}

# Abstand des Kastens vom Text und Rundung seiner Ecken, in Geviert - dieselben
# Werte wie in der Vorschau der Seite (.s-vorschau span).
KASTEN_X, KASTEN_Y, KASTEN_RUND = 0.35, 0.1, 0.35


@lru_cache(maxsize=24)
def schrift(font: str, bold: bool, groesse: int) -> ImageFont.FreeTypeFont:
    pfad = str(SCHRIFTEN / (SCHRIFT_DATEI[font] + ("-Bold" if bold else "") + ".ttf"))
    ober, unter = ImageFont.truetype(pfad, 1000).getmetrics()
    formung = ImageFont.Layout.RAQM if features.check("raqm") else ImageFont.Layout.BASIC
    return ImageFont.truetype(pfad, groesse * 1000 / (ober + unter), layout_engine=formung)


def kasten_pfad(w: int, h: int, r: int) -> str:
    """Ein Rechteck mit runden Ecken als ASS-Zeichnung, links oben bei 0,0.
    Die Ecken sind Bezierbogen - die uebliche Naeherung eines Viertelkreises."""
    r = max(0, min(r, w // 2, h // 2))
    k = round(r * 0.4477)                 # 1 - 0,5523: Abstand der Stuetzpunkte von der Ecke
    return (f"m {r} 0 l {w - r} 0 b {w - k} 0 {w} {k} {w} {r} "
            f"l {w} {h - r} b {w} {h - k} {w - k} {h} {w - r} {h} "
            f"l {r} {h} b {k} {h} 0 {h - k} 0 {h - r} "
            f"l 0 {r} b 0 {k} {k} 0 {r} 0")


def sub_options(opts: dict) -> dict:
    """Die Untertitel-Einstellungen, auf gueltige Werte gebracht."""
    o = dict(SUB_DEFAULTS)
    roh = opts.get("subtitles") or {}
    if not isinstance(roh, dict):
        raise HTTPException(422, "Untertitel-Einstellungen unlesbar.")
    o["on"] = bool(roh.get("on"))
    o["font"] = pick(str(roh.get("font", o["font"])), SUB_FONTS, "Schriftart")
    o["position"] = pick(str(roh.get("position", o["position"])), SUB_POSITIONS, "Position")
    o["bold"] = bool(roh.get("bold", o["bold"]))
    o["size"] = min(20.0, max(1.5, float(roh.get("size", o["size"]) or 0)))
    o["outline"] = min(6.0, max(0.0, float(roh.get("outline", o["outline"]) or 0)))
    o["margin"] = min(45.0, max(0.0, float(roh.get("margin", o["margin"]) or 0)))
    o["box_alpha"] = min(100.0, max(0.0, float(roh.get("box_alpha", o["box_alpha"]) or 0)))
    o["color"] = str(roh.get("color") or o["color"])
    o["box"] = str(roh.get("box") or o["box"])
    return o


def sub_cues(body: dict) -> list[dict]:
    roh = body.get("cues") or []
    if not isinstance(roh, list):
        raise HTTPException(422, "Die Untertitel sind keine Liste.")
    if len(roh) > MAX_CUES:
        raise HTTPException(422, f"Mehr als {MAX_CUES} Einblendungen sind nicht vorgesehen.")
    raus = []
    for c in roh:
        if not isinstance(c, dict):
            continue
        zeilen, frei = [], MAX_CUE_CHARS
        for z in text_zeilen(c.get("text")):
            if frei <= 0:
                break
            zeilen.append(z[:frei])
            frei -= len(z)
        start, ende = float(c.get("start") or 0), float(c.get("end") or 0)
        if not zeilen or ende <= start:
            continue
        raus.append({"start": max(0.0, start), "end": max(0.0, ende), "zeilen": zeilen})
    raus.sort(key=lambda c: c["start"])
    return raus


def build_ass(cues: list[dict], sub: dict, width: int, height: int) -> str:
    """Eine ASS-Datei, deren Bildmasse denen des Videos entsprechen - dann ist
    die Schriftgroesse in Prozent der Bildhoehe zu verstehen. Jede Einblendung
    hat zwei Ebenen: unten der Kasten, darueber der Text mit seinem Umriss."""
    font = dict(SUB_FONTS)[sub["font"]]
    groesse = max(8, int(round(height * sub["size"] / 100)))
    rand = max(0, int(round(height * sub["margin"] / 100)))
    ausrichtung = {p[0]: p[2] for p in SUB_POSITIONS}[sub["position"]]
    f = schrift(sub["font"], sub["bold"], groesse)
    em = f.size
    # Ohne Deckkraft bleibt der Kasten weg; dann macht der Umriss die Schrift
    # auf hellem Bild lesbar.
    kasten = sub["box_alpha"] > 0
    farbe_kasten = hex_to_ass(sub["box"], sub["box_alpha"])
    nichts = hex_to_ass("#000000", 0)

    kopf = [
        # WrapStyle 2: umgebrochen wird nur an \N. Die Zeilen stehen fest,
        # bevor der Kasten um sie gezeichnet wird.
        "[Script Info]", "ScriptType: v4.00+", "WrapStyle: 2", "ScaledBorderAndShadow: yes",
        f"PlayResX: {width}", f"PlayResY: {height}", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,"
        " Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,"
        " Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        (f"Style: Standard,{font},{groesse},{hex_to_ass(sub['color'])},{hex_to_ass(sub['color'])},"
         f"{hex_to_ass('#000000')},{nichts},{-1 if sub['bold'] else 0},0,0,0,100,100,0,0,"
         f"1,{fmt_num(sub['outline'])},0,{ausrichtung},{rand},{rand},{rand},1"),
        f"Style: Kasten,{font},{groesse},{farbe_kasten},{farbe_kasten},{nichts},{nichts},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    raus = []
    frei = width - 2 * rand
    for c in cues:
        zeilen = c["zeilen"]
        von, bis = ass_time(c["start"]), ass_time(c["end"])
        # Die Seite bricht so um, dass jede Zeile zwischen die Raender passt, und
        # nie in mehr Zeilen als eingestellt. Bleibt doch eine zu breit - eine
        # alte Seite, eine Schrift, die der Browser nicht laden konnte -, wird
        # diese Einblendung schmaler gesetzt statt um eine Zeile laenger.
        breit = max(f.getlength(z) for z in zeilen)
        eng = min(1.0, frei / breit) if breit > 0 else 1.0
        if kasten:
            hoehe = len(zeilen) * groesse
            oben = {"bottom": height - rand - hoehe, "top": rand}.get(sub["position"], (height - hoehe) / 2)
            w = round(breit * eng + 2 * KASTEN_X * em)
            h = round(hoehe + 2 * KASTEN_Y * em)
            pos = f"{round((width - w) / 2)},{round(oben - KASTEN_Y * em)}"
            raus.append(f"Dialogue: 0,{von},{bis},Kasten,,0,0,0,,"
                        f"{{\\an7\\pos({pos})\\p1}}{kasten_pfad(w, h, round(KASTEN_RUND * em))}{{\\p0}}")
        text = (f"{{\\fscx{fmt_num(round(eng * 100, 1))}}}" if eng < 1 else "") + "\\N".join(ass_text(z) for z in zeilen)
        raus.append(f"Dialogue: 1,{von},{bis},Standard,,0,0,0,,{text}")
    return "\n".join(kopf + raus) + "\n"


# ====================== Schnitt je Clip ======================

# Ein Clip muss nicht ganz ins Video: "start" und "end" schneiden vorn und
# hinten ab, "drops" nehmen Stuecke aus der Mitte heraus, und an einer Stelle
# laesst sich das Bild anhalten ("holds"), damit der Sprechertext nachkommt.
# Alles sind Angaben zum Auftrag, nicht zur hochgeladenen Datei - dieselbe
# Datei kann in zwei Auftraegen anders geschnitten sein.
MAX_HOLDS = 20
HOLD_MIN, HOLD_MAX = 0.05, 60.0
HOLD_TOTAL_MAX = 600.0
CUT_MIN = 0.05
MAX_DROPS = 50


def clip_cut(spec: dict, meta: dict) -> dict:
    """Anfang, Ende, herausgeschnittene Stuecke und Standbilder eines Clips,
    gegen seine Laufzeit geprueft.

    Heraus kommt auch die Laufzeit, die daraus wird: das geschnittene Stueck,
    ohne das Herausgeschnittene, plus die Standbilder. Mit ihr rechnen Plan,
    Zeitleiste und ffmpeg."""
    quelle = float(meta.get("duration") or 0)
    if quelle <= 0:
        raise HTTPException(422, "Clip ohne Dauer.")

    start = max(0.0, float(spec.get("start") or 0))
    ende = spec.get("end")
    ende = quelle if ende in (None, "") else float(ende)
    ende = min(quelle, ende)
    if ende - start < CUT_MIN:
        raise HTTPException(422, f"Der Ausschnitt ist kürzer als {fmt_num(CUT_MIN)} s.")
    laenge = ende - start

    # Herausgeschnittenes, in Sekunden ab dem Anfang des Ausschnitts wie die
    # Standbilder. Was sich ueberschneidet, wird zu einem Stueck.
    roh = spec.get("drops") or []
    if len(roh) > MAX_DROPS:
        raise HTTPException(422, f"Höchstens {MAX_DROPS} herausgeschnittene Stücke je Clip.")
    kanten = []
    for d in roh:
        a = min(laenge, max(0.0, float(d.get("from") or 0)))
        b = min(laenge, max(0.0, float(d.get("to") or 0)))
        if b - a >= CUT_MIN:
            kanten.append([round(a, 3), round(b, 3)])
    kanten.sort()
    drops: list[list[float]] = []
    for a, b in kanten:
        if drops and a <= drops[-1][1] + 1e-6:
            drops[-1][1] = max(drops[-1][1], b)
        else:
            drops.append([a, b])
    weg = sum(b - a for a, b in drops)
    if laenge - weg < CUT_MIN:
        raise HTTPException(422, "Von diesem Clip bliebe nichts übrig.")

    def raus(t: float) -> bool:
        return any(a - 1e-6 < t < b + 1e-6 for a, b in drops)

    holds = []
    roh = spec.get("holds") or []
    if len(roh) > MAX_HOLDS:
        raise HTTPException(422, f"Höchstens {MAX_HOLDS} Standbilder je Clip.")
    for h in roh:
        at = min(laenge, max(0.0, float(h.get("at") or 0)))
        sek = float(h.get("seconds") or 0)
        if sek < HOLD_MIN or raus(at):                 # zu kurz zum Sehen oder weggeschnitten
            continue
        holds.append({"at": round(at, 3), "seconds": round(min(HOLD_MAX, sek), 3)})
    holds.sort(key=lambda h: h["at"])
    if sum(h["seconds"] for h in holds) > HOLD_TOTAL_MAX:
        raise HTTPException(422, "Die Standbilder dieses Clips ergeben zusammen mehr als zehn Minuten.")

    return {"start": round(start, 3), "end": round(ende, 3), "holds": holds,
            "drops": [{"from": a, "to": b} for a, b in drops], "source_duration": quelle,
            "duration": round(laenge - weg + sum(h["seconds"] for h in holds), 3)}


def cut_specs(body: dict) -> list[dict]:
    """Die Schnittangaben aus dem Auftrag. Ein Clip darf als blosse Kennung
    dastehen - dann kommt er ungeschnitten ins Video."""
    raus = []
    for c in body.get("clips") or []:
        raus.append(c if isinstance(c, dict) else {})
    return raus


def clip_ids(body: dict) -> list[str]:
    raus = []
    for c in body.get("clips") or []:
        raus.append(str(c.get("id") if isinstance(c, dict) else c))
    return raus


def cut_pieces(cut: dict, fps: float) -> tuple[float, list[tuple[float, float, float]]]:
    """Die Stuecke, die vom Clip zu sehen sind: (von, bis, danach halten).

    Herausgeschnittenes kommt darin nicht vor; ein Standbild teilt das Stueck,
    in dem es liegt, und haengt seine Standzeit an die Naht. Ein Standbild ganz
    am Anfang laesst sich an kein Stueck haengen - es gibt davor keines -,
    darum steht seine Laenge getrennt davor."""
    laenge = cut["end"] - cut["start"]
    frame = 1.0 / max(1.0, fps)

    # Was uebrig bleibt: die Strecken zwischen dem Herausgeschnittenen.
    behalten: list[tuple[float, float]] = []
    los = 0.0
    for d in cut.get("drops") or []:
        if d["from"] > los + 1e-6:
            behalten.append((los, min(d["from"], laenge)))
        los = max(los, d["to"])
    if laenge > los + 1e-6:
        behalten.append((los, laenge))
    if not behalten:
        behalten = [(0.0, laenge)]

    vorne = 0.0
    stuecke: list[list[float]] = []
    for a, b in behalten:
        cur = a
        for h in cut["holds"]:
            at = min(b, h["at"])
            if at < a - 1e-6 or h["at"] > b + 1e-6:
                continue
            if at - cur < frame:                        # an der Naht statt im Stueck
                if stuecke:
                    stuecke[-1][2] += h["seconds"]
                else:
                    vorne += h["seconds"]
                continue
            stuecke.append([cur, at, h["seconds"]])
            cur = at
        if b - cur < frame and stuecke and abs(stuecke[-1][1] - cur) < 1e-6:
            stuecke[-1][1] = b                          # Rest ist kuerzer als ein Bild
        elif b - cur > 1e-6:
            stuecke.append([cur, b, 0.0])
    if not stuecke:
        stuecke.append([0.0, laenge, 0.0])
    return vorne, [(a, b, c) for a, b, c in stuecke]


def make_plan(clips: list[dict], opts: dict, voice_seconds: float | None) -> dict:
    """Leitet aus Clips und Optionen Bildgroesse, Laenge, Bitraten und die
    geschaetzte Dateigroesse ab. Dieselbe Rechnung dient Vorschau und Auftrag."""
    if not clips:
        raise HTTPException(422, "Keine Clips.")
    codec = pick(opts.get("codec", "h264"), [(k,) for k in CODECS], "Format")
    quality = pick(opts.get("quality", "medium"), QUALITIES, "Qualität")
    speed = pick(opts.get("speed", "balanced"), SPEEDS, "Geschwindigkeit")
    target_h = pick(int(opts.get("height", 0)), HEIGHTS, "Auflösung")
    aspect = pick(opts.get("aspect", "auto"), ASPECTS, "Seitenverhältnis")
    target_fps = pick(int(opts.get("fps", 0)), FPS, "Bildrate")
    audio_kbps = pick(int(opts.get("audio_kbps", 128)), AUDIO_KBPS, "Tonqualität")
    clip_audio = pick(float(opts.get("clip_audio", 0)), CLIP_AUDIO, "Originalton")
    transition = pick(float(opts.get("transition", 0)), TRANSITIONS, "Übergang")
    length = pick(opts.get("length", "longer"), LENGTHS, "Länge")
    offset = min(600.0, max(0.0, float(opts.get("voice_offset", 0) or 0)))
    # Vor- und Nachspann: das erste und das letzte Bild stehen still, und es ist
    # still. So hat ein Film Luft, bevor gesprochen wird, und beim
    # Zusammenfuegen laesst sich darin ueberblenden.
    still = min(STILL_MAX, max(0.0, float(opts.get("still_seconds", 0) or 0)))

    for c in clips:
        if not (c.get("width") and c.get("height") and c.get("duration")):
            raise HTTPException(422, "Clip ohne Bildgröße oder Dauer.")

    warnings = []
    # Seitenverhaeltnis: fest gewaehlt oder das, welches am laengsten zu sehen
    # ist. Clips mit anderem Verhaeltnis werden mit Raendern eingepasst.
    if aspect == "auto":
        screen: dict[float, float] = {}
        for c in clips:
            r = round(c["width"] / c["height"], 2)
            screen[r] = screen.get(r, 0) + c["duration"]
        ratio_wh = max(screen, key=screen.get)
        same = [c for c in clips if round(c["width"] / c["height"], 2) == ratio_wh]
        ratio_wh = same[0]["width"] / same[0]["height"]
    else:
        a, b = aspect.split(":")
        ratio_wh = int(a) / int(b)
        same = clips
    source_short = max(min(c["width"], c["height"]) for c in same)
    short = target_h or source_short
    if target_h and target_h > source_short:
        warnings.append(f"Hochgerechnet von {int(source_short)}p — schärfer wird es dadurch nicht.")
    if ratio_wh >= 1:
        width, height = even(short * ratio_wh), even(short)
    else:
        width, height = even(short), even(short / ratio_wh)
    if any(abs(c["width"] / c["height"] - width / height) > 0.01 for c in clips):
        warnings.append("Clips mit anderem Seitenverhältnis bekommen schwarze Ränder.")

    fps = float(target_fps) if target_fps else min(60.0, max(float(c.get("fps") or 30) for c in clips))
    fps = round(fps, 3)

    if transition and len(clips) > 1:
        short = [i + 1 for i, c in enumerate(clips) if c["duration"] <= transition * 2]
        if short:
            raise HTTPException(422, f"Clip {', '.join(map(str, short))} ist zu kurz für die Überblendung.")
    video_seconds = sum(c["duration"] for c in clips) - transition * (len(clips) - 1) + 2 * still
    # Gesprochen wird erst hinter dem Vorspann, und hinter der Sprache steht das
    # Bild noch einmal still.
    voice_end = still + offset + voice_seconds if voice_seconds else None

    if length == "voice" and voice_end:
        duration = voice_end + still
    elif length == "longer" and voice_end:
        duration = max(video_seconds, voice_end + still)
    else:
        duration = video_seconds

    vk = video_kbps(dict((k, b) for k, _, b in QUALITIES)[quality], width, height, fps, CODECS[codec]["factor"])
    has_audio = bool(voice_end) or clip_audio > 0
    ak = audio_kbps if has_audio else 0
    est = (vk + ak) * 1000 / 8 * duration * 1.01 + 8192

    return {
        "subtitles": sub_options(opts),
        "codec": codec, "quality": quality, "speed": speed, "aspect": aspect, "width": width, "height": height,
        "fps": fps, "audio_kbps": ak, "clip_audio": clip_audio, "transition": transition,
        "still_seconds": still, "length": length, "voice_offset": offset, "video_seconds": video_seconds,
        "voice_seconds": voice_seconds, "duration": duration, "video_kbps": vk,
        "estimated_bytes": int(est), "ext": CODECS[codec]["ext"], "warnings": warnings,
    }


@app.post("/api/plan")
async def plan(request: Request):
    body = await request.json()
    clips = []
    for c in body.get("clips", []):
        meta = {k: float(c.get(k) or 0) for k in ("width", "height", "duration", "fps")}
        meta["cut"] = clip_cut(c, meta)
        meta["duration"] = meta["cut"]["duration"]       # ab hier zaehlt der Schnitt
        clips.append(meta)
    voice = body.get("voice_seconds")
    return make_plan(clips, body.get("options", {}), float(voice) if voice else None)


# ====================== Hilfen ======================


async def run(*args: str) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    return proc.returncode, out, err


def ratio(text: str | None) -> float:
    try:
        a, _, b = (text or "0/1").partition("/")
        return float(a) / float(b or 1)
    except (ValueError, ZeroDivisionError):
        return 0.0


async def probe(path: Path, want_video: bool) -> dict:
    rc, out, _ = await run("ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path))
    if rc:
        raise HTTPException(422, "Datei lässt sich nicht lesen.")
    data = json.loads(out or b"{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not want_video:
        duration = float(fmt.get("duration") or (audio or {}).get("duration") or 0)
        if not audio or duration <= 0:
            raise HTTPException(422, "Datei enthält keinen Ton.")
        return {"duration": duration}

    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    if not video:
        raise HTTPException(422, "Datei enthält kein Video.")
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    # Hochkant gefilmte Clips tragen die Drehung als Metadatum; ffmpeg dreht
    # beim Dekodieren automatisch, die Bildgroesse muss also getauscht werden.
    rotation = video.get("tags", {}).get("rotate")
    for side in video.get("side_data_list", []):
        rotation = side.get("rotation", rotation)
    if rotation is not None and abs(int(float(rotation))) % 180 == 90:
        width, height = height, width
    fps = ratio(video.get("avg_frame_rate")) or ratio(video.get("r_frame_rate")) or 30.0
    duration = float(video.get("duration") or fmt.get("duration") or 0)
    if not (width and height and duration > 0):
        raise HTTPException(422, "Video ohne lesbare Bildgröße oder Dauer.")
    return {"width": width, "height": height, "fps": round(fps, 3), "duration": duration,
            "vcodec": video.get("codec_name"), "has_audio": audio is not None}


# Ein fertiges Video heisst nach seinem Auftrag, und der lebt nur im Speicher.
# Damit Name und Masse einen Neustart ueberstehen - und damit sich fertige
# Videos zusammenfuegen lassen -, steht beides als JSON daneben. Fuer Videos
# von vorher wird es beim ersten Nachsehen nachgetragen.
def output_datei(datei: str) -> Path:
    if "/" in datei or "\\" in datei or datei.startswith(".") or Path(datei).suffix == ".json":
        raise HTTPException(422, "Ungültiger Name.")
    return OUTPUT / datei


def save_output_meta(datei: str, meta: dict) -> None:
    ziel = OUTPUT / (Path(datei).stem + ".json")
    tmp = ziel.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta))
    tmp.replace(ziel)


async def output_meta(datei: str) -> dict:
    pfad = output_datei(datei)
    seite = OUTPUT / (pfad.stem + ".json")
    if seite.exists():
        try:
            return json.loads(seite.read_text())
        except (OSError, ValueError):
            pass
    if not pfad.is_file():
        raise HTTPException(404, "Das Video liegt nicht mehr auf dem Server.")
    meta = {"id": datei, "file": datei, "done": True, "ordner": str(OUTPUT),
            "name": (jobs.get(pfad.stem) or {}).get("name") or datei}
    try:
        meta.update(await probe(pfad, True))
    except HTTPException:
        return meta                                  # unlesbar: dann eben ohne Masse
    save_output_meta(datei, meta)
    return meta


def meta_path(folder: Path, fid: str) -> Path:
    if not ID.match(fid):
        raise HTTPException(404, "Unbekannt.")
    return folder / f"{fid}.json"


def load_meta(folder: Path, fid: str) -> dict:
    p = meta_path(folder, fid)
    if not p.exists():
        raise HTTPException(404, "Datei ist nicht mehr auf dem Server.")
    meta = json.loads(p.read_text())
    # Benutzt: das Aufraeumen verschiebt sich. Angefasst wird nur die
    # Beschreibung, nie die Datei - an deren Zeit erkennt der Browser (ETag,
    # Last-Modified), ob die Stuecke in seinem Speicher noch passen. Aenderte
    # sie sich bei jedem Abruf, verwarf Chrome jedes Stueck und holte den
    # ganzen Clip neu; ueber eine langsame Leitung blieb das Bild minutenlang
    # schwarz.
    now = time.time()
    os.utime(p, (now, now))
    return meta


def save_meta(folder: Path, meta: dict) -> None:
    meta_path(folder, meta["id"]).write_text(json.dumps(meta))


def datei_sha(pfad: Path) -> str:
    sha = hashlib.sha256()
    with open(pfad, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            sha.update(block)
    return sha.hexdigest()


def gleiche_datei(folder: Path, sha: str, size: int, ausser: str = "") -> dict | None:
    """Eine fertig hochgeladene Datei mit dieser Pruefsumme, falls es sie gibt.
    Die Pruefsumme rechnet der Dienst selbst beim Abschliessen; was die Seite
    beim Anmelden nennt, ist nur die Frage danach."""
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        return None
    for pfad in folder.glob("*.json"):
        try:
            meta = json.loads(pfad.read_text())
        except (OSError, ValueError):
            continue
        datei = folder / str(meta.get("file") or "")
        if (meta.get("sha") == sha and meta.get("done") and meta.get("size") == size
                and meta.get("id") != ausser and datei.is_file() and datei.stat().st_size == size):
            return load_meta(folder, meta["id"])
    return None


def umbenennen(folder: Path, meta: dict, name: str) -> dict:
    """Dieselbe Datei, vielleicht unter neuem Namen: es gilt der, unter dem sie
    zuletzt kam - die Tonspur heisst wie das Projekt, das sie gerade braucht."""
    if name and meta.get("name") != name:
        meta["name"] = name
        save_meta(folder, meta)
    return meta


# ====================== Hochladen in Stuecken ======================


# einmal: dieselbe Datei liegt nur einmal da. Fuer die Tonspuren - die Seite
# laedt vor jedem Video die Sprachausgabe hoch, und aus dem Zwischenspeicher
# des Sprachdienstes kommt derselbe Text als Byte fuer Byte dieselbe Datei.
# Ohne das stuende nach jedem Kodieren eine weitere Kopie in "Auf dem Server".
def upload_routes(kind: str, folder: Path, want_video: bool, limit: int, einmal: bool = False):
    @app.post(f"/api/{kind}", name=f"start_{kind}")
    async def start(request: Request):
        body = await request.json()
        size = int(body.get("size") or 0)
        name = str(body.get("name") or "datei")[:200]
        if size <= 0:
            raise HTTPException(422, "Leere Datei.")
        if size > limit:
            raise HTTPException(413, f"Datei zu groß (höchstens {limit // 1024**2} MB).")
        # Liegt sie schon da, kommt sie gleich fertig zurueck und hochgeladen
        # wird nichts.
        if einmal:
            vorhanden = gleiche_datei(folder, str(body.get("sha") or ""), size)
            if vorhanden:
                return umbenennen(folder, vorhanden, name)
        if shutil.disk_usage(DATA).free < size + FREE_RESERVE:
            raise HTTPException(507, "Nicht genug Speicherplatz auf dem Server.")
        ext = re.sub(r"[^a-z0-9]", "", Path(name).suffix.lower())[:8]
        fid = secrets.token_hex(12)
        meta = {"id": fid, "name": name, "size": size, "file": f"{fid}.{ext or 'bin'}", "done": False}
        (folder / meta["file"]).touch()
        save_meta(folder, meta)
        return meta

    @app.put(f"/api/{kind}/{{fid}}", name=f"part_{kind}")
    async def part(fid: str, offset: int, request: Request):
        meta = load_meta(folder, fid)
        if meta["done"]:
            raise HTTPException(409, "Bereits abgeschlossen.")
        path = folder / meta["file"]
        # Ein wiederholtes Stueck darf dieselbe Stelle noch einmal schreiben.
        if offset < 0 or offset > path.stat().st_size or offset >= meta["size"]:
            raise HTTPException(409, "Stück passt nicht an diese Stelle.")
        written = 0
        with open(path, "r+b") as f:
            f.seek(offset)
            async for chunk in request.stream():
                written += len(chunk)
                if written > MAX_PART or offset + written > meta["size"]:
                    raise HTTPException(413, "Stück zu groß.")
                f.write(chunk)
            f.truncate(offset + written)
        return {"received": offset + written}

    @app.post(f"/api/{kind}/{{fid}}/done", name=f"done_{kind}")
    async def done(fid: str):
        meta = load_meta(folder, fid)
        path = folder / meta["file"]
        if path.stat().st_size != meta["size"]:
            raise HTTPException(409, "Datei unvollständig.")
        try:
            meta.update(await probe(path, want_video))
        except HTTPException:
            remove(folder, fid)
            raise
        if einmal:
            # Auch ohne Pruefsumme von der Seite (die gibt es nur ueber HTTPS)
            # bleibt am Ende nur eine Kopie liegen.
            meta["sha"] = await asyncio.to_thread(datei_sha, path)
            vorhanden = gleiche_datei(folder, meta["sha"], meta["size"], ausser=fid)
            if vorhanden:
                remove(folder, fid)
                return umbenennen(folder, vorhanden, meta["name"])
        meta["done"] = True
        save_meta(folder, meta)
        return meta

    @app.get(f"/api/{kind}/{{fid}}", name=f"get_{kind}")
    async def get(fid: str):
        return load_meta(folder, fid)

    # Die hochgeladene Datei zurueck, damit das Schnittfenster der Seite sie
    # abspielen kann. Ohne Dateinamen im Kopf, sonst laedt der Browser sie
    # herunter statt sie zu zeigen. Den Bereichsabruf (Range), ohne den kein
    # Springen im Video moeglich waere, beantwortet FileResponse von selbst.
    @app.get(f"/api/{kind}/{{fid}}/file", name=f"file_{kind}")
    async def file(fid: str):
        meta = load_meta(folder, fid)
        path = folder / meta["file"]
        if not meta.get("done") or not path.exists():
            raise HTTPException(404, "Datei ist nicht mehr auf dem Server.")
        guess, _ = mimetypes.guess_type(meta["name"])
        fallback = "video/mp4" if want_video else "audio/wav"
        # Unter einer Kennung aendert sich nichts mehr, sobald sie fertig
        # hochgeladen ist. Der Browser darf behalten, was er einmal geholt hat,
        # auch ueber das Neuladen hinweg; "private", weil die Anmeldung davor
        # steht und kein Zwischenlager es sehen soll.
        return FileResponse(path, media_type=guess or fallback,
                            headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.delete(f"/api/{kind}/{{fid}}", name=f"delete_{kind}")
    async def delete(fid: str):
        meta_path(folder, fid)
        remove(folder, fid)
        return {"ok": True}


def remove(folder: Path, fid: str) -> None:
    p = folder / f"{fid}.json"
    if p.exists():
        try:
            (folder / json.loads(p.read_text())["file"]).unlink(missing_ok=True)
        except (ValueError, KeyError):
            pass
        p.unlink(missing_ok=True)


upload_routes("clips", CLIPS, True, MAX_UPLOAD)
upload_routes("voices", VOICES, False, 1024**3, einmal=True)


# ====================== Befehl bauen ======================


def fmt_num(x: float) -> str:
    return f"{x:.6f}".rstrip("0").rstrip(".")


def filter_pfad(pfad: str) -> str:
    """Ein Dateiname im Filtergraphen: Doppelpunkt, Komma und Backslash trennen
    dort Filter und Optionen und muessen ihre Bedeutung verlieren."""
    raus = pfad
    for zeichen in ("\\", ":", ",", ";", "[", "]", "'"):
        raus = raus.replace(zeichen, "\\" + zeichen)
    return raus


def build_command(clips: list[dict], voice: dict | None, p: dict, out: Path, ass: Path | None = None) -> list[str]:
    n = len(clips)
    args = ["nice", "-n", "10", "ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
            "-progress", "pipe:1", "-nostats"]
    for c in clips:
        cut = c["cut"]
        laenge = cut["end"] - cut["start"]
        # Vor "-i" gesucht: ffmpeg springt dann hin, statt alles davor zu
        # decodieren und wegzuwerfen. Bei einem langen Clip ist das der
        # Unterschied zwischen Sekunden und Minuten.
        if cut["start"] > 0:
            args += ["-ss", fmt_num(cut["start"])]
        if laenge < cut["source_duration"] - 0.001:
            args += ["-t", fmt_num(laenge)]
        args += ["-i", str(Path(c.get("ordner") or CLIPS) / c["file"])]
    if voice:
        args += ["-i", str(VOICES / voice["file"])]

    W, H, fps, T, D = p["width"], p["height"], fmt_num(p["fps"]), p["transition"], p["duration"]
    still = p.get("still_seconds") or 0.0
    use_clip_audio = p["clip_audio"] > 0
    graph = []
    # Fehlendes Bild entsteht durch Halten des letzten Bildes. Das geschieht am
    # letzten Clip selbst: hinter xfade verlaengert tpad in ffmpeg 5.1 nicht.
    hold = max(0.0, D - p["video_seconds"]) + 1.0

    # Jeder Clip auf gleiche Groesse, Bildrate und Zeitbasis; nur dann lassen
    # sich die Stuecke verketten oder ueberblenden.
    for i, c in enumerate(clips):
        cut = c["cut"]
        laenge = cut["end"] - cut["start"]               # der Ausschnitt, wie er hereinkommt
        d = fmt_num(laenge)
        vorne, stuecke = cut_pieces(cut, p["fps"])
        k = len(stuecke)
        # Ein einziges Stueck, das den ganzen Ausschnitt abdeckt, braucht weder
        # Teilen noch Zusammensetzen. Fehlt vorn oder hinten etwas, geht es den
        # allgemeinen Weg - sonst kaeme das Herausgeschnittene mit ins Bild.
        einfach = k == 1 and stuecke[0][0] <= 1e-6 and stuecke[0][1] >= laenge - 1e-6
        if i == 0:
            vorne += still                               # Vorspann: das erste Bild steht
        schwanz = (hold + still) if i == n - 1 else 0.0   # Nachspann und das Halten am Ende

        # Ein Standbild ist nichts anderes als ein geklontes letztes Bild:
        # tpad haelt es fuer die gewuenschte Zeit an. Dafuer wird der Clip an
        # den Haltestellen zerlegt und danach wieder zusammengesetzt.
        def tpad_filter(vor: float, nach: float) -> str:
            teile = []
            if vor > 0:
                teile.append(f"start_mode=clone:start_duration={fmt_num(vor)}")
            if nach > 0:
                teile.append(f"stop_mode=clone:stop_duration={fmt_num(nach)}")
            return (",tpad=" + ":".join(teile)) if teile else ""

        kopf = (f"[{i}:v]setpts=PTS-STARTPTS,scale={W}:{H}:force_original_aspect_ratio=decrease,"
                f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p,"
                f"trim=duration={d},setpts=PTS-STARTPTS")
        if einfach:
            graph.append(kopf + tpad_filter(vorne, stuecke[0][2] + schwanz) + f",settb=AVTB[v{i}]")
        else:
            graph.append(kopf + f"[b{i}]")
            graph.append(f"[b{i}]split={k}" + "".join(f"[s{i}_{j}]" for j in range(k)))
            for j, (von, bis, halten) in enumerate(stuecke):
                graph.append(f"[s{i}_{j}]trim=start={fmt_num(von)}:end={fmt_num(bis)},setpts=PTS-STARTPTS"
                             + tpad_filter(vorne if j == 0 else 0.0, halten + (schwanz if j == k - 1 else 0.0))
                             + f",settb=AVTB[p{i}_{j}]")
            graph.append("".join(f"[p{i}_{j}]" for j in range(k)) + f"concat=n={k}:v=1:a=0[v{i}]")

        if use_clip_audio:
            src = f"[{i}:a]asetpts=PTS-STARTPTS," if c.get("has_audio") else "anullsrc=r=48000:cl=stereo,"
            akopf = (f"{src}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                     f"apad=whole_dur={d},atrim=duration={d}")
            # Waehrend das Bild steht, schweigt der Originalton - sonst liefe er
            # dem Bild davon und alles Folgende laege daneben.
            if einfach and not vorne:
                halten = stuecke[0][2]
                graph.append(akopf + (f",apad=pad_dur={fmt_num(halten)}" if halten else "") + f"[a{i}]")
            else:
                graph.append(akopf + f"[ab{i}]")
                graph.append(f"[ab{i}]asplit={k}" + "".join(f"[as{i}_{j}]" for j in range(k)))
                for j, (von, bis, halten) in enumerate(stuecke):
                    zeile = f"[as{i}_{j}]atrim=start={fmt_num(von)}:end={fmt_num(bis)},asetpts=PTS-STARTPTS"
                    if j == 0 and vorne:
                        zeile += f",adelay=delays={int(round(vorne * 1000))}:all=1"
                    if halten:
                        zeile += f",apad=pad_dur={fmt_num(halten)}"
                    graph.append(zeile + f"[ap{i}_{j}]")
                graph.append("".join(f"[ap{i}_{j}]" for j in range(k)) + f"concat=n={k}:v=0:a=1[a{i}]")

    if n == 1:
        graph.append("[v0]null[vcat]")
        if use_clip_audio:
            graph.append("[a0]anull[acat]")
    elif not T:
        if use_clip_audio:
            graph.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vcat][acat]")
        else:
            graph.append("".join(f"[v{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=0[vcat]")
    else:
        prev_v, prev_a, offset = "v0", "a0", 0.0
        for i in range(1, n):
            offset += clips[i - 1]["duration"] - T
            nv = "vcat" if i == n - 1 else f"x{i}"
            graph.append(f"[{prev_v}][v{i}]xfade=transition=fade:duration={fmt_num(T)}:offset={fmt_num(offset)}[{nv}]")
            prev_v = nv
            if use_clip_audio:
                na = "acat" if i == n - 1 else f"y{i}"
                graph.append(f"[{prev_a}][a{i}]acrossfade=d={fmt_num(T)}[{na}]")
                prev_a = na

    graph.append(f"[vcat]trim=duration={fmt_num(D)}[vout]")
    bild = "vout"
    if ass:
        # Eingebrannt wird zuletzt, auf dem fertig zusammengesetzten Bild -
        # sonst liefen die Einblendungen durch eine Ueberblendung mit.
        graph.append(f"[vout]ass=filename={filter_pfad(str(ass))}[vsub]")
        bild = "vsub"

    mix = None
    if voice:
        delay = int(round((p["voice_offset"] + still) * 1000))
        graph.append(f"[{n}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                     f"adelay=delays={delay}:all=1[voice]")
        mix = "voice"
    if use_clip_audio:
        graph.append(f"[acat]volume={fmt_num(p['clip_audio'])}[orig]")
        if mix:
            graph.append("[voice][orig]amix=inputs=2:duration=longest:normalize=0[mix]")
            mix = "mix"
        else:
            mix = "orig"
    if mix:
        graph.append(f"[{mix}]apad=whole_dur={fmt_num(D)},atrim=duration={fmt_num(D)}[aout]")

    args += ["-filter_complex", ";".join(graph), "-map", f"[{bild}]"]
    if mix:
        args += ["-map", "[aout]"]

    kbps, codec, preset = p["video_kbps"], p["codec"], PRESETS[p["codec"]][p["speed"]]
    gop = str(max(1, round(p["fps"] * 2)))
    rate = ["-b:v", f"{kbps}k", "-maxrate", f"{int(kbps * 1.5)}k", "-bufsize", f"{kbps * 3}k"]
    if codec == "h264":
        args += ["-c:v", "libx264", "-preset", preset, *rate, "-profile:v", "high", "-g", gop,
                 "-threads", str(THREADS)]
    elif codec == "hevc":
        args += ["-c:v", "libx265", "-preset", preset, *rate, "-tag:v", "hvc1", "-g", gop,
                 "-x265-params", f"pools={THREADS}:log-level=error"]
    else:
        args += ["-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", preset, "-b:v", f"{kbps}k",
                 "-row-mt", "1", "-threads", str(THREADS), "-g", gop]
    args += ["-pix_fmt", "yuv420p", "-r", fps]
    if mix:
        if CODECS[codec]["audio"] == "aac":
            args += ["-c:a", "aac", "-b:a", f"{p['audio_kbps']}k"]
        else:
            args += ["-c:a", "libopus", "-b:a", f"{p['audio_kbps']}k"]
    if CODECS[codec]["ext"] == "mp4":
        args += ["-movflags", "+faststart"]
    args.append(str(out))
    return args


# ====================== Auftraege ======================

jobs: dict[str, dict] = {}
procs: dict[str, asyncio.subprocess.Process] = {}
queue: asyncio.Queue[str] = asyncio.Queue()


def public(job: dict) -> dict:
    return {k: v for k, v in job.items() if k not in ("command", "clips", "voice")}


def download_name(roh, ext: str) -> str:
    """Wie das fertige Video beim Herunterladen heisst. Die Seite schickt den
    Namen des Projekts mit Vorsatz; hier fallen nur die Zeichen weg, die kein
    Dateisystem mag. Ohne Namen heisst es wie bisher "video"."""
    name = re.sub(r'[\x00-\x1f\\/:*?"<>|]+', " ", str(roh or ""))
    name = re.sub(r"\s+", " ", name).strip()[:NAME_MAX].rstrip(". ")
    return f"{name or 'video'}.{ext}"


@app.post("/api/jobs")
async def create_job(request: Request):
    body = await request.json()
    ids = clip_ids(body)
    if not ids or len(ids) > 100:
        raise HTTPException(422, "Zwischen 1 und 100 Clips.")
    # Zusammengefuegt werden auch fertige Videos. Dann stehen im Auftrag ihre
    # Dateinamen statt der Kennungen hochgeladener Clips.
    quelle = str(body.get("source") or "clips")
    if quelle == "output":
        clips = [await output_meta(i) for i in ids]
    elif quelle == "clips":
        clips = [load_meta(CLIPS, i) for i in ids]
    else:
        raise HTTPException(422, f"Unbekannte Quelle: {quelle!r}")
    if not all(c.get("done") for c in clips):
        raise HTTPException(409, "Ein Clip ist noch nicht vollständig hochgeladen.")
    # Derselbe Clip kann in zwei Auftraegen anders geschnitten sein: der
    # Schnitt steht im Auftrag, nicht in der hochgeladenen Datei.
    for c, spec in zip(clips, cut_specs(body)):
        c["cut"] = clip_cut(spec, c)
        c["duration"] = c["cut"]["duration"]
    voice = load_meta(VOICES, str(body["voice"])) if body.get("voice") else None
    if voice and not voice.get("done"):
        raise HTTPException(409, "Die Sprachausgabe ist noch nicht vollständig hochgeladen.")
    p = make_plan(clips, body.get("options", {}), voice["duration"] if voice else None)

    jid = secrets.token_hex(12)
    out = OUTPUT / f"{jid}.{p['ext']}"

    # Die Einblendungen kommen fertig aus der Seite - sie kennt zu jedem
    # Abschnitt seine Stelle auf der Tonspur. Hier wird daraus eine ASS-Datei
    # neben dem Video, die ffmpeg beim Kodieren ins Bild brennt.
    cues = sub_cues(body) if p["subtitles"]["on"] else []
    ass = None
    if cues:
        ass = OUTPUT / f"{jid}.ass"
        # Gemessen wird jede Zeile - bei zweitausend Einblendungen nicht im Takt
        # der anderen Anfragen.
        inhalt = await asyncio.to_thread(build_ass, cues, p["subtitles"], p["width"], p["height"])
        ass.write_text(inhalt, encoding="utf-8")
    p["subtitle_cues"] = len(cues)

    job = {"id": jid, "name": download_name(body.get("name"), p["ext"]),
           "status": "queued", "progress": 0.0, "eta": None, "size": 0,
           "plan": p, "error": None, "created": time.time(), "started": None, "finished": None,
           "clips": clips, "voice": voice, "command": build_command(clips, voice, p, out, ass),
           "file": out.name, "ass": ass.name if ass else None}
    jobs[jid] = job
    await queue.put(jid)
    return public(job)


def get_job(jid: str) -> dict:
    job = jobs.get(jid) if ID.match(jid) else None
    if not job:
        raise HTTPException(404, "Auftrag unbekannt — vielleicht wurde der Dienst neu gestartet.")
    return job


@app.get("/api/jobs/{jid}")
async def job_status(jid: str):
    job = get_job(jid)
    if job["status"] == "queued":
        waiting = [j for j in jobs.values() if j["status"] in ("queued", "running")]
        job["ahead"] = sum(1 for j in waiting if j["created"] < job["created"])
    return public(job)


@app.delete("/api/jobs/{jid}")
async def cancel_job(jid: str):
    job = get_job(jid)
    if job["status"] in ("queued", "running"):
        job["status"] = "cancelled"
        proc = procs.get(jid)
        if proc and proc.returncode is None:
            proc.terminate()
    (OUTPUT / job["file"]).unlink(missing_ok=True)
    if job.get("ass"):
        (OUTPUT / job["ass"]).unlink(missing_ok=True)
    return public(job)


@app.get("/api/jobs/{jid}/file")
async def job_file(jid: str):
    job = get_job(jid)
    path = OUTPUT / job["file"]
    if job["status"] != "done" or not path.exists():
        raise HTTPException(404, "Video ist nicht (mehr) vorhanden.")
    return FileResponse(path, media_type=CODECS[job["plan"]["codec"]]["mime"], filename=job["name"])


async def run_job(job: dict) -> None:
    out = OUTPUT / job["file"]
    duration = job["plan"]["duration"]
    job["status"], job["started"] = "running", time.time()
    log = OUTPUT / f"{job['id']}.log"
    with open(log, "wb") as err:
        proc = await asyncio.create_subprocess_exec(*job["command"], stdout=asyncio.subprocess.PIPE, stderr=err)
        procs[job["id"]] = proc
        assert proc.stdout
        async for raw in proc.stdout:
            key, _, value = raw.decode(errors="replace").strip().partition("=")
            if key == "out_time_us" and value.lstrip("-").isdigit():
                done = max(0.0, int(value) / 1e6)
                job["progress"] = min(0.999, done / duration) if duration else 0.0
                elapsed = time.time() - job["started"]
                if job["progress"] > 0.01:
                    job["eta"] = elapsed * (1 - job["progress"]) / job["progress"]
            elif key == "total_size" and value.isdigit():
                job["size"] = int(value)
        await proc.wait()
    procs.pop(job["id"], None)
    job["finished"] = time.time()
    if job["status"] == "cancelled":
        out.unlink(missing_ok=True)
    elif proc.returncode == 0 and out.exists():
        job.update(status="done", progress=1.0, eta=0, size=out.stat().st_size)
        # Neben das fertige Video, was es ist: so heisst es auch nach einem
        # Neustart noch so, und zusammenfuegen laesst es sich ohne Nachmessen.
        p = job["plan"]
        meta = {"id": out.name, "file": out.name, "done": True, "ordner": str(OUTPUT),
                "name": job["name"], "width": p["width"], "height": p["height"], "fps": p["fps"],
                "duration": p["duration"], "still_seconds": p["still_seconds"],
                "has_audio": bool(p["audio_kbps"])}
        try:
            meta.update(await probe(out, True))       # gemessen ist besser als geplant
        except HTTPException:
            pass
        save_output_meta(out.name, meta)
    else:
        job["status"] = "failed"
        job["error"] = log.read_text(errors="replace")[-1500:].strip() or f"ffmpeg endete mit Code {proc.returncode}"
        out.unlink(missing_ok=True)
    log.unlink(missing_ok=True)


async def worker() -> None:
    while True:
        jid = await queue.get()
        job = jobs.get(jid)
        if job and job["status"] == "queued":
            try:
                await run_job(job)
            except Exception as e:  # noqa: BLE001 - der Dienst soll weiterlaufen
                job.update(status="failed", error=repr(e), finished=time.time())


async def cleanup() -> None:
    if KEEP_HOURS <= 0:
        return                                  # aufgeraeumt wird nur von Hand
    while True:
        limit = time.time() - KEEP_HOURS * 3600
        # Clips und Tonspuren gehen paarweise: massgeblich ist die
        # Beschreibung, denn nur sie wird beim Gebrauch angefasst.
        for folder in (CLIPS, VOICES):
            for meta in folder.glob("*.json"):
                try:
                    if meta.stat().st_mtime < limit:
                        remove(folder, meta.stem)
                except FileNotFoundError:
                    pass
        for f in OUTPUT.iterdir():
            try:
                if f.stat().st_mtime < limit:
                    f.unlink()
            except FileNotFoundError:
                pass
        for jid, job in list(jobs.items()):
            if job["finished"] and job["finished"] < limit:
                jobs.pop(jid, None)
        await asyncio.sleep(1800)


@app.on_event("startup")
async def startup() -> None:
    for folder in (CLIPS, VOICES, OUTPUT, TEXTS):
        folder.mkdir(parents=True, exist_ok=True)
    # Reste eines abgebrochenen Laufs; die zugehoerigen Auftraege sind weg.
    for f in OUTPUT.iterdir():
        f.unlink(missing_ok=True)
    asyncio.create_task(worker())
    asyncio.create_task(cleanup())
