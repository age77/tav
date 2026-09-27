// TAV · Abschrift mit Whisper und Neuvertonung nach dem Film.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Abschrift aus Video ---------- */

// Mitgeschrieben wird im Dienst tav-whisper, erreichbar unter /whisper/.
// Er liefert Abschnitte mit Zeitmarken; Text, SRT und VTT entstehen hier im
// Browser, damit sich die Textform ohne einen neuen Lauf aendern laesst.
const WAPI = '/whisper/api';
const WSTORE = 'kokoro.abschrift.v1';
const wApi = apiFor(WAPI);
const wEl = id => $('w-' + id);
const W_OPTS = { model: 'models', language: 'languages', task: 'tasks', speed: 'speeds' };
// Voreingestellt ist ein deutscher Film, gruendlich mitgeschrieben und ohne
// Stille zu ueberspringen (das Kaestchen steht im HTML). Das Modell nennt der
// Dienst selbst, siehe WHISPER_MODEL.
const W_DEFAULTS = { model: '', language: 'de', task: 'transcribe', speed: 'thorough' };

// Rechenzeit im Verhaeltnis zur Tonlaenge. Gemessen auf diesem Rechner mit
// vier Faeden und int8 (tiny 0,08 · base 0,15 · small 0,30), mit Luft nach
// oben, weil nebenher gesprochen und kodiert wird. Reicht, um vor einem
// langen Film zu warnen; die Modelle ohne Messwert sind geschaetzt.
const W_PACE = { tiny: 0.12, base: 0.22, small: 0.45, medium: 1.4, 'large-v3-turbo': 0.7, 'large-v3': 2.8 };

// Textform: so wird aus den Abschnitten der Text im Feld. "Mit Pausen" ist der
// Sprechertext zum Neuvertonen: ein Satz je Zeile, dazwischen die Stille als
// Zeile "(Pause: … s)" wie in der Anleitung - so lang, dass Martin dort
// einsetzt, wo im Film gesprochen wurde (siehe "Neu vertonen" weiter unten).
// "Fliesstext" macht aus laengerem Schweigen nur eine Leerzeile.
const W_FORMS = [['pausen', 'Mit Pausen — Sprechertext zum Neuvertonen'],
                 ['flow', 'Fließtext — Absatz bei längerer Pause'],
                 ['lines', 'Eine Zeile je Abschnitt'],
                 ['stamps', 'Mit Zeitmarken']];
const W_FILES = [['txt', 'Text (.txt)'], ['srt', 'Untertitel (.srt)'], ['vtt', 'Untertitel (.vtt)']];
const W_MIME = { txt: 'text/plain;charset=utf-8', srt: 'text/plain;charset=utf-8', vtt: 'text/vtt;charset=utf-8' };

let wInfo = null;
let wMedia = null;       // {key, name, size, file?, id?, meta?, local?, state, sent, error}
let wJob = null;
let wSegs = [];          // {start, end, text}
let wSprache = [];       // [von, bis]: wo laut Stilleerkennung gesprochen wird, in Sekunden

async function initWhisper() {
  try { wInfo = await wApi.get('/info'); }
  catch (e) { wEl('offline').hidden = false; wEl('body').hidden = true; return; }

  W_DEFAULTS.model = wInfo.default_model;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(WSTORE) || '{}') || {}; } catch (e) { /* egal */ }
  for (const [key, list] of Object.entries(W_OPTS)) {
    const sel = wEl(key);
    sel.innerHTML = wInfo[list].map(o => '<option value="' + o.id + '">' + esc(o.label) + '</option>').join('');
    const want = String((saved.options || {})[key] ?? W_DEFAULTS[key]);
    sel.value = wInfo[list].some(o => String(o.id) === want) ? want : String(wInfo[list][0].id);
    sel.onchange = () => { wSave(); wUpdateButton(); };
  }
  wEl('form').innerHTML = W_FORMS.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  wEl('format').innerHTML = W_FILES.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  // Bis es "Mit Pausen" gab, hiess der Eintrag "form" und stand fast immer auf
  // Fliesstext, der damaligen Voreinstellung. Gelesen wird darum nur der neue.
  if (W_FORMS.some(f => f[0] === saved.textform)) wEl('form').value = saved.textform;
  if (W_FILES.some(f => f[0] === saved.format)) wEl('format').value = saved.format;
  if (isFinite(saved.gap) && saved.gap >= 0) wEl('gap').value = saved.gap;
  if (typeof saved.vad === 'boolean') wEl('vad').checked = saved.vad;
  wEl('hint').maxLength = wInfo.max_hint;
  if (typeof saved.hint === 'string') wEl('hint').value = saved.hint.slice(0, wInfo.max_hint);

  wEl('vad').onchange = wEl('hint').oninput = wSave;
  wEl('format').onchange = wSave;
  wEl('form').onchange = wEl('gap').oninput = () => { wSave(); wShowText(); };

  wEl('add').onclick = () => wEl('file').click();
  wEl('file').onchange = () => { wSetFile(wEl('file').files[0]); wEl('file').value = ''; };
  wEl('srv').onclick = wVomServer;
  const box = $('sec-abschrift');
  box.ondragover = e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('dragover'); } };
  box.ondragleave = e => { if (!box.contains(e.relatedTarget)) box.classList.remove('dragover'); };
  box.ondrop = e => {
    box.classList.remove('dragover');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    wSetFile(e.dataTransfer.files[0]);          // mitgeschrieben wird eine Datei nach der anderen
  };
  wEl('go').onclick = wStart;
  wEl('cancel').onclick = wCancel;
  wEl('toclip').onclick = wToClip;
  wEl('use').onclick = () => wToText(false);
  wEl('append').onclick = () => wToText(true);
  wEl('copy').onclick = wCopy;
  wEl('save').onclick = wDownload;

  // Datei vom letzten Besuch, sofern der Server sie noch hat.
  if (saved.media) {
    try {
      const meta = await wApi.get('/media/' + encodeURIComponent(saved.media));
      if (meta.done) wMedia = { key: meta.id, name: meta.name, size: meta.size, id: meta.id, meta, state: 'ready' };
    } catch (e) { /* abgelaufen */ }
  }
  wShowText();                                  // blendet das Absatzfeld zur Textform ein
  wRender();
}

function wSave() {
  try {
    localStorage.setItem(WSTORE, JSON.stringify({
      options: Object.fromEntries(Object.keys(W_OPTS).map(k => [k, wEl(k).value])),
      vad: wEl('vad').checked, hint: wEl('hint').value,
      textform: wEl('form').value, gap: Number(wEl('gap').value) || 0, format: wEl('format').value,
      media: wMedia && wMedia.state === 'ready' ? wMedia.id : null
    }));
  } catch (e) { /* ohne Gedaechtnis */ }
}

function wOptions() {
  return { model: wEl('model').value, language: wEl('language').value, task: wEl('task').value,
           speed: wEl('speed').value, vad: wEl('vad').checked, hint: wEl('hint').value.trim() };
}

function wBusy() { return !!wJob && ['queued', 'running'].includes(wJob.status); }

/* ----- Datei waehlen und hochladen ----- */

// Wer eine Datei waehlt oder hierher zieht, will sie mitgeschrieben haben:
// die Abschrift beginnt, sobald sie hochgeladen ist, mit den Einstellungen,
// die gerade gelten. Die Datei vom letzten Besuch beginnt nicht von selbst.
function wSetFile(file) {
  if (!file || !wInfo || wBusy()) return;
  wDrop();
  wMedia = { key: Math.random().toString(36).slice(2), name: file.name, size: file.size, file,
             state: 'waiting', sent: 0, gleich: true };
  if (file.size > wInfo.max_upload) { wMedia.state = 'error'; wMedia.error = 'Zu groß für den Server.'; }
  wLocalMeta(wMedia);
  wRender();
  wUpload();
}

// Eine Datei, die schon beim Abschriftdienst liegt, noch einmal nehmen: nach
// einem Neustart des Browsers oder an einem anderen Platz. Hochgeladen wird
// dabei nichts - sie ist ja schon da.
async function wVomServer() {
  if (!wInfo || wBusy()) return;
  const [e] = await pickVom({
    titel: 'Datei für die Abschrift vom Server holen',
    hinweis: 'Was beim Abschriftdienst liegt. Clips des Videodienstes stehen nicht darunter: '
           + 'beide Dienste haben getrennte Ablagen, für die Abschrift muss die Datei hier liegen.',
    arten: ['media'],
    leer: 'Nichts beim Abschriftdienst — bitte eine Datei wählen.'
  });
  if (!e || (wMedia && wMedia.id === e.id)) return;
  let meta;
  try { meta = await wApi.get('/media/' + encodeURIComponent(e.id)); }
  catch (err) { note('Nicht geholt: ' + err.message); return; }
  wDrop();                                      // die bisherige Datei samt Abschrift weg
  wMedia = { key: Math.random().toString(36).slice(2), name: meta.name, size: meta.size,
             id: meta.id, meta, state: 'ready' };
  wSave();
  wRender();
  note('Vom Server: ' + meta.name);
  wStart();                                     // sie liegt schon da, also gleich mitschreiben
}

// Vergisst die bisherige Datei samt Abschrift und raeumt sie auf dem Server ab.
function wDrop() {
  const old = wMedia;
  wMedia = null; wJob = null; wSegs = []; wSprache = [];
  if (old && old.id) wApi.get('/media/' + old.id, { method: 'DELETE' }).catch(() => {});
  wEl('result').hidden = true;
  wEl('out').value = '';
  wEl('note').textContent = '';
  wEl('note').classList.remove('err');
  wEl('lang').textContent = '';
  wEl('prog').hidden = true;
  wEl('cancel').hidden = true;
}

function wClear() {
  if (wBusy()) return;
  wDrop();
  wSave();
  wRender();
}

// Die Dauer liest schon der Browser, damit die Zeile etwas sagt, bevor der
// Server die Datei gesehen hat.
function wLocalMeta(m) {
  const el = document.createElement('video'), url = URL.createObjectURL(m.file);
  el.preload = 'metadata'; el.muted = true;
  const done = () => { URL.revokeObjectURL(url); el.removeAttribute('src'); };
  el.onloadedmetadata = () => {
    if (isFinite(el.duration)) m.local = { duration: el.duration, has_video: el.videoWidth > 0 };
    done();
    if (wMedia === m) wRender();
  };
  el.onerror = done;
  el.src = url;
}

async function wUpload() {
  const m = wMedia;
  if (!m || m.state !== 'waiting') return;
  m.state = 'uploading';
  wRender();
  try {
    m.meta = await wApi.upload('media', wInfo.part_size, m.file, m.name,
                               sent => { m.sent = sent; wProgress(m); }, () => wMedia !== m);
    m.id = m.meta.id;
    m.state = 'ready';
    // Die Datei auf der Platte bleibt angehaengt, damit sie sich ohne zweites
    // Waehlen als Clip uebernehmen laesst. Sie kostet nichts: das ist ein
    // Verweis, keine Kopie im Speicher.
    if (wMedia !== m) wApi.get('/media/' + m.id, { method: 'DELETE' }).catch(() => {});
  } catch (e) {
    m.state = 'error';
    m.error = e.message;
  }
  wSave();
  if (wMedia !== m) return;
  wRender();
  if (m.state === 'ready' && m.gleich) wStart();
}

/* ----- Anzeige ----- */

function wDescribe(m) {
  const meta = m.meta || m.local, parts = [];
  if (meta) {
    parts.push(fmtTime(meta.duration));
    if (m.meta) {
      parts.push(meta.has_video ? 'mit Bild' : 'nur Ton', (meta.acodec || '').toUpperCase());
      if (meta.channels) parts.push(meta.channels === 1 ? 'Mono' : meta.channels === 2 ? 'Stereo'
                                                                 : meta.channels + ' Kanäle');
    }
  }
  parts.push(fmtBytes(m.size));
  if (m.state === 'waiting') parts.push('wartet auf Hochladen');
  if (m.state === 'uploading') parts.push('lädt hoch… ' + Math.round(100 * m.sent / m.size) + ' %');
  if (m.state === 'error') parts.push(m.error);
  return parts.filter(Boolean).join(' · ');
}

function wProgress(m) {
  const li = wEl('list').querySelector('li');
  if (!li) return;
  li.querySelector('.meta').textContent = wDescribe(m);
  const bar = li.querySelector('progress');
  if (bar) bar.value = m.sent / m.size;
}

function wRender() {
  const m = wMedia;
  wEl('list').innerHTML = !m ? '' :
    '<li><span class="num">' + (m.meta && !m.meta.has_video ? '♪' : '▦') + '</span>' +
    '<div class="what"><div class="name">' + esc(m.name) + '</div>' +
    '<div class="meta' + (m.state === 'error' ? ' err' : '') + '">' + esc(wDescribe(m)) + '</div>' +
    (m.state === 'uploading' ? '<progress max="1" value="' + (m.sent / m.size) + '"></progress>' : '') + '</div>' +
    '<button class="sec" title="Entfernen"' + (wBusy() ? ' disabled' : '') + '>✕</button></li>';
  const del = wEl('list').querySelector('button');
  if (del) del.onclick = wClear;
  wHead.textContent = wSegs.length ? wSegs.length + ' Abschnitt(e)' : m ? '1 Datei' : '';
  wZeigeUebernahme();
  wUpdateButton();
}

/* ----- Weiterreichen an die Clipliste ----- */

// Dieselbe Datei wird meist zweimal gebraucht: einmal zum Mitschreiben, einmal
// als Bild im Schnittfenster. Abschrift- und Videodienst haben getrennte
// Ablagen, darum wird sie dabei ein zweites Mal hochgeladen - gewaehlt aber
// nur einmal.
function wZeigeUebernahme() {
  const row = wEl('clip-row');
  const m = wMedia, meta = m && (m.meta || m.local);
  // Nur Ton hat im Bild nichts zu suchen; solange niemand die Datei gesehen
  // hat, wird sie als Video behandelt.
  const passt = m && vInfo && m.state !== 'error' && !(meta && meta.has_video === false);
  row.hidden = !passt;
  if (!passt) return;
  // Eine Datei nach der anderen: sonst schieben Abschrift- und Videodienst
  // dieselben Bilder gleichzeitig durch dieselbe Leitung.
  const drin = !!wClip(), laeuft = m.state !== 'ready';
  wEl('toclip').disabled = drin || laeuft || !m.file;
  wEl('clip-note').textContent = drin
    ? 'Liegt als Clip im Reiter „Schnitt“ — das Schnittfenster zeigt ihn.'
    : laeuft
    ? 'Sobald die Datei hochgeladen ist, lässt sie sich hier weiterreichen.'
    : !m.file
    ? 'Die Datei liegt nur noch beim Abschriftdienst. Fürs Schnittfenster bitte im Reiter „Schnitt“ unter „Clips“ noch einmal wählen.'
    : 'Legt dieselbe Datei als Clip in den Reiter „Schnitt“, damit das Schnittfenster ihr Bild zeigt.';
}

// Liegt die Datei schon in der Clipliste? Nach einem Neuladen ist der Verweis
// darauf weg, dann wird sie an Namen und Groesse wiedererkannt.
function wClip() {
  const m = wMedia;
  if (!m) return null;
  if (m.clip && vClips.includes(m.clip)) return m.clip;
  return (m.clip = vClips.find(c => c.name === m.name && c.size === m.size) || null);
}

function wToClip() {
  const m = wMedia;
  if (!m || !m.file || m.state !== 'ready' || !vInfo || wClip()) return;
  vAddFiles([m.file]);
  m.clip = vClips[vClips.length - 1];     // gemerkt, damit der Knopf nicht zweimal dasselbe tut
  wZeigeUebernahme();
  tlZeigen();
  note('„' + m.name + '“ liegt jetzt als Clip in der Zeitleiste.');
}

function wUpdateButton() {
  if (!wInfo) return;
  const m = wMedia, ready = m && m.state === 'ready';
  wEl('go').disabled = !ready || wBusy();
  if (wBusy() || (wJob && ['done', 'failed', 'cancelled'].includes(wJob.status))) return;
  const note = wEl('note');
  note.classList.remove('err');
  const meta = m && (m.meta || m.local);
  const pace = W_PACE[wEl('model').value] || 1;
  note.textContent = !m ? 'Noch keine Datei.'
    : m.state === 'error' ? 'Diese Datei lässt sich nicht verwenden — bitte entfernen.'
    : !ready ? 'Warte, bis die Datei hochgeladen ist.'
    : meta ? 'Rund ' + fmtTime(meta.duration) + ' Ton — das Mitschreiben dauert damit grob geschätzt ' +
             fmtTime(meta.duration * pace) + '. Beim ersten Lauf kommt der Modell-Download dazu.'
    : '';
}

/* ----- Auftrag ----- */

async function wStart() {
  if (wBusy() || !wMedia || wMedia.state !== 'ready') return;
  wSegs = [];
  wSprache = [];
  wEl('result').hidden = true;
  wEl('lang').textContent = '';
  try {
    wJob = await wApi.json('POST', '/jobs', { media: wMedia.id, options: wOptions() });
    while (true) {
      wShowJob();
      if (!wBusy()) break;
      await new Promise(r => setTimeout(r, 1000));
      wJob = await wApi.get('/jobs/' + wJob.id);
      await wPull();
    }
    if (['done', 'cancelled'].includes(wJob.status)) await wHoleSprache();
  } catch (e) {
    wJob = { status: 'failed', error: e.message };
    wShowJob();
  }
}

// Wo gesprochen wird, haelt der Dienst neben den Abschnitten bereit. Danach
// setzt "Mit Pausen" die Satzanfaenge (wEinsatz); ohne die Angabe - ein Dienst
// aelterer Fassung - bleibt es bei den Zeiten von Whisper.
async function wHoleSprache() {
  const job = wJob;
  let sprache = [];
  try { sprache = (await wApi.get('/jobs/' + job.id + '/speech')).speech || []; } catch (e) { /* ohne */ }
  if (wJob !== job) return;
  wSprache = sprache;
  wShowText();
}

// Die Abschnitte kommen nach und nach; geholt wird nur, was noch fehlt.
async function wPull() {
  if (!wJob || !wJob.id || wJob.count <= wSegs.length) return;
  const r = await wApi.get('/jobs/' + wJob.id + '/segments?start=' + wSegs.length);
  if (r.start !== wSegs.length) return;            // Antwort passt nicht mehr zum Stand
  wSegs.push(...r.segments);
  wShowText();
}

function wShowJob() {
  const j = wJob, note = wEl('note'), prog = wEl('prog');
  const busy = wBusy();
  wEl('cancel').hidden = !busy;
  prog.hidden = !busy;
  note.classList.toggle('err', j.status === 'failed');
  if (j.language) wEl('lang').innerHTML = 'erkannt: <b>' + esc(wLangName(j.language)) + '</b>' +
    (j.language_probability ? ' · ' + Math.round(j.language_probability * 100) + ' %' : '');
  if (j.status === 'queued') {
    prog.removeAttribute('value');
    note.textContent = 'Wartet' + (j.ahead ? ' — ' + j.ahead + ' Auftrag/Aufträge davor' : '') + '…';
  } else if (j.status === 'running' && j.stage === 'audio') {
    prog.removeAttribute('value');
    note.textContent = 'Löse den Ton heraus…';
  } else if (j.status === 'running' && j.stage === 'model') {
    prog.removeAttribute('value');
    note.textContent = 'Lade das Modell — beim ersten Mal wird es erst heruntergeladen…';
  } else if (j.status === 'running') {
    prog.value = j.progress;
    note.textContent = 'Schreibe mit… ' + Math.round(j.progress * 100) + ' %' +
      (j.eta != null ? ' · noch ca. ' + fmtTime(j.eta) : '') + ' · ' + j.count + ' Abschnitt(e)';
  } else if (j.status === 'done') {
    note.textContent = 'Fertig: ' + j.count + ' Abschnitt(e) aus ' + fmtTime(j.duration) +
      ' Ton, mitgeschrieben in ' + fmtTime(j.finished - j.started) + '.';
    wShowText();
  } else if (j.status === 'failed') {
    note.textContent = 'Fehler: ' + (j.error || 'unbekannt');
  } else if (j.status === 'cancelled') {
    note.textContent = 'Abgebrochen.' + (wSegs.length ? ' Der bis dahin mitgeschriebene Teil steht unten.' : '');
  }
  wRender();
}

async function wCancel() {
  if (!wJob || !wJob.id) return;
  try { wJob = await wApi.get('/jobs/' + wJob.id, { method: 'DELETE' }); } catch (e) { /* egal */ }
  wShowJob();
}

const wLangName = code => {
  const hit = (wInfo ? wInfo.languages : []).find(l => l.id === code);
  return hit ? hit.label : code;
};

/* ----- Aus den Abschnitten wird Text ----- */

const wClock = t => {
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60);
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
};

function wAssemble(form) {
  if (form === 'pausen') return wMitPausen();
  if (form === 'lines') return wSegs.map(s => s.text).join('\n');
  if (form === 'stamps') return wSegs.map(s => '[' + wClock(s.start) + '] ' + s.text).join('\n');
  // Fliesstext: ein Absatz endet dort, wo laenger geschwiegen wurde. Genau
  // daraus macht der Sprechertext spaeter wieder eine Pause.
  const gap = Math.max(0, Number(wEl('gap').value) || 0);
  let out = '', last = null;
  for (const s of wSegs) {
    out += last === null ? s.text : (gap > 0 && s.start - last >= gap ? '\n\n' : ' ') + s.text;
    last = s.end;
  }
  return out;
}

// Whisper schreibt Geraeusche als Anmerkung mit: "[Musik]", "*Applaus*", "♪".
// Im Sprechertext fielen nur die Zeichen weg und das Wort wuerde gesprochen,
// darum bleibt die Anmerkung dort ganz weg. Runde Klammern schweigen ohnehin.
const wOhneAnmerkung = t => t.replace(/\[[^\]]*\]|\*[^*]*\*|[♪♫]/g, ' ').replace(/\s+/g, ' ').trim();
const wSprechbar = t => /[\p{L}\p{N}]/u.test(t.replace(/\([^)]*\)/g, ''));
const W_SATZENDE = /[.!?…]["'“”»«)]*$/;

// Nach diesen Woertern beendet ein Punkt keinen Satz, ebenso nach einem
// einzelnen Buchstaben ("z. B.") und nach einer Zahl ("am 3. Oktober").
const W_ABK = new Set(['dr', 'prof', 'nr', 'st', 'str', 'hr', 'fr', 'ca', 'bzw', 'usw', 'vgl', 'ggf',
                       'inkl', 'zzgl', 'evtl', 'abb', 'kap', 'tel', 'min', 'max', 'mio', 'mrd', 'bd']);

// Ein Abschnitt von Whisper, zerlegt in seine Saetze. "von" ist die Stelle im
// Text, an der ein Satz beginnt; ein neuer Satz faengt gross an.
function wSaetze(text) {
  const saetze = [], rx = /[.!?…]+["'“”»«)]*(?=\s+["'„“«»(]?\p{Lu})/gu;
  let von = 0, m;
  while ((m = rx.exec(text))) {
    if (/^\.(?!\.)/.test(m[0])) {
      const wort = (/[\p{L}\p{N}]+$/u.exec(text.slice(0, m.index)) || [''])[0];
      if (/^(\p{L}|\d+)$/u.test(wort) || W_ABK.has(wort.toLowerCase())) continue;
    }
    const bis = m.index + m[0].length;
    saetze.push({ text: text.slice(von, bis).trim(), von });
    von = bis + /^\s*/.exec(text.slice(bis))[0].length;
  }
  saetze.push({ text: text.slice(von).trim(), von });
  return saetze.filter(x => wSprechbar(x.text));
}

// Wann in einem Abschnitt wirklich zu sprechen begonnen wird. Nach einer Stille
// legt Whisper den Anfang gern zu frueh, bis zu anderthalb Sekunden; die
// Stilleerkennung des Dienstes weiss es genauer. Faellt der Anfang mitten ins
// Sprechen, bleibt er, wie Whisper ihn nennt - dort gibt es nichts Besseres.
function wEinsatz(start, end) {
  const stueck = wSprache.find(([, bis]) => bis > start);
  return stueck && stueck[0] > start && stueck[0] < end ? stueck[0] : start;
}

// Ein Satz mitten im Abschnitt beginnt meist nach einer kurzen Stille; liegt
// eine nahe der geschaetzten Stelle, beginnt er dort - aber nach dem Satz davor
// und noch in seinem Abschnitt.
function wNaechsterEinsatz(t, nach, bis) {
  let best = t, abstand = 0.6;
  for (const [von] of wSprache)
    if (von > nach && von < bis && Math.abs(von - t) < abstand) { best = von; abstand = Math.abs(von - t); }
  return best;
}

// Die Saetze der Abschrift, jeder mit seinem Anfang im Film. Whisper trennt
// seine Abschnitte oft mitten im Satz; einzeln gesprochen klaenge Martin an so
// einer Naht, als sei der Satz zu Ende. Zusammengezogen wird darum bis zum
// naechsten Satzende - es sei denn, im Film wurde dazwischen so lange
// geschwiegen, wie "Neuer Absatz ab Pause" sagt. Endet ein Satz mitten in
// einem Abschnitt, beginnt der naechste dort; wann, weiss Whisper nicht genauer
// als fuer den ganzen Abschnitt, darum wird nach der Zeichenzahl geteilt. Was
// nur Anmerkung war, wird Stille.
function wZeilen() {
  const gap = Math.max(0, Number(wEl('gap').value) || 0);
  const zeilen = [];
  let cur = null, last = null;
  for (const s of wSegs) {
    const text = wOhneAnmerkung(s.text);
    if (!wSprechbar(text)) continue;
    if (cur && gap > 0 && s.start - last >= gap) { zeilen.push(cur); cur = null; }
    const ab = wEinsatz(s.start, s.end);
    const zeit = i => Math.round((ab + (s.end - ab) * i / text.length) * 1000) / 1000;
    for (const satz of wSaetze(text)) {
      const ende = zeit(satz.von + satz.text.length);
      if (cur) { cur.text += ' ' + satz.text; cur.end = ende; }
      else {
        const davor = zeilen.length ? zeilen[zeilen.length - 1].start : -Infinity;
        cur = { start: satz.von ? wNaechsterEinsatz(zeit(satz.von), Math.max(ab, davor), s.end) : ab,
                end: ende, text: satz.text };
      }
      if (W_SATZENDE.test(satz.text)) { zeilen.push(cur); cur = null; }
    }
    last = s.end;
  }
  if (cur) zeilen.push(cur);
  return zeilen;
}

// Wann jeder Satz im Film beginnt und wie lang der Film ist - das, wonach sich
// die Pausen im Sprechertext richten (siehe "Neu vertonen").
function wAnker(zeilen) {
  const m = wMedia || {}, letzte = zeilen[zeilen.length - 1];
  return { name: m.name || '', size: m.size || 0, zeiten: zeilen.map(z => z.start),
           ende: (wJob && wJob.duration) || (m.meta && m.meta.duration) || (letzte ? letzte.end : 0),
           fest: [], spaet: 0, bei: -1, gemessen: false };
}

// Der Sprechertext zum Neuvertonen: je Satz eine Zeile, davor als
// "(Pause: … s)" die Stille bis zu seinem Anfang im Film, und am Schluss die
// bis zum Ende des Films. Wie lange Martin fuer einen Satz braucht, ist hier
// noch aus der Zeichenzahl geschaetzt; gemessen wird beim Sprechen, und dann
// rechnet der Sprechertext die Pausen nach.
function wMitPausen() {
  const zeilen = wZeilen();
  if (!zeilen.length) return '';
  const a = wAnker(zeilen);
  const { pausen } = ankerRechne(a.zeiten.map(t => ankerZiel(a, t)),
                                 zeilen.map(z => tlAbschnittSek(z.text)), ankerZiel(a, a.ende));
  const out = [];
  zeilen.forEach((z, i) => { if (pausen[i] > 0) out.push(pauseZeile(pausen[i])); out.push(z.text); });
  if (pausen[zeilen.length] > 0) out.push(pauseZeile(pausen[zeilen.length]));
  return out.join('\n');
}

// Waehrend des Laufs waechst der Text mit; wer danach im Feld aendert, behaelt
// seine Fassung, bis Textform oder Absatzlaenge neu gewaehlt werden.
function wShowText() {
  wEl('gap-wrap').hidden = !['pausen', 'flow'].includes(wEl('form').value);
  if (!wSegs.length) return;
  wEl('result').hidden = false;
  wEl('out').value = wAssemble(wEl('form').value);
}

const wStamp = t => {
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t % 60),
        ms = Math.floor((t % 1) * 1000);
  return [h, m, s].map(x => String(x).padStart(2, '0')).join(':') + '.' + String(ms).padStart(3, '0');
};

function wSubtitles(kind) {
  const body = wSegs.map((s, i) => {
    const span = wStamp(s.start) + ' --> ' + wStamp(s.end);
    return (kind === 'srt' ? (i + 1) + '\n' + span.replace(/\./g, ',') : span) + '\n' + s.text + '\n';
  }).join('\n');
  return kind === 'vtt' ? 'WEBVTT\n\n' + body : body;
}

function wDownload() {
  if (!wSegs.length) return;
  const kind = wEl('format').value;
  const text = kind === 'txt' ? wEl('out').value : wSubtitles(kind);
  const base = ((wMedia && wMedia.name || 'abschrift').replace(/\.[^.]+$/, '') || 'abschrift').slice(0, 80);
  const url = URL.createObjectURL(new Blob([text], { type: W_MIME[kind] }));
  const a = document.createElement('a');
  a.href = url;
  a.download = base + '.' + kind;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  note('Gespeichert: ' + a.download);
}

async function wCopy() {
  try {
    await navigator.clipboard.writeText(wEl('out').value);
    note('Abschrift in die Zwischenablage kopiert.');
  } catch (e) {
    wEl('out').select();
    note('Kopieren ging nicht — der Text ist markiert, bitte mit Strg+C kopieren.');
  }
}

// Der Weg, auf den es ankommt: aus der Abschrift wird der Sprechertext.
function wToText(append) {
  const text = wEl('out').value.trim();
  if (!text) return;
  const alt = textEl.value.replace(/\s+$/, '');
  const dazu = append && alt;
  textEl.value = dazu ? alt + '\n\n' + text : text;
  // Angehaengt wird an einen Text, der schon einen Namen hat - der bleibt.
  if (!dazu && wMedia && wMedia.name) textDatei = wMedia.name;
  textId = null;                                // der Text im Feld ist keine abgelegte Datei mehr
  // Nach dem Film richten sich die Pausen nur, wenn der Sprechertext ganz aus
  // dieser Abschrift besteht: hinter einem anderen Text stimmt keine Zeit mehr.
  const zeilen = !dazu && wEl('form').value === 'pausen' ? wZeilen() : [];
  anker = zeilen.length ? wAnker(zeilen) : null;
  reparse();
  built = false;                                // altes Audio passt nicht mehr zum Text
  player.hidden = true;
  setAudio(null);
  status.textContent = '';
  // Wer im Feld oben Zeilen zusammengezogen oder geteilt hat, dessen Saetze
  // passen nicht mehr zu ihren Zeiten im Film.
  const n = anker ? anker.zeiten.length : 0;
  if (anker && ankerSetzen() === null) anker = null;
  ankerZeige();
  openCard('sec-text');
  note(dazu ? 'An den Sprechertext angehängt.'
    : anker ? 'In den Sprechertext übernommen: ' + n + ' Abschnitt(e), die Pausen folgen dem Film.'
    : n ? 'In den Sprechertext übernommen. Die Zeilen passen nicht mehr zur Abschrift — die Pausen '
          + 'bleiben, wie sie dastehen, und folgen dem Film nicht.'
    : 'In den Sprechertext übernommen.');
}

/* ---------- Neu vertonen: die Pausen folgen dem Film ---------- */

// Wer einen Film mit Martins Stimme neu vertont, will ihn dort sprechen hoeren,
// wo im Original gesprochen wurde. Zu jedem Abschnitt, der aus der Abschrift
// kam, ist bekannt, wann er im Film beginnt; die Pause davor wird so lang, dass
// Martin genau dort einsetzt. Spricht er dann noch, folgt die kuerzeste Pause,
// und der Rueckstand verschwindet in der naechsten laengeren Stille des Films.
//
// Die Laengen stehen als Zeilen "(Pause: … s)" im Sprechertext, so wie es die
// Anleitung beschreibt, und gehen damit auch in die Markdown-Datei. Nachgerechnet
// wird, sobald gemessen ist, wie lange Martin braucht - nach jedem Sprechen -,
// und wenn sich am Bild etwas verschiebt: ein Standbild, ein neuer Anfang, der
// Versatz der Sprache. Eine im Schnittfenster von Hand gesetzte Pause bleibt,
// wie sie ist; die Abschnitte danach richten sich weiter nach dem Film.
let anker = null;        // {name, size, zeiten, ende, fest, spaet, bei, gemessen} - Zeiten in Sekunden der Datei
let ankerStand = '';     // wohin die Abschnitte beim letzten Nachrechnen sollten
let ankerTimer = null;

// Wo ein Zeitpunkt der Datei in der Sprachausgabe liegt: durch Schnitt und
// Standbilder ihres Clips hindurch, abzueglich des Versatzes der Sprache. Steht
// der Film nicht in der Clipliste, gilt seine eigene Zeit. Erkannt wird er wie
// in wClip() an Name und Groesse.
function ankerZiel(a, t) {
  const versatz = vSprachVersatz();
  const it = tlClips().items.find(x => x.clip.name === a.name && x.clip.size === a.size);
  return (it ? it.t0 + vStelleImClip(it.clip, t) : t) - versatz;
}

function ankerZiele() {
  const ziele = anker.zeiten.map(t => ankerZiel(anker, t)), ende = ankerZiel(anker, anker.ende);
  return { ziele, ende, stand: ziele.map(z => z.toFixed(3)).join(' ') + ' | ' + ende.toFixed(3) };
}

// Die Pausen zu Zielen und Dauern: pausen[0] vor dem ersten Abschnitt, pausen[i]
// vor dem i-ten, pausen[n] nach dem letzten. "fest" nennt die, die bleiben, wie
// sie sind. Zwischen zwei Abschnitten ist die kuerzeste Pause eine Satzpause -
// 0 s ginge nicht, das zoege die beiden zu einem zusammen. Gerundet wird auf
// 0,05 s, jedes Mal auf das Ziel hin; so summieren sich die Rundungen nicht.
function ankerRechne(ziele, dauern, ende, fest = []) {
  const r = s => Math.min(PAUSE_MAX, Math.round(s * 20) / 20);
  const min = Math.max(0.1, r(sentencePause())), n = ziele.length;
  const pausen = [];
  let t = 0, spaet = 0, bei = -1;
  for (let i = 0; i <= n; i++) {
    const p = fest[i] != null ? fest[i] : Math.max(i && i < n ? min : 0, r((i < n ? ziele[i] : ende) - t));
    pausen.push(p);
    t += p;
    if (i === n) break;
    if (t - ziele[i] > spaet) { spaet = t - ziele[i]; bei = i; }
    t += dauern[i];
  }
  return { pausen, spaet, bei };
}

// Rechnet die Pausen des Sprechertextes nach und schreibt die geaenderten
// hinein. Heraus kommt, wie viele es waren, oder null, wenn der Text nicht mehr
// zur Abschrift passt - dann bleibt alles, wie es ist.
function ankerSetzen() {
  if (!anker) return null;
  const { segs, gaps, lead, tail } = layout();
  const n = anker.zeiten.length;
  const z = ankerZiele();
  ankerStand = z.stand;
  if (segs.length !== n) { ankerZeige(); return null; }
  const naehte = [lead, ...gaps, tail];
  const r = ankerRechne(z.ziele, segs.map(s => tlAbschnittSek(s.text)), z.ende,
                        naehte.map((p, i) => anker.fest[i] ? (p ? p.dur : 0) : null));
  Object.assign(anker, { spaet: r.spaet, bei: r.bei, gemessen: segs.every(s => cache.has(cacheKey(s.text))) });

  // Jede Naht bekommt ihre Zeile "(Pause: …)": steht dort schon eine, bekommt
  // sie die neue Zahl; sonst kommt eine vor den Abschnitt, am Schluss hinter
  // den letzten. Vor dem ersten und nach dem letzten darf sie wegfallen.
  const zeilen = tlZeilen(), schritte = [];
  naehte.forEach((p, i) => {
    if (anker.fest[i]) return;
    const soll = r.pausen[i], q = p && parts[p.part];
    if (q && q.kind === 'custom') {
      // Eine in der Vorschau verstellte Zahl zaehlt nicht; es gilt, was hier herauskommt.
      const steht = pauseCommand((zeilen[q.line] || '').trim());
      if (steht === null || (Math.abs(steht - soll) < 1e-6 && Math.abs(q.dur - soll) < 1e-6)) return;
      schritte.push({ zeile: q.line, raus: 1, rein: soll > 0 ? [pauseZeile(soll)] : [] });
    } else if (soll > 0 && Math.abs((p ? p.dur : 0) - soll) > 1e-6) {
      const letzter = segs[n - 1].stuecke[segs[n - 1].stuecke.length - 1].part;
      const zeile = i < n ? parts[segs[i].stuecke[0].part].line : tlBlockEnde(zeilen, parts[letzter].line) + 1;
      schritte.push({ zeile, raus: 0, rein: [pauseZeile(soll)] });
    }
  });
  if (!schritte.length) { ankerZeige(); return 0; }

  // Von unten nach oben, damit die Zeilennummern darueber stimmen.
  schritte.sort((a, b) => b.zeile - a.zeile);
  for (const s of schritte) zeilen.splice(s.zeile, s.raus, ...s.rein);
  const zuNeu = l => l + schritte.reduce((d, s) =>
    d + (s.zeile < l || (s.zeile === l && !s.raus) ? s.rein.length - s.raus : 0), 0);
  textSetzen(zeilen.join('\n'), zuNeu);
  if (tlEdit) { tlEdit.von = zuNeu(tlEdit.von); tlEdit.bis = zuNeu(tlEdit.bis); }
  reparseErhaltend(zuNeu);
  return schritte.length;
}

// Am Bild kann sich etwas verschoben haben - ein Standbild, ein Schnitt, der
// Versatz, ein Clip davor. Nachgerechnet wird nur, wenn die Abschnitte dadurch
// woanders hin sollen; Tippen im Sprechertext loest hier nichts aus.
function ankerPruefen() {
  clearTimeout(ankerTimer);
  ankerTimer = setTimeout(() => {
    if (!anker || controller || batchRunning || ankerZiele().stand === ankerStand) return;
    if (ankerSetzen()) scheduleRefresh();
  }, 300);
}

// Eine im Schnittfenster gezogene, eingefuegte oder entfernte Pause bleibt,
// wie sie dann ist. Gerufen wird das, solange "i" noch ihr Platz in parts ist.
function ankerFest(i) {
  if (!anker) return;
  const { segs, gaps, lead, tail } = layout();
  if (segs.length !== anker.zeiten.length) return;
  const k = [lead, ...gaps, tail].findIndex(p => p && p.part === i);
  if (k >= 0) anker.fest[k] = true;
}

function ankerZeige() {
  const zeile = $('anker-row'), el = $('anker-note');
  zeile.hidden = !anker;
  if (!anker) return;
  const n = anker.zeiten.length, m = layout().segs.length, film = '„' + anker.name + '“';
  el.classList.toggle('warn', m !== n);
  if (m !== n) {
    el.textContent = 'Der Sprechertext hat ' + m + ' Abschnitt(e), die Abschrift von ' + film + ' hatte ' + n +
      ' — solange das nicht zusammenpasst, werden die Pausen nicht nachgerechnet.';
    return;
  }
  let s = 'Die Pausen folgen dem Film ' + film + ': jeder Abschnitt beginnt dort, wo er im Original ' +
          'gesprochen wird. ';
  s += anker.gemessen ? 'Nachgerechnet wird nach jedem Sprechen und wenn sich am Bild etwas verschiebt.'
                      : 'Wie lange Martin braucht, ist bis „Audio erzeugen“ geschätzt.';
  if (anker.spaet > 0.3) {
    const wo = tlTc(ankerZiele().ziele[anker.bei] + vSprachVersatz(), tlModel().fps);
    s += ' Am weitesten zurück liegt Martin bei ' + wo + ', um ' + fmtSek(anker.spaet) +
         ' — ein höheres Tempo, ein kürzerer Satz oder ein Standbild davor holt das auf.';
  }
  el.textContent = s;
}

// Im Projekt steht, wonach sich die Pausen richten - so folgen sie dem Film
// auch nach dem Laden noch.
const ankerFuerProjekt = () => anker ? { datei: anker.name, groesse: anker.size, anfaenge: anker.zeiten,
                                         ende: anker.ende, fest: anker.fest.map(Boolean) } : null;

function ankerAusProjekt(o) {
  if (!o || !Array.isArray(o.anfaenge) || !o.anfaenge.length ||
      !o.anfaenge.every(t => Number.isFinite(Number(t)))) return null;
  return { name: String(o.datei || ''), size: Number(o.groesse) || 0, zeiten: o.anfaenge.map(Number),
           ende: Number(o.ende) || 0, fest: Array.isArray(o.fest) ? o.fest.map(Boolean) : [],
           spaet: 0, bei: -1, gemessen: false };
}

$('anker-los').onclick = () => {
  anker = null;
  ankerZeige();
  note('Die Pausen bleiben, wie sie sind, und folgen dem Film nicht mehr.');
};
