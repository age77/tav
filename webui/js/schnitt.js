// TAV · Schnittfenster: Zeitleiste, Bild, Ton, Schnitt.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Schnittfenster ---------- */

// Zeitleiste, Bildvorschau und Textcursor an einer Stelle. Gerechnet wird in
// Sekunden des fertigen Videos: die Clips liegen hintereinander, eine
// Ueberblendung laesst sie ueberlappen, die Sprachausgabe beginnt beim
// eingestellten Versatz. Dieselbe Rechnung stellt spaeter ffmpeg an - die
// Zeitleiste zeigt also, was herauskommt, ohne dass etwas kodiert wird.
//
// Geschnitten wird hier nichts. Was sich aendern laesst, sind die Pausen, und
// das ist derselbe Griff wie im Feld der Vorschau: die Tonspur wird danach nur
// neu zusammengesetzt, nicht neu gesprochen.

const tlEl = id => $('tl-' + id);
const tlCard = $('sec-schnitt');
const tlA = tlEl('a'), tlB = tlEl('b');
// Wie am Schnittplatz: der erste Druck auf J oder L faehrt in normaler
// Geschwindigkeit, jeder weitere verdoppelt sie.
const TL_TEMPI = [1, 2, 4, 8];
const TL_ZOOM = [1, 2, 4, 8, 16];
const fmtSek = s => s.toFixed(2).replace('.', ',') + ' s';

let tlZeit = 0;          // Stelle auf der Zeitleiste, in Sekunden
let tlTempo = 0;         // 0 = steht; sonst Faktor, negativ ist rueckwaerts
let tlZoomStufe = 0;
let tlWahl = null;       // angeklickte Pause: ihr Platz in parts
let tlPlan = null;       // gerechnetes Modell, siehe tlModel()
let tlUhr = 0, tlAbZeit = 0, tlRaf = null;
let tlMarkiert = null;   // hervorgehobener Teil der Vorschau
let tlFuehrtTon = false; // spielt die Seite gerade die Sprachausgabe?
let tlMarke = null;      // Marke fuer "Stück entfernen", in Sekunden der Zeitleiste
let tlOben = null;       // der Bildschirm, der gerade oben liegt - nur auf den wartet man
let tlBildTimer = null;  // Anzeige "Bild lädt" erst nach kurzem Warten

// Gerechnet und gespielt wird nur, solange das Schnittfenster zu sehen ist:
// im Reiter "Schnitt" oder im Vollbild.
const tlOffen = () => reiterJetzt === 'schnitt' || document.fullscreenElement === tlCard;

/* ----- Das Modell: was liegt wann ----- */

// Bildrate des Ergebnisses: die eingestellte, sonst die hoechste der Clips.
// Dieselbe Wahl trifft der Videodienst in make_plan().
function tlBildrate(items) {
  const wunsch = vInfo ? Number(vEl('fps').value) || 0 : 0;
  if (wunsch) return wunsch;
  const raten = items.map(c => (c.clip.meta || c.clip.local).fps).filter(f => f > 0);
  return raten.length ? Math.min(60, Math.max(...raten)) : 25;
}

// Bildspur: wo jeder Clip auf der Zeitleiste liegt. Eine Ueberblendung zieht
// den naechsten Clip um ihre Dauer nach vorn, so wie xfade es spaeter tut.
function tlClips() {
  const blende = vInfo ? Number(vEl('transition').value) || 0 : 0;
  const items = [];
  // Hinter dem Vorspann faengt der erste Clip an, hinter dem letzten steht das
  // Bild noch einmal so lange still.
  let t = vVorspann();
  for (const c of vClips) {
    const d = vDauer(c);
    if (!d) continue;
    items.push({ clip: c, t0: t, t1: t + d });
    t += d - blende;
  }
  return { items, total: items.length ? items[items.length - 1].t1 + vVorspann() : 0, blende };
}

// Dauer eines Abschnitts: gemessen, sobald er gesprochen ist, sonst aus der
// Zeichenzahl geschaetzt - dieselbe Rechnung wie in durations().
function tlAbschnittSek(text) {
  const pcm = cache.get(cacheKey(text));
  if (pcm) return pcm.length / lastRate;
  const saetze = Math.max(0, (text.match(/[.!?](?=\s|$)/g) || []).length - 1);
  return text.length / (CHARS_PER_SEC * Math.pow(Number(speed.value) || 1, TEMPO_EXP))
         + saetze * sentencePause();
}

// Sprachspur: jede Pause und jeder Abschnitt mit Anfang und Ende. Die Teile
// eines zusammengewachsenen Abschnitts stehen einzeln darin, damit der Cursor
// die richtige Zeile der Vorschau findet; ihre Dauer verteilt sich nach der
// Zeichenzahl, denn feiner misst die Seite nicht.
//
// Pausen von 0 s stehen mit darin, obwohl sie nichts trennen: in der
// Zeitleiste sind sie der Griff, an dem sich eine neue Pause aufziehen laesst.
function tlSprache() {
  const { segs, gaps, lead, tail } = layout();
  const items = [];
  let t = 0, gemessen = true;
  const pause = p => {
    if (!p) return;
    items.push({ art: 'pause', part: p.part, t0: t, t1: t + Math.max(0, p.dur) });
    t += Math.max(0, p.dur);
  };
  pause(lead);
  segs.forEach((s, i) => {
    const dauer = tlAbschnittSek(s.text);
    // Liegt der Ton schon vor, wird gerade gesprochen, oder fehlt er noch?
    // Dieselbe Frage beantwortet die Farbe des Blocks in der Zeitleiste.
    const key = cacheKey(s.text);
    const zustand = spricht === key ? 'laeuft' : cache.has(key) ? 'fertig' : 'wartet';
    if (zustand !== 'fertig') gemessen = false;
    const t0 = t;
    for (const st of s.stuecke)
      items.push({ art: 'text', part: st.part, zustand,
                   t0: t0 + dauer * st.von / s.text.length,
                   t1: t0 + dauer * st.bis / s.text.length });
    t = t0 + dauer;
    pause(gaps[i]);
  });
  pause(tail);
  return { items, total: t, gemessen };
}

function tlModel() {
  if (tlPlan) return tlPlan;
  const clips = tlClips();
  const sprache = tlSprache();
  const mit = (!vInfo || vEl('voice').checked) && sprache.total > 0;
  const versatz = vSprachVersatz();
  const ende = mit ? versatz + sprache.total + vVorspann() : 0;   // dahinter der Nachspann
  const art = vInfo ? vEl('length').value : 'longer';
  const total = !clips.total ? ende
    : art === 'voice' && ende ? ende
    : art === 'video' ? clips.total
    : Math.max(clips.total, ende);
  return (tlPlan = { clips, sprache, mit, versatz, total, fps: tlBildrate(clips.items) });
}

// Alles, was an Laenge oder Reihenfolge ruettelt, wirft das Modell weg.
// Gerechnet wird erst wieder, wenn die Zeitleiste danach fragt.
function tlNeu() {
  tlPlan = null;
  if (!tlOffen()) return;
  tlZeichne();
  tlStelle();
}

// Neue Clips sollen zu sehen sein, nicht bloss in der Liste stehen: der Kopf
// geht an den Anfang, der Bereich klappt auf, und das Bild wird frisch geholt.
// Zugeklappt rechnet die Zeitleiste sonst gar nicht - dann kam das Bild erst,
// wenn man den Bereich von Hand aufmachte.
function tlZeigen() {
  tlHalt();
  tlZeit = 0;
  tlPlan = null;
  if (!vClips.length) { tlNeu(); return; }
  openCard('sec-schnitt');
  tlNeu();
}

// Welches Stueck Sprache liegt an dieser Stelle der Zeitleiste?
function tlAn(t) {
  const m = tlModel();
  if (!m.mit) return null;
  const tau = t - m.versatz, list = m.sprache.items;
  if (tau < 0 || tau > m.sprache.total || !list.length) return null;
  let lo = 0, hi = list.length - 1, tr = -1;
  while (lo <= hi) {
    const mit2 = (lo + hi) >> 1;
    if (list[mit2].t0 <= tau) { tr = mit2; lo = mit2 + 1; } else hi = mit2 - 1;
  }
  if (tr < 0) return null;
  while (tr < list.length - 1 && list[tr].t1 <= tau) tr++;   // Pausen von 0 s ueberspringen
  const st = list[tr];
  return { st, anteil: Math.min(1, Math.max(0, (tau - st.t0) / Math.max(1e-6, st.t1 - st.t0))) };
}

/* ----- Zeichnen ----- */

function tlZeichne() {
  const m = tlModel();
  const inner = tlEl('inner');
  inner.style.width = (TL_ZOOM[tlZoomStufe] * 100) + '%';
  tlEl('zoom').textContent = TL_ZOOM[tlZoomStufe] + '×';
  tlEl('blank').hidden = m.clips.items.length > 0;

  const teil = (t0, t1) => 'left:' + (t0 / (m.total || 1) * 100) + '%;width:' +
                           ((t1 - t0) / (m.total || 1) * 100) + '%';

  // Bei einer Ueberblendung liegen zwei Clips uebereinander. Der spaetere
  // deckt den frueheren zu, darum bekommt die Naht ein eigenes Zeichen -
  // sonst sieht der Clip davor kuerzer aus, als er ist.
  const blenden = m.clips.blende > 0 ? m.clips.items.slice(1).map((c, i) =>
    '<div class="tl-block tl-blende" style="' +
    teil(c.t0, Math.min(c.t0 + m.clips.blende, m.clips.items[i].t1)) +
    '" title="Überblendung ' + fmtSek(m.clips.blende) + '"></div>').join('') : '';

  // Standbilder liegen als Band im Clip: dort steht das Bild still.
  const standbilder = m.clips.items.map(c => {
    const sch = vSchnitt(c.clip);
    return sch.halten.map(h => {
      const a = c.t0 + vStelleImClip(c.clip, sch.von + h.t);
      return '<div class="tl-block tl-hold" style="' + teil(a, a + h.dur) + '" title="' +
             escAttr('Standbild ' + fmtSek(h.dur)) + '"></div>';
    }).join('');
  }).join('');

  // Wo etwas herausgeschnitten ist, steht ein Strich: die Stelle selbst hat
  // keine Laenge mehr.
  const schnitte = m.clips.items.map(c => {
    const sch = vSchnitt(c.clip);
    return sch.weg.map(w => {
      const a = c.t0 + vStelleImClip(c.clip, sch.von + w.von);
      return '<div class="tl-schnitt" style="left:' + (a / (m.total || 1) * 100) + '%" title="' +
             escAttr(fmtSek(w.bis - w.von) + ' herausgeschnitten') + '"></div>';
    }).join('');
  }).join('');

  // Vor- und Nachspann stehen als eigene Kaesten da: dort haelt das erste
  // beziehungsweise letzte Bild still, und es ist still.
  const vor = vVorspann();
  const spann = !vor || !m.clips.items.length ? '' :
    ['<div class="tl-block tl-still" style="' + teil(0, vor) +
     '" title="Vorspann: das erste Bild steht still, ohne Ton">Standbild</div>',
     '<div class="tl-block tl-still" style="' + teil(m.clips.total - vor, m.clips.total) +
     '" title="Nachspann: das letzte Bild steht still, ohne Ton">Standbild</div>'].join('');

  tlEl('lane-v').innerHTML = spann + m.clips.items.map((c, i) => {
    const sch = vSchnitt(c.clip);
    const woher = vGeschnitten(c.clip)
      ? ' · Ausschnitt ' + fmtTime(sch.von) + '–' + fmtTime(sch.bis) : '';
    return '<div class="tl-block tl-clip" style="' + teil(c.t0, c.t1) + '" title="' +
      escAttr(c.clip.name + ' · ' + fmtTime(c.t1 - c.t0) + woher) + '">' +
      (i + 1) + ' · ' + esc(c.clip.name) + '</div>';
  }).join('') + blenden + standbilder + schnitte;

  // Jeder Abschnitt sagt, woran er ist: gefuellt liegt sein Ton bereit,
  // schraffiert ist er noch ungesprochen und seine Laenge nur geschaetzt, im
  // Warnton arbeitet die Stimme gerade an ihm.
  const ZUSTAND = { fertig: ['', 'Ton liegt vor'],
                    wartet: [' tl-vague', 'noch nicht gesprochen, Länge geschätzt'],
                    laeuft: [' tl-busy', 'wird gerade gesprochen'] };
  tlEl('lane-a').innerHTML = !m.mit ? '' : m.sprache.items.map(s => {
    const p = parts[s.part];
    if (s.art === 'text') {
      const [cls, wort] = ZUSTAND[s.zustand] || ZUSTAND.wartet;
      return '<div class="tl-block tl-say' + cls + '" data-part="' + s.part + '" style="' +
             teil(m.versatz + s.t0, m.versatz + s.t1) + '" title="' +
             escAttr((p ? p.text : '') + ' — ' + wort + '; anklicken ändert den Text') + '">' +
             esc(p ? p.text : '') + '</div>';
    }
    const wert = fmtSek(s.t1 - s.t0);
    return '<div class="tl-block tl-gap" data-part="' + s.part + '" style="' +
           teil(m.versatz + s.t0, m.versatz + s.t1) + '" title="' +
           escAttr((p ? KINDS[p.kind].label : 'Pause') + ' ' + wert +
                   ' — am rechten Rand ziehen ändert sie') + '"><span class="tl-grip"></span></div>';
  }).join('');

  // Ohne Sprachspur steht auf der Spur nichts, was sich aendern liesse.
  tlEl('change').disabled = !m.mit || !m.sprache.items.some(s => s.art === 'text');
  tlWaehle(tlWahl);
}

// Der Kopf und alles, was an ihm haengt. Laeuft bei jedem Bild.
function tlStelle() {
  const m = tlModel();
  tlEl('tc').textContent = tlTc(tlZeit, m.fps);
  tlEl('head').style.left = (tlZeit / (m.total || 1) * 100) + '%';
  const wahl = tlEl('auswahl');
  wahl.hidden = tlMarke === null;
  if (tlMarke !== null) {
    const a = Math.min(tlMarke, tlZeit), b = Math.max(tlMarke, tlZeit);
    wahl.style.left = (a / (m.total || 1) * 100) + '%';
    wahl.style.width = ((b - a) / (m.total || 1) * 100) + '%';
  }
  tlInSicht();
  tlBild();
  tlTon();
  tlCursor();
  tlSchnittKnoepfe();
}

// Beim Hineinzoomen laeuft der Kopf sonst aus dem Bild.
function tlInSicht() {
  const box = tlEl('tracks'), inner = tlEl('inner');
  if (inner.clientWidth <= box.clientWidth + 1) return;
  const x = tlZeit / (tlModel().total || 1) * inner.clientWidth;
  const rand = box.clientWidth * 0.15;
  if (x < box.scrollLeft + rand || x > box.scrollLeft + box.clientWidth - rand)
    box.scrollLeft = Math.max(0, x - box.clientWidth / 2);
}

// Zeitcode im Schnittformat: Stunden, Minuten, Sekunden, Bilder.
function tlTc(t, fps) {
  const rate = fps > 0 ? fps : 25;
  const bild = Math.max(0, Math.round(t * rate));
  const sek = Math.floor(bild / rate);
  const zwei = n => String(n).padStart(2, '0');
  const rest = Math.min(Math.max(0, bild - Math.round(sek * rate)), Math.ceil(rate) - 1);
  return zwei(Math.floor(sek / 3600)) + ':' + zwei(Math.floor(sek / 60) % 60) + ':' +
         zwei(sek % 60) + ':' + zwei(rest);
}

/* ----- Bild ----- */

// Hochgeladene Clips holt der Browser vom Videodienst zurueck; was noch
// hochlaedt, spielt er aus der Datei auf der Platte.
function tlQuelle(c) {
  if (c.id) return VAPI + '/clips/' + c.id + '/file';
  if (c.file) return c.url || (c.url = URL.createObjectURL(c.file));
  return null;
}

const tlLautstaerke = () => vInfo ? Math.max(0, Math.min(1, Number(vEl('clipaudio').value) || 0)) : 0;

// Gemerkt wird die Adresse, nicht der Clip: ein frisch hochgeladener Clip
// behaelt seinen Platz in der Liste, spielt aber ab dem Ende des Hochladens
// vom Server statt aus der Datei auf der Platte - und die Adresse der Datei
// ist dann schon zurueckgegeben. Nach dem Clip gemerkt bliebe hier die tote
// Adresse stehen, und das Bild bliebe schwarz.
function tlLade(el, item) {
  const src = (item ? tlQuelle(item.clip) : null) || '';
  if (el.dataset.key === src) return;
  el.dataset.key = src;
  if (src) el.src = src;
  else { el.removeAttribute('src'); el.load(); }
}

// Setzt einen Bildschirm auf die Stelle im Clip. Laeuft es vorwaerts in
// normaler oder maessiger Geschwindigkeit, spielt der Browser selbst und wird
// nur nachgefuehrt, wenn er auseinanderlaeuft; sonst wird Bild fuer Bild
// gesprungen.
function tlSpringe(el, lokal, steht) {
  if (!el.getAttribute('src')) return;
  // Waehrend eines Standbilds steht die Datei: weiterlaufen lassen hiesse, das
  // Bild liefe der Zeitleiste davon.
  const spielt = tlTempo > 0 && tlTempo <= 4 && !steht;
  if (spielt) {
    if (el.playbackRate !== tlTempo) el.playbackRate = tlTempo;
    if (Math.abs(el.currentTime - lokal) > 0.3) el.currentTime = lokal;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - lokal) > 0.5 / (tlModel().fps || 25)) el.currentTime = lokal;
  }
  const laut = tlLautstaerke();
  el.volume = laut;
  el.muted = laut <= 0 || tlTempo !== 1;
}

function tlBild() {
  const m = tlModel(), list = m.clips.items, blende = m.clips.blende;
  const sicht = [];
  for (let k = 0; k < list.length; k++)
    if (tlZeit >= list[k].t0 - 1e-6 && tlZeit <= list[k].t1 + 1e-6) sicht.push(k);
  // Hinter dem letzten Clip bleibt sein letztes Bild stehen - genau das tut
  // ffmpeg auch, wenn die Sprachausgabe laenger ist als das Video.
  if (!sicht.length && list.length) sicht.push(tlZeit > list[list.length - 1].t1 ? list.length - 1 : 0);

  // Gerade und ungerade Clips liegen fest auf je einem Bildschirm. So haelt
  // der eine schon den naechsten bereit, waehrend der andere zeigt.
  const belegt = [null, null];
  for (const k of sicht) belegt[k % 2] = k;
  const vor = sicht.length ? sicht[sicht.length - 1] + 1 : 0;
  if (list[vor] && belegt[vor % 2] === null) belegt[vor % 2] = vor;

  [tlA, tlB].forEach((el, s) => {
    const k = belegt[s];
    const item = k === null ? null : list[k];
    tlLade(el, item);
    if (item === null || !sicht.includes(k)) { el.style.opacity = 0; el.style.zIndex = 0; return; }
    const oben = sicht.length > 1 && k === sicht[sicht.length - 1];
    el.style.zIndex = oben ? 2 : 1;
    el.style.opacity = oben && blende > 0
      ? Math.min(1, Math.max(0, (tlZeit - item.t0) / blende)) : 1;
    const wo = vStelleInDatei(item.clip, Math.min(item.t1 - item.t0, Math.max(0, tlZeit - item.t0)));
    tlSpringe(el, wo.t, wo.steht);
  });
  const k = sicht.length ? sicht[sicht.length - 1] : null;
  tlOben = k === null ? null : [tlA, tlB][k % 2];
  tlBildLaedt();
}

/* ----- Was nachkommt ----- */

// Oben links im Bild steht, was noch nicht da ist: der Clip, solange der
// Browser ihn vom Server holt, und der Ton, solange er Abschnitt fuer
// Abschnitt kommt. Ueber eine langsame Leitung dauert beides - ohne Anzeige
// saehe das aus wie ein schwarzes Bild und eine stumme Zeitleiste.
function tlLaedt(art, text, anteil) {
  const zeile = tlEl('laedt-' + art);
  zeile.hidden = !text;
  if (text) {
    zeile.querySelector('span').textContent = text;
    zeile.querySelector('i').hidden = anteil == null;
    zeile.querySelector('b').style.width = Math.round(Math.min(1, Math.max(0, anteil || 0)) * 100) + '%';
  }
  tlEl('laedt').hidden = tlEl('laedt-bild').hidden && tlEl('laedt-ton').hidden;
}

function tlBildDa(el) {
  return !el || !el.getAttribute('src') || (el.readyState >= 2 && !el.seeking);
}

// Kurzes Warten zeigt nichts an, sonst sprang die Anzeige beim Suchen Bild fuer
// Bild bei jedem Schritt auf und zu. Wer laenger wartet, sieht, dass geladen
// wird und wie viel vom Clip der Browser schon hat.
function tlBildLaedt() {
  const el = tlOben;
  if (el && el.getAttribute('src') && el.error) {
    clearTimeout(tlBildTimer); tlBildTimer = null;
    tlLaedt('bild', 'Das Bild lässt sich nicht laden — der Browser kann die Datei nicht lesen, '
                    + 'oder sie liegt nicht mehr auf dem Server.');
    return;
  }
  if (tlBildDa(el)) {
    clearTimeout(tlBildTimer); tlBildTimer = null;
    tlLaedt('bild', '');
    return;
  }
  if (!tlEl('laedt-bild').hidden) { tlBildStand(el); return; }
  if (!tlBildTimer) tlBildTimer = setTimeout(() => {
    tlBildTimer = null;
    if (!tlBildDa(tlOben) && !tlOben.error) tlBildStand(tlOben);
  }, 400);
}

function tlBildStand(el) {
  let da = 0;
  for (let i = 0; i < el.buffered.length; i++) da += el.buffered.end(i) - el.buffered.start(i);
  const anteil = isFinite(el.duration) && el.duration > 0 ? da / el.duration : null;
  tlLaedt('bild', 'Bild lädt' + (el.dataset.key.startsWith(VAPI) ? ' vom Server' : '') + ' …' +
                  (anteil == null ? '' : ' ' + Math.round(anteil * 100) + ' % des Clips da'), anteil);
}

/* ----- Ton ----- */

// Die Sprachausgabe ist die Datei, die schon unter dem Sprechertext haengt.
// Gespielt wird sie nur bei normalem Tempo; beim Suchen waere sie Krach.
// Wie lang die Tonspur ist, weiss die Zeitleiste selbst - genauer als das
// Abspielelement, das seine Laenge erst nach dem Laden kennt.
function tlTon() {
  const m = tlModel();
  const soll = tlZeit - m.versatz;
  const geht = m.mit && built && player.src && tlTempo === 1 &&
               soll >= 0 && soll <= m.sprache.total + 0.05;
  if (!geht) {
    // Angehalten wird nur, was das Schnittfenster selbst gestartet hat. Wer
    // unter dem Sprechertext auf Abspielen drueckt, soll weiterhoeren duerfen.
    if (tlFuehrtTon && !player.paused) player.pause();
    tlFuehrtTon = false;
    return;
  }
  if (Math.abs(player.currentTime - soll) > 0.25) player.currentTime = soll;
  if (player.paused) player.play().catch(() => {});
}

/* ----- Cursor in der Vorschau ----- */

function tlCaret() {
  let c = $('tl-caret');
  if (!c) {
    c = document.createElement('span');
    c.id = 'tl-caret';
    preview.appendChild(c);
  }
  return c;
}

function tlCursor() {
  const treffer = tlAn(tlZeit);
  const caret = tlCaret();
  if (tlMarkiert) { tlMarkiert.classList.remove('at'); tlMarkiert = null; }
  if (!treffer) {
    caret.hidden = true;
    tlEl('at').textContent = tlModel().mit ? 'Hier ist es still.' : 'Ohne Sprachausgabe.';
    return;
  }
  const el = preview.children[treffer.st.part];
  if (el && el.classList) {
    if (el !== tlZuletzt) tlInSichtText(el);
    el.classList.add('at');
    tlMarkiert = tlZuletzt = el;
  }
  const p = parts[treffer.st.part];
  if (treffer.st.art !== 'text' || !p) {
    caret.hidden = true;
    tlEl('at').textContent = (p ? KINDS[p.kind].label : 'Pause') + ' · ' +
                             fmtSek(treffer.st.t1 - treffer.st.t0);
    return;
  }
  const stelle = Math.min(p.text.length, Math.round(treffer.anteil * p.text.length));
  tlSetzeCaret(caret, el, stelle);
  tlEl('at').innerHTML = tlAusschnitt(p.text, stelle);
}

// Ausserhalb des Schnittfensters steht in der Vorschau kein Cursor: dort
// hiesse er nichts. Zurueck im Reiter "Schnitt" setzt tlNeu() ihn wieder.
function tlCursorWeg() {
  const c = $('tl-caret');
  if (c) c.hidden = true;
  if (tlMarkiert) { tlMarkiert.classList.remove('at'); tlMarkiert = null; }
  tlZuletzt = null;
}

// Laeuft die Stelle aus dem Fenster der Vorschau, rueckt der Text nach -
// einmal je Abschnitt, damit niemand beim Lesen weggerissen wird.
let tlZuletzt = null;
function tlInSichtText(el) {
  if (preview.scrollHeight <= preview.clientHeight + 1) return;
  const oben = el.offsetTop - preview.scrollTop;
  if (oben < 0 || oben + el.offsetHeight > preview.clientHeight)
    preview.scrollTop = Math.max(0, el.offsetTop - preview.clientHeight / 3);
}

// Der Cursor liegt als eigener Balken ueber der Vorschau. Gemessen wird die
// Stelle mit einem Bereich ueber genau einem Zeichen - so bleibt der Text
// selbst unberuehrt und die Aussprache-Markierungen gehen nicht verloren.
function tlSetzeCaret(caret, el, off) {
  const lauf = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n, gesehen = 0, ziel = null, innen = 0;
  while ((n = lauf.nextNode())) {
    if (gesehen + n.length >= off) { ziel = n; innen = off - gesehen; break; }
    gesehen += n.length;
  }
  if (!ziel) { caret.hidden = true; return; }
  const r = document.createRange();
  r.setStart(ziel, Math.min(innen, ziel.length));
  r.setEnd(ziel, Math.min(innen + 1, ziel.length));
  const k = r.getBoundingClientRect(), box = preview.getBoundingClientRect();
  if (!k.height) { caret.hidden = true; return; }        // Vorschau ist nicht zu sehen
  caret.hidden = false;
  // Die Vorschau rollt, wenn der Text laenger ist als ihr Fenster; der Balken
  // sitzt im Inhalt und rollt mit.
  caret.style.left = (k.left - box.left - preview.clientLeft + preview.scrollLeft) + 'px';
  caret.style.top = (k.top - box.top - preview.clientTop + preview.scrollTop) + 'px';
  caret.style.height = k.height + 'px';
}

// Der Text an dieser Stelle, das gerade gesprochene Wort hervorgehoben.
function tlAusschnitt(text, off) {
  if (!text) return '';
  let a = Math.min(off, text.length - 1), b = a;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return (a > 60 ? '…' : '') + esc(text.slice(Math.max(0, a - 60), a)) +
         '<b>' + esc(text.slice(a, b)) + '</b>' + esc(text.slice(b, b + 60)) +
         (b + 60 < text.length ? '…' : '');
}

/* ----- Fahren ----- */

function tlSpringZu(t) {
  tlZeit = Math.max(0, Math.min(tlModel().total || 0, t));
  tlStelle();
}

function tlBildSchritt(n) {
  const fps = tlModel().fps || 25;
  tlHalt();
  tlSpringZu(Math.round(tlZeit * fps + n) / fps);
}

function tlHalt() {
  if (!tlTempo) return;
  tlTempo = 0;
  tlZeigeTempo();
  tlStelle();
}

function tlLauf(tempo) {
  const m = tlModel();
  if (!m.total) return;
  if (tempo > 0 && tlZeit >= m.total - 1e-3) tlZeit = 0;
  tlTempo = tempo;
  tlFuehrtTon = true;                  // ab jetzt gehoert die Tonspur dem Schnittfenster
  tlUhr = performance.now();
  tlAbZeit = tlZeit;
  tlZeigeTempo();
  tlStelle();
  if (!tlRaf) tlRaf = requestAnimationFrame(tlTakt);
}

// Die Uhr ist die Seitenuhr, nicht das Video: so bleibt die Zeitleiste auch
// dort im Takt, wo gar kein Clip liegt. Bild und Ton werden ihr nachgefuehrt.
function tlTakt() {
  tlRaf = null;
  if (!tlTempo) return;
  if (!tlOffen()) { tlHalt(); return; }
  const m = tlModel();
  const t = tlAbZeit + (performance.now() - tlUhr) / 1000 * tlTempo;
  if (t >= m.total) { tlZeit = m.total; tlHalt(); return; }
  if (t <= 0) { tlZeit = 0; tlHalt(); return; }
  tlZeit = t;
  tlStelle();
  tlRaf = requestAnimationFrame(tlTakt);
}

function tlZeigeTempo() {
  tlEl('play').textContent = tlTempo === 1 ? '⏸' : '▶';
  tlEl('speed').textContent = !tlTempo ? 'steht'
    : tlTempo === 1 ? 'läuft'
    : (tlTempo < 0 ? '◀◀ ' : '▶▶ ') + String(Math.abs(tlTempo)).replace('.', ',') + '×';
}

// Noch einmal auf denselben Knopf heisst: eine Stufe schneller.
function tlSchub(richtung) {
  const jetzt = tlTempo * richtung;
  tlLauf(richtung * (TL_TEMPI.find(x => x > jetzt + 1e-9) || TL_TEMPI[TL_TEMPI.length - 1]));
}

/* ----- Pausen aendern ----- */

function tlWaehle(i) {
  tlWahl = i;
  tlEl('lane-a').querySelectorAll('[data-part]').forEach(b =>
    b.classList.toggle('picked', Number(b.dataset.part) === i));
  tlEl('delpause').disabled = i === null || !parts[i] || parts[i].type !== 'pause';
}

// Eine Pause bekommt eine neue Laenge - von Hand gesetzt, wie im Feld der
// Vorschau. Das Feld zieht mit, ohne die Vorschau neu aufzubauen, damit der
// Cursor beim Ziehen an seiner Stelle bleibt.
function tlSetzePause(i, dur) {
  const p = parts[i];
  if (!p || p.type !== 'pause' || p.dur === dur) return;
  p.dur = dur;
  p.manual = true;
  const inp = preview.querySelector('input[data-i="' + i + '"]');
  if (inp) {
    inp.value = dur.toFixed(2);
    inp.closest('.pause').classList.add('edited');
    inp.closest('.pause').classList.toggle('zero', dur <= 0);
  }
  updateSummary();                                  // rechnet auch die Zeitleiste neu
}

// Eine von Hand gezogene Laenge gehoert in den Sprechertext, sonst steht sie
// nur in der Seite: die Datei, die "Text als Markdown speichern" schreibt,
// wuesste nichts von ihr. Geschrieben wird eine Zeile "(Pause: 3 s)". Sie
// sticht jede automatische Pause an derselben Naht - collapse() nimmt von
// mehreren Pausen hintereinander die staerkste, und das ist die aus dem Text -,
// heraus kommt also genau die gezogene Laenge. Gerufen wird das erst, wenn der
// Griff los ist; waehrend des Ziehens waere der Text sonst in Dauerbewegung.
const pauseZeile = dur => '(Pause: ' + (Math.round(dur * 100) / 100).toString().replace('.', ',') + ' s)';

function tlPauseSchreiben(i) {
  const p = parts[i];
  if (!p || p.type !== 'pause' || p.line == null) return;
  const zeilen = textEl.value.replace(/\r\n?/g, '\n').split('\n');
  const zeile = pauseZeile(p.dur);

  if (p.kind === 'custom') {
    // Ihre Zeile steht schon da und bekommt nur eine neue Zahl.
    if (!PAUSE_CMD.test((zeilen[p.line] || '').trim())) {
      tlSag('Die Zeile „(Pause …)“ im Sprechertext ist nicht mehr auffindbar.', true);
      return;
    }
    if (zeilen[p.line].trim() === zeile) return;
    zeilen[p.line] = zeile;
    textEl.value = zeilen.join('\n');
    reparseErhaltend(p.line, 0);
  } else {
    // Automatische Pause: die Zeile kommt vor die Stelle, aus der sie entsteht -
    // vor die Leerzeile, die Ueberschrift, die Trennlinie oder die Zeile, vor
    // der umgebrochen wurde. Beide Pausen fallen danach zu einer zusammen.
    zeilen.splice(p.line, 0, zeile);
    textEl.value = zeilen.join('\n');
    reparseErhaltend(p.line, 1);
  }

  // Nach dem neuen Zerlegen liegt die Pause an einer anderen Stelle in parts.
  const j = parts.findIndex(q => q.type === 'pause' && q.kind === 'custom' && q.line === p.line);
  tlWaehle(j >= 0 ? j : null);
}

// Der Zug am rechten Rand haengt am Fenster, nicht am Griff: die Zeitleiste
// zeichnet sich waehrenddessen staendig neu, der Griff von eben ist dann weg.
function tlGriffZug(i, e) {
  const p = parts[i];
  if (!p) return;
  e.preventDefault();
  e.stopPropagation();
  tlHalt();
  tlWaehle(i);
  const proSek = tlEl('inner').clientWidth / (tlModel().total || 1);
  const x0 = e.clientX, war = p.dur;
  const zieh = ev => {
    const neu = Math.max(0, Math.min(PAUSE_MAX, war + (ev.clientX - x0) / Math.max(1, proSek)));
    tlSetzePause(i, Math.round(neu * 20) / 20);      // Schritte von 0,05 s wie im Feld
    tlSag('Pause: ' + fmtSek(parts[i].dur));
  };
  const los = () => {
    removeEventListener('pointermove', zieh);
    removeEventListener('pointerup', los);
    removeEventListener('pointercancel', los);
    if (parts[i] && parts[i].dur !== war) {
      const jetzt = parts[i].dur;                    // nach dem Schreiben liegt parts neu
      ankerFest(i);                                  // folgt der Text einem Film: diese bleibt so
      tlPauseSchreiben(i);                           // erst jetzt in den Sprechertext
      tlSag('Pause: ' + fmtSek(jetzt) + ' — steht jetzt im Sprechertext.');
    }
    scheduleRefresh();                               // Tonspur neu zusammensetzen
  };
  addEventListener('pointermove', zieh);
  addEventListener('pointerup', los);
  addEventListener('pointercancel', los);
}

// Eine neue Pause entsteht an der naechstgelegenen Naht zwischen zwei
// Abschnitten. Mitten im Satz geht es nicht: dort gibt es keine Stelle, an
// der die Sprachausgabe auseinanderfiele.
// Alle Naehte der Sprachspur, mit ihrer Stelle in Sekunden. Eine Pause von
// 0 s liegt nicht als Luecke auf der Spur - sie zieht die beiden Abschnitte ja
// gerade zusammen -, sondern steckt in der Fuge zwischen zwei Stuecken eines
// Abschnitts. Ohne sie fand der Knopf nur Naehte, an denen schon eine Pause
// steht, und hatte nie etwas einzufuegen.
function tlNaehte() {
  const items = tlModel().sprache.items;
  const raus = [];
  items.forEach((s, k) => {
    if (s.art === 'pause') { raus.push({ part: s.part, t0: s.t0 }); return; }
    const vor = k ? items[k - 1] : null;
    if (!vor || vor.art !== 'text' || vor.part === s.part) return;
    for (let idx = vor.part + 1; idx < s.part; idx++) {
      if (parts[idx] && parts[idx].type === 'pause') { raus.push({ part: idx, t0: s.t0 }); break; }
    }
  });
  return raus;
}

function tlPauseEin() {
  const m = tlModel();
  const naehte = tlNaehte();
  if (!naehte.length) { tlSag('Im Sprechertext gibt es keine Stelle für eine Pause.', true); return; }
  const ziel = naehte.reduce((a, b) =>
    Math.abs(m.versatz + b.t0 - tlZeit) < Math.abs(m.versatz + a.t0 - tlZeit) ? b : a);
  const wo = tlTc(m.versatz + ziel.t0, m.fps);
  tlWaehle(ziel.part);
  const p = parts[ziel.part];
  if (!p) return;
  if (p.dur > 0) { tlSag('Bei ' + wo + ' steht schon eine Pause von ' + fmtSek(p.dur) + ' — sie ist jetzt ausgewählt.'); return; }
  ankerFest(ziel.part);
  tlSetzePause(ziel.part, 0.5);
  tlPauseSchreiben(ziel.part);
  scheduleRefresh();
  tlSag('Pause von 0,50 s bei ' + wo + ' eingefügt — sie steht als Zeile „(Pause: 0,5 s)“ im '
      + 'Sprechertext. Der rechte Rand zieht sie länger oder kürzer.');
}

function tlPauseWeg() {
  const p = parts[tlWahl];
  if (!p || p.type !== 'pause') return;
  ankerFest(tlWahl);                  // was hier wegkommt, setzt der Film nicht wieder ein
  if (p.kind === 'custom') {
    // Ihre Laenge steht als Zeile "(Pause: ...)" im Sprechertext. Bleibt die
    // Zeile stehen, waere die Pause beim naechsten Tippen wieder da.
    const zeilen = textEl.value.replace(/\r\n?/g, '\n').split('\n');
    if (p.line == null || !PAUSE_CMD.test((zeilen[p.line] || '').trim())) {
      tlSag('Die Zeile im Sprechertext ist nicht mehr auffindbar.', true);
      return;
    }
    zeilen.splice(p.line, 1);
    textEl.value = zeilen.join('\n');
    reparseErhaltend(p.line, -1);
    tlSag('Die Zeile „(Pause …)“ ist aus dem Sprechertext verschwunden.');
  } else {
    const i = tlWahl;
    tlSetzePause(i, 0);
    tlPauseSchreiben(i);
    tlSag('Pause auf 0 s gesetzt — die beiden Abschnitte gehen nun ineinander über; im '
        + 'Sprechertext steht dafür die Zeile „(Pause: 0 s)“.');
  }
  scheduleRefresh();
}

// Text neu zerlegen, ohne die von Hand gezogenen Pausen zu verlieren.
// Zugeordnet wird ueber die Zeile im Sprechertext; ab "ab" haben sich die
// Zeilennummern um "um" verschoben. Wurde an mehreren Stellen geschoben, sagt
// statt dessen eine Funktion, wohin jede Zeile gewandert ist.
function reparseErhaltend(ab, um) {
  const neu = typeof ab === 'function' ? ab : l => (l >= ab ? l + um : l);
  const merk = parts.filter(p => p.type === 'pause' && p.manual && p.kind !== 'custom')
    .map(p => ({ line: neu(p.line), kind: p.kind, dur: p.dur }));
  reparse();
  for (const p of parts) {
    if (p.type !== 'pause') continue;
    const m = merk.find(x => x.line === p.line && x.kind === p.kind);
    if (m) { p.dur = m.dur; p.manual = true; }
  }
  tlWahl = null;
  render();
}

/* ----- Bild schneiden: Anfang, Ende, Standbild ----- */

// Alles hier gilt dem Clip unter dem Abspielkopf. Geschnitten wird nichts an
// der hochgeladenen Datei: Anfang, Ende und Standbilder stehen am Clip in der
// Liste und gehen erst beim Kodieren an ffmpeg. Die Zeitleiste rechnet sofort
// mit ihnen, das Bild springt mit.
function tlClipHier() {
  for (const it of tlModel().clips.items)
    if (tlZeit >= it.t0 - 1e-6 && tlZeit <= it.t1 + 1e-6) return it;
  return null;
}

// Das Standbild unter dem Abspielkopf, mit seinem Platz in der Liste.
function tlHaltHier() {
  const it = tlClipHier();
  if (!it) return null;
  const s = vSchnitt(it.clip);
  for (let i = 0; i < s.halten.length; i++) {
    const h = s.halten[i];
    const a = it.t0 + vStelleImClip(it.clip, s.von + h.t);
    if (tlZeit >= a - 1e-6 && tlZeit <= a + h.dur + 1e-6) return { item: it, i, hold: h };
  }
  return null;
}

function tlSchnittKnoepfe() {
  const it = tlClipHier();
  for (const id of ['cutin', 'cutout', 'cutreset', 'hold', 'mark'])
    tlEl(id).disabled = !it;
  tlEl('cutreset').disabled = !it || !vGeschnitten(it.clip);
  tlEl('holddel').disabled = !tlHaltHier();
  tlEl('drop').disabled = !it || tlMarke === null;
  tlEl('mark').textContent = tlMarke === null ? 'Marke setzen' : 'Marke weg';
}

// Ein Stueck aus der Mitte nehmen: erst hier die Marke setzen, dann an der
// zweiten Stelle "Stück entfernen". Geschnitten wird nichts an der Datei - die
// Angabe steht am Clip wie Anfang und Ende und geht erst beim Kodieren an ffmpeg.
function tlMarkeSetzen() {
  const it = tlClipHier();
  if (!it) { tlSag('Unter dem Abspielkopf liegt kein Clip.', true); return; }
  const frame = 1 / (tlModel().fps || 25);
  if (tlMarke !== null && Math.abs(tlMarke - tlZeit) < frame) {
    tlMarke = null;
    tlSag('Marke weg.');
  } else {
    tlMarke = tlZeit;
    tlSag('Marke bei ' + tlTc(tlMarke, tlModel().fps) + ' — „Stück entfernen“ nimmt alles zwischen '
        + 'ihr und dem Abspielkopf aus dem Clip.');
  }
  tlStelle();
  tlSchnittKnoepfe();
}

function tlStueckWeg() {
  if (tlMarke === null) { tlSag('Erst die Marke setzen — sie sagt, wo das Stück anfängt.', true); return; }
  const a = Math.min(tlMarke, tlZeit), b = Math.max(tlMarke, tlZeit);
  const it = tlModel().clips.items.find(x => a >= x.t0 - 1e-6 && a <= x.t1 + 1e-6);
  if (!it) { tlSag('Bei der Marke liegt kein Clip.', true); return; }
  if (b > it.t1 + 1e-6) { tlSag('Marke und Abspielkopf liegen in verschiedenen Clips — '
                              + 'herausschneiden geht nur innerhalb eines Clips.', true); return; }
  const c = it.clip, s = vSchnitt(c);
  const von = vStelleInDatei(c, a - it.t0).t - s.von, bis = vStelleInDatei(c, b - it.t0).t - s.von;
  if (bis - von < CUT_MIN) { tlSag('Das Stück ist zu kurz zum Herausschneiden.', true); return; }
  if ((s.bis - s.von) - vWegSek(s) - (bis - von) < CUT_MIN) {
    tlSag('Dann bliebe vom Clip nichts übrig — dafür lieber den Clip aus der Liste nehmen.', true);
    return;
  }
  const weg = s.weg.concat([{ von, bis }]);
  tlMarke = null;
  tlSchnittSetzen(c, { von: s.von, bis: s.bis, halten: s.halten, weg });
  tlSpringZu(it.t0 + vStelleImClip(c, s.von + von));
  tlSag(fmtSek(bis - von) + ' herausgeschnitten — der Clip ist noch ' + fmtTime(vDauer(c)) +
        ' lang. „Ganzer Clip“ holt alles zurück.');
}

function tlSchnittSetzen(clip, neu, sage) {
  clip.schnitt = neu;
  vSave();
  vRender();                       // die Clipliste nennt den Ausschnitt
  scheduleVideoPlan();             // Groesse, Plan und Zeitleiste rechnen neu
  tlStelle();
  if (sage) tlSag(sage);
}

function tlAnfangHier() {
  const it = tlClipHier();
  if (!it) { tlSag('Unter dem Abspielkopf liegt kein Clip.', true); return; }
  const c = it.clip, s = vSchnitt(c);
  const neu = Math.min(s.bis - CUT_MIN, Math.max(0, vStelleInDatei(c, tlZeit - it.t0).t));
  if (neu <= s.von + 1e-3) { tlSag('Der Clip fängt hier schon an.'); return; }
  // Standbilder und herausgeschnittene Stuecke zaehlen ab dem Anfang des
  // Ausschnitts und ruecken mit; was vor den neuen Anfang faellt, ist mit
  // weggeschnitten.
  const ab = neu - s.von;
  const halten = s.halten.map(h => ({ t: h.t - ab, dur: h.dur })).filter(h => h.t > 1e-3);
  const weg = s.weg.map(w => ({ von: Math.max(0, w.von - ab), bis: w.bis - ab })).filter(w => w.bis > 1e-3);
  tlSpringZu(it.t0);
  tlSchnittSetzen(c, { von: neu, bis: s.bis, halten, weg },
    'Der Clip beginnt jetzt bei ' + fmtTime(neu) + ' seiner Datei.');
}

function tlEndeHier() {
  const it = tlClipHier();
  if (!it) { tlSag('Unter dem Abspielkopf liegt kein Clip.', true); return; }
  const c = it.clip, s = vSchnitt(c);
  const neu = Math.max(s.von + CUT_MIN, vStelleInDatei(c, tlZeit - it.t0).t);
  if (neu >= s.bis - 1e-3) { tlSag('Der Clip hört hier schon auf.'); return; }
  const laenge = neu - s.von;
  const halten = s.halten.filter(h => h.t < laenge - 1e-3);
  const weg = s.weg.filter(w => w.von < laenge - 1e-3).map(w => ({ von: w.von, bis: Math.min(w.bis, laenge) }));
  tlSchnittSetzen(c, { von: s.von, bis: neu, halten, weg },
    'Der Clip endet jetzt bei ' + fmtTime(neu) + ' seiner Datei.');
}

function tlGanzerClip() {
  const it = tlClipHier();
  if (!it) { tlSag('Unter dem Abspielkopf liegt kein Clip.', true); return; }
  if (!vGeschnitten(it.clip)) { tlSag('Der Clip ist schon ganz zu sehen.'); return; }
  tlSchnittSetzen(it.clip, { von: 0, bis: vQuelleSek(it.clip), halten: [], weg: [] },
    'Der Clip ist wieder ganz zu sehen — auch das Herausgeschnittene.');
}

function tlStandbild() {
  const it = tlClipHier();
  if (!it) { tlSag('Unter dem Abspielkopf liegt kein Clip.', true); return; }
  const c = it.clip, s = vSchnitt(c);
  const wo = vStelleInDatei(c, Math.max(0, Math.min(vDauer(c), tlZeit - it.t0)));
  if (wo.steht) { tlSag('Hier steht das Bild schon still.'); return; }
  const dauer = Math.min(HOLD_MAX, Math.max(0.1, Number(tlEl('holdsec').value) || 0));
  const t = Math.max(0, Math.min(s.bis - s.von, wo.t - s.von));
  const halten = s.halten.concat([{ t, dur: dauer }]).sort((a, b) => a.t - b.t);
  tlSchnittSetzen(c, { von: s.von, bis: s.bis, halten, weg: s.weg },
    'Das Bild steht ab hier ' + fmtSek(dauer) + ' still — der Clip wird um so viel länger.');
}

function tlStandbildWeg() {
  const treffer = tlHaltHier();
  if (!treffer) { tlSag('Unter dem Abspielkopf steht kein Standbild.', true); return; }
  const c = treffer.item.clip, s = vSchnitt(c);
  tlSchnittSetzen(c, { von: s.von, bis: s.bis, weg: s.weg,
                       halten: s.halten.filter((h, i) => i !== treffer.i) },
    'Standbild entfernt — hier läuft das Bild wieder durch.');
}

/* ----- Text aendern ----- */

// Geaendert wird die Zeile, wie sie im Sprechertext steht - nicht der Satz,
// der auf der Zeitleiste steht. Der ist geputzt: Auszeichnung heraus, Klammern
// fort, Aussprache-Liste angewandt. Schriebe man ihn zurueck, ginge all das
// verloren. Darum liegt im Feld die Quelle, und Sprechertext und Schnittfenster
// sind dieselbe Sache in zwei Fenstern.
let tlEdit = null;             // {von, bis, war}: Zeilen im Sprechertext, beide einschliesslich
let tlTippTimer = null, tlSprechTimer = null;
let tlNachspielen = false;     // waehrend der Synthese wurde weitergetippt

const tlZeilen = () => textEl.value.replace(/\r\n?/g, '\n').split('\n');

// Diese Zeilen beenden einen Lauf von Textzeilen - in derselben Reihenfolge
// wie in parse(), sonst faende das Feld eine andere Grenze als der Parser.
function tlBricht(zeile) {
  const t = (zeile == null ? '' : zeile).trim();
  return !t || /^#{1,6}\s*\S/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
         pauseCommand(t) !== null || !!sayCommand(t) || isDirection(t);
}

// Eine offene Klammer zieht die naechste Zeile mit hinein - stripParens()
// macht daraus einen einzigen Abschnitt. Geaendert wird dann der ganze Block.
function tlBlockEnde(zeilen, von) {
  let tiefe = 0;
  for (let i = von; i < zeilen.length; i++) {
    for (const ch of zeilen[i]) {
      if (ch === '(') tiefe++;
      else if (ch === ')' && tiefe) tiefe--;
    }
    if (!tiefe || tlBricht(zeilen[i + 1])) return i;
  }
  return zeilen.length - 1;
}

// Schreibt das Feld in den Sprechertext zurueck. Heraus kommt, wo und um wie
// viele Zeilen sich dabei etwas verschoben hat - wer danach noch einen Platz
// in parts sucht, braucht das. null heisst: nichts geaendert.
function tlSchreibe() {
  if (!tlEdit) return null;
  const { von, bis } = tlEdit;
  const zeilen = tlZeilen();
  const feld = tlEl('text');
  const neu = feld.value.trim() ? feld.value.replace(/\r\n?/g, '\n').split('\n') : [];
  const jetzt = zeilen.slice(von, bis + 1).join('\n');
  // Der Sprechertext kann sich zwischendurch woanders geaendert haben - beim
  // Einlesen einer Datei, beim Uebernehmen einer Abschrift. Dann zeigt das
  // Feld eine ueberholte Fassung, und es wird nichts zurueckgeschrieben.
  if (jetzt !== tlEdit.war) {
    tlEdit = null;
    tlEl('edit').hidden = true;
    tlSag('Der Sprechertext hat sich zwischendurch geändert — das Feld ist zu.', true);
    return null;
  }
  if (neu.join('\n') === jetzt) return null;

  zeilen.splice(von, bis - von + 1, ...neu);
  textEl.value = zeilen.join('\n');
  const um = neu.length - (bis - von + 1);
  reparseErhaltend(von, um);                      // die gezogenen Pausen ueberleben das

  if (!neu.length) {                              // leeres Feld heisst: Abschnitt fort
    tlEdit = null;
    tlEl('edit').hidden = true;
    tlSag('Abschnitt entfernt.');
    return { von, um };
  }
  tlEdit = { von, bis: von + neu.length - 1, war: neu.join('\n') };
  // Nach dem neuen Zerlegen liegt der Abschnitt an einer anderen Stelle in parts.
  const i = parts.findIndex(p => p.type === 'text' && p.line === von);
  tlWaehle(i >= 0 ? i : null);
  return { von, um };
}

// Vor jedem Griff, der Zeilen verschiebt, wird das Feld festgeschrieben. Der
// eben angeklickte Teil liegt danach woanders in parts; gefunden wird er ueber
// seine Zeile, die sich um so viel verschoben hat wie der Text darueber.
function tlFestUndFinde(i) {
  const p = parts[i];
  if (!p) return null;
  clearTimeout(tlTippTimer);
  const art = p.type, kind = p.kind;
  let zeile = p.line;
  const vor = tlSchreibe();
  if (!vor) return i;
  if (zeile > vor.von) zeile += vor.um;
  const j = parts.findIndex(q => q.type === art && q.kind === kind && q.line === zeile);
  return j >= 0 ? j : null;
}

// Das Feld oeffnen - mit der Zeile, aus der dieser Abschnitt entstanden ist.
function tlTextAendern(i) {
  const j = tlFestUndFinde(i);
  const p = j === null ? null : parts[j];
  if (!p || p.type !== 'text' || p.line == null) { tlEditZu(false); return; }
  const zeilen = tlZeilen();
  const bis = tlBlockEnde(zeilen, p.line);
  tlEdit = { von: p.line, bis, war: zeilen.slice(p.line, bis + 1).join('\n') };
  tlHalt();
  tlWaehle(j);
  const feld = tlEl('text');
  tlEl('edit').hidden = false;
  feld.value = zeilen.slice(p.line, bis + 1).join('\n');
  tlEl('editwo').textContent = bis > p.line
    ? 'Zeilen ' + (p.line + 1) + ' bis ' + (bis + 1) + ' im Sprechertext'
    : 'Zeile ' + (p.line + 1) + ' im Sprechertext';
  tlEl('editnote').textContent = 'Hier steht die Zeile wie im Sprechertext — mit Auszeichnung, ' +
    'Klammern und Aussprache-Regeln. Dort steht sofort dasselbe; kurz darauf spricht die Stimme ' +
    'nach, was sich geändert hat. Ein leeres Feld entfernt den Abschnitt.';
  // Erst nach dem Klick, sonst holt sich die Zeitleiste den Fokus zurueck.
  setTimeout(() => feld.focus({ preventScroll: true }), 0);
}

// "schreiben" ist falsch, wenn der Sprechertext selbst gerade bearbeitet wird:
// dann steht im Feld eine ueberholte Fassung derselben Zeile.
function tlEditZu(schreiben) {
  clearTimeout(tlTippTimer);
  clearTimeout(tlSprechTimer);
  if (schreiben) tlSchreibe();
  tlEdit = null;
  tlEl('edit').hidden = true;
}

// Tippen schreibt nach kurzer Ruhe zurueck; bleibt es danach ruhig, wird
// nachgesprochen. So steht im Sprechertext sofort dasselbe, ohne dass jeder
// Tastendruck den Sprachdienst weckt.
function tlGetippt() {
  clearTimeout(tlTippTimer);
  clearTimeout(tlSprechTimer);
  tlTippTimer = setTimeout(() => {
    tlSchreibe();
    tlSprechTimer = setTimeout(tlSprich, 700);
  }, 250);
}

// Nach einer Aenderung fehlt genau der geaenderte Abschnitt im
// Zwischenspeicher. speak() spricht nur, was fehlt - alles andere bleibt liegen.
function tlSprich() {
  if (batchRunning) { tlSag('Erst ist der Stapel an der Reihe.', true); return; }
  if (controller) { tlNachspielen = true; return; }        // laeuft schon, gleich noch einmal
  if (!built) {
    tlSag('Der Text steht, der Ton fehlt noch: „Audio erzeugen“ im Reiter „Text“ spricht ihn zum ersten Mal.');
    return;
  }
  const { segs } = plan();
  if (!segs.length) { tlSag('Kein sprechbarer Text mehr.'); return; }
  if (segs.every(s => cache.has(cacheKey(s)))) {
    scheduleRefresh();                                     // nur neu zusammensetzen
    tlSag('Der Ton ist nachgezogen, ohne neu zu sprechen.');
    return;
  }
  tlSag('Wird nachgesprochen — anhalten lässt es sich im Reiter „Text“.');
  speak({ leise: true });
}

// Der Abschnitt, auf dem der Kopf steht; steht er in einer Pause, der
// naechstgelegene.
function tlTextHier() {
  const m = tlModel();
  const treffer = tlAn(tlZeit);
  if (treffer && treffer.st.art === 'text') return treffer.st.part;
  const texte = m.sprache.items.filter(s => s.art === 'text');
  if (!texte.length) return null;
  return texte.reduce((a, b) =>
    Math.abs(m.versatz + b.t0 - tlZeit) < Math.abs(m.versatz + a.t0 - tlZeit) ? b : a).part;
}

// Vollbild. Hinein geht die ganze Karte, nicht nur das Bild: ohne Transport
// und Zeitleiste liesse sich darin nichts mehr suchen. Escape beendet es, das
// macht der Browser von selbst.
function tlVollbild() {
  if (document.fullscreenElement === tlCard) { document.exitFullscreen(); return; }
  tlCard.open = true;
  tlCard.requestFullscreen().catch(e => tlSag('Vollbild geht nicht: ' + e.message, true));
}

function tlSag(text, schlimm) {
  const n = tlEl('note');
  n.textContent = text || '';
  n.classList.toggle('err', !!schlimm);
}

/* ----- Verdrahtung ----- */

function initSchnitt() {
  const jog = tlEl('jog'), inner = tlEl('inner'), schirm = tlEl('screen');

  // Jede Nachricht vom Laden fuehrt die Anzeige "Bild lädt" nach - aber nur
  // fuer den Bildschirm, der gerade oben liegt.
  for (const el of [tlA, tlB])
    for (const was of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'progress',
                       'seeking', 'seeked', 'waiting', 'playing', 'emptied', 'error'])
      el.addEventListener(was, () => { if (el === tlOben) tlBildLaedt(); });

  const knopf = {
    home: () => { tlHalt(); tlSpringZu(0); },
    end:  () => { tlHalt(); tlSpringZu(tlModel().total); },
    prev: () => tlBildSchritt(-1),
    next: () => tlBildSchritt(1),
    rew:  () => tlSchub(-1),
    ff:   () => tlSchub(1),
    play: () => (tlTempo ? tlHalt() : tlLauf(1)),
    zoomin:  () => { tlZoomStufe = Math.min(TL_ZOOM.length - 1, tlZoomStufe + 1); tlZeichne(); tlStelle(); },
    zoomout: () => { tlZoomStufe = Math.max(0, tlZoomStufe - 1); tlZeichne(); tlStelle(); },
    addpause: tlPauseEin,
    delpause: tlPauseWeg,
    cutin: tlAnfangHier,
    cutout: tlEndeHier,
    cutreset: tlGanzerClip,
    mark: tlMarkeSetzen,
    drop: tlStueckWeg,
    hold: tlStandbild,
    holddel: tlStandbildWeg,
    edit: () => {
      const i = tlTextHier();
      if (i === null) tlSag('Im Sprechertext steht noch kein Abschnitt.', true);
      else tlTextAendern(i);
    },
    full: tlVollbild
  };
  tlCard.querySelectorAll('[data-tl]').forEach(b => b.onclick = knopf[b.dataset.tl]);

  // Das Feld fuer den Abschnitt. Der Fokus geht beim Verlassen nicht verloren,
  // ohne dass geschrieben wuerde: sonst faenden die Knoepfe darunter eine
  // andere Zeile vor, als der Benutzer gerade gesehen hat.
  const feld = tlEl('text');
  feld.oninput = tlGetippt;
  feld.onblur = () => { clearTimeout(tlTippTimer); tlSchreibe(); };
  tlEl('editzu').onclick = () => { tlEditZu(true); tlSprich(); tlEl('tracks').focus(); };
  tlEl('editdel').onclick = () => {
    feld.value = '';
    clearTimeout(tlTippTimer);
    tlSchreibe();
    tlEditZu(false);
    tlSprich();
    tlEl('tracks').focus();
  };

  // Das Jograd: die Striche wandern mit, so fuehlt es sich an wie ein Rad.
  let jogAb = null, jogVon = 0;
  jog.onpointerdown = e => {
    jog.setPointerCapture(e.pointerId);
    jogAb = e.clientX; jogVon = tlZeit;
    tlHalt();
  };
  jog.onpointermove = e => {
    if (jogAb === null) return;
    const weg = e.clientX - jogAb, fps = tlModel().fps || 25;
    jog.style.backgroundPositionX = (weg % 14) + 'px';
    tlSpringZu(Math.round(jogVon * fps + Math.round(weg / 6)) / fps);
  };
  jog.onpointerup = jog.onpointercancel = () => { jogAb = null; };

  // Mausrad ueber dem Bild geht ebenfalls Bild fuer Bild.
  schirm.onwheel = e => { e.preventDefault(); tlBildSchritt(Math.sign(e.deltaY || e.deltaX)); };

  // In der Zeitleiste ziehen heisst suchen; auf eine Pause klicken waehlt sie.
  let spurAb = false;
  const zeitBei = x => {
    const r = inner.getBoundingClientRect();
    return (x - r.left) / Math.max(1, r.width) * (tlModel().total || 0);
  };
  tlEl('lane-a').onpointerdown = e => {
    // Ein Abschnitt: der Kopf faehrt hin (der Griff darunter sucht weiter) und
    // das Feld geht auf. Eine Pause: sie wird ausgewaehlt, das Feld geht zu.
    const sag = e.target.closest('.tl-say');
    if (sag) { tlTextAendern(Number(sag.dataset.part)); return; }
    const block = e.target.closest('.tl-gap');
    if (!block) return;
    const i = tlFestUndFinde(Number(block.dataset.part));
    tlEditZu(false);
    if (i === null) return;
    if (e.target.closest('.tl-grip')) tlGriffZug(i, e);
    else { e.stopPropagation(); tlHalt(); tlWaehle(i); }
  };
  inner.onpointerdown = e => {
    spurAb = true;
    inner.setPointerCapture(e.pointerId);
    tlHalt();
    tlSpringZu(zeitBei(e.clientX));
  };
  inner.onpointermove = e => { if (spurAb) tlSpringZu(zeitBei(e.clientX)); };
  inner.onpointerup = inner.onpointercancel = () => { spurAb = false; };

  // Tasten wie am Schnittplatz, aber nur wenn das Schnittfenster den Fokus
  // hat - sonst nimmt die Leertaste dem Blaettern die Arbeit weg.
  addEventListener('keydown', e => {
    if (!tlOffen() || !tlCard.contains(document.activeElement)) return;
    // Im Feld gehoeren die Tasten dem Text und nicht dem Transport; Escape
    // legt es weg und gibt die Tasten zurueck.
    const el = document.activeElement;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) {
      if (e.key !== 'Escape') return;
      tlEditZu(true);
      tlSprich();
      tlEl('tracks').focus();
      return;
    }
    const aufKnopf = document.activeElement.tagName === 'BUTTON';
    const k = e.key;
    if (k === 'j' || k === 'J') tlSchub(-1);
    else if (k === 'l' || k === 'L') tlSchub(1);
    else if (k === 'k' || k === 'K' || (k === ' ' && !aufKnopf)) knopf.play();
    else if (k === 'ArrowLeft') tlBildSchritt(e.shiftKey ? -Math.round(tlModel().fps || 25) : -1);
    else if (k === 'ArrowRight') tlBildSchritt(e.shiftKey ? Math.round(tlModel().fps || 25) : 1);
    else if (k === 'Home') knopf.home();
    else if (k === 'End') knopf.end();
    else if (k === 'f' || k === 'F') knopf.full();
    else return;
    e.preventDefault();
  });

  // Im Vollbild muss der Fokus in der Karte liegen, sonst greifen J, K und L
  // nicht mehr - ausserhalb ist dann ohnehin nichts mehr zu sehen.
  const voll = tlEl('full');
  if (!tlCard.requestFullscreen) voll.hidden = true;
  document.addEventListener('fullscreenchange', () => {
    const drin = document.fullscreenElement === tlCard;
    voll.setAttribute('aria-pressed', drin ? 'true' : 'false');
    voll.title = drin ? 'Vollbild beenden (F oder Escape)' : 'Vollbild (F) — Escape beendet es';
    if (drin) schirm.focus();
    if (tlOffen()) tlStelle();
  });

  addEventListener('resize', () => { if (tlOffen()) tlStelle(); });
  tlZeigeTempo();
  if (tlOffen()) tlNeu();
}
