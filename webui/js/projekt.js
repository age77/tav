// TAV · Projekte, Dateien auf dem Server und der Arbeitsstand.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Pausenlaengen merken ---------- */

const STORE = 'kokoro.pausen.v1';
const DEF_IDS = ['d-sentence', 'd-line', 'd-paragraph', 'd-divider', 'd-chapter'];

function saveDefaults() {
  try {
    localStorage.setItem(STORE, JSON.stringify(
      Object.fromEntries(DEF_IDS.map(id => [id.slice(2), Number($(id).value) || 0]))));
  } catch (e) { /* privater Modus o. ae.: dann eben ohne Gedaechtnis */ }
}

function loadDefaults() {
  try {
    const o = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (o) applyDefaults(o);
  } catch (e) { /* kaputter Eintrag wird ignoriert */ }
}

function applyDefaults(o) {
  for (const id of DEF_IDS) {
    const v = Number(o[id.slice(2)]);
    if (isFinite(v) && v >= 0) $(id).value = v;
  }
}

/* ---------- Sprechertext als Markdown-Datei ---------- */

// Geaendert wird der Sprechertext an zwei Stellen: im Feld und im
// Schnittfenster. Beide Male steht das Ergebnis hier im Feld, und der Knopf
// schreibt genau das heraus - mit Auszeichnung, Klammern und Aussprache-Zeilen,
// also dieselbe Markdown-Datei, die hereinkam. Kam der Text aus einer Datei,
// behaelt er deren Namen; sonst traegt die Datei das Datum.
let textDatei = null;          // Name der Datei, aus der der Text kam

// Endung weg, Pfad weg, Steuerzeichen weg - heraus geht immer Markdown, auch
// wenn eine .txt hereinkam oder der Text aus der Abschrift eines Videos stammt.
const textDateiName = () => (textDatei
  ? (textDatei.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[\x00-\x1f]/g, '').trim() || 'sprechertext')
  : 'sprechertext-' + new Date().toISOString().slice(0, 10)) + '.md';

function textSpeichern() {
  const text = textEl.value.replace(/\s+$/, '');
  if (!text) return;
  const name = textDateiName();
  const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  note('Gespeichert: ' + name);
}

textMd.onclick = textSpeichern;

/* ---------- Import und Export ---------- */

// Die Datei haelt alles fest, was sich auf dieser Seite einstellen laesst:
// Text, Tempo, Standardpausen, die einzeln geaenderten Pausen sowie die
// Einstellungen von Audio- und Videoexport. Nicht darin stehen die
// hochgeladenen Clips - von denen stehen nur Kennung, Name und Schnitt darin,
// die Dateien selbst bleiben auf dem Server. Auch nicht darin: die
// Aussprache-Liste, die gilt fuer jeden Text und liegt beim Sprachdienst.
// Seit Fassung 6 steht darin auch, nach welchem Film sich die Pausen richten.
const PROJEKT_VERSION = 6;

const audioChoice = () => ({ format: xFormat.value, qualitaet: xQuality.value, abtastrate: xRate.value });

const abschriftChoice = () => wInfo ? {
  optionen: Object.fromEntries(Object.keys(W_OPTS).map(k => [k, wEl(k).value])),
  stille_ueberspringen: wEl('vad').checked,
  fachwoerter: wEl('hint').value,
  textform: wEl('form').value,
  absatzpause: Number(wEl('gap').value) || 0
} : null;

// Die Clips selbst liegen auf dem Server; hier steht, welche es sind und wie
// sie geschnitten werden. Wer die Datei auf einem anderen Rechner oeffnet,
// findet dieselben Clips wieder, solange sie dort noch liegen.
const clipChoice = () => vClips.filter(c => c.id).map(c => ({
  id: c.id, name: c.name, schnitt: vSchnitt(c)
}));

async function applyClips(list) {
  if (!Array.isArray(list) || !vInfo) return null;
  const neu = [];
  let fehlend = 0;
  for (const c of list) {
    if (!c || !c.id) { fehlend++; continue; }
    try {
      const meta = await vFetch('/clips/' + encodeURIComponent(c.id));
      if (!meta.done) { fehlend++; continue; }
      neu.push({ key: vKey(), name: meta.name || c.name || 'Clip', size: meta.size,
                 id: meta.id, meta, state: 'ready', schnitt: c.schnitt || null });
    } catch (e) { fehlend++; }
  }
  // Die bisherigen Clips bleiben auf dem Server liegen: sie gehoeren
  // vielleicht zu einem anderen Projekt.
  vClips.forEach(vVergiss);
  vClips = neu;
  vSave();
  vRender();
  scheduleVideoPlan();
  return fehlend;
}

const videoChoice = () => vInfo ? {
  optionen: Object.fromEntries(Object.keys(V_OPTS).map(k => [k, vEl(k).value])),
  sprachausgabe: vEl('voice').checked,
  versatz: Number(vEl('offset').value) || 0,
  standbild: Number(vEl('still').value) || 0
} : null;

// Uebernommen wird nur, was es in dieser Fassung wirklich gibt; alles andere
// behaelt seinen Wert.
function applyAudioChoice(o) {
  if (!o || typeof o !== 'object') return;
  const opt = FORMATS[o.format] && xFormat.querySelector('option[value="' + o.format + '"]');
  if (opt && !opt.disabled) xFormat.value = o.format;
  fillQuality(String(o.qualitaet ?? ''));
  if (RATES.some(r => String(r[0]) === String(o.abtastrate))) xRate.value = String(o.abtastrate);
  saveChoice();
  updateEstimate();
}

function applyVideoChoice(o) {
  if (!o || typeof o !== 'object' || !vInfo) return false;
  for (const [key, list] of Object.entries(V_OPTS)) {
    const want = String((o.optionen || {})[key] ?? '');
    if (vInfo[list].some(x => String(x.id) === want)) vEl(key).value = want;
  }
  if (typeof o.sprachausgabe === 'boolean') vEl('voice').checked = o.sprachausgabe;
  vVorgabeZeigen();
  const versatz = Number(o.versatz);
  if (isFinite(versatz) && versatz >= 0) vEl('offset').value = versatz;
  const standbild = Number(o.standbild);
  if (isFinite(standbild) && standbild >= 0) vEl('still').value = Math.min(30, standbild);
  vSave();
  scheduleVideoPlan();
  return true;
}

function applyAbschriftChoice(o) {
  if (!o || typeof o !== 'object' || !wInfo) return;
  for (const [key, list] of Object.entries(W_OPTS)) {
    const want = String((o.optionen || {})[key] ?? '');
    if (wInfo[list].some(x => String(x.id) === want)) wEl(key).value = want;
  }
  if (typeof o.stille_ueberspringen === 'boolean') wEl('vad').checked = o.stille_ueberspringen;
  if (typeof o.fachwoerter === 'string') wEl('hint').value = o.fachwoerter.slice(0, wInfo.max_hint);
  if (W_FORMS.some(f => f[0] === o.textform)) wEl('form').value = o.textform;
  const pause = Number(o.absatzpause);
  if (isFinite(pause) && pause >= 0) wEl('gap').value = pause;
  wSave();
  wShowText();
  wUpdateButton();
}

// Was ein Projekt ausmacht - einmal beschrieben, dreifach gebraucht: fuer die
// Datei zum Herunterladen, fuer die Ablage auf dem Server und beim Zurueckholen.
function projektDaten() {
  return {
    version: PROJEKT_VERSION,
    erstellt: new Date().toISOString(),
    text: textEl.value,
    textdatei: textDatei,
    textid: textId,                 // liegt der Text als Datei auf dem Server, steht hier seine Kennung
    tempo: Number(speed.value),
    standardpausen: Object.fromEntries(DEF_IDS.map(id => [id.slice(2), Number($(id).value) || 0])),
    pausen: parts.filter(p => p.type === 'pause')
                 .map(p => ({ art: p.kind, dauer: p.dur, geaendert: !!p.manual })),
    audioexport: audioChoice(),
    videoexport: videoChoice(),
    videoclips: clipChoice(),
    untertitel: vInfo ? sChoice() : null,
    abschrift: abschriftChoice(),
    neuvertonung: ankerFuerProjekt()
  };
}

function exportProject() {
  const data = projektDaten();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = projektDatei('json');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  note('Exportiert: ' + a.download);
}

async function importProject(file) {
  let o;
  try { o = JSON.parse(await file.text()); }
  catch (e) { note('Datei ist kein gültiges JSON.'); return; }
  note(await projektAnwenden(o));
}

// Die einzeln gesetzten Pausen liegen in derselben Reihenfolge wie im
// zerlegten Text. Passt die Reihenfolge nicht, bleiben die Standardwerte.
// Heraus kommt, wie viele uebernommen wurden - oder null, wenn sie nicht passten.
function pausenAnwenden(saved) {
  saved = Array.isArray(saved) ? saved : [];
  const live = parts.filter(p => p.type === 'pause');
  if (!saved.length || saved.length !== live.length ||
      !live.every((p, i) => saved[i] && saved[i].art === p.kind)) return null;
  live.forEach((p, i) => {
    const v = Number(saved[i].dauer);
    if (isFinite(v) && v >= 0) { p.dur = v; p.manual = !!saved[i].geaendert; }
  });
  return live.length;
}

// Aus den Angaben wird wieder die Seite. Heraus kommt der Satz, der unten am
// Rand steht - wer das Projekt vom Server holt, bekommt denselben.
async function projektAnwenden(o) {
  if (!o || typeof o.text !== 'string') return 'Darin steht kein Sprechertext.';

  if (o.standardpausen) { applyDefaults(o.standardpausen); saveDefaults(); }
  if (isFinite(o.tempo)) { speed.value = o.tempo; speed.oninput(); }
  applyAudioChoice(o.audioexport);
  applyAbschriftChoice(o.abschrift);
  const videoOffen = !o.videoexport || applyVideoChoice(o.videoexport);
  const fehlendeClips = await applyClips(o.videoclips);
  if (o.untertitel) { sApply(o.untertitel); vSave(); }

  textEl.value = o.text;
  textDatei = typeof o.textdatei === 'string' && o.textdatei ? o.textdatei : null;
  textId = typeof o.textid === 'string' && o.textid ? o.textid : null;
  anker = ankerAusProjekt(o.neuvertonung);      // folgten die Pausen einem Film, tun sie es weiter
  reparse();                                    // Pausen zunaechst auf den Standardwerten

  const uebernommen = pausenAnwenden(o.pausen);
  let text;
  if (uebernommen !== null) {
    text = 'Importiert: ' + uebernommen + ' Pause(n) übernommen.';
  } else {
    text = Array.isArray(o.pausen) && o.pausen.length
      ? 'Importiert, aber die gespeicherten Pausen passen nicht zum Text — es gelten die Standardwerte.'
      : 'Importiert.';
  }
  if (!videoOffen) text += ' Die Videoeinstellungen bleiben außen vor: der Dienst ist nicht erreichbar.';
  if (fehlendeClips) text += ' ' + fehlendeClips + ' Clip(s) liegen nicht mehr auf dem Server.';
  render();

  built = false;                                // altes Audio passt nicht mehr zum Text
  player.hidden = true;
  setAudio(null);
  status.textContent = '';

  // Die Clips des Projekts gehoeren ins Bild, nicht nur in die Liste: der Kopf
  // geht an den Anfang und der Bereich klappt auf, damit der erste Clip sofort
  // zu sehen ist. Zugeklappt kam das Bild bisher erst beim Aufklappen.
  tlZeigen();
  if (!vClips.length) openCard('sec-text');     // ohne Bild beginnt die Arbeit am Text
  projektTon();                                 // und der Ton dazu
  return text;
}

/* ---------- Eine Datei vom Server holen ---------- */

// Ueberall, wo sich eine Datei oeffnen laesst, steht daneben derselbe Knopf:
// nimm, was schon auf dem Server liegt. Das Fenster fragt beide Dienste
// frisch, zeigt nur die Arten, die an dieser Stelle passen, und sagt zu jedem
// Eintrag, zu welchen Projekten er gehoert. Herausgegeben wird die Auswahl -
// was damit geschieht, entscheidet die Stelle, die gefragt hat.
const pickEl = id => $('pick-' + id);
const pickBox = $('pick');
let pickWahl = [];             // angeklickte Eintraege, in der Reihenfolge des Klickens

// Frisch gefragt, nicht aus dem Gedaechtnis: zwischen zwei Blicken in den
// Bereich "Auf dem Server" kann sich dort etwas geaendert haben. Nebenbei
// steht der Bereich danach auf demselben Stand wie dieses Fenster.
async function srvAlles() {
  await srvHoleDateien();
  const raus = [];
  for (const [dienst, quelle] of Object.entries(srvDateien)) {
    if (!quelle) continue;
    for (const [art, liste] of Object.entries(quelle.items || {}))
      for (const e of liste) raus.push(Object.assign({ dienst, art }, e));
  }
  return raus.sort((a, b) => (b.created || 0) - (a.created || 0));
}

function pickZeile(e, i) {
  return '<li data-i="' + i + '"><span class="mark" aria-hidden="true"></span>' +
    '<div class="what"><div class="name">' + esc(e.name || String(e.id)) + '</div>' +
    '<div class="meta">' + esc([
      SRV_ARTEN[e.art] || e.art,
      fmtBytes(e.size || 0),
      e.duration ? fmtTime(e.duration) : '',
      e.created ? new Date(e.created * 1000).toLocaleDateString('de-DE') : '',
      e.used ? 'in ' + e.used + ' Projekt(en)' : ''
    ].filter(Boolean).join(' · ')) + '</div></div></li>';
}

// Gibt die gewaehlten Eintraege zurueck, oder eine leere Liste beim Abbrechen.
// mehrfach: mehrere duerfen an, und die Reihenfolge des Klickens zaehlt.
async function pickVom({ titel, hinweis, arten, mehrfach = false, leer }) {
  pickEl('title').textContent = titel;
  pickEl('hint').textContent = hinweis || '';
  pickEl('note').textContent = 'Wird gelesen …';
  pickEl('list').innerHTML = '';
  pickEl('ok').disabled = true;
  pickWahl = [];
  pickBox.showModal();

  let liste = [];
  try { liste = (await srvAlles()).filter(e => arten.includes(e.art) && e.done !== false); }
  catch (err) { pickEl('note').textContent = 'Der Server antwortet nicht: ' + err.message; }

  pickEl('list').innerHTML = liste.length
    ? liste.map(pickZeile).join('')
    : '<li><span class="what"><div class="meta">' + esc(leer || 'Nichts Passendes auf dem Server.') + '</div></span></li>';
  pickEl('note').textContent = liste.length
    ? (mehrfach ? 'Mehrere gehen — sie kommen in der Reihenfolge des Anklickens.' : 'Eine auswählen.')
    : '';

  const zeichne = () => {
    pickEl('list').querySelectorAll('li[data-i]').forEach(li => {
      const n = pickWahl.indexOf(liste[Number(li.dataset.i)]);
      li.classList.toggle('an', n >= 0);
      li.querySelector('.mark').textContent = n < 0 ? '' : mehrfach ? String(n + 1) : '✓';
    });
    pickEl('ok').disabled = !pickWahl.length;
  };
  pickEl('list').querySelectorAll('li[data-i]').forEach(li => li.onclick = () => {
    const e = liste[Number(li.dataset.i)], n = pickWahl.indexOf(e);
    if (n >= 0) pickWahl.splice(n, 1);
    else if (mehrfach) pickWahl.push(e);
    else pickWahl = [e];
    zeichne();
  });

  await new Promise(r => pickBox.addEventListener('close', r, { once: true }));
  return pickBox.returnValue === 'ok' ? pickWahl.slice() : [];
}

/* ---------- Der Sprechertext als Datei auf dem Server ---------- */

// Eingelesen wird er im Browser, aber liegen soll er dort, wo auch die Clips
// liegen - sonst fehlt im Bereich "Auf dem Server" gerade die Datei, mit der
// alles anfaengt. Abgelegt wird beim Einlesen und auf Zuruf; derselbe Text
// unter demselben Namen landet dabei nicht zweimal dort.
let textId = null;             // Kennung des Textes auf dem Server, falls abgelegt

async function textAblegen(name, text, opt = {}) {
  if (!vInfo || !(text || '').trim()) return null;
  try {
    const meta = await vJson('POST', '/texts', { name, text });
    // Gemerkt wird die Kennung nur fuer den Text, der auch im Feld steht -
    // sonst zeigte das Projekt auf eine Datei aus dem Stapel.
    if (opt.merken !== false) textId = meta.id;
    if (!opt.leise) note('Auf dem Server abgelegt: ' + meta.name);
    srvBald();
    return meta;
  } catch (e) {
    if (!opt.leise) note('Nicht abgelegt: ' + e.message);
    return null;
  }
}

// Einen abgelegten Text zurueck ins Feld. Derselbe Weg wie beim Einlesen einer
// Datei, damit Pausen und Tonspur genauso frisch gerechnet werden.
function textUebernehmen(name, text, id) {
  textEl.value = text;
  textDatei = name || null;
  textId = id || null;
  anker = null;                       // ein anderer Text folgt keinem Film
  reparse();
  built = false;
  player.hidden = true;
  setAudio(null);
  status.textContent = '';
}

/* ---------- Auf dem Server: Projekte und Dateien ---------- */

// Dieselbe Arbeitsfassung wie die Projektdatei, nur liegt sie hier beim
// Videodienst statt im Download-Ordner: schneller zurueckgeholt, an jedem Platz
// dieselbe. Die Dateien dazu - Clips, Tonspuren, fertige Videos, die Dateien
// der Abschrift - stehen darunter und verschwinden nicht mehr von selbst.
const srvEl = id => $('srv-' + id);
const SRV_STORE = 'kokoro.projekt.v1';
const SRV_ARTEN = { clips: 'Clip', voices: 'Tonspur', output: 'Fertiges Video',
                    media: 'Abschrift', texts: 'Sprechertext' };

let srvProjekte = [];
let srvDateien = { video: null, whisper: null };
let srvOffen = null;             // Kennung des zuletzt geladenen Projekts

async function initServer() {
  if (!vInfo) { srvEl('offline').hidden = false; srvEl('body').hidden = true; return; }
  try { srvOffen = localStorage.getItem(SRV_STORE) || null; } catch (e) { /* ohne Gedaechtnis */ }
  srvEl('save').onclick = () => srvSpeichern(null);
  srvEl('update').onclick = () => srvSpeichern(srvOffen);
  srvEl('reload').onclick = () => { srvHole(); srvHoleDateien(); srvHoleSaetze(); };
  srvEl('saetze-weg').onclick = srvSaetzeWeg;
  await srvHole();
  await srvHoleDateien();
  await srvHoleSaetze();
  // Ob die Seite noch dem gespeicherten Projekt entspricht, sagt erst dessen
  // Fassung auf dem Server. Gibt es das Projekt nicht mehr, ist keines offen.
  if (srvOffen) {
    try { projektGespeichert = schnappschuss((await vFetch('/projects/' + encodeURIComponent(srvOffen))).data || {}); }
    catch (e) { srvMerke(null); srvRender(); }
  }
}

function srvMerke(id) {
  srvOffen = id;
  if (!id) projektGespeichert = null;
  try { id ? localStorage.setItem(SRV_STORE, id) : localStorage.removeItem(SRV_STORE); }
  catch (e) { /* ohne Gedaechtnis */ }
  srvEl('update').disabled = !id || !srvProjekte.some(p => p.id === id);
}

function srvSag(text, fehler) {
  srvEl('state').textContent = text || '';
  srvEl('state').classList.toggle('err', !!fehler);
}

async function srvHole() {
  try {
    const d = await vFetch('/projects');
    srvProjekte = d.projects || [];
  } catch (e) {
    srvProjekte = [];
    srvSag('Die Projekte ließen sich nicht lesen: ' + e.message, true);
  }
  srvRender();
}

function srvRender() {
  const liste = srvEl('list');
  if (!srvProjekte.length) {
    liste.innerHTML = '<li><span class="what"><div class="meta">Noch kein Projekt auf dem Server.</div></span></li>';
  } else {
    liste.innerHTML = srvProjekte.map((p, i) =>
      '<li data-id="' + escAttr(p.id) + '"' + (p.id === srvOffen ? ' class="offen"' : '') + '>' +
      '<span class="num">' + (i + 1) + '</span>' +
      '<div class="what"><div class="name">' + esc(p.name || 'Ohne Namen') + '</div>' +
      '<div class="meta">' + esc([
        p.updated ? 'geändert ' + new Date(p.updated * 1000).toLocaleString('de-DE') : '',
        fmtBytes(p.size || 0),
        (p.clips || 0) + ' Clip(s)',
        p.id === srvOffen ? 'geöffnet' : ''
      ].filter(Boolean).join(' · ')) + '</div></div>' +
      '<button class="sec" data-act="load">Laden</button>' +
      '<button class="sec" data-act="save" title="Mit dem jetzigen Stand überschreiben">Speichern</button>' +
      '<button class="sec" data-act="del" title="Projekt löschen">✕</button></li>').join('');
  }
  liste.querySelectorAll('li[data-id]').forEach(li => {
    const id = li.dataset.id;
    li.querySelectorAll('button').forEach(b => b.onclick = () => {
      if (b.dataset.act === 'load') srvLaden(id);
      else if (b.dataset.act === 'save') srvSpeichern(id);
      else srvLoeschen(id);
    });
  });
  srvEl('update').disabled = !srvOffen || !srvProjekte.some(p => p.id === srvOffen);
}

async function srvSpeichern(id, neuerName) {
  const name = (neuerName || '').trim() || srvEl('name').value.trim()
    || (id && (srvProjekte.find(p => p.id === id) || {}).name)
    || textDateiName().replace(/\.md$/, '')
    || 'Projekt';
  srvSag('Wird gespeichert …');
  try {
    // Erst der Sprechertext, dann das Projekt: so zeigt "textid" im Projekt
    // auf eine Datei, die wirklich daliegt. Derselbe Text unter demselben
    // Namen landet dabei nicht zweimal dort.
    await textAblegen(textDateiName(), textEl.value, { leise: true });
    const daten = { name, data: projektDaten() };
    const p = id ? await vJson('PUT', '/projects/' + encodeURIComponent(id), daten)
                 : await vJson('POST', '/projects', daten);
    srvEl('name').value = '';
    srvMerke(p.id);
    projektGespeichert = schnappschuss(daten.data);   // so liegt es jetzt auf dem Server
    await srvHole();
    await srvHoleDateien();        // die Dateien gehoeren jetzt zu einem Projekt mehr
    srvSag('Gespeichert: „' + (p.name || name) + '“.');
    note('Projekt auf dem Server gespeichert.');
  } catch (e) {
    srvSag('Nicht gespeichert: ' + e.message, true);
  }
}

async function srvLaden(id) {
  const p = srvProjekte.find(x => x.id === id);
  if (p && !confirm('„' + (p.name || 'Projekt') + '“ laden?\n\nDer Sprechertext, die Pausen, die '
      + 'Clips und alle Einstellungen dieser Seite werden dabei ersetzt.')) return;
  srvSag('Wird geladen …');
  try {
    const voll = await vFetch('/projects/' + encodeURIComponent(id));
    const satz = await projektAnwenden(voll.data || {});
    srvMerke(id);
    projektGespeichert = projektSchnappschuss();      // geladen heisst: nichts Neues darin
    srvRender();
    srvSag('Geladen: „' + (voll.name || '') + '“ — ' + satz);
    note(satz);
  } catch (e) {
    srvSag('Nicht geladen: ' + e.message, true);
  }
}

async function srvLoeschen(id) {
  const p = srvProjekte.find(x => x.id === id) || {};
  if (!confirm('„' + (p.name || 'Projekt') + '“ vom Server löschen?\n\nDie Clips und Dateien bleiben '
      + 'liegen; nur die Arbeitsfassung verschwindet. Das lässt sich nicht rückgängig machen.')) return;
  try {
    await vFetch('/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    if (srvOffen === id) srvMerke(null);
    await srvHole();
    await srvHoleDateien();
    srvSag('Gelöscht.');
  } catch (e) {
    srvSag('Nicht gelöscht: ' + e.message, true);
  }
}

/* ----- Die Dateien dazu ----- */

async function srvHoleDateien() {
  srvDateien.video = await vFetch('/storage').catch(() => null);
  srvDateien.whisper = wInfo ? await wApi.get('/storage').catch(() => null) : null;
  srvRenderDateien();
}

// Wer einen Stapel Textdateien einliest, legt zwanzig davon hintereinander ab.
// Die Liste muss deswegen nicht zwanzigmal neu gefragt werden - einmal kurz
// danach reicht.
let srvBaldTimer = null;
function srvBald() {
  clearTimeout(srvBaldTimer);
  srvBaldTimer = setTimeout(() => srvHoleDateien().catch(() => {}), 400);
}

// Dieselbe Datei kann zweimal auf dem Server liegen: einmal beim
// Abschriftdienst zum Mitschreiben, einmal beim Videodienst als Clip. Das ist
// so gewollt - beide Dienste haben getrennte Ablagen -, sieht in einer langen
// Liste aber nach Versehen aus. Darum stehen die beiden Haelften in einer
// Zeile, mit beiden Rollen und dem doppelten Platz daneben.
function srvPaare(liste) {
  const gruppen = [], sucht = new Map();    // Name und Groesse -> Gruppe, der noch die zweite Haelfte fehlt
  const eigene = e => { const g = { name: e.name, created: e.created, teile: [e] }; gruppen.push(g); return g; };
  for (const e of liste) {
    if (e.art !== 'clips' && e.art !== 'media') { eigene(e); continue; }
    const schluessel = (e.name || '') + '|' + (e.size || 0);
    const g = sucht.get(schluessel);
    // Gepaart wird nur ueber die Dienstgrenze: ein Clip und seine Abschrift.
    // Zwei Clips desselben Namens bleiben zwei Zeilen - das sind zwei Dateien.
    if (g && !g.teile.some(t => t.art === e.art)) {
      g.teile.push(e);
      g.created = Math.max(g.created || 0, e.created || 0);
      sucht.delete(schluessel);
    } else {
      sucht.set(schluessel, eigene(e));
    }
  }
  return gruppen.sort((a, b) => (b.created || 0) - (a.created || 0));
}

function srvRenderDateien() {
  const raus = [];
  const sammle = (dienst, quelle) => {
    if (!quelle) return;
    for (const [art, liste] of Object.entries(quelle.items || {}))
      for (const e of liste) raus.push(Object.assign({ dienst, art }, e));
  };
  sammle('video', srvDateien.video);
  sammle('whisper', srvDateien.whisper);
  const gruppen = srvPaare(raus);

  const liste = srvEl('files');
  liste.innerHTML = gruppen.length ? gruppen.map((g, i) => {
    const platz = g.teile.reduce((n, e) => n + (e.size || 0), 0);
    const erst = g.teile[0];
    const dauer = g.teile.find(e => e.duration);
    const nutzt = g.teile.reduce((n, e) => n + (e.used || 0), 0);
    return '<li data-i="' + i + '">' +
      '<span class="num">' + (i + 1) + '</span>' +
      '<div class="what"><div class="name">' + esc(g.name || String(erst.id)) + '</div>' +
      '<div class="meta">' + esc([
        g.teile.map(e => SRV_ARTEN[e.art] || e.art).join(' + '),
        fmtBytes(platz) + (g.teile.length > 1 ? ' — zweimal abgelegt' : ''),
        dauer ? fmtTime(dauer.duration) : '',
        g.created ? new Date(g.created * 1000).toLocaleDateString('de-DE') : '',
        nutzt ? 'in ' + nutzt + ' Projekt(en)' : '',
        g.teile.some(e => e.done === false) ? 'unvollständig' : ''
      ].filter(Boolean).join(' · ')) + '</div></div>' +
      (erst.art === 'texts' ? '<button class="sec" data-act="get" title="In den Sprechertext holen">Holen</button>' : '') +
      '<button class="sec" data-act="del" title="Vom Server löschen">✕</button></li>';
  }).join('')
    : '<li><span class="what"><div class="meta">Nichts auf dem Server.</div></span></li>';

  liste.querySelectorAll('li[data-i]').forEach(li => {
    const g = gruppen[Number(li.dataset.i)];
    li.querySelectorAll('button').forEach(b => b.onclick = () => {
      if (b.dataset.act === 'get') srvTextHolen(g.teile[0].id, g.name);
      else srvDateiWeg(g);
    });
  });

  const belegt = (srvDateien.video ? srvDateien.video.used : 0) + (srvDateien.whisper ? srvDateien.whisper.used : 0);
  const frei = srvDateien.video ? srvDateien.video.free : (srvDateien.whisper || {}).free;
  const doppelt = gruppen.filter(g => g.teile.length > 1).length;
  srvEl('space').innerHTML = raus.length || belegt
    ? gruppen.length + ' Datei(en) · <b>' + fmtBytes(belegt) + '</b> belegt' +
      (frei ? ' · ' + fmtBytes(frei) + ' frei auf dem Server' : '') +
      (doppelt ? ' · ' + doppelt + ' davon zweimal abgelegt (Abschrift und Clip)' : '')
    : (frei ? fmtBytes(frei) + ' frei auf dem Server' : '');
}

// Einen abgelegten Sprechertext zurueck ins Feld holen.
async function srvTextHolen(id, name) {
  if (textEl.value.trim() && !confirm('„' + (name || 'Sprechertext') + '“ in das Feld holen?\n\n'
      + 'Der Text, der jetzt dort steht, wird dabei ersetzt.')) return;
  try {
    const t = await vFetch('/texts/' + encodeURIComponent(id));
    textUebernehmen(t.name, t.text, t.id);
    note('Im Feld: ' + t.name);
    openCard('sec-text');
  } catch (e) {
    // Gerufen wird das von zwei Stellen: aus dem Bereich "Auf dem Server" und
    // vom Knopf beim Sprechertext. Die Meldung muss an beiden ankommen.
    srvSag('Nicht geholt: ' + e.message, true);
    note('Nicht geholt: ' + e.message);
  }
}

// Geloescht wird die ganze Gruppe: liegt dieselbe Datei als Abschrift und als
// Clip auf dem Server, sollen beide Haelften verschwinden - sonst bleibt die
// Haelfte liegen, die man in der Liste gar nicht mehr sieht.
async function srvDateiWeg(gruppe) {
  const nutzt = gruppe.teile.reduce((n, e) => n + (e.used || 0), 0);
  const warnung = nutzt
    ? '\n\nAchtung: sie gehört noch zu ' + nutzt + ' Projekt(en) — die finden sie danach nicht mehr.'
    : '';
  const zweimal = gruppe.teile.length > 1
    ? '\n\nSie liegt zweimal (' + gruppe.teile.map(e => SRV_ARTEN[e.art] || e.art).join(' und ')
      + '); beide Teile verschwinden.' : '';
  if (!confirm('„' + (gruppe.name || 'Datei') + '“ vom Server löschen?' + warnung + zweimal
      + '\n\nDas lässt sich nicht rückgängig machen.')) return;
  try {
    for (const e of gruppe.teile) {
      const pfad = '/storage/' + encodeURIComponent(e.art) + '/' + encodeURIComponent(e.id);
      if (e.dienst === 'whisper') await wApi.get(pfad, { method: 'DELETE' });
      else await vFetch(pfad, { method: 'DELETE' });
      // Was hier verschwindet, darf in den Listen der Seite nicht stehen bleiben.
      if (e.art === 'clips' && vClips.some(c => c.id === e.id)) {
        // Dieselbe Datei darf mehrfach in der Liste stehen - dann muessen auch
        // alle diese Zeilen weg, nicht nur die erste.
        vClips.filter(c => c.id === e.id).forEach(vVergiss);
        vClips = vClips.filter(c => c.id !== e.id);
        vSave(); vRender(); scheduleVideoPlan();
      }
      if (e.art === 'media' && wMedia && wMedia.id === e.id) { wMedia = null; wSave(); wRender(); }
      if (e.art === 'texts' && textId === e.id) textId = null;
    }
    await srvHoleDateien();
    srvSag('Gelöscht: ' + (gruppe.name || 'Datei'));
  } catch (e) {
    srvSag('Nicht gelöscht: ' + e.message, true);
  }
}

/* ----- Die gesprochenen Saetze ----- */

// Der Sprachdienst hebt jeden gesprochenen Satz auf. Hier steht, wie viel das
// ist, und hier wird es auf Zuruf weggeworfen. Anders als die Dateien darueber
// ist das ein Speicher, kein Lager: was herausfaellt, spricht die Stimme beim
// naechsten Mal eben wieder.
let srvSaetze = null;          // {saetze, bytes, sekunden, max_bytes}; null ohne Antwort

async function srvHoleSaetze() {
  srvSaetze = await sayApi.get('/zwischenspeicher').catch(() => null);
  srvRenderSaetze();
}

function srvRenderSaetze() {
  const s = srvSaetze;
  const dauer = t => t >= 3600 ? Math.floor(t / 3600) + ' h ' + Math.floor(t % 3600 / 60) + ' min' : fmtTime(t);
  srvEl('saetze-weg').disabled = !s || !s.saetze;
  srvEl('saetze').innerHTML = !s ? 'Der Sprachdienst antwortet nicht.'
    : !s.max_bytes ? 'Abgeschaltet — die Stimme spricht jedes Mal alles neu.'
    : !s.saetze ? 'Noch nichts gesprochen · höchstens ' + fmtBytes(s.max_bytes)
    : s.saetze.toLocaleString('de-DE') + ' Satz/Sätze · ' + dauer(s.sekunden) + ' Sprache · <b>' +
      fmtBytes(s.bytes) + '</b> von höchstens ' + fmtBytes(s.max_bytes);
}

async function srvSaetzeWeg() {
  const n = (srvSaetze || {}).saetze || 0;
  if (!confirm('Alle ' + n.toLocaleString('de-DE') + ' gesprochenen Sätze vom Server löschen?\n\n'
      + 'Was danach gebraucht wird, spricht die Stimme neu — das dauert wieder, und es klingt '
      + 'etwas anders als bisher. Der Ton, der gerade in der Seite ist, bleibt.')) return;
  try {
    srvSaetze = await sayApi.get('/zwischenspeicher', { method: 'DELETE' });
    srvRenderSaetze();
    srvSag('Die gesprochenen Sätze sind gelöscht.');
  } catch (e) {
    srvSag('Nicht gelöscht: ' + e.message, true);
  }
}

/* ---------- Arbeitsstand: nichts geht verloren ---------- */

// Was gerade in der Seite steht, haelt der Browser fest: Sprechertext, Tempo,
// die einzeln gesetzten Pausen und der Film, dem sie folgen. Nach dem
// Neuladen steht die Seite wieder so da, und der Ton kommt aus dem Speicher
// des Sprachdienstes nach. Den Beispieltext gibt es nur beim ersten Besuch
// und nach "Alles zurücksetzen". Clips und Einstellungen merken sich ihre
// Bereiche schon selbst.
//
// Oben steht dazu das geoeffnete Projekt: sein Name und ob der Stand auf dem
// Server noch dem in der Seite entspricht. Verglichen wird mit genau der
// Fassung, die zuletzt gespeichert oder geladen wurde.
const ARBEIT_STORE = 'kokoro.arbeit.v1';
let arbeitStand = null;          // zuletzt im Browser festgehaltene Fassung, als JSON
let projektGespeichert = null;   // die Fassung des geoeffneten Projekts auf dem Server
let arbeitBereit = false;        // erst wenn alle Dienste geantwortet haben, wird verglichen
let tonNachStart = false;        // vor dem Neuladen lag schon Ton vor
let arbeitAus = false;           // "Alles zurücksetzen" laeuft: nichts mehr festhalten
let beispiel = null;             // der Beispieltext, wie er geladen wurde

// Mit sortierten Schluesseln: dieselbe Fassung ergibt dieselbe Zeichenkette,
// gleich in welcher Reihenfolge der Server sie zurueckgibt.
function stabil(x) {
  if (Array.isArray(x)) return '[' + x.map(stabil).join(',') + ']';
  if (x && typeof x === 'object')
    return '{' + Object.keys(x).sort().filter(k => x[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + stabil(x[k])).join(',') + '}';
  return JSON.stringify(x === undefined ? null : x);
}

// Der Zeitpunkt des Speicherns macht kein Projekt anders.
function schnappschuss(daten) {
  const d = Object.assign({}, daten);
  delete d.erstellt;
  return stabil(d);
}
const projektSchnappschuss = () => schnappschuss(projektDaten());

function arbeitDaten() {
  return {
    text: textEl.value, textdatei: textDatei, textid: textId, tempo: Number(speed.value),
    pausen: parts.filter(p => p.type === 'pause').map(p => ({ art: p.kind, dauer: p.dur, geaendert: !!p.manual })),
    neuvertonung: ankerFuerProjekt(), ton: built
  };
}

function arbeitSichern() {
  if (!arbeitBereit || arbeitAus || timer) return;   // mitten im Tippen: beim naechsten Mal
  const jetzt = JSON.stringify(arbeitDaten());
  if (jetzt === arbeitStand) return;
  try { localStorage.setItem(ARBEIT_STORE, jetzt); arbeitStand = jetzt; }
  catch (e) { /* ohne Gedaechtnis - dann eben wie frueher */ }
}

// Beim Start: der Stand vom letzten Mal, falls es einen gibt. Heraus kommt,
// ob einer da war - sonst kommt der Beispieltext.
function arbeitLaden() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(ARBEIT_STORE) || 'null'); } catch (e) { /* kaputter Eintrag */ }
  if (!o || typeof o.text !== 'string') return false;
  textEl.value = o.text;
  textDatei = typeof o.textdatei === 'string' && o.textdatei ? o.textdatei : null;
  textId = typeof o.textid === 'string' && o.textid ? o.textid : null;
  if (isFinite(o.tempo) && o.tempo > 0) { speed.value = o.tempo; speed.oninput(); }
  anker = ankerAusProjekt(o.neuvertonung);
  reparse();
  pausenAnwenden(o.pausen);
  render();
  ankerZeige();
  tonNachStart = !!o.ton && !!o.text.trim();
  return true;
}

// Hat sich seit dem letzten Speichern oder Laden etwas geaendert?
function projektGeaendert() {
  return !!(arbeitBereit && srvOffen && projektGespeichert !== null &&
            projektSchnappschuss() !== projektGespeichert);
}

function projektStand() {
  const bar = $('projekt');
  bar.hidden = !vInfo;                           // Projekte liegen beim Videodienst
  if (!vInfo) return;
  const p = srvOffen && srvProjekte.find(x => x.id === srvOffen);
  // Das unberuehrte Beispiel ist nichts, was verloren gehen koennte.
  const t = textEl.value.trim();
  const inhalt = !!((t && t !== (beispiel || '').trim()) || vClips.length);
  const geaendert = p ? projektGeaendert() : inhalt;
  $('projekt-name').textContent = p ? (p.name || 'Ohne Namen') : 'Neues Projekt';
  const stand = $('projekt-stand');
  stand.textContent = p ? (geaendert ? 'nicht gespeichert' : 'gespeichert')
                        : inhalt ? 'noch nicht gespeichert' : '';
  stand.classList.toggle('offen', geaendert);
  $('projekt-sichern').disabled = !p && !inhalt;
  $('projekt-sichern').title = p ? '„' + (p.name || 'Projekt') + '“ auf dem Server speichern (Strg+S)'
                                 : 'Als neues Projekt auf dem Server speichern (Strg+S)';
}

// Ein neues Projekt fragt erst nach seinem Namen; vorgeschlagen wird der des
// Sprechertextes.
function nameFragen(vorschlag) {
  const box = $('namen'), feld = $('namen-feld');
  feld.value = vorschlag || '';
  box.returnValue = '';
  box.showModal();
  feld.select();
  return new Promise(fertig => box.addEventListener('close', () =>
    fertig(box.returnValue === 'ok' ? feld.value.trim() : null), { once: true }));
}
$('namen-weg').onclick = () => $('namen').close('');

async function projektSichern() {
  if (!vInfo) return;
  if (srvOffen && srvProjekte.some(x => x.id === srvOffen)) { await srvSpeichern(srvOffen); }
  else {
    if (!textEl.value.trim() && !vClips.length) { note('Noch nichts zum Speichern.'); return; }
    const name = await nameFragen(textDatei ? textDateiName().replace(/\.md$/, '') : '');
    if (name === null) return;
    await srvSpeichern(null, name || 'Projekt');
  }
  arbeitSichern();
  projektStand();
}
$('projekt-sichern').onclick = projektSichern;
$('projekt-name').onclick = () => { openCard('sec-server'); srvHole(); };

// Strg+S (am Mac Befehl+S) speichert das Projekt statt der Seite.
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    if (!$('namen').open) projektSichern();
  }
});

// Verloren ginge beim Schliessen nur, was noch unterwegs ist - ein Upload,
// ein laufender Auftrag -, und was im geoeffneten Projekt noch nicht
// gespeichert ist. Alles andere steht beim naechsten Mal wieder da.
addEventListener('beforeunload', e => {
  arbeitSichern();
  const unterwegs = vUploading || vBusy() || zBusy() || exporting || batchRunning ||
                    (wMedia && wMedia.state === 'uploading');
  if (arbeitAus || (!unterwegs && !projektGeaendert())) return;
  e.preventDefault();
  e.returnValue = '';
});
addEventListener('pagehide', arbeitSichern);

// Erst wenn alle Dienste geantwortet haben, stehen Clips und Einstellungen
// fest - vorher saehe jede Fassung anders aus als die gespeicherte.
function arbeitStart() {
  arbeitBereit = true;
  arbeitStand = null;
  arbeitSichern();
  projektStand();
  setInterval(() => { arbeitSichern(); projektStand(); }, 1000);
  if (tonNachStart && !controller) projektTon();   // der Ton vom letzten Mal, aus dem Speicher
}
