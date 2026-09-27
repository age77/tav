# TAV — Text to Audio to Video MultiTool

(formerly *Kokoro ONNX German Martin*)

Docker and Home Assistant Assist setup for the German Kokoro voice **Martin**, using the ONNX export published on Hugging Face:

[Godelaune/Kokoro-82M-ONNX-German-Martin](https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin)

This GitHub repository contains the service code, German text normalization rules, Docker setup and Wyoming bridge overlay. The large model files and audio samples stay on Hugging Face, which is the better home for model artifacts.

## What Is Included

- `onnx-docker/`: a FastAPI service exposing an OpenAI-compatible `/v1/audio/speech` endpoint for Kokoro ONNX.
- `wyoming_openai_german_separator/`: a Docker overlay for `wyoming_openai` that protects German dotted abbreviations during streaming sentence segmentation.
- `german_text_rules.py`: the shared German abbreviation, unit and sentence-boundary rule file used by both services.
- `docker-compose.yml`: the Home Assistant Assist setup for Kokoro ONNX plus Wyoming, the web UI, the video service and the transcription service.
- `docker-compose.public.yml`: the same stack from the prebuilt images on Docker Hub (`age77/tav-*`), nothing to build.
- `webui/`: a static page for writing, tuning and exporting German voice-over text — markup in
  `index.html`, styles in `tav.css`, and the logic in `js/`, one classic script per area that
  shares one namespace with the others and loads in the order `index.html` gives.
- `video-docker/`: an ffmpeg service that joins uploaded video clips and lays the voice-over underneath.
- `whisper-docker/`: a faster-whisper service that transcribes the speech in an uploaded video or audio file.
- `scripts/download-model-files.sh`: downloads `kokoro-martin.onnx` and `voices-martin.npz` from Hugging Face.
- `tests/ui/`: a Playwright smoke test that builds the web UI from the working tree, starts it in a
  throwaway stack next to the running services and walks through the main workflows
  (`sh tests/ui/run.sh`, `sh tests/ui/run.sh --weg` removes the stack again).

## Relationship To Upstream Projects

This is not a fork of `semidark/kikiri-tts` or `hexgrad/kokoro`. It is a deployment and normalization repository built around the German Martin ONNX export.

Related projects:

- German Martin voice: [kikiri-tts/kikiri-german-martin](https://huggingface.co/kikiri-tts/kikiri-german-martin)
- Kokoro architecture: [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) and [hexgrad/kokoro](https://github.com/hexgrad/kokoro)
- ONNX runtime package used by the service: [thewh1teagle/kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)
- Kikiri TTS tooling: [semidark/kikiri-tts](https://github.com/semidark/kikiri-tts)
- Wyoming OpenAI bridge base image: [roryeckel/wyoming_openai](https://github.com/roryeckel/wyoming_openai)

## Quick Start

### From Docker Hub, without building

```bash
curl -O https://raw.githubusercontent.com/age77/tav/main/docker-compose.public.yml
docker compose -f docker-compose.public.yml up -d
```

Then open `http://<your-docker-host>:8884`. The images are built for `linux/amd64` and run on
the CPU. The web UI has no login of its own — put a reverse proxy with authentication in front
before exposing it beyond your own network.

### From source

Clone this repository:

```bash
git clone https://github.com/age77/tav.git
cd tav
```

Download the model artifacts from Hugging Face:

```bash
sh scripts/download-model-files.sh
```

This is only needed to run the service outside Docker. The image build fetches
`kokoro-martin.onnx` and `voices-martin.npz` from Hugging Face itself and checks
their SHA-256 sums, so a plain `git clone` is enough to build the stack — which is
what lets Portainer deploy it straight from the repository.

Start the ONNX TTS service and Wyoming bridge:

```bash
docker compose up -d --build
```

Check the TTS service:

```bash
curl http://localhost:8881/v1/audio/voices
```

For Home Assistant, add the Wyoming integration and point it to the Docker host:

```text
Host: <your-docker-host>
Port: 10203
```

## German Text Normalization

The service normalizes common German forms before synthesis, including:

- decimal numbers with units, for example `2,5 kWh`
- singular/plural unit forms, for example `1 kWh` vs. `2 kWh`
- dotted units and abbreviations such as `Min.`, `Stck.`, `ltr.`, `zzgl.` and `ggf.`
- Euro amounts such as `42,80 EUR`
- ordinal/cardinal contexts such as dates, quarters, tracks and numbered labels

The same `german_text_rules.py` file is mounted into both containers, so the FastAPI service and Wyoming bridge use the same abbreviation and sentence-boundary rules.

## Process-Isolated Parallel Workers

Version 1.2 replaces thread-shared Kokoro synthesis with process-isolated workers. Each worker owns its own Kokoro/ONNX session, which avoids sharing Kokoro, espeak and tokenizer state across threads while still allowing parallel sentence synthesis.

The included compose file uses this Intel NUC-oriented profile:

```text
KOKORO_WORKERS=2
KOKORO_ONNX_INTRA_OP_THREADS=2
KOKORO_ONNX_INTER_OP_THREADS=1
KOKORO_ONNX_ALLOW_SPINNING=0
OMP_NUM_THREADS=2
OPENBLAS_NUM_THREADS=2
MKL_NUM_THREADS=2
NUMEXPR_NUM_THREADS=2
```

For very small systems, set `KOKORO_WORKERS=1`. For larger CPUs, benchmark higher worker and thread counts carefully; each worker also uses ONNX Runtime threads.

## Pronunciation List

A line `(Chefarzt|Schähfarzt)` in a speech text tells the page how a word should be spoken; such a
list belongs at the end of the file and applies to that text only. Words that have to sound the same
in *every* text — house names, abbreviations, technical terms — live in the "Aussprache" panel of
the web UI instead. That list is stored by `tav-onnx`, because it is the one service with storage
that outlives a rebuild, and the page loads it on start:

| Method | Path | Meaning |
|---|---|---|
| `GET` | `/v1/aussprache` | the stored list, plus the limits `max_regeln` and `max_zeichen` |
| `PUT` | `/v1/aussprache` | replaces it with `{"regeln": [{"wort": …, "aussprache": …}, …]}` |

nginx already forwards `/v1/` to `tav-onnx`, so the page reaches both endpoints same-origin behind
the login. The file lives as `aussprache.json` in the `tav-onnx-data` volume and is written to a
temporary name first, so a crash mid-write cannot leave half a file behind. Half-filled rules are
dropped — the page saves while someone is still typing — and brackets, `|`, `:` and `;` are rejected,
because those are what separate a pronunciation rule from a stage direction in the text. At most 500
rules of 120 characters each.

Substitution itself still happens in the page, before the text is sent for synthesis: the list from
the server is applied first, the `(…|…)` lines of the text after it, so a line in the text wins over
the global list for the same word, and the longest rule wins between different ones. Home Assistant
speaks through the same service but does not see the list; it is a writing aid for the web UI, not a
filter in front of the model.

| Variable | Default | Meaning |
|---|---|---|
| `KOKORO_DATA` | `/data` | directory for `aussprache.json` and the speech cache, backed by the `tav-onnx-data` volume |

## Speech Cache

Every sentence the voice speaks for the web UI is kept by `tav-onnx`, one file per sentence, and a
request only synthesizes what is not there yet. The page forgets its audio on a reload, and it asks
for every segment again after a project is loaded or the sentence pause changes; with the cache that
takes seconds instead of a full pass, which on a busy machine can mean up to two minutes for a single
sentence.

The key is exactly what goes into the model: the sentence after normalization and after the page has
applied its pronunciation rules, the voice, the speed and the language, plus a fingerprint of the
model file, the voices file and the packages that turn letters into phonemes (`kokoro-onnx`,
`phonemizer-fork`, `espeakng-loader`). A changed word, a new pronunciation rule or another speed
therefore misses for exactly the sentences that sound different, and a new model or phonemizer
misses for all of them. Pauses are not part of the key — they are silence between sentences, laid out
per request — so a different sentence pause is served entirely from the cache. `SATZ_FASSUNG` in
`main.py` has to be raised by hand if `process_sentence` ever changes how a prepared sentence is
handed to the model.

The cache is also what makes the voice repeatable. Kokoro is not deterministic: the same sentence
comes out slightly different on every pass, in its waveform and by a few dozen milliseconds in its
length. Without the cache the same text never produced the same file twice; with it, it does, which is
what lets `tav-video` recognize a voice track it already holds.

Only requests that send `"cache": true` are cached. The web UI does; Home Assistant does not — it has
its own TTS cache, and what it says does not belong on disk. Every response carries `X-Saetze`,
`X-Saetze-Neu` and `X-Saetze-Vorhanden` (sentences in total, newly synthesized, served without
synthesis), which the page turns into its status line. A sentence that occurs twice in one request is
synthesized once. Sentences are stored as raw 16-bit PCM in `saetze/`, written to a temporary name and
then renamed; reading one bumps its modification time, and once the cache grows past its limit the
least recently used sentences are dropped until it is back at 90 %.

| Method | Path | Meaning |
|---|---|---|
| `GET` | `/v1/zwischenspeicher` | `saetze`, `bytes`, `sekunden` of speech stored, and `max_bytes` (`0` when off) |
| `DELETE` | `/v1/zwischenspeicher` | empties the cache |

| Variable | Default | Meaning |
|---|---|---|
| `KOKORO_CACHE_GB` | `4` | cap for the speech cache; 1 GB holds about six hours of speech; `0` turns it off |

## Projects And Storage

Nothing on the server expires any more: `VIDEO_KEEP_HOURS` and `WHISPER_KEEP_HOURS` are `0`, which
turns the age-based cleanup loop off, and files are deleted only from the "Auf dem Server" panel of
the web UI. That panel lists what both services hold — clips, voice tracks, finished videos, speech
texts and the transcription media — with size, date and how many projects still reference a file,
and it shows the free space on the volume, because a store that never expires can fill up.

One file can legitimately lie on the server twice. `tav-whisper` and `tav-video` have separate
stores, so "Als Clip übernehmen" uploads the same video a second time: once to be transcribed, once
to be cut. The panel folds those two halves into a single row — "Abschrift + Clip", with the space
both of them take — so it reads as one file, which is what it is on the desk; deleting the row
deletes both halves.

A voice track, on the other hand, lies there only once. The page uploads the voice-over before every
video job; `tav-video` hashes each finished voice upload, and if a track with the same SHA-256 is
already there, it drops the new copy and answers with the existing id. Over HTTPS the page hashes the
WAV itself and sends the sum with the upload request, so an identical track is not even transferred.
Since the speech cache returns the same text as the same bytes, rendering the same project again
after a reload reuses the track instead of piling up copies. The bottom of the panel shows the speech
cache of `tav-onnx` — sentences, hours of speech and space against its cap — with a button to empty
it.

The same panel keeps *projects*: the working state that "Projekt exportieren" writes to a file —
speech text, pauses, audio/video/subtitle settings and the clips with their cuts — stored in
`tav-video` instead of a download folder, so it opens again at any desk. The speech text lies there
as a file of its own as well, not only as a string inside the project: reading a `.md` into the page
puts a copy under `/api/texts`, saving a project puts the current text there, and the project points
at it through `textid`, which is what makes it show up in the panel with a size and a date like
everything else.

| Method | Path | Meaning |
|---|---|---|
| `GET` | `/api/projects` | the list: id, name, created, updated, size, clip count |
| `POST` | `/api/projects` | `{"name": …, "data": {…}}`, answers with the new id |
| `GET` | `/api/projects/{id}` | the whole project including `data` |
| `PUT` | `/api/projects/{id}` | replaces name and data, keeps `created` |
| `DELETE` | `/api/projects/{id}` | removes the working state; the files stay |
| `POST` | `/api/texts` | `{"name": …, "text": …}` puts the speech text there as a `.md` file; the same text under the same name is stored once |
| `GET` | `/api/texts/{id}` | the file including `text` |
| `GET` | `/api/texts/{id}/file` | the `.md` itself, for downloading |
| `DELETE` | `/api/texts/{id}` | removes it |
| `GET` | `/api/storage` | what lies in each folder, plus free and used bytes |
| `DELETE` | `/api/storage/{kind}/{id}` | deletes one file (`clips`, `voices`, `output`, `texts`, or `media` on `tav-whisper`) |

Projects live as one JSON file each in `projects/` inside the `tav-video-data` volume, written to a
temporary name first and then renamed; at most 200 of them, 8 MB each. A project only references
clips by id, so deleting a clip does not touch the project — the panel says how many projects use a
file before it is deleted, and loading a project reports how many of its clips are gone.

"Alles zurücksetzen" no longer deletes anything on the server. It clears the page and the browser's
memory; what was uploaded stays, because it may belong to a saved project.

## Video Service

`tav-video` backs the "Video exportieren mit Sprachausgabe" panel of the web UI. It has no published port; nginx in `tav-webui` forwards `/video/` to it. Clips are uploaded in 32 MB parts so that no single request runs into reverse-proxy read timeouts (Traefik 3 aborts after 60 s by default). Jobs run one at a time under `nice` and are encoded on the CPU with libx264, libx265 or libvpx-vp9 at a target bitrate, which keeps the size estimate close to the result.

| Variable | Default | Meaning |
|---|---|---|
| `VIDEO_THREADS` | `4` | encoder threads; leave room for speech synthesis |
| `VIDEO_KEEP_HOURS` | `24` | uploaded clips and finished videos are deleted after this idle time |
| `VIDEO_MAX_UPLOAD_GB` | `8` | largest accepted clip |

A clip can be cut for a job without touching the uploaded file: `/api/plan` and `/api/jobs` accept
each clip as an object `{"id": …, "start": s, "end": s, "drops": [{"from": s, "to": s}], "holds":
[{"at": s, "seconds": s}]}` instead of a bare id, and answer for that cut. `start`/`end` are seconds
in the source file and become an `-ss`/`-t` seek in front of the input, so a long clip is not decoded
from the beginning. A drop takes a stretch out of the middle, counted from the start of the cut; at
most 50 per clip, overlapping ones are merged, and what is left has to be longer than 0.05 s. A hold
freezes the picture at `at` seconds (also counted from the start of the cut) for `seconds` seconds,
which is how a shot waits for a sentence that runs longer than the motion. At most 20 holds per clip,
60 s each, 600 s in total; a hold inside a dropped stretch is ignored.

`cut_pieces()` turns cut, drops and holds into the pieces that are actually seen —
`(from, to, hold after it)` — and the filter graph builds them with `split`, `trim` and `concat`,
cloning the frame with `tpad` where the picture holds, with silence padded into the clip's own audio
so the rest stays in sync. A hold at 0 clones the first frame ahead of the clip. The effective clip
length — cut, minus drops, plus holds — is what the plan, the timeline and the transitions count
with. The same file may appear twice in one job with different cuts.

`still_seconds` (0 to 30, the page sends 2) holds the first and the last frame of the whole video
that long, without sound: the voice starts behind the lead-in (`voice_offset` is added to it), the
subtitle cues arrive already shifted from the page, and the length grows by twice the value. It
gives a film air before the first word, and it is what a transition can be laid into when finished
videos are joined.

Finished videos can be joined into one: a job with `"source": "output"` takes its clips from the
finished videos instead of the uploaded ones — `clips` then carries their file names — and is
otherwise an ordinary job, so order, transition, format, resolution and the size estimate all work
the same. The page's "Videos zusammenfügen" panel uses it with the clips' own sound, no voice track
and no subtitles, and with a 1 s crossfade that falls into the still frames at both ends. A finished
video now also gets a small JSON beside it with its download name and its measured dimensions, so
both survive a restart of the service (before, the name lived only in the in-memory job) and joining
needs no probing; `GET /api/storage` reports them, and a video from an earlier version is measured
once on first sight.

The speech text can be burned in as subtitles. The page knows where every segment sits on the voice
track, so it sends the cues — `{"start": s, "end": s, "text": "…"}`, at most 2000 — together with a
`subtitles` block in the options: font (the DejaVu faces that ship with ffmpeg), size and margin in
percent of the picture height, colour, bold, outline, position, and a box behind the text whose
opacity is set in percent. The service writes an ASS file next to the output (`PlayResX/Y` equal to
the output size so the percentages hold) and adds `ass=` as the last video filter, after cutting and
transitions. The subtitle carries the *written* wording: the pronunciation list applies to the voice,
so "Schähfarzt" is spoken but "Chefarzt" is shown.

The box is not libass's own. `BorderStyle 3` fills its box with the *outline* colour and pads it by
the outline width, so the box colour was never used and an outline of 0 left no box at all; it is
also always square. Instead, every cue gets two layers: a rounded rectangle drawn as an ASS vector
path (`\p1`) in the box colour and opacity, and the text above it with its own outline. To know how
big the box has to be, the service measures each line with Pillow — the same DejaVu files and the
same HarfBuzz shaping as libass; measured against libass's own line boxes, the widths agree within
half a percent. In libass the font size is the height of a line (ascender plus descender), not the
em, and the text block ends exactly at the margin. Libass no longer wraps on its own (`WrapStyle: 2`):
the lines arrive finished from the page, and the service never adds one. Should a line still be wider
than the space between the margins — an old page, a browser that could not load the font — that cue
is set narrower with `\fscx` instead, and its box with it. Padding and corner radius (`KASTEN_X`,
`KASTEN_Y`, `KASTEN_RUND`, in em) are the same as in the page's preview.

The page does the splitting, in the video's own terms. `tav-webui` serves the very DejaVu files the
video service burns in (copied from the same Debian package in a build stage, `/fonts/`), and the page
measures each word with them at the size the video will have — the size setting is a line's height,
the em 1.164 times smaller. A line fits when it has at most "Zeichen je Zeile" characters and is no
wider than the picture between the margins. A segment first gets the smallest number of cues that
holds it in "Zeilen je Einblendung" lines, then its words are spread over them by a small dynamic
program that weighs even length against good seams: after a sentence end, a colon or semicolon, a
comma or dash; before a conjunction such as "und" or "oder"; before an article or preposition, where
a phrase begins — and never right after one, which would leave "in" or "der" hanging at a line end.
One cue more is taken when it buys clearly better seams. The lines within a cue are split the same
way. The preview is a frame in the video's own size and aspect ratio, laid out in video pixels and
scaled down as a whole: laid out small, the browser rounds every glyph advance and a line came out a
twentieth too narrow. Measured against a frame rendered by the service, the box in the preview lies
within 0.15 % of the picture on every side.

A job may carry a `name`: the page sends the project's name with the prefix `TAV` (or the speech
text's name when no project is open), and the finished video is downloaded as `<name>.<ext>` — the
service only drops characters no file system accepts and falls back to `video`. The "Auf dem Server"
panel lists a finished video under that name as well. An uppercase prefix already in the name is
replaced rather than stacked, so the project `TTS_01_Anlage` renders as `TAV_01_Anlage.mp4`; the same
rule names the voice track, the audio export, the project file and the batch files. A voice track
that is already on the server under another name takes the name it was uploaded with last.

Files live in the `tav-video-data` volume. Job state is kept in memory, so a restart forgets running and finished jobs; uploaded clips survive.

An uploaded clip can be fetched back with `GET /video/api/clips/{id}/file`. It answers with the clip's own media type and honours `Range`, which is what lets the "Schnittfenster" panel play and seek in a clip that only exists on the server — after a page reload the browser no longer holds the local file. The file's modification time is never touched after the upload (only the `.json` next to it is, to mark use), so `ETag` and `Last-Modified` stay the same from request to request, and the response carries `Cache-Control: private, max-age=31536000, immutable`: nothing under an id changes once it is complete, so the browser may keep every piece it has fetched, across reloads too.

## Transcription Service

`tav-whisper` backs the "Abschrift aus Video" panel of the web UI. It has no published port; nginx in `tav-webui` forwards `/whisper/` to it. An uploaded video or audio file is uploaded in 32 MB parts, ffmpeg extracts the audio as 16 kHz mono, and [faster-whisper](https://github.com/SYSTRAN/faster-whisper) transcribes it on the CPU. Jobs run one at a time and the whole service runs at `nice 10`, so speech synthesis and Home Assistant keep priority.

The service returns segments with timestamps. The page turns them into a speech text with pauses, flowing text, one line per segment, or text with timestamps, and can save them as `.txt`, `.srt` or `.vtt`. "In den Sprechertext übernehmen" drops the transcript straight into the speech-text field, which is the point of the panel: a foreign clip can be transcribed, edited and spoken again in Martin's voice. "Als Clip übernehmen" passes the same file on to the video panel, so the "Schnittfenster" has a picture to go with the new voice-over; it is uploaded to `tav-video` a second time, as the two services do not share storage. A file that is chosen, dropped or fetched from the server is transcribed right away, with the settings the panel shows — German, "Gründlich", without skipping silence, unless someone changed them.

The default text form, "Mit Pausen", is written for re-voicing. It puts one sentence on each line and the silence between two sentences on a `(Pause: … s)` line of its own, the syntax of the speech-text guide, sized so that Martin starts every sentence where the original speaker started it. Whisper's segments often end mid-sentence, so they are joined up to the next sentence end — spoken separately, Martin would drop his voice at every seam — and a sentence that ends inside a segment is split off, with its start interpolated by character count, since Whisper times whole segments only. Annotations such as `[Musik]` are dropped and their time becomes silence.

Until the audio exists, Martin's length per sentence is estimated from its characters; after "Audio erzeugen" (or any re-speaking) the page knows it exactly and rewrites the pause lines, which only changes silence between separately synthesized segments and so needs no new synthesis. Where Martin is slower than the original, the shortest pause — the sentence pause — follows and the next longer silence in the film catches up; the speech-text panel says where he lags furthest behind. The targets are mapped through the clip in the timeline, so a freeze frame, a new in-point or the voice offset moves the pauses after it, and a pause dragged by hand in the "Schnittfenster" stays as it is. "Pausen freigeben" detaches the text from the film. The start times travel with the project (`neuvertonung`, project version 6); if the text is edited into a different number of segments, the page stops refitting and says so.

Without word timestamps Whisper times its segments to about half a second, and after a long silence it tends to put a segment's start up to one and a half seconds early — where a new scene begins, which is exactly where an early voice shows. The service therefore also runs the Silero speech detector that ships with faster-whisper over the extracted audio, right after ffmpeg; `GET /api/jobs/{id}/speech` returns the spans as `[[start, end], …]` in seconds. It takes about half a second per two minutes of sound, leaves the transcript untouched and does not change what "Stille überspringen" means. The page moves a segment start that falls into silence to where speech resumes, and an interpolated sentence start to a speech onset within 0.6 s, if there is one. Word timestamps would sharpen the times further, but in a test they changed the transcript itself — a sentence went missing — so they stay off.

| Variable | Default | Meaning |
|---|---|---|
| `WHISPER_MODELS` | `tiny,base,small` | models offered in the page, in that order |
| `WHISPER_MODEL` | `small` | preselected model; must be one of `WHISPER_MODELS` |
| `WHISPER_COMPUTE` | `int8` | CTranslate2 compute type, for example `int8`, `int8_float32`, `float32` |
| `WHISPER_THREADS` | `4` | CPU threads for transcription; leave room for speech synthesis |
| `WHISPER_IDLE_MINUTES` | `30` | the loaded model is released again after this idle time |
| `WHISPER_KEEP_HOURS` | `24` | uploaded files are deleted after this idle time |
| `WHISPER_MAX_UPLOAD_GB` | `8` | largest accepted file |

Known model names are `tiny`, `base`, `small`, `medium`, `large-v3-turbo` and `large-v3`; any other CTranslate2 Whisper repository on Hugging Face also works, it just has no size label in the page. Models are downloaded on first use into the `tav-whisper-models` volume, so the first job with a new model waits for the download — the page says so while it happens. Uploaded files live in `tav-whisper-data`. Job state is kept in memory, so a restart forgets finished transcripts; uploaded files survive.

Rough transcription times measured on this Intel NUC with four threads and `int8`, as a multiple of the recording length: `tiny` 0.08, `base` 0.15, `small` 0.30. `medium` and the `large` models are usable but slow enough that a long film takes longer than watching it.

## Audio Sample

The main v1.1/v1.2 German normalization sample is hosted on Hugging Face:

[martin-onnx-beispiel-v1.1.mp3](https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin/resolve/main/martin-onnx-beispiel-v1.1.mp3)

Spoken text:

> Zum 14.05.2026 um 18:20 Uhr ist das Abendessen geplant. Für den Auflauf brauchen wir 1,5 kg Kartoffeln, 500 g Quark, 2 Eier, 1 ltr. Milch und ggf. 3 cm mehr Backpapier. Prof. Klein sagt: "Bitte stelle die Form auf die 2. Schiene, backe alles für 45 Min. und lass es danach 1 Min. oder auch 2 Min. ruhen." Die Kosten liegen bei ca. 12,80 EUR zzgl. Pfand.

## Changelog

### v1.4 (September 2026)

- The web UI follows the work in tabs instead of one long page of twelve panels: "Text"
  (voice-over script with its preview side by side, pause lengths and pronunciation below),
  "Schnitt" (the clips and the cutting window, with the preview next to the picture so the
  cursor runs along), "Export" (audio, and video with its subtitles inside). Transcription,
  joining videos, projects & files and the guide are tabs of their own. Only one tab is visible;
  the last one is remembered, the address names it (`#schnitt`), and links in the texts open
  the tab they point to. The page is wider on large screens.
- Nothing gets lost on reload any more: the script, tempo, hand-set pauses and the film the
  pauses follow are kept in the browser and restored, audio included from the speech cache.
  The example text only appears on a first visit and after "Alles zurücksetzen".
- The header names the open project and whether it is saved; "Speichern" or `Ctrl+S` stores it,
  a new project asks for its name first. Leaving the page with unsaved changes or a running
  upload asks first.
- Shorter paths: "Ton speichern" right next to "Audio erzeugen", `Ctrl+Enter` speaks from
  anywhere, and the video export starts from a preset ("Standard", "Klein", "Hohe Qualität",
  "Hochkant") with the individual settings folded away.
- Fixed: a pause changed in the preview did not rebuild the audio, so player and download kept
  the old length; "Audio erzeugen" right after typing spoke the previous text and failed with
  "Abschnitte fehlen im Zwischenspeicher"; loading the pronunciation list threw away hand-set
  pauses; free space showed as "645578 MB" instead of "630 GB".
- `webui/index.html` is split into markup, `tav.css` and one script per area under `webui/js/`;
  `tests/ui/run.sh` builds the page and walks through the main workflows with Playwright.

### v1.3 (September 2026)

- The "Schnittfenster" can take a stretch out of the middle of a clip, not just trim its ends:
  "Marke setzen" marks where it starts, the playhead says where it ends, and "Stück entfernen"
  drops it. The timeline, the picture and the length follow at once, a dashed line marks the seam,
  and "Ganzer Clip" brings everything back. Nothing happens to the uploaded file — the cut travels
  with the job, like the trim and the freeze frames, so the same file can still appear twice with
  different cuts. See "Video Service".
- Every exported video begins and ends with a still, silent frame — two seconds by default,
  adjustable in "Video exportieren". The voice starts behind it, subtitles move with it, and the
  timeline shows both as dashed boxes.
- New panel "Videos zusammenfügen" joins finished videos: tick what belongs together, put it in
  order, pick a transition, and the parts are encoded into one film. The crossfade takes its time
  from the still frames at the end of one part and the start of the next, so no word is lost in it;
  the parts keep their own sound. The result lies on the server like any other video and can be
  joined again.
- Every chapter has its own strong colour: it carries the title bar and frames the whole open
  panel, so it is clear at a glance where a chapter begins and ends. The explanation of each chapter
  now starts collapsed behind "Erklärung" — the panels are a screenful shorter, and the text is
  still one click away.
- A transcript becomes a speech text with the film's pauses in it, and Martin speaks each sentence
  where the original speaker did. The panel used to offer flowing text with a blank line wherever
  the recording paused for a second — but without word timestamps Whisper rounds its segment times
  to whole seconds and runs one segment into the next, so on the 1:49 min screen recording this was
  built against only one gap reached a second, and Martin read the whole film as one paragraph that
  drifted away from the picture. The new default form, "Mit Pausen", writes one sentence per line
  and the silence before it as a `(Pause: … s)` line, sized from where the sentence starts in the
  film and how long Martin needs for the one before; after "Audio erzeugen" those lengths are
  measured instead of estimated and the page rewrites the lines, and a freeze frame or a trim in the
  "Schnittfenster" moves them along. On that recording every sentence then starts within 0.02 s of
  its place in the film wherever Martin keeps up, the ten seconds of silence in the middle take up
  the almost six seconds he falls behind in the fast passage before it, and the voice track is
  109.05 s long for a 109.07 s film. See "Transcription Service". The form choice is stored under a
  new key, so a browser that remembered "Fließtext" starts on the new form once.
- `tav-whisper` also says where in the recording someone speaks: the Silero speech detector that
  ships with faster-whisper runs over the extracted audio, and `GET /api/jobs/{id}/speech` returns
  the spans. The page uses them for the sentence starts, because after a long silence Whisper puts
  a segment's start early — on the recording above at 56.00 s for speech that resumes at 57.8 s,
  which would have had Martin talking over a silent screen. The transcript itself is unchanged.
- Choosing, dropping or fetching a file in "Abschrift aus Video" starts the transcription as soon as
  the file is on the server; "Abschrift erstellen" is only needed to run it again with other
  settings. The panel now starts out on German, "Gründlich" and without "Stille überspringen"; the
  model is still the one the service names (`WHISPER_MODEL`, "Mittel" = `small`).
- "Audio erzeugen" no longer starts playing when it is done. The track lies in the player and in
  the "Schnittfenster" and plays when someone presses play.
- A `(Pause: …)` line may now be up to 600 s long instead of 30 s, so a long silent stretch in a
  film can be reproduced; longer values are still capped.
- Subtitles keep to the number of lines set, split evenly and at sensible places, and the preview
  shows them the way the video will. The page used to cut a segment into chunks of "lines × characters"
  and then wrap each chunk greedily — which regularly needed a third line — and filled every cue to
  the brim, leaving a lone "zur Verfügung." for the last one. Now the smallest number of cues is
  chosen first and the words are spread over them evenly, preferring seams after punctuation and
  before "und", "oder", articles and prepositions; see "Video Service". The page measures in the same
  DejaVu files and at the same pixel size as the video, so no line is wider than the picture either.
  The preview was a flat 4.7:1 strip with the text sized to its height, so text and box looked nothing
  like the result; it is now a scaled-down frame of the video, in its aspect ratio and font.
- Every file the tool makes for a project is named after it, with an uppercase `TAV` in front: the
  video, the voice track on the server (until now always `sprachausgabe.wav`), the audio export
  (`sprachausgabe.<ext>`), the project file (`kokoro-sprechtext-<date>.json`) and each file of a batch
  (`kokoro-<file>`). A prefix the name already has — `TTS_` on the speech texts — is replaced instead of
  stacked: `TTS_01_Anlage_Kurzarztbrief` becomes `TAV_01_Anlage_Kurzarztbrief.mp4`, not
  `tav-TTS_01_…`. Uploaded clips and the speech text keep their own names; they are the material, not
  the output.
- Fixed the subtitle box missing from the exported video, and gave it rounded corners. The ASS
  file asked libass for its opaque box (`BorderStyle 3`), which takes the *outline* colour and uses
  the outline width as its padding: the chosen box colour went into a field that box never reads,
  and with the outline at 0 nothing was drawn at all — white text straight on a bright screen
  recording, while the preview showed a box. The service now draws the box itself, as a rounded
  rectangle on a layer beneath the text, sized from the lines measured with Pillow and the DejaVu
  files libass uses; see "Video Service". The preview uses the same padding, the same rounding and
  libass's size rule (the size is a line's height, the em is 1.164 times smaller), so it shows the
  text at the size the video will have instead of about 16 % larger.
- "Neues Projekt" in the menu starts over with an empty page: speech text, clips and audio are
  cleared, while every setting stays — format, subtitles and pause lengths carry over to the next
  video. Nothing on the server is touched; the project that was open simply is not open any more, so
  "Geöffnetes überschreiben" cannot write the new one over it. It asks first when there is something
  to lose, and refuses while an upload, an encode or an audio export is running. Unlike "Alles
  zurücksetzen" it keeps the transcript and the batch, which are tools of their own.
- The finished video (`.mp4` or `.webm`) is named after the project instead of `video.mp4`, with
  the `TAV` prefix described above; without an open project it takes the speech text's name. The
  panel is now called "Video exportieren mit Sprachausgabe".
- TAV has an icon: three lines of text on the left, and a play triangle sliced into sound bars on
  the right — text becomes audio becomes video. At tab size the slices vanish and a clean triangle
  remains. It sits in front of the name in the header and is the browser tab icon (`webui/tav.svg`,
  in the page's blue); `favicon.ico` (16/32/48 px) and `tav-180.png` for Apple devices are rendered
  from it with Chrome and have to be redone when the SVG changes. The header now reads "TAV"
  followed by "Text to Audio to Video MultiTool" in smaller, lighter type, without the brackets.
- Fixed clips staying black for minutes in the "Schnittfenster" when the page is opened from a
  remote machine. Every request for a clip — the file itself included — set the file's modification
  time to "now", to postpone the old age-based cleanup. That changed the `ETag` and
  `Last-Modified` of the file on every request, and Chromium, which validates the pieces of a video
  it has cached with `If-Range`, was told each time that its pieces were stale and got the whole
  file again (`200` instead of `206`): a 120 MB clip was fetched from the start over and over, and
  over a home uplink that took minutes. Only the `.json` next to a clip is touched now, the cleanup
  (still off with `VIDEO_KEEP_HOURS=0`) judges a clip and its description as a pair, and the file is
  served as `private, immutable`. Firefox did not send `If-Range` and was not affected.
- Loading a project brings its audio along. The page used to clear the audio and wait for "Audio
  erzeugen", so a loaded project played silent in the "Schnittfenster" until someone thought of the
  button in another panel. It now fetches the audio right away — from the speech cache, synthesizing
  only what is missing — and a synthesis still running for the previous text is stopped first.
- The "Schnittfenster" says what is still on its way, in the top left corner of the picture: the
  clip while the browser fetches it (with how much of the clip it already holds) and the audio while
  it comes in segment by segment, each with a bar. A short wait shows nothing, so stepping through
  frames does not make it flicker.
- The speech service keeps what it has spoken. Every sentence the web UI synthesizes lies in
  `tav-onnx` as a file, keyed by exactly what goes into the model, and "Audio erzeugen" only
  synthesizes what is missing: after a reload, a loaded project or a new sentence pause the audio is
  back in seconds instead of a full pass, and editing one sentence in a long segment re-speaks that
  sentence rather than the whole segment. The same sentence also sounds the same every time now,
  where Kokoro used to vary slightly from pass to pass. The status line says how many sentences were
  new and how many were already on the server; "Auf dem Server" shows the cache with its size and a
  button to empty it; `KOKORO_CACHE_GB` (default 4) caps it and drops the least recently used
  sentences first. Home Assistant is not cached. See "Speech Cache" above.
- A voice track lies on the server only once. Rendering a video uploaded the voice-over again
  whenever the page had been reloaded, and now that nothing expires, those copies would have piled
  up under "Tonspuren". `tav-video` now hashes each voice upload and answers with the track it already has,
  and over HTTPS the page sends the hash first and skips the upload entirely.
- Every place that opens a file has a second button beside it: "Vom Server holen". The same picker
  opens at all three — speech text, transcription, clips — and shows only what fits there, with the
  size, the date and how many projects still need it. Clips can be picked several at a time and come
  in in the order they were clicked; nothing is uploaded again, the id is enough, so a clip from
  another project is in the list and on the timeline at once. In the menu, "Projekt vom Server holen"
  jumps to the panel where the projects are. The speech text also got the "Textdatei wählen" button
  it never had — until now it could only be dragged in.
- The speech text lies on the server as a file now, not only as a string inside the project. Reading
  a `.md` into the page puts a copy under `/api/texts` in `tav-video`, saving a project puts the
  current text there, and "Auf dem Server ablegen" does it on command; the same text under the same
  name is stored once, not twice. It then stands in "Auf dem Server" like a clip — with size, date
  and the projects that use it — and comes back into the field with "Holen". Before this, the one
  file everything starts with was the one file the panel did not show.
- The same file may lie on the server twice, and the panel now says so instead of looking like a
  mistake. `tav-whisper` and `tav-video` have separate stores, so "Als Clip übernehmen" uploads the
  video a second time — once to transcribe, once to cut. Both halves now share one row: "Abschrift +
  Clip", with the space the two of them take, and deleting the row deletes both.
- Loading a project puts its clips on the timeline reliably. The picture element remembered which
  *clip* it was showing, not which *address* — so a clip that finished uploading kept the address of
  the local file, which had just been handed back, and the "Schnittfenster" stayed black until
  something else happened to reload it. It now remembers the address. Loading a project, taking a
  clip over from the transcription or fetching one from the server also puts the playhead at the
  start and opens the panel, instead of leaving the clip in the list and the picture folded away.
- Taking a clip out of the list no longer deletes it from the server. It deleted the file outright,
  which silently emptied every saved project that still pointed at it — while loading a project,
  which replaces the whole list, deliberately left the old files alone. The ✕ now only takes the row
  out; deleting is what "Auf dem Server" is for, and it is the place that says who still needs the
  file.
- The server keeps things now. `VIDEO_KEEP_HOURS` and `WHISPER_KEEP_HOURS` are `0`, so nothing is
  swept away after a day; the new "Auf dem Server" panel lists the clips, voice tracks, finished
  videos and transcription files with size, date, how many projects still need them and the free
  space left, and deletes them one by one on confirmation. The same panel holds projects: the
  working state that "Projekt exportieren" writes to a file, stored in `tav-video` instead, so it
  opens again at any desk without going through the download folder — save, overwrite, load, delete.
  "Alles zurücksetzen" no longer deletes uploads, because they may belong to a saved project.
- New "Untertitel" panel burns the speech text into the picture. Each segment appears where it is
  spoken — the times come from the same calculation as the voice track, not a second estimate — and
  long segments are split at sentence ends, then commas, then spaces, to the line length set in the
  panel. Font, size, colour, bold, outline, position, margin and a box behind the text with an
  adjustable opacity are all settings, with a preview that shows what the picture will look like.
  ffmpeg burns them in last, over the finished cut, via an ASS file the service writes. The subtitle
  shows the written word, not the phonetic one: a rule like `(Chefarzt|Schähfarzt)` steers the voice,
  while the picture keeps "Chefarzt".
- Clips can be trimmed and held still, from the "Schnittfenster" panel. "Anfang hier" and "Ende hier"
  cut the clip under the playhead at that frame, "Ganzer Clip" takes the cut back, and "Standbild
  einfügen" freezes the picture there for the seconds set beside the button — the answer to a
  sentence that runs longer than the shot. The timeline recomputes immediately, a held stretch shows
  as a red band inside the clip, and the picture in the preview stops there instead of running on.
  Nothing happens to the uploaded file: the cut travels with the job, so the same file can appear
  twice with different cuts, and ffmpeg applies it while encoding. The project file now carries the
  clip list — ids, names and cuts — so an export restores the edit, not just the settings.
- Changing a pronunciation rule now re-speaks the segments that use the word, on its own. The cache
  is keyed by segment text, so a changed rule already meant a cache miss for exactly those segments;
  the page now acts on it a moment after the last keystroke instead of waiting for the next "Audio
  erzeugen". Untouched segments stay as they are, a running pass is followed by another rather than
  interrupted, and nothing is spoken before the first full run — a half-typed rule should not kick
  off a pass over the whole text.
- A pause dragged on the timeline is now written into the speech text as a `(Pause: 3 s)` line, so
  it survives "Text als Markdown speichern" and is visible where the rest of the text is. It stood
  only in the page's parts list before, which the exported file knows nothing about. The line is
  written when the handle is released, not while dragging; a pause that already has one gets its
  number updated rather than a second line; "Pause entfernen" takes the line back out. The number
  field in "Vorschau" is unchanged — it stays the quiet nudge that "Pausen zurücksetzen" collects.
- Fixed "Pause einfügen" never inserting anything. It looked for seams among the gaps on the voice
  track, but `layout()` only puts a pause there once it is longer than 0 s — so every seam it could
  find already had a pause, and the button only ever answered "steht schon eine Pause". Seams where
  the pause is 0 s sit inside a segment, between two of its pieces, and are now found as well.
- New "Aussprache" panel for the pronunciation rules that apply to *every* speech text. Until now a
  line `(Chefarzt|Schähfarzt)` had to be repeated at the end of every file; the list in the panel is
  kept by `tav-onnx` under `/v1/aussprache`, loaded when the page opens and saved on its own a
  moment after the last keystroke, so it is the same at every desk and for every project. The rules
  of the text still win over it for the same word, and the longest rule still wins between different
  ones — a general ruling can be overridden for one text without changing it for the others. A ▶
  button next to each rule speaks the pronunciation on its own, at the speed set in "Sprechertext",
  so a spelling can be tried out without synthesizing the whole text. See "Pronunciation List"
  above.
- "Text als Markdown speichern" writes the speech text back out as an `.md` file, with its Markdown,
  its round brackets and its pronunciation lines — the same file that came in. If the text came from
  a file, it keeps that file's name (the transcript of `film.mp4` becomes `film.md`), otherwise the
  file carries the date. This is the way back now that the "Schnittfenster" panel edits the speech
  text: what is changed on the timeline is changed in the text, and the text can be saved again.
  The project JSON carries the file name along, so an import restores it.
- The "Schnittfenster" panel edits the speech text where the cutting happens. Clicking a segment on
  the voice track opens the line it came from — the raw line, with its Markdown, its round brackets
  and its pronunciation rules, because the cleaned-up sentence on the track cannot be written back
  without losing all of that. Typing mirrors into "Sprechertext" a moment later, and a moment after
  that the voice re-speaks — only the changed segment, since the cache is keyed by segment text. A
  line break in the field splits the segment in two, an empty field removes it, `Escape` puts the
  field away. Re-speaking only happens once "Audio erzeugen" has run, so a typo cannot kick off a
  first pass over the whole text. Manually dragged pauses survive the re-parse, and the field
  refuses to write back if the speech text changed underneath it.
- Each segment on the voice track now says where its audio stands: filled means the audio is there,
  hatched means it has not been spoken yet and its length is an estimate, and the warning colour
  with moving stripes means the voice is working on it right now. A legend under the timeline spells
  the three out, and the states update segment by segment while synthesis runs, so the timeline also
  works as a progress display.
- The burger menu has an "Alles zurücksetzen" item that puts the page back to how it looks on a
  first visit: speech text, pauses, batch, clips and transcript are dropped, every setting returns
  to its default, and the uploaded clips, voice track and transcription media are deleted on the
  video and transcription services. Only the colour choice survives. It asks first, and it refuses
  while synthesis, a batch, an export, an upload, an encode or a transcription is running, because
  clearing mid-step would leave half-written files on the server. The reset removes the page's
  `localStorage` entries and reloads, so the state is the first-visit state rather than a hand-made
  imitation of it.
- The "Schnittfenster" panel has a fullscreen mode, on the ⛶ button at the right of the transport
  bar or the `F` key, with `Escape` to leave. The whole panel goes fullscreen rather than just the
  picture — without the transport bar and the timeline there would be nothing left to search with.
  The picture then takes whatever height the controls leave instead of holding its 16:9 box, and
  focus moves to it so `J`, `K` and `L` keep working.
- Fixed "Audio erzeugen" failing with a raw HTML 502 on a busy machine. The page answers a speech
  request only once the segment has been spoken, and `oauth2-proxy` waits 30 s for the response
  headers by default, so a segment that took longer — up to 118 s under load — was cut off and
  answered with the proxy's own error page. `OAUTH2_PROXY_UPSTREAM_TIMEOUT` is now `600s`, above
  the 300 s nginx already allows for `/v1/`, so the login in front is no longer the narrower limit.
  A 502, 503 or 504 is also no longer dumped into the page as markup but named for what it is.
- The "Abschrift aus Video" panel can hand its file to the clip list: "Als Clip übernehmen" adds the
  same video under "Video mit Sprachausgabe", where the "Schnittfenster" picks it up. The two services
  keep separate storage, so the file is uploaded a second time — but it is only chosen once. The button
  stays hidden for audio-only files and, after a reload, says that the file has to be chosen again,
  because by then the browser no longer holds it.
- The stack can be deployed straight from a Git repository (e.g. as a Portainer *repository*
  stack), so the compose file in Git is the only copy. The two model files stay out of Git;
  `onnx-docker/Dockerfile` downloads them during the build and verifies their SHA-256 sums,
  which is what makes a build from a bare clone possible.
- Removed every host bind mount. Portainer builds the stack inside its own clone, and a relative
  source such as `./webui/index.html` is resolved by the Docker daemon on the *host*, where that
  path does not exist — the daemon then silently creates an empty directory and mounts it over the
  file. `german_text_rules.py` is now copied into the speech and Wyoming images, and the page is
  its own image built from `webui/Dockerfile` instead of four files mounted into `nginx:alpine`.
  Only named volumes are left. The practical consequence: editing `webui/index.html` no longer
  shows up on a browser reload — the change has to be committed, pushed and the stack redeployed.
- Renamed the project to **TAV (Text to Audio to Video MultiTool)**: the page title and the
  containers, which are now `tav-onnx`, `tav-wyoming`, `tav-webui`, `tav-video` and `tav-whisper`.
  The stack is deployed from this `docker-compose.yml` as the Compose project `tav`.
- Each service says which model and library version it runs: `GET /v1/info` on the speech service
  and the `engine` block of `GET /whisper/api/info`. Clicking the "Kokoro AI" or "Whisper AI" badge
  in a panel header shows it.
- Moved the colour switch, "Anleitung", "Projekt exportieren" and "Projekt importieren" into a
  burger menu in the header.
- Added `kokoro-whisper`, a faster-whisper transcription service, and the "Abschrift aus Video" panel.
- Added batch synthesis: dropping several Markdown files on the "Sprechertext" panel produces one
  audio file per Markdown file, named `kokoro-<file>.<ext>` and delivered as a single ZIP.
- Added a button that hands out the writing guide as `SPRECHTEXT-ANLEITUNG.md`.
- Reworked the page chrome: each panel header now names the tool behind it (Whisper, Kokoro, ffmpeg,
  browser) and the running figures moved into the panel bodies; "Pausenlängen", "Audio exportieren"
  and "Video mit Sprachausgabe" explain how they work; the page is now called "TAV (Text to Audio to Video MultiTool)".
- Added a light/dark switch in the header. It cycles between following the system, light and dark,
  and the choice is remembered in the browser.
- "Video herunterladen" now checks that the job is still on the server before starting, and says what is wrong instead of failing silently: an expired login (the proxy answers with a redirect to the login page), a restarted video service, or a file past `VIDEO_KEEP_HOURS`.
- Added the "Schnittfenster" panel: an editing timeline that lays the video clips and the spoken
  text on one time base. It jogs and shuttles frame by frame (jog wheel, J/K/L, arrow keys), shows
  the frame in the browser, and puts a cursor in the "Vorschau" on the word spoken at that frame.
  Pauses sit on the voice track as boxes whose right edge can be dragged, so changing, adding or
  removing a pause shifts picture and text against each other at once, without re-synthesis.
  Segment lengths are measured once spoken and estimated (drawn hatched) before that. Nothing is
  encoded; the panel uses the same arithmetic as the video service, so it shows what will come out.
- Added `GET /video/api/clips/{id}/file`, which serves an uploaded clip back with Range support so
  the timeline can play and seek in it after a reload.
- Transcripts can be saved as text, SRT or VTT, or handed straight to the speech-text field.
- Factored the chunked upload used by the video and transcription panels into one shared helper.

### v1.2 (May 2026)

- Replaced thread-based parallel sentence synthesis with process-isolated Kokoro workers.
- Avoids sharing Kokoro, espeak and tokenizer state across worker threads, addressing possible word-order corruption under parallel synthesis.
- Added ONNX Runtime session tuning via `KOKORO_ONNX_INTRA_OP_THREADS`, `KOKORO_ONNX_INTER_OP_THREADS`, `KOKORO_ONNX_EXECUTION_MODE`, `KOKORO_ONNX_GRAPH_OPT` and `KOKORO_ONNX_ALLOW_SPINNING`.
- Added background warm-up for process workers.
- Added `KOKORO_WORKERS` as the public knob for parallel synthesis workers.

### v1.1 (May 2026)

- Added German text normalization before synthesis.
- Added decimal units, singular/plural unit handling, Euro amount handling and improved abbreviation support.
- Added better ordinal/cardinal handling in contexts such as dates, quarters, tracks, chapters and numbered labels.
- Fixed sentence pauses around common German abbreviations and dotted unit abbreviations.

### v1.0

- Initial ONNX conversion and Docker/FastAPI service setup.

## License And Credits

The model is published under Apache 2.0 on Hugging Face. Please credit the original model authors and upstream projects when using this setup:

- [kikiri-tts/kikiri-german-martin](https://huggingface.co/kikiri-tts/kikiri-german-martin)
- [dida-80b/kokoro-german-hui-multispeaker-base](https://huggingface.co/dida-80b/kokoro-german-hui-multispeaker-base)
- [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
- [Godelaune/Kokoro-82M-ONNX-German-Martin](https://huggingface.co/Godelaune/Kokoro-82M-ONNX-German-Martin)
