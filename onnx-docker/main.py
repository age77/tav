from __future__ import annotations

import hashlib
import io
import json
import os
import secrets
import time
import wave
import re
import asyncio
import multiprocessing
import numpy as np
import onnxruntime as ort
from concurrent.futures import ProcessPoolExecutor
from importlib import metadata
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from kokoro_onnx import Kokoro
from tts_normalizer import normalize_tts_text


# ====================== CONFIG ======================
MODEL_PATH = os.getenv("KOKORO_ONNX_MODEL", "/app/kokoro-martin.onnx")
VOICES_PATH = "/app/voices-martin.npz"
DEFAULT_VOICE = os.getenv("KOKORO_ONNX_VOICE", "martin")
DEFAULT_LANG = os.getenv("KOKORO_ONNX_LANG", "de")
DEFAULT_SPEED = float(os.getenv("KOKORO_ONNX_SPEED", "1.125"))
SAMPLE_RATE = 24000

# Pause aus Docker-Compose laden (Standard: 0.25 Sekunden)
PAUSE_DURATION = float(os.getenv("KOKORO_PAUSE_DURATION", "0.25"))
WORKERS = max(1, int(os.getenv("KOKORO_WORKERS", os.getenv("KOKORO_MAX_WORKERS", "1"))))
WARMUP_TEXT = os.getenv("KOKORO_WARMUP_TEXT", "Hallo.")
ORT_INTRA_OP_THREADS = max(1, int(os.getenv("KOKORO_ONNX_INTRA_OP_THREADS", os.getenv("KOKORO_ONNX_THREADS", "2"))))
ORT_INTER_OP_THREADS = max(1, int(os.getenv("KOKORO_ONNX_INTER_OP_THREADS", "1")))
ORT_EXECUTION_MODE = os.getenv("KOKORO_ONNX_EXECUTION_MODE", "sequential").lower()
ORT_GRAPH_OPT = os.getenv("KOKORO_ONNX_GRAPH_OPT", "all").lower()
ORT_ALLOW_SPINNING = os.getenv("KOKORO_ONNX_ALLOW_SPINNING", "0")

# Ablage fuer die Aussprache-Liste und die gesprochenen Saetze, siehe weiter
# unten. Ein Volume, damit beides einen neuen Bau ueberlebt.
DATA_DIR = Path(os.getenv("KOKORO_DATA", "/data"))
# Obergrenze fuer die gesprochenen Saetze; 0 schaltet den Speicher ab.
CACHE_MAX_BYTES = int(float(os.getenv("KOKORO_CACHE_GB", "4")) * 1024**3)

# ONNX / CPU Optimierung
os.environ.setdefault("OMP_NUM_THREADS", os.getenv("KOKORO_ONNX_THREADS", "1"))
os.environ.setdefault("OPENBLAS_NUM_THREADS", os.getenv("KOKORO_ONNX_THREADS", "1"))
os.environ.setdefault("MKL_NUM_THREADS", os.getenv("KOKORO_ONNX_THREADS", "1"))
os.environ.setdefault("NUMEXPR_NUM_THREADS", os.getenv("KOKORO_ONNX_THREADS", "1"))
os.environ.setdefault("ONNXRUNTIME_EXECUTION_MODE", "PARALLEL")


app = FastAPI()
kokoro: Kokoro | None = None
process_pool: ProcessPoolExecutor | None = None
worker_tts: Kokoro | None = None


# ==================== HELPER FUNKTIONEN ====================


def make_session_options() -> ort.SessionOptions:
    options = ort.SessionOptions()
    options.intra_op_num_threads = ORT_INTRA_OP_THREADS
    options.inter_op_num_threads = ORT_INTER_OP_THREADS

    if ORT_EXECUTION_MODE == "parallel":
        options.execution_mode = ort.ExecutionMode.ORT_PARALLEL
    else:
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

    graph_levels = {
        "disable": ort.GraphOptimizationLevel.ORT_DISABLE_ALL,
        "basic": ort.GraphOptimizationLevel.ORT_ENABLE_BASIC,
        "extended": ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED,
        "all": ort.GraphOptimizationLevel.ORT_ENABLE_ALL,
    }
    options.graph_optimization_level = graph_levels.get(ORT_GRAPH_OPT, ort.GraphOptimizationLevel.ORT_ENABLE_ALL)
    options.add_session_config_entry("session.intra_op.allow_spinning", ORT_ALLOW_SPINNING)
    options.add_session_config_entry("session.inter_op.allow_spinning", ORT_ALLOW_SPINNING)
    return options


def create_tts() -> Kokoro:
    session = ort.InferenceSession(
        MODEL_PATH,
        sess_options=make_session_options(),
        providers=["CPUExecutionProvider"],
    )
    return Kokoro.from_session(session, VOICES_PATH)


def pcm16(samples: np.ndarray) -> np.ndarray:
    """Gleitkomma der Stimme als 16 Bit, so wie es in der WAV-Datei steht.
    Jeder Wert fuer sich - ein Satz einzeln gewandelt ist darum Bit fuer Bit
    derselbe wie im Ganzen, und so liegt er auch im Zwischenspeicher."""
    samples = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (samples * 32767.0).astype(np.int16)


def wav_bytes(pcm: np.ndarray, sample_rate: int = SAMPLE_RATE) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(np.asarray(pcm, dtype="<i2").tobytes())
    return output.getvalue()


def warm_tts(tts: Kokoro, label: str) -> None:
    if not WARMUP_TEXT:
        return

    warmup_started = time.perf_counter()
    try:
        tts.create(
            text=WARMUP_TEXT,
            voice=DEFAULT_VOICE,
            speed=1.0,
            lang=DEFAULT_LANG,
        )
        print(f"{label} warmed in {time.perf_counter() - warmup_started:.3f}s", flush=True)
    except Exception as err:
        print(f"{label} warm-up failed: {err!r}", flush=True)


def get_tts() -> Kokoro:
    global kokoro
    if kokoro is None:
        started = time.perf_counter()
        print(
            "Loading Kokoro ONNX model: "
            f"intra={ORT_INTRA_OP_THREADS}, inter={ORT_INTER_OP_THREADS}, "
            f"spinning={ORT_ALLOW_SPINNING}...",
            flush=True,
        )
        kokoro = create_tts()
        warm_tts(kokoro, "Kokoro ONNX")
        print(
            f"Kokoro ONNX ready in {time.perf_counter() - started:.3f}s, voices={kokoro.get_voices()}",
            flush=True,
        )
    return kokoro


def init_process_worker() -> None:
    global worker_tts
    os.environ["OMP_NUM_THREADS"] = str(ORT_INTRA_OP_THREADS)
    os.environ["OPENBLAS_NUM_THREADS"] = str(ORT_INTRA_OP_THREADS)
    os.environ["MKL_NUM_THREADS"] = str(ORT_INTRA_OP_THREADS)
    os.environ["NUMEXPR_NUM_THREADS"] = str(ORT_INTRA_OP_THREADS)

    started = time.perf_counter()
    worker_tts = create_tts()
    warm_tts(worker_tts, f"Kokoro ONNX process {os.getpid()}")
    print(
        f"Kokoro ONNX process {os.getpid()} ready in {time.perf_counter() - started:.3f}s",
        flush=True,
    )


def process_worker_ping(_index: int) -> int:
    if worker_tts is None:
        raise RuntimeError("Kokoro worker was not initialized")
    return os.getpid()


def get_process_pool() -> ProcessPoolExecutor:
    global process_pool
    if process_pool is None:
        print(
            "Loading Kokoro ONNX process pool: "
            f"workers={WORKERS}, intra={ORT_INTRA_OP_THREADS}, inter={ORT_INTER_OP_THREADS}, "
            f"spinning={ORT_ALLOW_SPINNING}...",
            flush=True,
        )
        process_pool = ProcessPoolExecutor(
            max_workers=WORKERS,
            initializer=init_process_worker,
            mp_context=multiprocessing.get_context("fork"),
        )
        print("Kokoro ONNX process pool created; workers start on first request.", flush=True)
    return process_pool


def split_into_sentences(text: str):
    """Trennt den Text an echten Satzgrenzen (.  !  ?  Zeilenumbruch)."""
    # Mehrfache Leerzeilen normalisieren
    text = re.sub(r"\n\s*\n", "\n\n", text)

    # Splitte nur an echten Satzenden: . ! ? gefolgt von Leerzeichen + Nicht-Leerzeichen.
    # Doppelpunkt und " werden bewusst NICHT als Trenner verwendet.
    sentences = re.split(r"(?<=[.!?])\s+(?=\S)", text)

    # Zeilenumbrüche innerhalb der Segmente weiter aufteilen
    result = []
    for segment in sentences:
        for line in segment.split("\n"):
            line = line.strip()
            if line and len(line) > 1:
                result.append(line)

    return result


def prepare_sentence(sentence: str) -> str:
    """Was von einem Satz wirklich bei der Stimme ankommt. Danach richtet sich
    auch der Zwischenspeicher, darum steht es hier und nicht nur im Arbeiter."""
    # 1. Zeilenumbrüche entfernen, da diese intern bei kokoro-onnx
    #    zu "input=2" führen, wenn der Satz damit endet.
    sentence = sentence.replace("\n", " ").strip()

    # 2. Problematische typografische Sonderzeichen entschärfen.
    return re.sub(r'[«‹–""]', ",", sentence).strip()


def process_sentence(item):
    """Wird im ThreadPool ausgeführt."""
    idx, sentence, voice, speed, lang = item
    tts_instance = worker_tts if worker_tts is not None else get_tts()
    safe_sentence = prepare_sentence(sentence)

    if not safe_sentence:
        return idx, None, None, "Satz leer oder nur Sonderzeichen"

    try:
        samples, sr = tts_instance.create(
            text=safe_sentence,
            voice=voice,
            speed=speed,
            lang=lang,
        )
        return idx, samples, sr, None

    except ValueError as e:
        err_str = str(e)
        if "number of lines in input and output must be equal" in err_str:
            # ROBUSTER FALLBACK: Wenn espeak abstürzt (z. B. bei unbekannten
            # Abkürzungen), entfernen wir exotische Zeichen, behalten aber
            # normale Satzzeichen für eine natürliche Aussprache.
            very_safe = re.sub(r"[^\w\säöüßÄÖÜ.,:;!?\"'\-]", " ", safe_sentence).strip()
            if very_safe:
                try:
                    samples, sr = tts_instance.create(
                        text=very_safe,
                        voice=voice,
                        speed=speed,
                        lang=lang,
                    )
                    return idx, samples, sr, None
                except Exception as e2:
                    return idx, None, None, f"Fallback fehlgeschlagen: {e2}"
        return idx, None, None, f"Fehler für Satz '{sentence}': {err_str}"

    except Exception as e:
        return idx, None, None, f"Fehler für Satz '{sentence}': {e}"


# ==================== API ENDPUNKTE ====================


@app.get("/v1/audio/voices")
async def list_voices():
    return {"voices": [DEFAULT_VOICE]}


@app.get("/v1/info")
async def service_info():
    """Was hier wirklich spricht - die Seite zeigt es hinter der Marke
    "Kokoro AI". Die Fassungen werden beim Aufruf gelesen, damit nach einem
    neuen Bau nichts Veraltetes stehen bleibt."""
    from importlib.metadata import PackageNotFoundError, version

    try:
        kokoro_version = version("kokoro-onnx")
    except PackageNotFoundError:
        kokoro_version = ""

    return {
        "engine": {
            "name": "kokoro-onnx",
            "version": kokoro_version,
            "runtime": f"onnxruntime {ort.__version__}",
            "model": os.path.basename(MODEL_PATH),
            "voice": DEFAULT_VOICE,
            "language": DEFAULT_LANG,
            "device": f"CPU, {ORT_INTRA_OP_THREADS} Rechenf\u00e4den, {WORKERS} Arbeiter",
        },
        "speed": DEFAULT_SPEED,
        "sample_rate": SAMPLE_RATE,
    }


# ==================== AUSSPRACHE-LISTE ====================

# Die Seite ersetzt Woerter, bevor sie den Text zum Sprechen schickt: eine Zeile
# "(Chefarzt|Schaehfarzt)" im Sprechtext legt fest, wie ein Wort klingen soll.
# Solche Listen gelten nur fuer den Text, in dem sie stehen. Hier liegt die
# Liste, die fuer jeden Text gilt - einmal gepflegt, von jedem Browser beim
# Start geladen. Ersetzt wird auch dann in der Seite; dieser Dienst haelt die
# Liste nur fest, weil er als einziger etwas hat, was einen Neustart ueberlebt.
SAY_FILE = DATA_DIR / "aussprache.json"
SAY_MAX_RULES = 500
SAY_MAX_LEN = 120

# Klammer, senkrechter Strich, Doppelpunkt und Semikolon trennen im Sprechtext
# die Aussprache-Regel von der Regieanweisung. In einem Wort haben sie nichts
# zu suchen, und ein Zeilenumbruch erst recht nicht.
SAY_FORBIDDEN = re.compile(r"[()|:;\r\n\t]")

say_lock = asyncio.Lock()


def clean_rules(raw) -> list[dict]:
    """Aus dem, was hereinkommt, wird eine Liste aus sauberen Paaren.

    Halb ausgefuellte Zeilen fallen weg - die Seite speichert waehrend des
    Tippens, da steht die rechte Haelfte manchmal noch nicht. Alles andere,
    was nicht passt, wird abgelehnt statt stillschweigend verbogen."""
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="Die Liste fehlt.")
    if len(raw) > SAY_MAX_RULES:
        raise HTTPException(status_code=400, detail=f"Mehr als {SAY_MAX_RULES} Regeln sind nicht vorgesehen.")

    rules: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Jede Regel ist ein Paar aus Wort und Aussprache.")
        wort = str(item.get("wort") or "").strip()
        aussprache = str(item.get("aussprache") or "").strip()
        if not wort or not aussprache:
            continue
        for teil in (wort, aussprache):
            if len(teil) > SAY_MAX_LEN:
                raise HTTPException(status_code=400, detail=f"Laenger als {SAY_MAX_LEN} Zeichen: {teil[:40]}")
            if SAY_FORBIDDEN.search(teil):
                raise HTTPException(status_code=400, detail=f"Klammer, |, : und ; gehoeren nicht hinein: {teil[:40]}")
        rules.append({"wort": wort, "aussprache": aussprache})
    return rules


def read_rules() -> list[dict]:
    """Was auf der Platte liegt. Eine kaputte Datei gilt als leere Liste: die
    Seite soll starten koennen, auch wenn hier jemand von Hand geschrieben hat."""
    try:
        data = json.loads(SAY_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as err:
        print(f"Aussprache-Liste nicht lesbar: {err!r}", flush=True)
        return []

    raw = data.get("regeln") if isinstance(data, dict) else data
    try:
        return clean_rules(raw)
    except HTTPException as err:
        print(f"Aussprache-Liste unbrauchbar: {err.detail}", flush=True)
        return []


def write_rules(rules: list[dict]) -> None:
    """Erst daneben schreiben, dann umhaengen - so liegt dort nie eine halbe
    Datei, wenn der Dienst mitten im Schreiben stehen bleibt."""
    SAY_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SAY_FILE.with_name(SAY_FILE.name + ".neu")
    tmp.write_text(json.dumps({"regeln": rules}, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, SAY_FILE)


@app.get("/v1/aussprache")
async def get_aussprache():
    async with say_lock:
        rules = read_rules()
    return {"regeln": rules, "max_regeln": SAY_MAX_RULES, "max_zeichen": SAY_MAX_LEN}


@app.put("/v1/aussprache")
async def put_aussprache(request: Request):
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="Die Anfrage ist kein JSON.")

    rules = clean_rules(body.get("regeln") if isinstance(body, dict) else body)
    async with say_lock:
        try:
            write_rules(rules)
        except OSError as err:
            raise HTTPException(status_code=500, detail=f"Die Liste liess sich nicht speichern: {err}")
    print(f"Aussprache-Liste gespeichert: {len(rules)} Regel(n)", flush=True)
    return {"regeln": rules, "max_regeln": SAY_MAX_RULES, "max_zeichen": SAY_MAX_LEN}


# ==================== ZWISCHENSPEICHER ====================

# Jeder Satz, den die Stimme fuer die Seite gesprochen hat, bleibt hier als
# Datei liegen. Die Seite vergisst ihren Ton beim Neuladen, und nach einem
# geladenen Projekt oder einer anderen Satzpause fragt sie alle Abschnitte neu
# an - gesprochen wird dann nur, was hier fehlt. Auf einem ausgelasteten
# Rechner braucht ein Satz bis zu zwei Minuten, aus der Datei kommt er sofort.
#
# Der Schluessel ist genau das, was die Stimme bekommt: der Satz nach allen
# Ersetzungen, Stimme, Tempo und Sprache, dazu der Fingerabdruck von Modell und
# Lautschrift. Ein geaendertes Wort, eine neue Aussprache-Regel oder ein anderes
# Tempo treffen damit genau die Saetze, die dadurch anders klingen. Pausen
# stehen nicht darin - sie sind Stille zwischen den Saetzen und werden bei
# jeder Anfrage neu gesetzt.
#
# Nebenbei klingt derselbe Satz jetzt immer gleich. Die Stimme wuerfelt bei
# jedem Durchlauf ein wenig anders; ohne Speicher waere dieselbe Tonspur,
# zweimal erzeugt, zweimal eine andere Datei.
#
# Hier landet nur, wer "cache": true mitschickt. Home Assistant tut das nicht:
# es hat seinen eigenen Speicher, und was es sagt, gehoert nicht auf die Platte.
CACHE_DIR = DATA_DIR / "saetze"

# Hochzaehlen, wenn process_sentence einen vorbereiteten Satz anders an die
# Stimme gibt als bisher - dann passt keiner der gespeicherten mehr.
SATZ_FASSUNG = 1

cache_abdruck = ""                     # Fingerabdruck der Stimme, beim Start gerechnet
cache_belegt = 0                       # Bytes auf der Platte, nachgefuehrt
cache_aufraeumen: asyncio.Task | None = None


def stimmen_abdruck() -> str:
    """Was ausser dem Satz bestimmt, wie er klingt: Modell und Stimmen, dazu
    die Programme, die aus Buchstaben Laute machen. Aendert sich davon etwas,
    fuehrt der neue Abdruck von selbst zu neuen Schluesseln. onnxruntime
    gehoert nicht dazu - es aendert keine Laute, und gewuerfelt wird ohnehin."""
    abdruck = hashlib.sha256(f"satz {SATZ_FASSUNG}".encode())
    for pfad in (MODEL_PATH, VOICES_PATH):
        with open(pfad, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                abdruck.update(block)
    for paket in ("kokoro-onnx", "phonemizer-fork", "espeakng-loader"):
        try:
            abdruck.update(f"{paket} {metadata.version(paket)}".encode())
        except metadata.PackageNotFoundError:
            abdruck.update(f"{paket} -".encode())
    return abdruck.hexdigest()


def satz_schluessel(satz: str, voice: str, speed: float, lang: str) -> str:
    roh = json.dumps([cache_abdruck, voice, float(speed), lang, satz], ensure_ascii=False)
    return hashlib.sha256(roh.encode("utf-8")).hexdigest()


def satz_lesen(schluessel: str) -> np.ndarray | None:
    pfad = CACHE_DIR / f"{schluessel}.pcm"
    try:
        pcm = np.fromfile(pfad, dtype="<i2")
    except (OSError, ValueError):
        return None
    try:
        os.utime(pfad)                 # gebraucht: faellt beim Aufraeumen zuletzt heraus
    except OSError:
        pass                           # gerade aufgeraeumt - gelesen ist er trotzdem
    return pcm


def satz_ablegen(schluessel: str, pcm: np.ndarray) -> None:
    """Erst daneben schreiben, dann umhaengen - wer gleichzeitig liest,
    findet den ganzen Satz oder keinen. Scheitert das Schreiben, bleibt der
    Satz eben ungespeichert; gesprochen ist er trotzdem."""
    global cache_belegt
    pfad = CACHE_DIR / f"{schluessel}.pcm"
    tmp = CACHE_DIR / f"{schluessel}.{secrets.token_hex(4)}.neu"
    daten = np.asarray(pcm, dtype="<i2").tobytes()
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(daten)
        os.replace(tmp, pfad)
    except OSError as err:
        tmp.unlink(missing_ok=True)
        print(f"Satz nicht gespeichert: {err!r}", flush=True)
        return
    cache_belegt += len(daten)


def cache_eintraege() -> list[tuple[float, int, Path]]:
    """(zuletzt gebraucht, Groesse, Pfad) je gespeichertem Satz."""
    raus = []
    try:
        with os.scandir(CACHE_DIR) as eintraege:
            for e in eintraege:
                if not e.name.endswith(".pcm"):
                    continue
                try:
                    st = e.stat()
                except FileNotFoundError:
                    continue
                raus.append((st.st_mtime, st.st_size, Path(e.path)))
    except FileNotFoundError:
        pass
    return raus


def cache_zaehlen() -> tuple[int, int]:
    global cache_belegt
    eintraege = cache_eintraege()
    cache_belegt = sum(e[1] for e in eintraege)
    return len(eintraege), cache_belegt


def cache_kuerzen() -> None:
    """Was am laengsten nicht gebraucht wurde, faellt heraus, bis ein Zehntel
    der Obergrenze frei ist - sonst stuende nach jedem neuen Satz das naechste
    Aufraeumen an."""
    global cache_belegt
    eintraege = sorted(cache_eintraege())
    belegt = sum(e[1] for e in eintraege)
    weg = 0
    for _zeit, groesse, pfad in eintraege:
        if belegt <= CACHE_MAX_BYTES * 0.9:
            break
        pfad.unlink(missing_ok=True)
        belegt -= groesse
        weg += 1
    cache_belegt = belegt
    print(f"Zwischenspeicher aufgeraeumt: {weg} Satz/Saetze entfernt, "
          f"{belegt / 1024**2:.0f} MB bleiben", flush=True)


def cache_kuerzen_bald() -> None:
    """Aufgeraeumt wird neben der Antwort her, nicht vor ihr."""
    global cache_aufraeumen
    if cache_belegt <= CACHE_MAX_BYTES or (cache_aufraeumen and not cache_aufraeumen.done()):
        return
    cache_aufraeumen = asyncio.create_task(asyncio.to_thread(cache_kuerzen))


def cache_leeren() -> int:
    global cache_belegt
    eintraege = cache_eintraege()
    for _zeit, _groesse, pfad in eintraege:
        pfad.unlink(missing_ok=True)
    cache_belegt = 0
    return len(eintraege)


def cache_start() -> None:
    """Beim Start: Abdruck rechnen, Reste abgebrochener Schreibvorgaenge
    wegraeumen, den belegten Platz zaehlen. Laeuft vor dem ersten Arbeiter -
    der Abdruck liest 325 MB Modell, das soll kein Faden neben fork() tun."""
    global cache_abdruck
    if CACHE_MAX_BYTES <= 0:
        print("Zwischenspeicher abgeschaltet (KOKORO_CACHE_GB=0).", flush=True)
        return
    started = time.perf_counter()
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        for rest in CACHE_DIR.glob("*.neu"):
            rest.unlink(missing_ok=True)
        abdruck = stimmen_abdruck()
    except OSError as err:
        # Ohne Ablage spricht die Stimme trotzdem, nur eben alles neu.
        print(f"Zwischenspeicher abgeschaltet: {err!r}", flush=True)
        return
    anzahl, belegt = cache_zaehlen()
    cache_abdruck = abdruck            # erst jetzt wird gespeichert
    print(
        f"Zwischenspeicher {CACHE_DIR}: {anzahl} Satz/Saetze, {belegt / 1024**2:.0f} MB "
        f"von hoechstens {CACHE_MAX_BYTES / 1024**3:g} GB, Abdruck {cache_abdruck[:12]} "
        f"({time.perf_counter() - started:.1f}s)",
        flush=True,
    )


def cache_auskunft(anzahl: int, belegt: int) -> dict:
    return {"saetze": anzahl, "bytes": belegt, "sekunden": round(belegt / 2 / SAMPLE_RATE, 1),
            "max_bytes": CACHE_MAX_BYTES if cache_abdruck else 0}


@app.get("/v1/zwischenspeicher")
async def get_zwischenspeicher():
    return cache_auskunft(*await asyncio.to_thread(cache_zaehlen))


@app.delete("/v1/zwischenspeicher")
async def delete_zwischenspeicher():
    weg = await asyncio.to_thread(cache_leeren)
    print(f"Zwischenspeicher geleert: {weg} Satz/Saetze", flush=True)
    return cache_auskunft(0, 0) | {"geloescht": weg}


async def warm_process_pool_background() -> None:
    if WORKERS <= 1:
        return

    try:
        await asyncio.sleep(0.1)
        pool = get_process_pool()
        loop = asyncio.get_running_loop()
        warm_sentence = WARMUP_TEXT or "Hallo."
        warm_tasks = [(-1, warm_sentence, DEFAULT_VOICE, 1.0, DEFAULT_LANG)] * WORKERS
        await asyncio.gather(*(loop.run_in_executor(pool, process_sentence, task) for task in warm_tasks))
        print("Kokoro ONNX process pool warmed in background.", flush=True)
    except Exception as err:
        print(f"Kokoro ONNX background warm-up failed: {err!r}", flush=True)


@app.on_event("startup")
async def start_background_warmup() -> None:
    if WORKERS > 1:
        asyncio.create_task(warm_process_pool_background())


@app.post("/v1/audio/speech")
async def generate_speech(request: Request):
    data = await request.json()
    raw_text = str(data.get("input") or "")
    text = normalize_tts_text(raw_text)
    voice = str(data.get("voice") or DEFAULT_VOICE)
    speed = float(data.get("speed") or DEFAULT_SPEED)
    lang = str(data.get("lang") or data.get("language") or DEFAULT_LANG)
    req_pause_duration = float(data.get("pause_duration", PAUSE_DURATION))
    merken = data.get("cache") is True and bool(cache_abdruck)

    if voice != DEFAULT_VOICE:
        voice = DEFAULT_VOICE

    if text != raw_text:
        print(f"TTS normalisiert: {raw_text[:80]} -> {text[:80]}", flush=True)
    print(f"Generiere ONNX: {text[:40]}... [{voice}, pause={req_pause_duration}s]", flush=True)

    try:
        started = time.perf_counter()
        sentences = split_into_sentences(text)

        if not sentences:
            return Response(status_code=400, content="Kein verarbeitbarer Text gefunden.")

        results: list[np.ndarray | None] = [None] * len(sentences)

        # Erst nachsehen, was schon gesprochen ist. Kommt ein Satz zweimal vor,
        # spricht die Stimme ihn einmal, und beide Stellen klingen gleich.
        keys: list[str | None] = [None] * len(sentences)
        tasks, zweite = [], []
        erste: dict[str, int] = {}
        for i, sentence in enumerate(sentences):
            prepared = prepare_sentence(sentence) if merken else ""
            if prepared:
                keys[i] = satz_schluessel(prepared, voice, speed, lang)
                results[i] = satz_lesen(keys[i])
                if results[i] is not None:
                    continue
                if keys[i] in erste:
                    zweite.append((i, erste[keys[i]]))
                    continue
                erste[keys[i]] = i
            tasks.append((i, sentence, voice, speed, lang))
        vorhanden = sum(r is not None for r in results)

        if not tasks:
            sentence_results = []
        elif WORKERS > 1:
            pool = get_process_pool()
            loop = asyncio.get_running_loop()
            sentence_results = await asyncio.gather(
                *(loop.run_in_executor(pool, process_sentence, task) for task in tasks)
            )
        else:
            sentence_results = [process_sentence(task) for task in tasks]

        neu = 0
        for idx, samples, sr, error in sentence_results:
            if idx >= 0:
                if error:
                    print(f"Fehler in Satz {idx + 1}: {error}", flush=True)
                else:
                    results[idx] = pcm16(samples)
                    neu += 1
                    if keys[idx]:
                        satz_ablegen(keys[idx], results[idx])
        for idx, original in zweite:
            if results[original] is not None:
                results[idx] = results[original]
                vorhanden += 1

        # === PAUSEN-LOGIK ===
        all_audio = []

        # BUGFIX: Fehlgeschlagene Sätze werden nicht mehr komplett gedroppt,
        # sondern durch eine kurze Stille ersetzt. So bleibt die zeitliche
        # Struktur erhalten und kein Text wird "zusammengezogen".
        valid_samples = []
        for s in results:
            if s is not None:
                valid_samples.append(s)
            else:
                valid_samples.append(
                    np.zeros(int(SAMPLE_RATE * req_pause_duration), dtype=np.int16)
                )

        num_sentences = len(valid_samples)

        for i, samples in enumerate(valid_samples):
            all_audio.append(samples)
            if req_pause_duration > 0:
                if i < num_sentences - 1:
                    # Pause zwischen den Sätzen
                    pause = np.zeros(int(SAMPLE_RATE * req_pause_duration), dtype=np.int16)
                    all_audio.append(pause)
                elif i == num_sentences - 1:
                    # Diese Pause hilft dem I2S-Puffer des Speakers (z. B. ESPHome)
                    # zu leeren und die Status-LED geht aus.
                    pause = np.zeros(int(SAMPLE_RATE * req_pause_duration), dtype=np.int16)
                    all_audio.append(pause)

        if not all_audio:
            raise ValueError("Ich hab alles gegeben, aber es konnte kein Audio generiert werden.")

        final_audio = np.concatenate(all_audio)

        elapsed = time.perf_counter() - started
        print(
            f"Kokoro ONNX fertig in {elapsed:.3f}s, samples={len(final_audio)}, Sätze={num_sentences}, "
            f"neu={neu}, vorhanden={vorhanden}",
            flush=True,
        )
        if neu and merken:
            cache_kuerzen_bald()

        # Wie viele Saetze die Stimme sprechen musste und wie viele schon da
        # waren - die Seite sagt es dazu, damit man sieht, was gewartet hat.
        return Response(
            content=wav_bytes(final_audio, SAMPLE_RATE),
            media_type="audio/wav",
            headers={"X-Saetze": str(num_sentences), "X-Saetze-Neu": str(neu),
                     "X-Saetze-Vorhanden": str(vorhanden)},
        )

    except Exception as err:
        print(f"Kokoro ONNX Fehler: {err!r}", flush=True)
        return Response(status_code=500, content=str(err))


print("Initialisiere Kokoro-ONNX-Service...", flush=True)
cache_start()
if WORKERS > 1:
    print(
        f"Kokoro ONNX process pool configured: workers={WORKERS}, "
        f"intra={ORT_INTRA_OP_THREADS}, inter={ORT_INTER_OP_THREADS}, spinning={ORT_ALLOW_SPINNING}",
        flush=True,
    )
else:
    get_tts()
