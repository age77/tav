// TAV · Verdrahtung, Menue, Farben und der Start der Seite.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Verdrahtung ---------- */

let timer = null;
// Wer unten selbst tippt, hat das letzte Wort: das Feld im Schnittfenster
// zeigte sonst eine ueberholte Fassung derselben Zeile.
textEl.oninput = () => {
  tlEditZu(false);
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; reparse(); }, 350);
};

// Die Vorschau folgt dem Tippen erst nach kurzer Ruhe. Wer vorher schon
// "Audio erzeugen" drueckt - gleich nach dem Einfuegen etwa -, meint trotzdem
// den Text, der jetzt im Feld steht, und nicht den von vor einer Sekunde.
function reparseJetzt() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  reparse();
}
function reparse() {
  parts = parse(textEl.value);
  const n = textEl.value.trim().length;
  textNote.textContent = n ? n.toLocaleString('de-DE') + ' Zeichen' : '';
  textMd.disabled = !n;
  textMd.title = n ? 'Speichert als ' + textDateiName() : 'Noch kein Text zum Speichern.';
  const up = $('text-up');
  up.disabled = !n;
  up.title = n ? 'Legt ihn als ' + textDateiName() + ' unter „Projekte & Dateien“ ab.'
               : 'Noch kein Text zum Ablegen.';
  render();
  ankerZeige();                       // passt der Text noch zur Abschrift?
}

// Schreibt den Sprechertext neu, ohne dass jemand, der gerade darin steht,
// seine Stelle verliert: Auswahl und Bildlauf wandern mit ihren Zeilen.
// "zuNeu" sagt, wohin eine Zeile gewandert ist.
function textSetzen(neu, zuNeu) {
  const alt = tlZeilen(), fokus = document.activeElement === textEl, oben = textEl.scrollTop;
  const zeileSpalte = off => {
    let l = 0;
    while (l < alt.length - 1 && off > alt[l].length) { off -= alt[l].length + 1; l++; }
    return [l, off];
  };
  const auswahl = fokus ? [zeileSpalte(textEl.selectionStart), zeileSpalte(textEl.selectionEnd)] : null;
  textEl.value = neu;
  if (auswahl) {
    const z = neu.split('\n');
    const stelle = ([l, c]) => {
      const ziel = Math.min(z.length - 1, zuNeu(l));
      let off = 0;
      for (let i = 0; i < ziel; i++) off += z[i].length + 1;
      return off + Math.min(c, z[ziel].length);
    };
    textEl.setSelectionRange(stelle(auswahl[0]), stelle(auswahl[1]));
  }
  textEl.scrollTop = oben;
}

for (const kind of Object.keys(KINDS)) {
  if (!KINDS[kind].input) continue;                  // Textpause hat keinen Standardwert
  $(KINDS[kind].input).oninput = () => {
    // Nur die Pausen nachziehen, die noch nicht von Hand geaendert wurden.
    parts.forEach(p => { if (p.type === 'pause' && p.kind === kind && !p.manual) p.dur = defaultFor(kind); });
    render();
    saveDefaults();
    scheduleRefresh();
  };
}
$('d-sentence').oninput = () => { updateSummary(); saveDefaults(); scheduleRefresh(); };

resetBtn.onclick = () => {
  // Pausen aus dem Text behalten ihre Laenge - sie steht im Sprechtext.
  parts.forEach(p => { if (p.type === 'pause' && p.kind !== 'custom') { p.dur = defaultFor(p.kind); p.manual = false; } });
  render();
  scheduleRefresh();
};
speed.oninput = () => {
  speedval.textContent = Number(speed.value).toFixed(2) + '×';
  tlNeu();                            // anderes Tempo, andere geschaetzte Laengen
};
stopBtn.onclick = () => controller && controller.abort();
go.onclick = () => speak();          // ohne das Klickereignis als Einstellung

// Strg+Enter (am Mac Befehl+Enter) spricht, von wo auch immer. Im Feld des
// Schnittfensters schliesst es den Abschnitt ab und spricht nach.
addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter' || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (document.activeElement === tlEl('text')) { tlEditZu(true); tlSprich(); return; }
  if (!go.disabled) speak();
});

exportBtn.onclick = exportProject;
importBtn.onclick = () => fileEl.click();
// Die Projekte auf dem Server stehen in ihrem eigenen Bereich; von hier geht
// es nur hin - geladen wird dort, wo auch die Namen und die Daten stehen.
$('import-srv').onclick = () => { openCard('sec-server'); srvHole(); srvHoleDateien(); srvHoleSaetze(); };
fileEl.onchange = () => { if (fileEl.files[0]) importProject(fileEl.files[0]); fileEl.value = ''; };

/* ---------- Neues Projekt ---------- */

// Leer anfangen, ohne alles zurueckzusetzen: Sprechertext, Clips und Ton gehen
// aus der Seite, die Einstellungen bleiben - wer das naechste Video im selben
// Stil macht, soll Format, Untertitel und Pausen nicht neu waehlen muessen. Auf
// dem Server bleibt alles liegen, auch das bisher geoeffnete Projekt, so wie
// es zuletzt gespeichert wurde; die Seite zeigt nur nicht mehr darauf, damit
// "Geöffnetes überschreiben" es nicht mit dem neuen ueberschreibt. Abschrift
// und Stapel sind eigene Werkzeuge und bleiben, wie sie sind.
function neuesProjekt() {
  const hindernis = exporting ? 'Die Audiodatei wird gerade geschrieben.'
    : vUploading || vDownloading || vBusy() ? 'Der Videodienst ist gerade beschäftigt.' : null;
  if (hindernis) { note(hindernis + ' Erst abwarten oder anhalten, dann neu anfangen.'); return; }
  if ((textEl.value.trim() || vClips.length) &&
      !confirm('Ein neues, leeres Projekt beginnen?\n\nSprechertext, Clips und Ton gehen aus der Seite, '
             + 'die Einstellungen bleiben. Auf dem Server bleibt alles liegen — was dort noch nicht '
             + 'gespeichert ist, geht aber verloren.')) return;

  if (controller) controller.abort();          // der Ton des alten Textes wird nicht mehr gebraucht
  player.pause();
  tlHalt();
  tlEditZu(false);
  textUebernehmen(null, '', null);
  vClips.forEach(vVergiss);
  vClips = [];
  vVoice = null;
  vJob = null;
  vEl('dl').hidden = true; vEl('cancel').hidden = true; vEl('prog').hidden = true;
  // Ohne Videodienst stehen die Auswahlfelder leer; gemerkt wuerde sonst das.
  if (vInfo) { vSave(); vRender(); scheduleVideoPlan(); }
  srvMerke(null);
  srvRender();
  tlSpringZu(0);
  openCard('sec-text');
  textEl.focus();
  note('Neues Projekt: der Sprechertext ist leer. „Speichern“ oben legt es auf den Server.');
}

// Wie beim Zuruecksetzen: erst schliesst der Klick das Menue, dann die Rueckfrage.
$('neu').onclick = () => setTimeout(neuesProjekt, 0);

/* ---------- Alles zuruecksetzen ---------- */

// Der Griff fuer den naechsten Film: Sprechertext, Pausen, Stapel, Clips und
// Abschrift sind aus der Seite geraeumt, alle Einstellungen stehen wieder auf
// ihren Standardwerten. Das Gedaechtnis des Browsers wird geleert, dann laedt
// die Seite neu - so steht sie nachweislich da wie beim ersten Besuch, statt
// dass hier jedes Feld einzeln zurueckgedreht wird. Die Farbwahl bleibt: die
// ist Geschmack und keine Arbeit. Was auf dem Server liegt, bleibt ebenfalls -
// geloescht wird dort im Bereich "Auf dem Server".
const RESET_STORES = [STORE, XSTORE, VSTORE, WSTORE, UI_STORE, SRV_STORE, ARBEIT_STORE];

// Mitten im Schritt abzuraeumen liesse halbe Dateien auf dem Server liegen;
// wer zuruecksetzen will, haelt vorher an.
function resetHindernis() {
  if (controller) return 'Es wird gerade gesprochen.';
  if (batchRunning) return 'Der Stapel wird gerade gesprochen.';
  if (exporting) return 'Die Audiodatei wird gerade geschrieben.';
  if (vUploading || vDownloading || vBusy()) return 'Der Videodienst ist gerade beschäftigt.';
  if (wBusy() || (wMedia && wMedia.state === 'uploading')) return 'Die Abschrift ist gerade beschäftigt.';
  return null;
}

async function resetAll() {
  const hindernis = resetHindernis();
  if (hindernis) { note(hindernis + ' Erst anhalten, dann zurücksetzen.'); return; }
  if (!confirm('Alles zurücksetzen?\n\nSprechertext, Pausen, Stapel, Clips und Abschrift werden '
             + 'aus der Seite geräumt, alle Einstellungen stehen danach wieder auf ihren '
             + 'Standardwerten.\n\nWas auf dem Server liegt — Projekte, Clips, Tonspuren, fertige '
             + 'Videos —, bleibt liegen; das wird unter „Projekte & Dateien“ gelöscht.')) return;
  note('Wird zurückgesetzt…');
  arbeitAus = true;                    // sonst schriebe das Neuladen den alten Stand zurueck

  // Auf dem Server wird nichts angefasst. Fruher verschwand dort ohnehin alles
  // nach VIDEO_KEEP_HOURS, da war das Abraeumen Hoeflichkeit; jetzt bleibt,
  // was dort liegt, bis es jemand loescht - und es kann zu einem gespeicherten
  // Projekt gehoeren, das danach ins Leere zeigte.
  const laufend = [];
  const still = p => laufend.push(p.catch(() => {}));
  if (vInfo && vJob && vJob.id) still(vFetch('/jobs/' + vJob.id, { method: 'DELETE' }));
  if (wInfo && wJob && wJob.id) still(wApi.get('/jobs/' + wJob.id, { method: 'DELETE' }));
  await Promise.race([Promise.all(laufend), new Promise(r => setTimeout(r, 4000))]);

  for (const key of RESET_STORES) {
    try { localStorage.removeItem(key); } catch (e) { /* ohne Gedaechtnis */ }
  }
  // Ohne Sprungmarke faengt die Seite wieder oben an.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  location.reload();
}

// Erst schliesst der Klick das Menue, dann kommt die Rueckfrage - sonst stuende
// das Menue offen hinter dem Fenster des Browsers.
$('wipe').onclick = () => setTimeout(resetAll, 0);

/* ---------- Menue ---------- */

// Farben, Anleitung und der Austausch ganzer Projekte liegen hinter dem
// Burger-Knopf. Die Knoepfe darin behalten ihre Kennungen, ihre Handgriffe
// haengen unveraendert weiter unten.
const menuBtn = $('menu-btn'), menuBox = $('menu');

function menuAuf(offen) {
  menuBox.hidden = !offen;
  menuBtn.setAttribute('aria-expanded', offen ? 'true' : 'false');
}

menuBtn.onclick = e => { e.stopPropagation(); menuAuf(menuBox.hidden); };

// Ein Griff ins Menue schliesst es wieder - ausser bei den Farben, die der
// Reihe nach durchschalten und dabei sichtbar bleiben sollen.
menuBox.onclick = e => { if (!e.target.closest('#theme')) menuAuf(false); };

addEventListener('click', e => { if (!e.target.closest('.menuwrap')) menuAuf(false); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !menuBox.hidden) { menuAuf(false); menuBtn.focus(); } });

/* ---------- Auskunft zur KI ---------- */

// Die Marke rechts in der Kopfzeile einer Karte ist ein Knopf: ein Klick
// fragt den Dienst selbst, welches Modell und welche Programmfassung dort
// gerade laufen. Gefragt wird einmal je Dienst, danach steht die Antwort.
const INFO = {
  whisper: { url: '/whisper/api/info',
             text: 'Whisper von OpenAI, ausgef\u00fchrt mit faster-whisper auf der CPU dieses Servers \u2014 im Dienst tav-whisper.' },
  kokoro:  { url: '/v1/info',
             text: 'Kokoro als ONNX-Modell mit der deutschen Stimme Martin, auf der CPU dieses Servers \u2014 im Dienst tav-onnx.' }
};
const infoCache = {};

// Der Dienst liefert die Angaben als Paare; leere Felder bleiben weg, damit
// hier nichts Erfundenes steht.
function infoListe(engine) {
  const zeilen = [
    ['Modell', engine.model],
    ['Stimme', engine.voice],
    ['Sprache', engine.language],
    ['Programm', engine.name && engine.version ? engine.name + ' ' + engine.version : engine.version],
    ['Laufzeit', engine.runtime],
    ['Rechenart', engine.compute],
    ['Gerät', engine.device]
  ].filter(z => z[1] !== undefined && z[1] !== null && z[1] !== '');
  if (!zeilen.length) return '';
  return '<dl>' + zeilen.map(z => '<dt>' + esc(z[0]) + '</dt><dd>' + esc(String(z[1])) + '</dd>').join('') + '</dl>';
}

async function zeigeInfo(name, box) {
  const q = INFO[name];
  box.innerHTML = '<p>' + esc(q.text) + '</p><p style="margin-top:.6rem">Wird abgefragt \u2026</p>';
  if (!infoCache[name]) {
    try {
      const r = await fetch(q.url, { headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('Der Dienst antwortet mit ' + r.status + '.');
      const d = await r.json();
      if (!d.engine) throw new Error('Der Dienst nennt seine Fassung nicht.');
      infoCache[name] = d.engine;
    } catch (e) {
      box.innerHTML = '<p>' + esc(q.text) + '</p><p style="margin-top:.6rem" class="warn">'
        + esc('Die Fassung ließ sich nicht erfragen: ' + e.message) + '</p>';
      return;
    }
  }
  box.innerHTML = '<p>' + esc(q.text) + '</p>' + infoListe(infoCache[name]);
}

// Die Marke steckt in der Kopfzeile, und die klappt die Karte auf und zu:
// Klicks auf Knopf und Auskunft duerfen dort nicht durchschlagen.
document.querySelectorAll('.toolwrap').forEach(wrap => {
  const btn = wrap.querySelector('button.tool'), box = wrap.querySelector('.toolinfo');
  wrap.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.target.closest('button.tool')) return;   // Klick in die Auskunft selbst
    const auf = box.hidden;
    document.querySelectorAll('.toolinfo').forEach(b => {
      b.hidden = true;
      b.closest('.toolwrap').querySelector('button.tool').setAttribute('aria-expanded', 'false');
    });
    box.hidden = !auf;
    btn.setAttribute('aria-expanded', auf ? 'true' : 'false');
    if (auf) zeigeInfo(btn.dataset.info, box);
  });
});

addEventListener('click', e => {
  if (e.target.closest('.toolwrap')) return;
  document.querySelectorAll('.toolinfo').forEach(b => {
    b.hidden = true;
    b.closest('.toolwrap').querySelector('button.tool').setAttribute('aria-expanded', 'false');
  });
});
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.toolinfo:not([hidden])').forEach(b => {
    b.hidden = true;
    b.closest('.toolwrap').querySelector('button.tool').setAttribute('aria-expanded', 'false');
  });
});

/* ---------- Farben ---------- */

// Drei Zustaende im Kreis: dem System folgen, hell, dunkel. Die Wahl steht als
// data-theme am <html>; das CSS sperrt damit die Systemabfrage aus oder
// schaltet ohne sie um. Gesetzt wird sie schon im Kopf der Seite, damit beim
// Laden nicht kurz die helle Fassung aufblitzt.
const THEME_STORE = 'kokoro.thema.v1';
const THEMES = [['auto', '◐', 'Automatisch'], ['light', '☀', 'Hell'], ['dark', '☾', 'Dunkel']];

function applyTheme(name) {
  const [id, icon, label] = THEMES.find(t => t[0] === name) || THEMES[0];
  if (id === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  $('theme-icon').textContent = icon;
  $('theme-label').textContent = label;
  $('theme').dataset.mode = id;
  measureHead();
}

function initTheme() {
  let saved = 'auto';
  try { saved = localStorage.getItem(THEME_STORE) || 'auto'; } catch (e) { /* ohne Gedaechtnis */ }
  applyTheme(saved);
  $('theme').onclick = () => {
    const i = THEMES.findIndex(t => t[0] === $('theme').dataset.mode);
    const next = THEMES[(i + 1) % THEMES.length][0];
    applyTheme(next);
    try { localStorage.setItem(THEME_STORE, next); } catch (e) { /* ohne Gedaechtnis */ }
  };
}

/* ---------- Anleitung als Datei ---------- */

// Die Anleitung steht wortgleich als SPRECHTEXT-ANLEITUNG.md neben der Seite.
// Der Knopf reicht diese Datei weiter, statt die Seite zurueckzuuebersetzen —
// so bleibt eine Fassung die massgebliche. Der Hinweis an die Pflegenden ganz
// oben in der Datei geht niemanden an, der sie nur lesen soll, und faellt weg.
const GUIDE_FILE = 'SPRECHTEXT-ANLEITUNG.md';

$('guide-md').onclick = async () => {
  try {
    const r = await fetch(GUIDE_FILE, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = (await r.text()).replace(/^\s*<!--[\s\S]*?-->\s*/, '');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = GUIDE_FILE;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    note('Gespeichert: ' + GUIDE_FILE);
  } catch (e) {
    note('Die Anleitung liegt nicht neben der Seite: ' + e.message);
  }
};

/* ---------- Angemeldeter Benutzer ---------- */

// Vor der Seite steht oauth2-proxy mit Keycloak als Anmeldung. Der Proxy
// beantwortet /oauth2/userinfo mit den Daten der laufenden Sitzung, auf
// derselben Adresse wie die Seite. Antwortet er nicht (Seite ohne Proxy
// aufgerufen, Sitzung abgelaufen), bleibt die Anzeige einfach leer.
async function showUser() {
  try {
    const r = await fetch('/oauth2/userinfo', { credentials: 'same-origin' });
    if (!r.ok) return;
    const u = await r.json();
    const name = (u.preferredUsername || u.user || u.email || '').trim();
    if (!name) return;
    uname.textContent = name;
    avatar.textContent = name.charAt(0).toUpperCase();
    if (u.email && u.email !== name) whoami.title = u.email;   // voller Name beim Zeigen
    whoami.hidden = false;
  } catch (e) { /* ohne Proxy laeuft die Seite unangemeldet */ }
}
showUser();

initTheme();
initExport();
const videoBereit = initVideo();
const abschriftBereit = initWhisper();
const ausspracheBereit = initSay();
initSchnitt();
reiterStart();                         // der Reiter aus der Adresse oder vom letzten Mal
loadDefaults();
if (!arbeitLaden()) loadExample();     // der Stand vom letzten Mal, sonst das Beispiel

// Der Bereich "Auf dem Server" fragt beide Dienste; erst wenn die geantwortet
// haben, weiss er, was dort liegt - und ob es ihn ueberhaupt zu zeigen gibt.
Promise.allSettled([videoBereit, abschriftBereit]).then(async () => {
  await Promise.allSettled([initServer(), initZusammen(), ausspracheBereit]);
  arbeitStart();
});

// Der Beispieltext steht in beispiel.txt neben der Seite und laesst sich dort
// aendern, ohne die Seite anzufassen. Fehlt die Datei, startet die Seite mit
// leerem Feld.
async function loadExample() {
  try {
    const r = await fetch('beispiel.txt', { cache: 'no-store' });
    if (r.ok) textEl.value = beispiel = (await r.text()).replace(/\s+$/, '');
  } catch (e) { /* ohne Datei bleibt das Feld leer */ }
  reparse();
}
