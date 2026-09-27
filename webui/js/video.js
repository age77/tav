// TAV · Clips, Schnitt je Clip und Video exportieren.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Video exportieren mit Sprachausgabe ---------- */

// Zusammenfuegen und Kodieren uebernimmt der Dienst tav-video (ffmpeg),
// erreichbar unter /video/. Die Groesse schaetzt der Dienst selbst, damit
// Schaetzung und Auftrag dieselbe Rechnung verwenden.
const VAPI = '/video/api';
const vApi = apiFor(VAPI);
const vFetch = vApi.get, vJson = vApi.json;
const vUpload = (kind, blob, name, onSent, aborted, extra) =>
  vApi.upload(kind, vInfo.part_size, blob, name, onSent, aborted, extra);
const VSTORE = 'kokoro.video.v1';
const vEl = id => $('v-' + id);
const V_OPTS = { codec: 'codecs', aspect: 'aspects', height: 'heights', fps: 'fps', quality: 'qualities', speed: 'speeds',
                 audio: 'audio_kbps', clipaudio: 'clip_audio', transition: 'transitions', length: 'lengths' };
const V_DEFAULTS = { codec: 'h264', aspect: 'auto', height: '0', fps: '0', quality: 'medium', speed: 'balanced',
                     audio: '128', clipaudio: '0', transition: '0', length: 'longer' };

let vInfo = null;
let vClips = [];         // {key, name, size, file?, id?, meta?, local?, state, sent, error}
let vVoice = null;       // {pcm, id} – hochgeladene Sprachausgabe
let vJob = null;
let vPlanTimer = null, vPlanSeq = 0, vUploading = false;

// Der Schluessel unterscheidet die Zeilen der Clipliste, nicht die Dateien:
// dieselbe Datei darf zweimal darin stehen und zweimal anders geschnitten sein.
const vKey = () => Math.random().toString(36).slice(2);

async function initVideo() {
  try { vInfo = await vFetch('/info'); }
  catch (e) {
    vEl('offline').hidden = false; vEl('body').hidden = true;
    $('c-offline').hidden = false; $('c-body').hidden = true;     // ohne Dienst auch keine Clips
    return;
  }

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(VSTORE) || '{}') || {}; } catch (e) { /* egal */ }
  for (const [key, list] of Object.entries(V_OPTS)) {
    const sel = vEl(key);
    sel.innerHTML = vInfo[list].map(o => '<option value="' + o.id + '">' + esc(o.label) + '</option>').join('');
    const want = String((saved.options || {})[key] ?? V_DEFAULTS[key]);
    sel.value = vInfo[list].some(o => String(o.id) === want) ? want : String(vInfo[list][0].id);
    sel.onchange = () => { vSave(); vVorgabeZeigen(); scheduleVideoPlan(); };
  }
  vVorgabenEinrichten();
  if (typeof saved.voice === 'boolean') vEl('voice').checked = saved.voice;
  if (isFinite(saved.still) && saved.still >= 0) vEl('still').value = saved.still;
  vEl('voice').onchange = vEl('offset').oninput = vEl('still').oninput =
    () => { vSave(); scheduleVideoPlan(); };

  vEl('add').onclick = () => vEl('file').click();
  vEl('file').onchange = () => { vAddFiles(vEl('file').files); vEl('file').value = ''; };
  vEl('srv').onclick = vVomServer;
  const box = $('sec-clips');
  box.ondragover = e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('dragover'); } };
  box.ondragleave = e => { if (!box.contains(e.relatedTarget)) box.classList.remove('dragover'); };
  box.ondrop = e => {
    box.classList.remove('dragover');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    vAddFiles(e.dataTransfer.files);
  };
  vEl('go').onclick = vStart;
  vEl('cancel').onclick = vCancel;
  vEl('dl').onclick = e => { e.preventDefault(); vDownload(); };

  // Clips vom letzten Besuch, sofern der Server sie noch hat.
  for (const c of saved.clips || []) {
    try {
      const meta = await vFetch('/clips/' + encodeURIComponent(c.id));
      if (meta.done) vClips.push({ key: vKey(), name: meta.name, size: meta.size, id: meta.id, meta,
                                   state: 'ready', schnitt: c.schnitt || null });
    } catch (e) { /* abgelaufen */ }
  }
  vRender();
  initUntertitel();                     // braucht vInfo, darum erst hier
  scheduleVideoPlan();
}

/* ----- Voreinstellungen ----- */

// Die ueblichen Wege, ein Video herauszugeben. Eine Voreinstellung setzt nur
// Format, Bild und Ton; Uebergang, Originalton und Zeiten bleiben, wie sie
// sind. Passt die Einstellung zu keiner, steht dort "Eigene Einstellung" -
// geaendert wird dann unter "Format, Auflösung, Qualität und Zeiten".
const V_VORGABEN = [
  ['standard', 'Standard — MP4, Größe der Clips',
   { codec: 'h264', aspect: 'auto', height: '0', fps: '0', quality: 'medium', speed: 'balanced', audio: '128' }],
  ['klein', 'Klein — zum Verschicken, 720p',
   { codec: 'h264', aspect: 'auto', height: '720', fps: '30', quality: 'small', speed: 'balanced', audio: '96' }],
  ['hoch', 'Hohe Qualität — zum Aufheben',
   { codec: 'h264', aspect: 'auto', height: '0', fps: '0', quality: 'high', speed: 'thorough', audio: '192' }],
  ['hochkant', 'Hochkant — fürs Handy, 1080 × 1920',
   { codec: 'h264', aspect: '9:16', height: '1080', fps: '30', quality: 'medium', speed: 'balanced', audio: '128' }]
];
let vVorgaben = [];      // die Voreinstellungen, die der Dienst auch anbietet

function vVorgabenEinrichten() {
  // Nur, was der Videodienst mit genau diesen Werten kennt.
  vVorgaben = V_VORGABEN.filter(([, , werte]) => Object.entries(werte).every(([k, w]) =>
    vInfo[V_OPTS[k]].some(o => String(o.id) === w)));
  const sel = vEl('preset');
  sel.innerHTML = vVorgaben.map(([id, label]) => '<option value="' + id + '">' + esc(label) + '</option>').join('') +
                  '<option value="eigen">Eigene Einstellung</option>';
  sel.onchange = () => {
    const v = vVorgaben.find(x => x[0] === sel.value);
    if (!v) { vEl('mehr').open = true; return; }       // "Eigene": dort wird eingestellt
    for (const [k, w] of Object.entries(v[2])) vEl(k).value = w;
    vSave();
    scheduleVideoPlan();
  };
  vVorgabeZeigen();
}

function vVorgabeZeigen() {
  const v = vVorgaben.find(([, , werte]) => Object.entries(werte).every(([k, w]) => vEl(k).value === w));
  vEl('preset').value = v ? v[0] : 'eigen';
}

function vSave() {
  try {
    localStorage.setItem(VSTORE, JSON.stringify({
      options: Object.fromEntries(Object.keys(V_OPTS).map(k => [k, vEl(k).value])),
      voice: vEl('voice').checked,
      still: Number(vEl('still').value) || 0,
      clips: vClips.filter(c => c.state === 'ready').map(c => ({ id: c.id, schnitt: vSchnitt(c) })),
      untertitel: vInfo ? sChoice() : null
    }));
  } catch (e) { /* ohne Gedaechtnis */ }
}

function vAddFiles(files) {
  for (const file of files) {
    const clip = { key: vKey(), name: file.name, size: file.size, file,
                   state: 'waiting', sent: 0 };
    if (vInfo && file.size > vInfo.max_upload) { clip.state = 'error'; clip.error = 'Zu groß für den Server.'; }
    vClips.push(clip);
    vLocalMeta(clip);
  }
  vRender();
  vUploadNext();
}

// Clips, die schon auf dem Server liegen, in die Liste nehmen: aus einem
// anderen Projekt, von einem anderen Platz oder nach einem Neustart des
// Browsers. Hochgeladen wird dabei nichts, die Kennung reicht - und damit
// zeigt das Schnittfenster sie sofort.
async function vVomServer() {
  if (!vInfo) return;
  const wahl = await pickVom({
    titel: 'Clips vom Server holen',
    hinweis: 'Was als Clip beim Videodienst liegt. Der Clip wird nicht noch einmal hochgeladen — '
           + 'dieselbe Datei darf auch zweimal in der Liste stehen und zweimal anders geschnitten sein.',
    arten: ['clips'],
    mehrfach: true,
    leer: 'Noch kein Clip auf dem Server — bitte Videos hinzufügen.'
  });
  let dazu = 0;
  for (const e of wahl) {
    try {
      const meta = await vFetch('/clips/' + encodeURIComponent(e.id));
      if (!meta.done) continue;
      // Ein eigener Schluessel je Zeile: dieselbe Datei darf mehrfach in der
      // Liste stehen, und die Zeilen muessen sich trotzdem unterscheiden.
      vClips.push({ key: vKey(), name: meta.name, size: meta.size, id: meta.id, meta,
                    state: 'ready', schnitt: null });
      dazu++;
    } catch (err) { /* liegt nicht mehr da */ }
  }
  if (!dazu) { if (wahl.length) note('Die Clips liegen nicht mehr auf dem Server.'); return; }
  vSave();
  vRender();
  scheduleVideoPlan();
  note(dazu + ' Clip(s) vom Server in der Liste.');
  tlZeigen();
}

// Dauer und Bildgroesse liest schon der Browser, damit die Schaetzung nicht
// auf das Hochladen warten muss. Die Bildrate kennt erst der Server.
function vLocalMeta(clip) {
  const v = document.createElement('video'), url = URL.createObjectURL(clip.file);
  v.preload = 'metadata'; v.muted = true;
  const done = () => { URL.revokeObjectURL(url); v.removeAttribute('src'); };
  v.onloadedmetadata = () => {
    if (v.videoWidth && isFinite(v.duration))
      clip.local = { width: v.videoWidth, height: v.videoHeight, duration: v.duration, fps: 30 };
    done(); vRender(); scheduleVideoPlan();
  };
  v.onerror = done;
  v.src = url;
}

async function vUploadNext() {
  if (vUploading) return;
  const clip = vClips.find(c => c.state === 'waiting');
  if (!clip) return;
  vUploading = true;
  clip.state = 'uploading';
  vRender();
  try {
    clip.meta = await vUpload('clips', clip.file, clip.name, sent => { clip.sent = sent; vProgress(clip); },
                              () => !vClips.includes(clip));
    clip.id = clip.meta.id;
    clip.state = 'ready';
    clip.file = null;
    vVergiss(clip);                                 // ab jetzt spielt das Schnittfenster vom Server
    if (!vClips.includes(clip)) vFetch('/clips/' + clip.id, { method: 'DELETE' }).catch(() => {});
  } catch (e) {
    clip.state = 'error';
    clip.error = e.message;
  }
  vUploading = false;
  vSave(); vRender(); scheduleVideoPlan();
  vUploadNext();
}

// Die Adresse, unter der das Schnittfenster die noch nicht hochgeladene Datei
// abspielt, belegt Speicher, bis sie ausdruecklich zurueckgegeben wird.
function vVergiss(c) {
  if (!c || !c.url) return;
  URL.revokeObjectURL(c.url);
  c.url = null;
}

/* ----- Schnitt je Clip: Anfang, Ende, Standbilder ----- */

// Nicht die hochgeladene Datei wird geschnitten, sondern der Clip in dieser
// Liste: dieselbe Datei darf zweimal in der Liste stehen und zweimal anders
// geschnitten sein. Gerechnet wird in Sekunden der Datei; "halten" zaehlt
// dagegen ab dem Anfang des Ausschnitts, so wie der Dienst es erwartet.
const CUT_MIN = 0.05, HOLD_MAX = 60;

const vQuelleSek = c => { const m = (c && (c.meta || c.local)) || null; return m && m.duration > 0 ? m.duration : 0; };

function vSchnitt(c) {
  const q = vQuelleSek(c);
  const s = c.schnitt || (c.schnitt = { von: 0, bis: null, halten: [], weg: [] });
  if (!q) return { von: 0, bis: 0, halten: [], weg: [] };
  const von = Math.max(0, Math.min(q - CUT_MIN, Number(s.von) || 0));
  const bis = Math.max(von + CUT_MIN, Math.min(q, s.bis == null ? q : Number(s.bis) || 0));
  // Herausgeschnittene Stuecke, in Sekunden ab dem Anfang des Ausschnitts wie
  // die Standbilder. Was sich ueberschneidet, wird zu einem Stueck.
  const weg = [];
  for (const w of (s.weg || [])
      .map(w => ({ von: Math.max(0, Math.min(bis - von, Number(w.von) || 0)),
                   bis: Math.max(0, Math.min(bis - von, Number(w.bis) || 0)) }))
      .filter(w => w.bis - w.von >= CUT_MIN)
      .sort((a, b) => a.von - b.von)) {
    const letzt = weg[weg.length - 1];
    if (letzt && w.von <= letzt.bis + 1e-6) letzt.bis = Math.max(letzt.bis, w.bis);
    else weg.push(w);
  }
  const drin = t => weg.some(w => t > w.von + 1e-6 && t < w.bis - 1e-6);
  const halten = (s.halten || [])
    .map(h => ({ t: Math.max(0, Math.min(bis - von, Number(h.t) || 0)),
                 dur: Math.min(HOLD_MAX, Math.max(0, Number(h.dur) || 0)) }))
    .filter(h => h.dur > 0 && !drin(h.t))         // was weggeschnitten ist, haelt nichts an
    .sort((a, b) => a.t - b.t);
  return { von, bis, halten, weg };
}

const vHaltenSek = s => s.halten.reduce((a, h) => a + h.dur, 0);
const vWegSek = s => s.weg.reduce((a, w) => a + (w.bis - w.von), 0);

// Die Stuecke, die vom Clip zu sehen sind: von und bis ab dem Anfang des
// Ausschnitts, dahinter die Standzeit. Dieselbe Rechnung stellt der
// Videodienst in cut_pieces() an. "vorne" ist die Standzeit ganz am Anfang,
// die an kein Stueck davor passt.
function vStuecke(s) {
  const laenge = Math.max(0, s.bis - s.von);
  const behalten = [];
  let los = 0;
  for (const w of s.weg) {
    if (w.von > los + 1e-6) behalten.push([los, Math.min(w.von, laenge)]);
    los = Math.max(los, w.bis);
  }
  if (laenge > los + 1e-6) behalten.push([los, laenge]);
  if (!behalten.length) behalten.push([0, laenge]);

  const stuecke = [];
  let vorne = 0;
  for (const [a, b] of behalten) {
    let cur = a;
    for (const h of s.halten) {
      if (h.t < a - 1e-6 || h.t > b + 1e-6) continue;
      if (h.t - cur < 1e-6) {                      // an der Naht statt im Stueck
        if (stuecke.length) stuecke[stuecke.length - 1].halten += h.dur;
        else vorne += h.dur;
        continue;
      }
      stuecke.push({ von: cur, bis: h.t, halten: h.dur });
      cur = h.t;
    }
    if (b - cur > 1e-6) stuecke.push({ von: cur, bis: b, halten: 0 });
  }
  if (!stuecke.length) stuecke.push({ von: 0, bis: laenge, halten: 0 });
  return { vorne, stuecke };
}

// Wie lang der Clip im fertigen Video ist: was uebrig bleibt plus seine Standbilder.
function vDauer(c) {
  if (!vQuelleSek(c)) return 0;
  const s = vSchnitt(c);
  return (s.bis - s.von) - vWegSek(s) + vHaltenSek(s);
}

const vGeschnitten = c => {
  const q = vQuelleSek(c);
  if (!q) return false;
  const s = vSchnitt(c);
  return s.von > 1e-3 || s.bis < q - 1e-3 || s.halten.length > 0 || s.weg.length > 0;
};

// Fuer den Dienst: Sekunden in der Datei, Standbilder und Herausgeschnittenes
// ab Anfang des Ausschnitts.
function vSchnittFuerDienst(c) {
  const s = vSchnitt(c);
  const ms = x => Math.round(x * 1000) / 1000;
  return { start: ms(s.von), end: ms(s.bis),
           holds: s.halten.map(h => ({ at: ms(h.t), seconds: ms(h.dur) })),
           drops: s.weg.map(w => ({ from: ms(w.von), to: ms(w.bis) })) };
}

// Aus der Stelle im Clip (0 bis vDauer) wird die Stelle in der Datei. Waehrend
// eines Standbilds steht sie - das sagt "steht", damit das Bild nicht
// weiterlaeuft, waehrend die Zeitleiste durch das Standbild faehrt.
function vStelleInDatei(c, lokal) {
  const s = vSchnitt(c), { vorne, stuecke } = vStuecke(s);
  let rest = Math.max(0, lokal);
  if (rest < vorne) return { t: s.von + stuecke[0].von, steht: true };
  rest -= vorne;
  for (const st of stuecke) {
    const d = st.bis - st.von;
    if (rest < d) return { t: s.von + st.von + rest, steht: false };
    rest -= d;
    if (rest < st.halten) return { t: s.von + st.bis, steht: true };
    rest -= st.halten;
  }
  return { t: s.von + stuecke[stuecke.length - 1].bis, steht: false };
}

// Und zurueck: aus der Stelle in der Datei wird die Stelle im Clip. Was
// herausgeschnitten ist, liegt auf der Schnittstelle.
function vStelleImClip(c, datei) {
  const s = vSchnitt(c), { vorne, stuecke } = vStuecke(s);
  const ziel = Math.max(0, Math.min(s.bis, datei) - s.von);
  let raus = vorne;
  for (const st of stuecke) {
    if (ziel < st.bis - 1e-9) return raus + Math.max(0, ziel - st.von);
    raus += st.bis - st.von + st.halten;
  }
  return raus;
}

function vDescribe(c) {
  const m = c.meta || c.local;
  const parts = [];
  if (m) {
    const s = vSchnitt(c), halt = vHaltenSek(s);
    parts.push(vGeschnitten(c)
      ? fmtTime(vDauer(c)) + ' (von ' + fmtTime(m.duration) + ': ' + fmtTime(s.von) + '–' + fmtTime(s.bis)
        + (s.weg.length ? ', ' + s.weg.length + '× heraus ' + fmtSek(vWegSek(s)) : '')
        + (halt ? ', ' + s.halten.length + '× Standbild ' + fmtSek(halt) : '') + ')'
      : fmtTime(m.duration), m.width + '×' + m.height);
    if (c.meta) parts.push(String(Math.round(m.fps * 100) / 100).replace('.', ',') + ' fps',
                           (m.vcodec || '').toUpperCase(), m.has_audio ? 'mit Ton' : 'ohne Ton');
  }
  parts.push(fmtBytes(c.size));
  if (c.state === 'waiting') parts.push('wartet auf Hochladen');
  if (c.state === 'uploading') parts.push('lädt hoch… ' + Math.round(100 * c.sent / c.size) + ' %');
  if (c.state === 'error') parts.push(c.error);
  return parts.join(' · ');
}

function vProgress(clip) {
  const li = vEl('list').querySelector('li[data-key="' + clip.key + '"]');
  if (!li) return;
  li.querySelector('.meta').textContent = vDescribe(clip);
  li.querySelector('progress').value = clip.sent / clip.size;
}

function vRender() {
  const list = vEl('list');
  list.innerHTML = vClips.map((c, i) =>
    '<li draggable="true" data-key="' + c.key + '">' +
    '<span class="grip" title="Ziehen zum Umsortieren">⠿</span><span class="num">' + (i + 1) + '</span>' +
    '<div class="what"><div class="name">' + esc(c.name) + '</div>' +
    '<div class="meta' + (c.state === 'error' ? ' err' : '') + '">' + esc(vDescribe(c)) + '</div>' +
    (c.state === 'uploading' ? '<progress max="1" value="' + (c.sent / c.size) + '"></progress>' : '') + '</div>' +
    '<button class="sec" data-act="up" title="Nach oben"' + (i ? '' : ' disabled') + '>↑</button>' +
    '<button class="sec" data-act="down" title="Nach unten"' + (i < vClips.length - 1 ? '' : ' disabled') + '>↓</button>' +
    '<button class="sec" data-act="del" title="Aus der Liste nehmen — die Datei bleibt auf dem Server">✕</button></li>').join('');

  list.querySelectorAll('li').forEach(li => {
    const idx = () => vClips.findIndex(c => c.key === li.dataset.key);
    li.querySelectorAll('button').forEach(b => b.onclick = () => {
      const i = idx();
      if (b.dataset.act === 'del') {
        // Nur aus dieser Liste. Die hochgeladene Datei bleibt liegen: sie
        // gehoert vielleicht noch zu einem Projekt, und geloescht wird im
        // Bereich "Auf dem Server" - dort steht auch, wer sie noch braucht.
        const [c] = vClips.splice(i, 1);
        vVergiss(c);
        if (c.state === 'waiting' && c.id) vFetch('/clips/' + c.id, { method: 'DELETE' }).catch(() => {});
      } else {
        const j = b.dataset.act === 'up' ? i - 1 : i + 1;
        [vClips[i], vClips[j]] = [vClips[j], vClips[i]];
      }
      vSave(); vRender(); scheduleVideoPlan();
    });
    li.ondragstart = e => { e.dataTransfer.setData('text/x-clip', li.dataset.key); li.classList.add('dragging'); };
    li.ondragend = () => li.classList.remove('dragging');
    li.ondragover = e => { if (e.dataTransfer.types.includes('text/x-clip')) e.preventDefault(); };
    li.ondrop = e => {
      const key = e.dataTransfer.getData('text/x-clip');
      if (!key) return;
      e.preventDefault(); e.stopPropagation();
      const from = vClips.findIndex(c => c.key === key), to = idx();
      if (from < 0 || from === to) return;
      vClips.splice(to, 0, vClips.splice(from, 1)[0]);
      vSave(); vRender(); scheduleVideoPlan();
    };
  });
  vHead.textContent = vClips.length ? vClips.length + ' Clip(s)' : '';
  // Im Reiter "Export" stehen die Clips nicht mehr selbst - nur, was es sind.
  const lang = vClips.reduce((n, c) => n + vDauer(c), 0);
  $('v-clips-kurz').innerHTML = vClips.length
    ? esc(vClips.length + ' Clip(s)' + (lang ? ', zusammen ' + fmtTime(lang) : '')) +
      ' — <a href="#sec-clips">im Reiter „Schnitt“</a>'
    : 'Noch keine Clips — sie kommen <a href="#sec-clips">im Reiter „Schnitt“</a> dazu.';
  if (wInfo) wZeigeUebernahme();          // ein entfernter Clip gibt den Knopf wieder frei
  vUpdateButton();
}

function vOptions() {
  return { subtitles: sFuerDienst(),
           codec: vEl('codec').value, aspect: vEl('aspect').value, height: Number(vEl('height').value), fps: Number(vEl('fps').value),
           quality: vEl('quality').value, speed: vEl('speed').value, audio_kbps: Number(vEl('audio').value),
           clip_audio: Number(vEl('clipaudio').value), transition: Number(vEl('transition').value),
           length: vEl('length').value, voice_offset: Math.max(0, Number(vEl('offset').value) || 0),
           still_seconds: vVorspann() };
}

// Vor- und Nachspann: das erste und das letzte Bild des Videos stehen so lange
// still und stumm. Das gibt Luft, bevor gesprochen wird, und beim
// Zusammenfuegen laesst sich darin ueberblenden. Ohne Clips gibt es keins von beidem.
const vVorspann = () => vInfo && vClips.length ? Math.max(0, Math.min(30, Number(vEl('still').value) || 0)) : 0;

// Wo die Sprachausgabe im fertigen Video beginnt: hinter dem Vorspann und dem
// eingestellten Versatz. Danach richten sich Zeitleiste, Untertitel und die
// Pausen nach dem Film.
const vSprachVersatz = () => vVorspann() + (vInfo ? Math.max(0, Number(vEl('offset').value) || 0) : 0);

// Sprachdauer: gemessen, sonst aus dem Text geschaetzt (siehe durations()).
function vVoiceSeconds() {
  if (!vEl('voice').checked) return null;
  const d = durations();
  return d ? d.total : null;
}

function vBusy() { return !!vJob && ['uploading', 'queued', 'running'].includes(vJob.status); }

// Alles, was die Seite fuer ein Projekt herausgibt - Video, Tonspur,
// Audiodatei, Projektdatei -, heisst wie das Projekt, mit TAV davor; so liegt
// es im Download-Ordner und auf dem Server unter demselben Namen. Traegt der
// Name schon einen Vorsatz in Grossbuchstaben, etwa TTS_ vom Sprechertext,
// wird der ersetzt statt verdoppelt: aus TTS_01_Anlage wird TAV_01_Anlage.
// Ohne geoeffnetes Projekt gilt der Name des Sprechertextes.
const VORSATZ = 'TAV';

function mitVorsatz(name) {
  const alt = /^(?:[A-Z]{2,5}|tav)(?=[_-])/.exec(name);  // "tav-" hiessen die Videos bis zu dieser Fassung
  return alt ? VORSATZ + name.slice(alt[0].length) : VORSATZ + '_' + name;
}

// Ohne die Zeichen, die kein Dateisystem mag - wie der Videodienst es auch tut.
const dateiTauglich = name => name.replace(/[\x00-\x1f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

function projektDatei(ext) {
  const p = srvOffen && srvProjekte.find(x => x.id === srvOffen);
  const name = dateiTauglich(mitVorsatz((p && p.name) || textDateiName().replace(/\.md$/, '')));
  return ext ? name + '.' + ext : name;
}

function vUpdateButton() {
  if (!vInfo) return;
  const ready = vClips.length && vClips.every(c => c.state === 'ready');
  const needVoice = vEl('voice').checked && !audio;
  vEl('go').disabled = !ready || needVoice || vBusy();
  vEl('voice').disabled = vBusy();
  if (vBusy()) return;
  const note = vEl('note');
  note.classList.remove('err');
  if (vJob && vJob.status === 'done') return;
  note.textContent = !vClips.length ? 'Noch keine Clips.'
    : vClips.some(c => c.state === 'error') ? 'Fehlerhafte Clips bitte im Reiter „Schnitt“ entfernen.'
    : !ready ? 'Warte, bis alle Clips hochgeladen sind.'
    : needVoice ? 'Erst im Reiter „Text“ „Audio erzeugen“ — oder die Sprachausgabe abwählen.' : '';
}

function scheduleVideoPlan() {
  if (anker) ankerPruefen();          // was am Bild ruckt, verschiebt die Pausen nach dem Film
  if (!vInfo) return;
  clearTimeout(vPlanTimer);
  vPlanTimer = setTimeout(vPlan, 250);
  vUpdateButton();
  tlNeu();                            // Clips und Einstellungen bewegen die Zeitleiste
}

async function vPlan() {
  const known = vClips.filter(c => c.meta || c.local)
    .map(c => Object.assign({}, c.meta || c.local, vSchnittFuerDienst(c)));
  const size = vEl('size'), lengths = vEl('lengths');
  if (!vClips.length || known.length < vClips.filter(c => c.state !== 'error').length) {
    size.textContent = ''; lengths.textContent = '';
    return;
  }
  const seq = ++vPlanSeq, voiceSec = vVoiceSeconds();
  try {
    const p = await vJson('POST', '/plan', { clips: known, voice_seconds: voiceSec, options: vOptions() });
    if (seq !== vPlanSeq) return;
    // Die Untertitel werden fuer genau dieses Bild umbrochen und in der Vorschau
    // in seinem Seitenverhaeltnis gezeigt.
    if (p.width && p.height && (p.width !== vBildMass.w || p.height !== vBildMass.h)) {
      vBildMass = { w: p.width, h: p.height };
      sZeige();
    }
    const guessed = vClips.some(c => !c.meta) || (voiceSec && !audio);
    size.innerHTML = 'ca. <b>' + fmtBytes(p.estimated_bytes) + '</b> · ' + fmtTime(p.duration) + ' · ' +
      p.width + '×' + p.height + ' · ' + String(p.fps).replace('.', ',') + ' fps · ' +
      ((p.video_kbps + p.audio_kbps) / 1000).toFixed(1).replace('.', ',') + ' Mbit/s';
    lengths.textContent = 'Video ' + fmtTime(p.video_seconds) +
      (voiceSec ? ' · Sprache ' + (audio ? '' : 'rund ') + fmtTime(voiceSec) +
                  (p.voice_offset ? ' ab ' + fmtTime(p.voice_offset) : '') : ' · ohne Sprachausgabe') +
      ' → Ergebnis ' + fmtTime(p.duration) +
      (guessed ? ' (vorläufig)' : '') +
      (p.warnings.length ? ' — ' + p.warnings.join(' ') : '');
  } catch (e) {
    if (seq !== vPlanSeq) return;
    size.textContent = '';
    lengths.textContent = e.message;
  }
}

async function vStart() {
  if (vBusy()) return;
  const note = vEl('note'), prog = vEl('prog');
  vEl('dl').hidden = true;
  vJob = { status: 'uploading' };
  vEl('cancel').hidden = false;
  vUpdateButton();
  try {
    let voiceId = null;
    if (vEl('voice').checked) {
      // Dieselbe Sprachausgabe nur einmal hochladen. Das gilt auch ueber das
      // Neuladen hinweg: aus dem Speicher des Sprachdienstes kommt derselbe
      // Text als dieselbe Datei, und liegt sie schon beim Videodienst, genuegt
      // ihre Pruefsumme.
      if (!vVoice || vVoice.pcm !== audio.pcm) {
        note.textContent = 'Lade Sprachausgabe hoch…';
        const wav = encodeWav(audio.pcm, audio.rate);
        const sha = await sha256Hex(wav);
        const meta = await vUpload('voices', wav, projektDatei('wav'), () => {}, undefined, sha ? { sha } : {});
        vVoice = { pcm: audio.pcm, id: meta.id };
      }
      voiceId = vVoice.id;
    }
    if (vJob.status !== 'uploading') return;            // zwischendurch abgebrochen
    // Umbrochen wird nach der Schrift des Videos; ohne sie zaehlten nur Zeichen.
    if (sEl('on').checked) await document.fonts.load(sSchrift(sChoice(), 40)).catch(() => {});
    vJob = await vJson('POST', '/jobs', {
      clips: vClips.map(c => Object.assign({ id: c.id }, vSchnittFuerDienst(c))),
      voice: voiceId, options: vOptions(), cues: sCues(), name: projektDatei() });
    prog.hidden = false; prog.value = 0;
    while (vBusy()) {
      vShowJob();
      await new Promise(r => setTimeout(r, 1000));
      if (!vBusy()) break;
      vJob = await vFetch('/jobs/' + vJob.id);
    }
    vShowJob();
  } catch (e) {
    if (vJob && vJob.status === 'uploading' && vVoice && e.message.includes('nicht mehr')) vVoice = null;
    vJob = { status: 'failed', error: e.message };
    vShowJob();
  }
}

function vShowJob() {
  const j = vJob, note = vEl('note'), prog = vEl('prog');
  const busy = vBusy();
  vEl('cancel').hidden = !busy;
  prog.hidden = !busy || j.status === 'uploading';
  note.classList.toggle('err', j.status === 'failed');
  if (j.status === 'queued') {
    note.textContent = 'Wartet' + (j.ahead ? ' — ' + j.ahead + ' Auftrag/Aufträge davor' : '') + '…';
    prog.removeAttribute('value');
  } else if (j.status === 'running') {
    prog.value = j.progress;
    note.textContent = 'Kodiere… ' + Math.round(j.progress * 100) + ' %' +
      (j.eta != null ? ' · noch ca. ' + fmtTime(j.eta) : '') + ' · bisher ' + fmtBytes(j.size);
  } else if (j.status === 'done') {
    const dl = vEl('dl');
    dl.href = VAPI + '/jobs/' + j.id + '/file';          // fuer "Ziel speichern unter"
    dl.download = j.name || 'video.' + j.plan.ext;
    dl.textContent = 'Video herunterladen (' + fmtBytes(j.size) + ')';
    dl.hidden = false;
    note.textContent = 'Fertig: ' + (j.name ? j.name + ', ' : '') + fmtBytes(j.size) +
      ' (geschätzt ' + fmtBytes(j.plan.estimated_bytes) + '), ' +
      fmtTime(j.plan.duration) + ', kodiert in ' + fmtTime(j.finished - j.started) +
      '. Die Datei liegt auf dem Server, bis der Videodienst neu startet.';
    vDownload();                                          // einmal von selbst
    if (vInfo) zHolen().catch(() => {});                  // es steht jetzt zum Zusammenfuegen bereit
  } else if (j.status === 'failed') {
    note.textContent = 'Fehler: ' + (j.error || 'unbekannt');
  } else if (j.status === 'cancelled') {
    note.textContent = 'Abgebrochen.';
  }
  vUpdateButton();
}

// Der Knopf fragt erst nach, ob es den Auftrag ueberhaupt noch gibt. Ohne das
// laedt der Browser wortlos die Anmeldeseite herunter oder tut gar nichts -
// beides sah aus, als reagiere der Knopf nicht. Heruntergeladen wird danach
// weiter vom Browser selbst, damit auch grosse Dateien direkt auf die Platte
// gehen und nicht erst in den Arbeitsspeicher.
let vDownloading = false;

async function vDownload() {
  const note = vEl('note');
  if (vDownloading || !vJob || !vJob.id) return;
  vDownloading = true;
  const vorher = note.textContent;
  note.classList.remove('err');
  note.textContent = 'Der Download wird vorbereitet…';
  try {
    const j = await vFetch('/jobs/' + vJob.id);
    if (!j || j.status !== 'done') throw new Error('Das Video ist nicht mehr fertig — bitte noch einmal erstellen.');
    const a = document.createElement('a');
    a.href = VAPI + '/jobs/' + j.id + '/file';
    a.download = j.name || 'video.' + j.plan.ext;
    a.click();
    note.textContent = vorher;
  } catch (e) {
    note.classList.add('err');
    note.textContent = e.message;
  } finally {
    vDownloading = false;
  }
}

async function vCancel() {
  if (!vJob) return;
  if (vJob.id) {
    try { vJob = await vFetch('/jobs/' + vJob.id, { method: 'DELETE' }); } catch (e) { /* egal */ }
  } else {
    vJob = { status: 'cancelled' };
  }
  vShowJob();
}
