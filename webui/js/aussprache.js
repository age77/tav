// TAV · Aussprache-Liste fuer jeden Text.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Aussprache: die Liste fuer jeden Text ---------- */

// Eine Zeile "(Chefarzt|Schaehfarzt)" im Sprechertext gilt nur fuer diesen
// Text. Was hier steht, gilt fuer jeden - und liegt darum nicht im Browser,
// sondern im Sprachdienst unter /v1/aussprache: geladen beim Start, gespeichert
// kurz nach der letzten Taste. Ersetzt wird trotzdem in der Seite, gleich beim
// Zerlegen des Textes; der Dienst haelt die Liste nur fest.
const sayApi = apiFor('/v1');
const sayEl = id => $('say-' + id);
const SAY_WEG = /[()|:;\r\n\t]/g;             // im Sprechtext trennen sie Regel und Regie

let sayMax = { regeln: 500, zeichen: 120 };
let sayStand = '[]';           // zuletzt gespeicherte Fassung, als JSON
let sayTimer = null;
let saySprechTimer = null;     // Nachsprechen wartet laenger als das Speichern
let sayLaeuft = false;         // eine Anfrage ist unterwegs
let sayNochmal = false;        // waehrenddessen wurde weiter getippt

// Halb ausgefuellte Zeilen zaehlen nicht: im Feld entsteht eine Regel
// Buchstabe fuer Buchstabe, und solange sie nicht fertig ist, gilt sie nicht.
function sayAktiv() {
  return sayGlobal.map(r => ({ from: r.from.trim(), to: r.to.trim() }))
                  .filter(r => r.from && r.to);
}

const sayRegeln = () => sayAktiv().map(r => ({ wort: r.from, aussprache: r.to }));
const sayPutz = s => s.replace(SAY_WEG, '').slice(0, sayMax.zeichen);

async function initSay() {
  sayEl('off').hidden = true;
  sayEl('body').hidden = false;
  let d;
  try {
    d = await sayApi.get('/aussprache');
  } catch (e) {
    // Ohne Dienst keine Liste: lieber gar keine Regeln als eine veraltete
    // Fassung aus dem Browser, die niemand mehr sieht.
    sayGlobal = [];
    sayStand = '[]';
    sayEl('body').hidden = true;
    sayEl('off').hidden = false;
    sayEl('offline').textContent = 'Die Aussprache-Liste liegt im Sprachdienst, und der antwortet '
      + 'nicht: ' + e.message + ' Bis dahin gelten nur die Regeln aus dem Sprechertext selbst.';
    reparse();
    return;
  }
  if (isFinite(d.max_regeln)) sayMax.regeln = d.max_regeln;
  if (isFinite(d.max_zeichen)) sayMax.zeichen = d.max_zeichen;
  sayGlobal = (Array.isArray(d.regeln) ? d.regeln : [])
    .map(r => ({ from: sayPutz(String(r && r.wort || '')), to: sayPutz(String(r && r.aussprache || '')) }))
    .filter(r => r.from.trim() && r.to.trim());
  sayStand = JSON.stringify(sayRegeln());
  sayRender();
  reparseErhaltend(0, 0);                     // die geladenen Regeln gelten sofort
}

// Getippt wird im Feld, nicht in der Liste: neu gezeichnet wird nur, wenn eine
// Zeile dazukommt oder verschwindet - sonst spraenge der Schreibcursor weg.
function sayRender() {
  const list = sayEl('list');
  list.innerHTML = sayGlobal.map((r, i) =>
    '<li data-i="' + i + '"><span class="num">' + (i + 1) + '</span>' +
    '<div class="pair">' +
    '<input type="text" class="say-von" maxlength="' + sayMax.zeichen +
      '" placeholder="Wort im Text" aria-label="Wort im Text" value="' + escAttr(r.from) + '">' +
    '<span class="arrow" aria-hidden="true">→</span>' +
    '<input type="text" class="say-nach" maxlength="' + sayMax.zeichen +
      '" placeholder="so gesprochen" aria-label="so gesprochen" value="' + escAttr(r.to) + '">' +
    '</div>' +
    '<button class="sec say-play" data-act="play" title="Aussprache anhören"' +
      (r.to.trim() ? '' : ' disabled') + '>▶</button>' +
    '<button class="sec" data-act="del" title="Regel entfernen">✕</button></li>').join('');
  sayEl('leer').hidden = !!sayGlobal.length;

  list.querySelectorAll('li').forEach(li => {
    const i = Number(li.dataset.i);
    const von = li.querySelector('.say-von'), nach = li.querySelector('.say-nach');
    const probe = li.querySelector('[data-act="play"]');
    const lies = () => {
      for (const feld of [von, nach]) {
        const sauber = sayPutz(feld.value);
        if (sauber !== feld.value) feld.value = sauber;   // verbotenes Zeichen gar nicht erst stehen lassen
      }
      sayGlobal[i] = { from: von.value, to: nach.value };
      probe.disabled = !nach.value.trim();                // ohne Lautschrift gibt es nichts zu hoeren
      sayGeaendert();
    };
    von.oninput = nach.oninput = lies;
    probe.onclick = () => sayHoeren(i, probe);
    li.querySelector('[data-act="del"]').onclick = () => {
      sayStumm();
      sayGlobal.splice(i, 1);
      sayRender();
      sayGeaendert();
    };
  });
  sayZeige();
}

function sayZeige(text, fehler) {
  const n = sayAktiv().length;
  sayEl('state').textContent = n + (n === 1 ? ' Regel' : ' Regeln') + (text ? ' · ' + text : '');
  sayEl('state').classList.toggle('err', !!fehler);
}

// Erst nach einer kurzen Ruhe: so wird nicht bei jedem Buchstaben der Text neu
// zerlegt und nicht bei jedem Buchstaben gespeichert. Das Nachsprechen wartet
// noch etwas laenger - es kostet Rechenzeit, und eine Regel entsteht Buchstabe
// fuer Buchstabe.
function sayGeaendert() {
  sayZeige('noch nicht gespeichert');
  clearTimeout(sayTimer);
  clearTimeout(saySprechTimer);
  sayTimer = setTimeout(() => { reparseErhaltend(0, 0); saySave(); }, 600);
  saySprechTimer = setTimeout(sayNachsprechen, 1500);
}

// Eine geaenderte Regel aendert den Wortlaut der Abschnitte, in denen das Wort
// vorkommt - und damit ihren Schluessel im Zwischenspeicher. Wer schon Ton hat,
// bekommt ihn hier gleich nachgezogen: gesprochen wird nur, was dadurch fehlt,
// alles andere bleibt liegen. Vor dem ersten „Audio erzeugen“ passiert nichts,
// sonst loeste eine halb getippte Regel einen Lauf ueber den ganzen Text aus.
function sayNachsprechen() {
  if (!built || batchRunning) return;
  if (controller) { tlNachspielen = true; return; }      // laeuft schon, gleich noch einmal
  const { segs } = plan();
  if (!segs.length) return;
  const offen = segs.filter(s => !cache.has(cacheKey(s))).length;
  if (!offen) return;                                    // kein Abschnitt hat sich geaendert
  note(offen === 1 ? 'Ein Abschnitt wird nachgesprochen …'
                   : offen + ' Abschnitte werden nachgesprochen …');
  speak({ leise: true });
}

async function saySave() {
  const daten = sayRegeln();
  const jetzt = JSON.stringify(daten);
  if (jetzt === sayStand) { sayZeige(); return; }
  // Eine Anfrage nach der anderen, sonst ueberholt eine aeltere Fassung die neue.
  if (sayLaeuft) { sayNochmal = true; return; }
  sayLaeuft = true;
  sayZeige('wird gespeichert …');
  try {
    await sayApi.json('PUT', '/aussprache', { regeln: daten });
    sayStand = jetzt;
    sayZeige('gespeichert');
  } catch (e) {
    sayZeige('nicht gespeichert: ' + e.message, true);
  } finally {
    sayLaeuft = false;
    if (sayNochmal) { sayNochmal = false; saySave(); }
  }
}

// Ausprobieren, ohne den ganzen Text zu sprechen: der Knopf schickt die
// Lautschrift allein an den Sprachdienst - mit dem Tempo aus dem Sprechertext,
// damit sie klingt wie spaeter im Text. Gehoert wird eine Regel nach der
// anderen; ein neuer Klick loest die alte ab, und die Vorschau des ganzen
// Textes bleibt davon unberuehrt.
let sayProbe = null;           // laufende Anfrage
let sayTon = null;             // laufende Wiedergabe

function sayStumm() {
  if (sayProbe) { sayProbe.abort(); sayProbe = null; }
  if (sayTon) { sayTon.pause(); URL.revokeObjectURL(sayTon.src); sayTon = null; }
}

async function sayHoeren(i, knopf) {
  const text = ((sayGlobal[i] || {}).to || '').trim();
  if (!text) return;
  sayStumm();
  const eigen = sayProbe = new AbortController();
  knopf.disabled = true;
  knopf.textContent = '…';
  try {
    const res = await fetch('/v1/audio/speech', {
      method: 'POST',
      signal: eigen.signal,
      headers: { 'Content-Type': 'application/json' },
      // Ohne Schlusspause: hier steht ein Wort, kein Abschnitt. Ein zweiter
      // Klick auf dieselbe Regel kommt aus dem Speicher des Sprachdienstes.
      body: JSON.stringify({ model: 'kokoro', voice: 'martin', input: text,
                             speed: Number(speed.value), pause_duration: 0, cache: true })
    });
    if (!res.ok) throw new Error(await fehlerText(res));
    const url = URL.createObjectURL(await res.blob());
    const ton = sayTon = new Audio(url);
    ton.onended = () => { URL.revokeObjectURL(url); if (sayTon === ton) sayTon = null; };
    await ton.play();
  } catch (e) {
    if (e.name !== 'AbortError') note('„' + text + '“ ließ sich nicht sprechen: ' + e.message);
  } finally {
    if (sayProbe === eigen) sayProbe = null;
    knopf.disabled = !((sayGlobal[i] || {}).to || '').trim();
    knopf.textContent = '▶';
  }
}

sayEl('add').onclick = () => {
  if (sayGlobal.length >= sayMax.regeln) { note('Mehr als ' + sayMax.regeln + ' Regeln sind nicht vorgesehen.'); return; }
  sayGlobal.push({ from: '', to: '' });
  sayRender();
  const feld = sayEl('list').querySelector('li:last-child .say-von');
  if (feld) feld.focus();
};
sayEl('retry').onclick = initSay;
