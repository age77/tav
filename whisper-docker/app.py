"""Abschriftdienst fuer die Kokoro-Weboberflaeche.

Nimmt ein Video oder eine Tonaufnahme entgegen, loest den Ton mit ffmpeg
heraus und schreibt ihn mit Whisper mit (faster-whisper auf der CPU).
Zurueck kommen Abschnitte mit Zeitmarken; Text, SRT und VTT setzt die Seite
daraus selbst zusammen, damit sich die Textform ohne neuen Lauf aendern laesst.
Dazu kommen die Stellen, an denen gesprochen wird - danach richtet die Seite
die Saetze aus, wenn ein Film neu vertont wird.

Hochgeladen wird in Stuecken, weil Traefik jede Anfrage nach 60 Sekunden
Lesezeit abbricht. Auftraege laufen nacheinander und mit niedriger Prioritaet,
damit Sprachsynthese und Home Assistant auf demselben Rechner fluessig bleiben.
Alle Dateien sind voruebergehend und verschwinden nach WHISPER_KEEP_HOURS.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request

DATA = Path(os.getenv("WHISPER_DATA", "/data"))
MEDIA = DATA / "media"
WORK = DATA / "work"
THREADS = max(1, int(os.getenv("WHISPER_THREADS", "4")))
COMPUTE = os.getenv("WHISPER_COMPUTE", "int8")
# 0 heisst: nichts verschwindet von selbst; geloescht wird in der Seite.
KEEP_HOURS = float(os.getenv("WHISPER_KEEP_HOURS", "24"))
MAX_UPLOAD = int(float(os.getenv("WHISPER_MAX_UPLOAD_GB", "8")) * 1024**3)
MAX_PART = 64 * 1024**2
PART_SIZE = 32 * 1024**2
FREE_RESERVE = 2 * 1024**3
# Das geladene Modell belegt je nach Groesse einige hundert Megabyte. Wird
# eine Weile nichts mitgeschrieben, gibt der Dienst den Speicher wieder frei.
IDLE_SECONDS = max(0.0, float(os.getenv("WHISPER_IDLE_MINUTES", "30")) * 60)

ID = re.compile(r"^[0-9a-f]{24}$")

app = FastAPI()


# ====================== Auswahl ======================

# Label und ungefaehre Downloadgroesse in MB. Das Modell wird beim ersten
# Gebrauch von Hugging Face geholt und liegt danach im Volume unter /models.
MODEL_INFO = {
    "tiny": ("Winzig — sehr schnell, nur für saubere Aufnahmen", 75),
    "base": ("Klein — schnell", 145),
    "small": ("Mittel — guter Kompromiss", 490),
    "medium": ("Groß — genauer, deutlich langsamer", 1530),
    "large-v3-turbo": ("Turbo — fast so genau wie sehr groß, schneller", 1620),
    "large-v3": ("Sehr groß — am genauesten, sehr langsam", 3090),
}

MODELS = [m.strip() for m in os.getenv("WHISPER_MODELS", "tiny,base,small").split(",") if m.strip()] or ["small"]
DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "small")
if DEFAULT_MODEL not in MODELS:
    DEFAULT_MODEL = MODELS[0]

LANGUAGES = [
    ("auto", "Automatisch erkennen"), ("de", "Deutsch"), ("en", "Englisch"), ("fr", "Französisch"),
    ("es", "Spanisch"), ("it", "Italienisch"), ("nl", "Niederländisch"), ("pl", "Polnisch"),
    ("pt", "Portugiesisch"), ("ru", "Russisch"), ("tr", "Türkisch"), ("uk", "Ukrainisch"),
    ("cs", "Tschechisch"), ("da", "Dänisch"), ("sv", "Schwedisch"), ("no", "Norwegisch"),
    ("fi", "Finnisch"), ("ro", "Rumänisch"), ("hu", "Ungarisch"), ("el", "Griechisch"),
    ("ar", "Arabisch"), ("zh", "Chinesisch"), ("ja", "Japanisch"), ("ko", "Koreanisch"),
]

TASKS = [("transcribe", "Mitschreiben — Sprache so lassen"), ("translate", "Ins Englische übersetzen")]

# Mehr Suchpfade heissen bessere Wortwahl und laengere Laufzeit.
SPEEDS = [("fast", "Schnell"), ("balanced", "Ausgewogen"), ("thorough", "Gründlich")]
BEAM = {"fast": 1, "balanced": 3, "thorough": 5}

MAX_HINT = 400


def model_label(name: str) -> str:
    label, mb = MODEL_INFO.get(name, (name, 0))
    return f"{label} · {mb} MB" if mb else label


def engine_info() -> dict:
    """Was hier wirklich rechnet - die Seite zeigt es hinter der Marke
    "Whisper AI". Die Fassungen werden beim Aufruf gelesen, damit nach einem
    neuen Bau nichts Veraltetes stehen bleibt."""
    from importlib.metadata import PackageNotFoundError, version

    def fassung(paket: str) -> str:
        try:
            return version(paket)
        except PackageNotFoundError:
            return ""

    ct2 = fassung("ctranslate2")
    return {
        "name": "faster-whisper",
        "version": fassung("faster-whisper"),
        "runtime": f"CTranslate2 {ct2}" if ct2 else "",
        "model": model_label(DEFAULT_MODEL),
        "compute": COMPUTE,
        "device": f"CPU, {THREADS} Rechenf\u00e4den",
    }


@app.get("/api/info")
async def info():
    return {
        "engine": engine_info(),
        "models": [{"id": m, "label": model_label(m)} for m in MODELS],
        "languages": [{"id": k, "label": label} for k, label in LANGUAGES],
        "tasks": [{"id": k, "label": label} for k, label in TASKS],
        "speeds": [{"id": k, "label": label} for k, label in SPEEDS],
        "default_model": DEFAULT_MODEL,
        "max_upload": MAX_UPLOAD,
        "part_size": PART_SIZE,
        "max_hint": MAX_HINT,
    }


def pick(value, choices, name):
    for c in choices:
        if c[0] == value:
            return c[0]
    raise HTTPException(422, f"Ungültiger Wert für {name}: {value!r}")


def make_options(o: dict) -> dict:
    model = str(o.get("model") or DEFAULT_MODEL)
    if model not in MODELS:
        raise HTTPException(422, f"Unbekanntes Modell: {model!r}")
    return {
        "model": model,
        "language": pick(str(o.get("language") or "auto"), LANGUAGES, "Sprache"),
        "task": pick(str(o.get("task") or "transcribe"), TASKS, "Aufgabe"),
        "speed": pick(str(o.get("speed") or "balanced"), SPEEDS, "Genauigkeit"),
        "vad": bool(o.get("vad", True)),
        "hint": str(o.get("hint") or "").strip()[:MAX_HINT],
    }


# ====================== Hilfen ======================


async def run(*args: str) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    return proc.returncode, out, err


async def probe(path: Path) -> dict:
    rc, out, _ = await run("ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path))
    if rc:
        raise HTTPException(422, "Datei lässt sich nicht lesen.")
    data = json.loads(out or b"{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    if not audio:
        raise HTTPException(422, "Datei enthält keine Tonspur.")
    duration = float(fmt.get("duration") or audio.get("duration") or 0)
    if duration <= 0:
        raise HTTPException(422, "Datei ohne lesbare Dauer.")
    return {"duration": duration, "acodec": audio.get("codec_name"),
            "channels": int(audio.get("channels") or 0), "has_video": video is not None}


def meta_path(fid: str) -> Path:
    if not ID.match(fid):
        raise HTTPException(404, "Unbekannt.")
    return MEDIA / f"{fid}.json"


def load_meta(fid: str) -> dict:
    p = meta_path(fid)
    if not p.exists():
        raise HTTPException(404, "Datei ist nicht mehr auf dem Server.")
    meta = json.loads(p.read_text())
    now = time.time()
    for f in (p, MEDIA / meta["file"]):
        if f.exists():
            os.utime(f, (now, now))                     # benutzt: Aufraeumen verschieben
    return meta


def save_meta(meta: dict) -> None:
    meta_path(meta["id"]).write_text(json.dumps(meta))


def remove(fid: str) -> None:
    p = MEDIA / f"{fid}.json"
    if p.exists():
        try:
            (MEDIA / json.loads(p.read_text())["file"]).unlink(missing_ok=True)
        except (ValueError, KeyError):
            pass
        p.unlink(missing_ok=True)


# ====================== Hochladen in Stuecken ======================


# Was hier liegt, zeigt die Seite in ihrem Bereich "Auf dem Server" - dieselbe
# Auskunft wie beim Videodienst, damit beide dort nebeneinander stehen koennen.
@app.get("/api/storage")
async def storage():
    MEDIA.mkdir(parents=True, exist_ok=True)
    eintraege = []
    for f in MEDIA.glob("*.json"):
        try:
            meta = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        datei = MEDIA / meta.get("file", "")
        eintraege.append({"id": meta.get("id"), "name": meta.get("name"),
                          "size": datei.stat().st_size if datei.exists() else 0,
                          "created": f.stat().st_mtime, "done": bool(meta.get("done")),
                          "duration": meta.get("duration"), "used": 0})
    eintraege.sort(key=lambda e: e.get("created") or 0, reverse=True)
    platte = shutil.disk_usage(DATA)
    return {"items": {"media": eintraege}, "free": platte.free, "total": platte.total,
            "used": sum(e["size"] for e in eintraege), "keep_hours": KEEP_HOURS}


@app.delete("/api/storage/media/{fid}")
async def delete_storage(fid: str):
    remove(fid)
    return {"ok": True}


@app.post("/api/media")
async def start_media(request: Request):
    body = await request.json()
    size = int(body.get("size") or 0)
    name = str(body.get("name") or "datei")[:200]
    if size <= 0:
        raise HTTPException(422, "Leere Datei.")
    if size > MAX_UPLOAD:
        raise HTTPException(413, f"Datei zu groß (höchstens {MAX_UPLOAD // 1024**2} MB).")
    if shutil.disk_usage(DATA).free < size + FREE_RESERVE:
        raise HTTPException(507, "Nicht genug Speicherplatz auf dem Server.")
    ext = re.sub(r"[^a-z0-9]", "", Path(name).suffix.lower())[:8]
    fid = secrets.token_hex(12)
    meta = {"id": fid, "name": name, "size": size, "file": f"{fid}.{ext or 'bin'}", "done": False}
    (MEDIA / meta["file"]).touch()
    save_meta(meta)
    return meta


@app.put("/api/media/{fid}")
async def part_media(fid: str, offset: int, request: Request):
    meta = load_meta(fid)
    if meta["done"]:
        raise HTTPException(409, "Bereits abgeschlossen.")
    path = MEDIA / meta["file"]
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


@app.post("/api/media/{fid}/done")
async def done_media(fid: str):
    meta = load_meta(fid)
    path = MEDIA / meta["file"]
    if path.stat().st_size != meta["size"]:
        raise HTTPException(409, "Datei unvollständig.")
    try:
        meta.update(await probe(path))
    except HTTPException:
        remove(fid)
        raise
    meta["done"] = True
    save_meta(meta)
    return meta


@app.get("/api/media/{fid}")
async def get_media(fid: str):
    return load_meta(fid)


@app.delete("/api/media/{fid}")
async def delete_media(fid: str):
    meta_path(fid)
    remove(fid)
    return {"ok": True}


# ====================== Modell ======================

# Ein Auftrag nach dem anderen, darum genuegt ein einziges geladenes Modell.
_model = None
_model_name: str | None = None
_model_used = 0.0


def get_model(name: str):
    """Laedt das Modell beim ersten Gebrauch. Der Wechsel auf ein anderes gibt
    das alte zuerst frei, damit nie zwei gleichzeitig im Speicher liegen."""
    global _model, _model_name, _model_used
    _model_used = time.time()
    if _model is not None and _model_name == name:
        return _model
    from faster_whisper import WhisperModel

    _model, _model_name = None, None
    _model = WhisperModel(name, device="cpu", compute_type=COMPUTE, cpu_threads=THREADS, num_workers=1)
    _model_name = name
    _model_used = time.time()
    return _model


def drop_model() -> None:
    global _model, _model_name
    _model, _model_name = None, None


# ====================== Mitschreiben ======================


class Cancelled(Exception):
    pass


def transcribe_blocking(job: dict, wav: Path) -> None:
    """Laeuft in einem eigenen Faden, weil faster-whisper blockierend rechnet.
    Die Abschnitte werden einzeln angehaengt, damit die Seite schon waehrend
    des Laufs mitlesen kann."""
    o = job["options"]
    model = get_model(o["model"])
    segments, detected = model.transcribe(
        str(wav),
        language=None if o["language"] == "auto" else o["language"],
        task=o["task"],
        beam_size=BEAM[o["speed"]],
        best_of=BEAM[o["speed"]],
        vad_filter=o["vad"],
        initial_prompt=o["hint"] or None,
        # Ohne das schaukeln sich Wiederholungen auf langen Aufnahmen auf.
        condition_on_previous_text=False,
    )
    job["language"] = detected.language
    job["language_probability"] = round(float(detected.language_probability or 0), 3)
    total = job["duration"] or float(detected.duration or 0)

    for s in segments:
        if job["status"] == "cancelled":
            raise Cancelled
        text = s.text.strip()
        if text:
            job["segments"].append({"start": round(s.start, 3), "end": round(s.end, 3), "text": text})
            job["count"] = len(job["segments"])
        job["progress"] = min(0.999, s.end / total) if total else 0.0
        elapsed = time.time() - job["started"]
        if job["progress"] > 0.01:
            job["eta"] = elapsed * (1 - job["progress"]) / job["progress"]
        global _model_used
        _model_used = time.time()


# Wo in der Aufnahme gesprochen wird, laut der Stilleerkennung, die
# faster-whisper mitbringt (Silero). Mitgeschrieben wird davon unabhaengig -
# "Stille ueberspringen" bleibt, wie es eingestellt ist. Die Seite braucht es
# zum Neuvertonen: nach einer Stille legt Whisper den Anfang eines Abschnitts
# gern bis zu anderthalb Sekunden zu frueh, und Martin setzte dann ein, bevor im
# Film wieder gesprochen wird. Kurze Stillen zaehlen mit, damit auch der
# Anfang eines Satzes mitten in einem Abschnitt zu finden ist.
SPEECH_VAD = {"min_silence_duration_ms": 250, "speech_pad_ms": 100}


def speech_spans(wav: Path) -> list[list[float]]:
    import wave

    import numpy as np
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    with wave.open(str(wav)) as w:
        rate = w.getframerate()
        audio = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    spans = get_speech_timestamps(audio, VadOptions(**SPEECH_VAD), sampling_rate=rate)
    return [[round(s["start"] / rate, 3), round(s["end"] / rate, 3)] for s in spans]


# ====================== Auftraege ======================

jobs: dict[str, dict] = {}
procs: dict[str, asyncio.subprocess.Process] = {}
queue: asyncio.Queue[str] = asyncio.Queue()

# Abschnitte und Sprechstellen koennen lang werden; sie holt die Seite
# getrennt, die Abschnitte nur, soweit sie neu hinzugekommen sind.
HIDDEN = ("segments", "speech", "media", "log")


def public(job: dict) -> dict:
    return {k: v for k, v in job.items() if k not in HIDDEN}


@app.post("/api/jobs")
async def create_job(request: Request):
    body = await request.json()
    media = load_meta(str(body.get("media") or ""))
    if not media.get("done"):
        raise HTTPException(409, "Die Datei ist noch nicht vollständig hochgeladen.")
    options = make_options(body.get("options", {}))

    jid = secrets.token_hex(12)
    job = {"id": jid, "status": "queued", "stage": "queued", "progress": 0.0, "eta": None,
           "count": 0, "language": None, "language_probability": None,
           "duration": media["duration"], "name": media["name"], "options": options,
           "error": None, "created": time.time(), "started": None, "finished": None,
           "media": media, "segments": [], "speech": []}
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


@app.get("/api/jobs/{jid}/segments")
async def job_segments(jid: str, start: int = 0):
    job = get_job(jid)
    start = max(0, start)
    return {"start": start, "count": len(job["segments"]), "segments": job["segments"][start:]}


@app.get("/api/jobs/{jid}/speech")
async def job_speech(jid: str):
    """Die Stellen, an denen gesprochen wird, in Sekunden: [[von, bis], ...]."""
    return {"speech": get_job(jid)["speech"]}


@app.delete("/api/jobs/{jid}")
async def cancel_job(jid: str):
    job = get_job(jid)
    if job["status"] in ("queued", "running"):
        job["status"] = "cancelled"
        proc = procs.get(jid)
        if proc and proc.returncode is None:
            proc.terminate()
    return public(job)


async def run_job(job: dict) -> None:
    job["status"], job["started"], job["stage"] = "running", time.time(), "audio"
    wav = WORK / f"{job['id']}.wav"
    src = MEDIA / job["media"]["file"]
    try:
        # Whisper rechnet ohnehin mit 16 kHz Mono; ffmpeg liefert das aus jedem
        # Container und aendert dabei nichts am Inhalt.
        args = ["nice", "-n", "10", "ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
                "-i", str(src), "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le", str(wav)]
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL,
                                                    stderr=asyncio.subprocess.PIPE)
        procs[job["id"]] = proc
        _, err = await proc.communicate()
        procs.pop(job["id"], None)
        if job["status"] == "cancelled":
            return
        if proc.returncode != 0 or not wav.exists():
            raise RuntimeError(err.decode(errors="replace")[-800:].strip()
                               or f"ffmpeg endete mit Code {proc.returncode}")
        # Dauert eine halbe Sekunde je zwei Minuten Ton. Geht es schief, gelten
        # eben die Zeiten von Whisper - die Abschrift selbst haengt nicht daran.
        try:
            job["speech"] = await asyncio.to_thread(speech_spans, wav)
        except Exception:                   # noqa: BLE001
            job["speech"] = []
        if job["status"] == "cancelled":
            return

        job["stage"] = "model"
        await asyncio.to_thread(get_model, job["options"]["model"])
        if job["status"] == "cancelled":
            return
        job["stage"] = "text"
        await asyncio.to_thread(transcribe_blocking, job, wav)
        job.update(status="done", stage="done", progress=1.0, eta=0)
    except Cancelled:
        pass
    except Exception as e:                  # noqa: BLE001 - der Dienst soll weiterlaufen
        job.update(status="failed", stage="failed", error=str(e) or repr(e))
    finally:
        procs.pop(job["id"], None)
        wav.unlink(missing_ok=True)
        job["finished"] = time.time()
        if job["status"] == "cancelled":
            job["stage"] = "cancelled"


async def worker() -> None:
    while True:
        jid = await queue.get()
        job = jobs.get(jid)
        if job and job["status"] == "queued":
            await run_job(job)


async def cleanup() -> None:
    if KEEP_HOURS <= 0:
        return                                  # aufgeraeumt wird nur von Hand
    while True:
        limit = time.time() - KEEP_HOURS * 3600
        for folder in (MEDIA, WORK):
            for f in folder.iterdir():
                try:
                    if f.stat().st_mtime < limit:
                        f.unlink()
                except FileNotFoundError:
                    pass
        for jid, job in list(jobs.items()):
            if job["finished"] and job["finished"] < limit:
                jobs.pop(jid, None)
        await asyncio.sleep(1800)


async def idle_watch() -> None:
    while True:
        await asyncio.sleep(60)
        if not IDLE_SECONDS or _model is None:
            continue
        busy = any(j["status"] in ("queued", "running") for j in jobs.values())
        if not busy and time.time() - _model_used > IDLE_SECONDS:
            drop_model()


@app.on_event("startup")
async def startup() -> None:
    for folder in (MEDIA, WORK):
        folder.mkdir(parents=True, exist_ok=True)
    # Reste eines abgebrochenen Laufs; die zugehoerigen Auftraege sind weg.
    for f in WORK.iterdir():
        f.unlink(missing_ok=True)
    # Der ganze Dienst rechnet nachrangig: Sprachsynthese und Home Assistant
    # auf demselben Rechner sollen nicht warten muessen.
    try:
        os.nice(10)
    except OSError:
        pass
    asyncio.create_task(worker())
    asyncio.create_task(cleanup())
    asyncio.create_task(idle_watch())
