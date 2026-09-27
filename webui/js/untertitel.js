// TAV · Untertitel: Einblendungen und Vorschau.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Untertitel: der Sprechertext im Bild ---------- */

// Eingeblendet wird, was gesprochen wird, und zwar dann, wenn es gesprochen
// wird: die Zeiten kommen aus derselben Rechnung wie die Tonspur (layout() und
// die gemessenen Abschnittslaengen), nicht aus einer zweiten Schaetzung. Die
// Einteilung in Einblendungen geschieht hier, das Einbrennen im Videodienst -
// die Seite schickt Stil und Liste, ffmpeg legt sie ueber das fertige Bild.
const sEl = id => $('s-' + id);
const S_FELDER = ['size', 'margin', 'alpha', 'outline', 'chars', 'lines'];
const S_DEFAULTS = { on: false, font: 'sans', size: 5, position: 'bottom', margin: 6,
                     color: '#ffffff', box: '#000000', alpha: 55, outline: 0,
                     chars: 42, lines: 2, bold: true };

function initUntertitel() {
  if (!vInfo) { sEl('offline').hidden = false; sEl('body').hidden = true; return; }
  sEl('font').innerHTML = (vInfo.sub_fonts || []).map(o =>
    '<option value="' + o.id + '">' + esc(o.label) + '</option>').join('');
  sEl('position').innerHTML = (vInfo.sub_positions || []).map(o =>
    '<option value="' + o.id + '">' + esc(o.label) + '</option>').join('');

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(VSTORE) || '{}').untertitel || {}; } catch (e) { /* egal */ }
  sApply(Object.assign({}, S_DEFAULTS, saved));

  for (const el of [sEl('on'), sEl('font'), sEl('position'), sEl('color'), sEl('box'), sEl('bold'),
                    ...S_FELDER.map(sEl)])
    el.oninput = el.onchange = () => { vSave(); sZeige(); scheduleVideoPlan(); };
  if (window.ResizeObserver) new ResizeObserver(sMassstab).observe(sEl('vorschau'));
  sZeige();
}

function sChoice() {
  return { on: sEl('on').checked, font: sEl('font').value, position: sEl('position').value,
           color: sEl('color').value, box: sEl('box').value, bold: sEl('bold').checked,
           size: Number(sEl('size').value) || 0, margin: Number(sEl('margin').value) || 0,
           alpha: Number(sEl('alpha').value) || 0, outline: Number(sEl('outline').value) || 0,
           chars: Math.round(Number(sEl('chars').value) || 42),
           lines: Math.round(Number(sEl('lines').value) || 2) };
}

function sApply(o) {
  if (!o || typeof o !== 'object' || !vInfo) return;
  sEl('on').checked = !!o.on;
  sEl('bold').checked = o.bold !== false;
  if ((vInfo.sub_fonts || []).some(f => f.id === o.font)) sEl('font').value = o.font;
  if ((vInfo.sub_positions || []).some(f => f.id === o.position)) sEl('position').value = o.position;
  for (const feld of ['color', 'box'])
    if (/^#[0-9a-f]{6}$/i.test(String(o[feld] || ''))) sEl(feld).value = o[feld];
  for (const feld of S_FELDER) {
    const v = Number(o[feld]);
    if (isFinite(v)) sEl(feld).value = v;
  }
  sZeige();
}

// Fuer den Dienst: dieselben Namen wie dort, Prozent bleibt Prozent.
function sFuerDienst() {
  const o = sChoice();
  return { on: o.on, font: o.font, position: o.position, color: o.color, box: o.box,
           bold: o.bold, size: o.size, margin: o.margin, box_alpha: o.alpha, outline: o.outline };
}

/* ----- Aus dem Sprechertext werden Einblendungen ----- */

// Gemessen wird in der Schrift und in den Bildpunkten des Videos: libass setzt
// die Groesse als Hoehe einer Zeile, das Geviert der DejaVu-Schriften ist
// 1,164-mal kleiner. Die Dateien sind dieselben wie im Videodienst.
const DEJAVU_ZEILE = 1.164;
const S_SCHRIFT = { sans: 'TAV DejaVu Sans', serif: 'TAV DejaVu Serif', mono: 'TAV DejaVu Sans Mono' };
const sSchrift = (o, geviert) => (o.bold ? '700 ' : '400 ') + geviert + 'px "' + (S_SCHRIFT[o.font] || S_SCHRIFT.sans) + '"';
const sLeinwand = document.createElement('canvas').getContext('2d');

// Das Bild, in das die Untertitel kommen: so gross, wie der Videodienst es
// zuletzt geplant hat, sonst Full HD.
let vBildMass = { w: 1920, h: 1080 };

// Ist die Schrift noch nicht geladen, wird nur nach Zeichen gezaehlt und die
// Schrift nachgeladen; danach rechnet die Vorschau neu.
function sSchriftDa(schrift) {
  if (document.fonts.check(schrift)) return true;
  document.fonts.load(schrift).then(() => { if (document.fonts.check(schrift)) sZeige(); }).catch(() => {});
  return false;
}

// Wo sich gut schneiden laesst, je kleiner, desto besser: hinter einem
// Satzende, hinter Doppelpunkt oder Semikolon, hinter Komma oder Gedankenstrich,
// vor einem Bindewort wie "und" oder "oder", vor einem Artikel oder einer
// Praeposition, wo eine neue Wortgruppe anfaengt. Nie aber dahinter: ein "in",
// "der" oder "zu" am Zeilenende haengt in der Luft.
const S_BINDEWORT = new Set(['und', 'oder', 'aber', 'sondern', 'denn', 'doch', 'jedoch', 'weil', 'dass',
  'damit', 'wenn', 'ob', 'sowie', 'bzw.', 'bevor', 'nachdem', 'während', 'wobei', 'sodass', 'obwohl',
  'falls', 'indem', 'sobald', 'solange', 'sofern']);
const S_HAENGT = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'eines', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'mein', 'meine', 'sein', 'seine', 'ihr', 'ihre',
  'unser', 'unsere', 'dein', 'deine', 'in', 'im', 'an', 'am', 'auf', 'aus', 'bei', 'beim', 'mit', 'nach',
  'von', 'vom', 'vor', 'zu', 'zum', 'zur', 'für', 'über', 'unter', 'durch', 'um', 'ohne', 'gegen', 'bis',
  'seit', 'zwischen', 'neben', 'hinter', 'ab', 'per', 'pro', 'und', 'oder', 'sowie', 'als', 'wie']);
function sNaht(links, rechts) {
  if (/[.!?…]["'»«“”)]*$/.test(links)) return 0;
  if (/[:;]$/.test(links)) return 1;
  if (/[,–—]$/.test(links)) return 2;
  const l = links.toLowerCase(), r = rechts.toLowerCase();
  if (S_HAENGT.has(l)) return 14;
  if (S_BINDEWORT.has(r)) return 3;
  if (S_HAENGT.has(r)) return 5;
  return 8;
}

// Ein Abschnitt wird zu Einblendungen aus hoechstens "zeilen" Zeilen: erst
// die kleinste Zahl von Einblendungen, dann die Worte gleichmaessig darauf
// verteilt - lieber an einer guten Naht als genau in der Mitte, und nie vorn
// voll und hinten ein Rest. Innerhalb einer Einblendung dasselbe mit den
// Zeilen. Jedes Wort wird einmal gemessen; Zeichen und Breite einer Zeile
// kommen aus Summen, denn ueber ein Leerzeichen hinweg wird nicht unterschnitten.
function sAufteilen(text, mass, zeilen) {
  const worte = text.split(/\s+/).filter(Boolean);
  const n = worte.length;
  if (!n) return [];
  const zVor = [0], bVor = [0];
  worte.forEach((w, i) => { zVor.push(zVor[i] + w.length + 1); bVor.push(bVor[i] + mass.breite(w) + mass.leer); });
  // Worte i bis j-1 als eine Zeile; ein einzelnes Wort passt immer.
  const passt = (i, j) => j - i <= 1 ||
    (zVor[j] - zVor[i] - 1 <= mass.zeichen && bVor[j] - bVor[i] - mass.leer <= mass.frei);
  const gezaehlt = new Map();
  const zeilenNoetig = (i, j) => {
    const schluessel = i * 65536 + j;
    let z = gezaehlt.get(schluessel);
    if (z === undefined) {
      z = 1;
      for (let a = i, b = i + 2; b <= j; b++) if (!passt(a, b)) { z++; a = b - 1; }
      gezaehlt.set(schluessel, z);
    }
    return z;
  };
  // Worte i0 bis i1-1 auf genau k Stuecke, die alle geht(i, j) erfuellen.
  const verteilen = (i0, i1, k, geht) => {
    const ziel = (zVor[i1] - zVor[i0] - 1) / k, n1 = i1 - i0 + 1;
    // best[s][j - i0]: kleinste Kosten fuer s Stuecke bis vor Wort j
    const best = [...Array(k + 1)].map(() => new Float64Array(n1).fill(Infinity));
    const von = [...Array(k + 1)].map(() => new Int32Array(n1).fill(-1));
    best[0][0] = 0;
    for (let s = 1; s <= k; s++) {
      for (let j = i0 + 1; j <= i1; j++) {
        const naht = j < i1 ? sNaht(worte[j - 1], worte[j]) : 0;
        for (let i = j - 1; i >= i0; i--) {
          if (!geht(i, j)) break;                    // weiter vorn passt noch weniger
          const b = best[s - 1][i - i0];
          if (b === Infinity) continue;
          const abw = (zVor[j] - zVor[i] - 1 - ziel) / ziel;
          const c = b + 20 * abw * abw + naht;
          if (c < best[s][j - i0]) { best[s][j - i0] = c; von[s][j - i0] = i; }
        }
      }
    }
    const teile = [];
    for (let s = k, j = i1; s > 0; s--) { const i = von[s][j - i0]; teile.unshift([i, j]); j = i; }
    return { teile, kosten: best[k][n1 - 1] };
  };
  const passtIn = (i, j) => zeilenNoetig(i, j) <= zeilen;
  const kMin = Math.ceil(zeilenNoetig(0, n) / zeilen);
  let wahl = verteilen(0, n, kMin, passtIn);
  // Eine Einblendung mehr, wenn sie deutlich bessere Schnitte erlaubt - etwa
  // am Satzende statt mitten in einer Wortgruppe. Was in eine passt, bleibt eine.
  if (kMin > 1 && kMin < n) {
    const mehr = verteilen(0, n, kMin + 1, passtIn);
    if (mehr.kosten + 6 < wahl.kosten) wahl = mehr;
  }
  return wahl.teile.map(([a, b]) => {
    const m = zeilenNoetig(a, b);
    const teile = m <= 1 ? [[a, b]] : verteilen(a, b, m, passt).teile;
    return teile.map(([x, y]) => worte.slice(x, y).join(' '));
  });
}

// Die Liste, die mit dem Auftrag geht: Anfang, Ende und Text jeder Einblendung.
// Eine Zeile passt, wenn sie hoechstens "Zeichen je Zeile" hat und im Bild
// zwischen den Raendern Platz findet - gemessen in der Schrift des Videos.
function sCues() {
  if (!vInfo || !sEl('on').checked) return [];
  const { segs, gaps, lead } = layout();
  if (!segs.length) return [];
  const o = sChoice();
  const { w, h } = vBildMass;
  const schrift = sSchrift(o, h * o.size / 100 / DEJAVU_ZEILE);
  const messbar = sSchriftDa(schrift);
  sLeinwand.font = schrift;
  const gemessen = new Map();
  const mass = {
    zeichen: Math.max(16, o.chars),
    frei: messbar ? w - 2 * Math.round(h * o.margin / 100) : Infinity,
    leer: messbar ? sLeinwand.measureText(' ').width : 0,
    breite: wort => {
      if (!messbar) return 0;
      if (!gemessen.has(wort)) gemessen.set(wort, sLeinwand.measureText(wort).width);
      return gemessen.get(wort);
    }
  };
  const zeilen = Math.max(1, o.lines);

  const versatz = vVorspann() + (vEl('voice').checked ? Math.max(0, Number(vEl('offset').value) || 0) : 0);
  const raus = [];
  let t = versatz + (lead && lead.dur > 0 ? lead.dur : 0);
  segs.forEach((s, i) => {
    const dauer = tlAbschnittSek(s.text);             // gesprochen wird der eine,
    const klar = s.klar || s.text;                    // im Bild steht der andere
    const stuecke = sAufteilen(klar, mass, zeilen);
    // Die Zeit einer Einblendung waechst mit ihrem Anteil am Text.
    const gesamt = Math.max(1, stuecke.reduce((n, z) => n + z.join(' ').length + 1, -1));
    let pos = 0;
    for (const z of stuecke) {
      const laenge = z.join(' ').length;
      const start = t + dauer * pos / gesamt, ende = t + dauer * (pos + laenge) / gesamt;
      pos += laenge + 1;
      if (ende > start) raus.push({ start: Math.round(start * 1000) / 1000,
                                    end: Math.round(ende * 1000) / 1000, text: z.join('\n') });
    }
    t += dauer + (gaps[i] && gaps[i].dur > 0 ? gaps[i].dur : 0);
  });
  return raus;
}

// Das Bild in Videogroesse passt sich der Breite der Vorschau an - auch wenn
// das Fenster schmaler wird oder der Bereich erst aufklappt.
function sMassstab() {
  const { w, h } = vBildMass, bild = sEl('bild');
  bild.style.width = w + 'px';
  bild.style.height = h + 'px';
  bild.style.transform = 'scale(' + ((sEl('vorschau').clientWidth || 640) / w) + ')';
}

// Die Vorschau zeigt Schrift, Kasten und Lage so, wie ffmpeg sie setzen wird:
// ein Bild in der Groesse des Videos, in derselben Schrift und mit denselben
// Zeilen, gesetzt in seinen Bildpunkten und als Ganzes auf die Vorschau
// verkleinert (.s-bild).
function sZeige() {
  if (!vInfo) return;
  const o = sChoice(), kasten = sEl('vorschau'), demo = sEl('demo');
  sEl('an').hidden = !o.on;                // Vorschau und Stil nur, wenn es Untertitel gibt
  const { w, h } = vBildMass;
  kasten.style.aspectRatio = w + ' / ' + h;
  sMassstab();
  const mische = (hex, deckkraft) => {
    const n = parseInt(String(hex).slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (deckkraft / 100) + ')';
  };
  demo.style.fontFamily = '"' + (S_SCHRIFT[o.font] || S_SCHRIFT.sans) + '", sans-serif';
  demo.style.fontWeight = o.bold ? '700' : '400';
  demo.style.fontSize = (h * o.size / 100 / DEJAVU_ZEILE) + 'px';
  demo.style.lineHeight = String(DEJAVU_ZEILE);
  demo.style.color = o.color;
  demo.style.background = o.alpha > 0 ? mische(o.box, o.alpha) : 'transparent';
  const u = o.outline;
  demo.style.textShadow = o.outline > 0
    ? [[-u, -u], [u, -u], [-u, u], [u, u]].map(([x, y]) => x + 'px ' + y + 'px 0 rgba(0,0,0,.9)').join(',') : 'none';
  // Der Rand zaehlt bis zur Zeile; der Kasten steht um sein Polster darueber hinaus.
  const rand = 'calc(' + Math.round(h * o.margin / 100) + 'px - .1em)';
  demo.style.bottom = o.position === 'bottom' ? rand : 'auto';
  demo.style.top = o.position === 'top' ? rand : o.position === 'middle' ? '50%' : 'auto';
  demo.style.transform = o.position === 'middle' ? 'translateY(-50%)' : 'none';

  const cues = sCues();
  const beispiel = cues.length ? cues[Math.min(cues.length - 1, Math.floor(cues.length / 2))].text
                               : 'So sieht der Sprechertext im Bild aus.';
  demo.textContent = beispiel;
  sEl('note').textContent = !sEl('on').checked
    ? 'Ausgeschaltet — das Video bleibt ohne Untertitel.'
    : cues.length
      ? cues.length + ' Einblendung(en)' +
        (vInfo.max_cues && cues.length > vInfo.max_cues
          ? ' — mehr als ' + vInfo.max_cues + ', der Dienst nimmt nur so viele an.'
          : ' · erste bei ' + fmtTime(cues[0].start) + ', letzte bis ' + fmtTime(cues[cues.length - 1].end))
      : 'Noch kein Sprechertext, aus dem Untertitel werden könnten.';
}
