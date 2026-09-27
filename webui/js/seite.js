// TAV · Reiter und Bereiche der Seite.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Reiter und Bereiche ---------- */

// Die Seite ist in Reiter geteilt: drei Arbeitsschritte - Text, Schnitt,
// Export - und dahinter die Werkzeuge. Zu sehen ist immer einer. Welcher,
// merkt sich der Browser, und die Adresse nennt ihn (#schnitt), damit ein
// Neuladen dort bleibt. Eine Sprungmarke auf einen Bereich (#sec-video)
// oeffnet den Reiter, in dem er steht.
//
// Die Hauptbereiche eines Reiters stehen immer offen. Auf- und zuklappen
// lassen sich nur die Nebenbereiche; welche offen sind, merkt sich der Browser.
const UI_STORE = 'kokoro.ansicht.v1';
const TAB_STORE = 'kokoro.reiter.v1';
const topbar = document.querySelector('.topbar');
const cards = [...document.querySelectorAll('details.card')];
const reiterKnoepfe = [...document.querySelectorAll('#tabs [role="tab"]')];
const tafeln = [...document.querySelectorAll('main > .tab')];
let reiterJetzt = null;

// Die Kopfleiste bleibt beim Blaettern stehen. Ihre Hoehe steht als Variable,
// damit ein Sprung nicht hinter ihr landet.
function measureHead() { document.documentElement.style.setProperty('--top', topbar.offsetHeight + 'px'); }
addEventListener('resize', measureHead);
measureHead();

try {
  const offen = JSON.parse(localStorage.getItem(UI_STORE) || 'null');
  if (Array.isArray(offen)) cards.forEach(c => { if (!c.classList.contains('fest')) c.open = offen.includes(c.id); });
} catch (e) { /* dann eben die Standardansicht */ }

cards.forEach(c => {
  if (c.classList.contains('fest')) {
    c.open = true;
    // Die Kopfzeile ist Ueberschrift, kein Griff mehr - nur die Auskunft zur
    // KI darin bleibt ein Knopf.
    c.querySelector(':scope > summary').addEventListener('click', e => {
      if (!e.target.closest('.toolwrap')) e.preventDefault();
    });
    return;
  }
  c.addEventListener('toggle', () => {
    try {
      localStorage.setItem(UI_STORE, JSON.stringify(
        cards.filter(x => x.open && !x.classList.contains('fest')).map(x => x.id)));
    } catch (e) { /* ohne Gedaechtnis */ }
  });
});

// Die Vorschau gehoert zu zwei Reitern: neben den Sprechertext und neben das
// Schnittfenster, wo der Cursor in ihr mitlaeuft. Es gibt sie nur einmal; sie
// wandert mit dem Reiter und behaelt dabei alles, was in ihr steht.
function vorschauPlatz(name) {
  const karte = $('sec-vorschau'), platz = $(name === 'schnitt' ? 'platz-schnitt' : 'platz-text');
  if (karte.parentElement !== platz) platz.appendChild(karte);
}

// "adresse" ist falsch, wenn gleich ein Bereich darin angesprungen wird - dann
// nennt die Adresse den Bereich.
function zeigeTab(name, adresse = true) {
  if (!tafeln.some(t => t.dataset.tab === name)) name = 'text';
  if (name !== reiterJetzt) {
    const war = reiterJetzt;
    reiterJetzt = name;
    vorschauPlatz(name);
    tafeln.forEach(t => { t.hidden = t.dataset.tab !== name; });
    reiterKnoepfe.forEach(b => {
      const an = b.dataset.tab === name;
      b.setAttribute('aria-selected', an ? 'true' : 'false');
      b.tabIndex = an ? 0 : -1;
    });
    try { localStorage.setItem(TAB_STORE, name); } catch (e) { /* ohne Gedaechtnis */ }
    // Das Schnittfenster rechnet nur, solange es zu sehen ist.
    if (name === 'schnitt') tlNeu();
    else if (war === 'schnitt') { tlHalt(); tlCursorWeg(); }
  }
  if (adresse) history.replaceState(null, '', '#' + name);
}

function openCard(id) {
  const c = $(id);
  if (!c) return;
  const tafel = c.closest('main > .tab');
  if (tafel) zeigeTab(tafel.dataset.tab, false);
  if (c.tagName === 'DETAILS') c.open = true;
  history.replaceState(null, '', '#' + id);
  // Erst nach dem Wechsel steht fest, wo der Bereich liegt.
  requestAnimationFrame(() => c.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

reiterKnoepfe.forEach((b, i) => {
  b.onclick = () => { zeigeTab(b.dataset.tab); scrollTo({ top: 0 }); };
  // Pfeiltasten gehen von Reiter zu Reiter, wie in jeder Reiterleiste.
  b.onkeydown = e => {
    const schritt = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!schritt) return;
    e.preventDefault();
    const n = reiterKnoepfe[(i + schritt + reiterKnoepfe.length) % reiterKnoepfe.length];
    n.focus();
    n.click();
  };
});

// Verweise im Text ("im Bereich Aussprache") oeffnen den Reiter, in dem das
// Ziel steht. Ohne das sprang der Browser zu einem Bereich, der gar nicht zu
// sehen war - und schon frueher klappte er einen zugeklappten nicht auf.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  const ziel = a ? a.getAttribute('href').slice(1) : '';
  if (!ziel) return;
  if (tafeln.some(t => t.dataset.tab === ziel)) { e.preventDefault(); zeigeTab(ziel); scrollTo({ top: 0 }); return; }
  if (!$(ziel)) return;
  e.preventDefault();
  openCard(ziel);
});

// Wo die Seite aufgeht: bei der Sprungmarke in der Adresse, sonst beim Reiter
// vom letzten Mal, sonst beim Text. Gerufen wird das erst beim Start, wenn
// auch das Schnittfenster eingerichtet ist.
function reiterStart() {
  const ziel = location.hash.slice(1);
  if (ziel && tafeln.some(t => t.dataset.tab === ziel)) { zeigeTab(ziel); return; }
  if (ziel && $(ziel) && $(ziel).closest('main > .tab')) { openCard(ziel); return; }
  let name = 'text';
  try { name = localStorage.getItem(TAB_STORE) || 'text'; } catch (e) { /* ohne Gedaechtnis */ }
  zeigeTab(name);
}

// Aendert sich nur die Sprungmarke - von Hand in der Adresszeile oder ueber
// "Zurueck" -, laedt der Browser nicht neu. Der Reiter folgt ihr trotzdem.
addEventListener('hashchange', reiterStart);

// Kurze Rueckmeldungen (Import, Export) erscheinen unten und gehen von selbst.
let noteTimer = null;
function note(msg) {
  iohint.textContent = msg || '';
  iohint.hidden = !msg;
  clearTimeout(noteTimer);
  if (msg) noteTimer = setTimeout(() => { iohint.hidden = true; }, 7000);
}
