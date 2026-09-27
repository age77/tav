// TAV · Grundlagen, Zerlegen des Sprechertextes und Vorschau.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

const $ = id => document.getElementById(id);
const speed = $('speed'), speedval = $('speedval'), go = $('go'), stopBtn = $('stop'),
      resetBtn = $('reset'), status = $('status'), player = $('player'),
      preview = $('preview'), summary = $('summary'), prog = $('prog'), textEl = $('text'),
      exportBtn = $('export'), importBtn = $('import'), fileEl = $('file'), iohint = $('iohint'),
      whoami = $('whoami'), uname = $('uname'), avatar = $('avatar'),
      xFormat = $('x-format'), xQuality = $('x-quality'), xRate = $('x-rate'), xRateWrap = $('x-rate-wrap'),
      xGo = $('x-go'), xSize = $('x-size'), xNote = $('x-note'), xHead = $('x-head'),
      textNote = $('text-note'), textMd = $('text-md'), vHead = $('v-head'), wHead = $('w-head');

const KINDS = {
  line:      { label: 'Zeilenumbruch', rank: 1, input: 'd-line' },
  paragraph: { label: 'Absatz',        rank: 2, input: 'd-paragraph' },
  divider:   { label: 'Trennlinie',    rank: 3, input: 'd-divider' },
  chapter:   { label: 'Kapitelwechsel',rank: 4, input: 'd-chapter' },
  // Im Text gesetzt: "(Pause: 1,5 s)". Staerker als jede automatische Pause und
  // ohne Standardwert, weil die Laenge im Sprechtext selbst steht.
  custom:    { label: 'Pause aus dem Text', rank: 5, input: null }
};
const DROP_LABEL = { heading: 'Überschrift', direction: 'Regieanweisung', divider: 'Trennlinie',
                     say: 'Aussprache' };

let parts = [];          // {type:'text'|'pause'|'drop', ...}
let controller = null;

const defaultFor = kind => KINDS[kind].input ? Number($(KINDS[kind].input).value) || 0 : 0;
const sentencePause = () => Math.max(0, Number($('d-sentence').value) || 0);

/* ---------- Text bereinigen ---------- */

// Klammerangaben sind Regieanweisungen und werden nicht gesprochen. Eine Klammer
// darf über mehrere Zeilen laufen; dann verschwindet der Zeilenumbruch mit ihr,
// weil er mitten im Satz liegt und keine Pause sein soll.
// Herein kommen {text, line}, heraus dasselbe: line ist die Zeile im Sprechtext,
// in der der Abschnitt beginnt. Das Schnittfenster setzt dort seine Pausen ein.
function stripParens(lines) {
  const res = [];
  let cur = '', at = 0, offen = false, depth = 0, swallowed = '';
  for (const { text, line } of lines) {
    let s = '';
    for (const ch of text) {
      if (ch === '(') { if (!depth) swallowed = ''; depth++; continue; }
      if (ch === ')' && depth) { depth--; continue; }
      if (depth) swallowed += ch; else s += ch;
    }
    if (depth) swallowed += ' ';
    if (!offen) { at = line; offen = true; }
    cur += cur && s ? ' ' + s : s;
    if (!depth) { res.push({ text: cur, line: at }); cur = ''; offen = false; }
  }
  // Klammer nie geschlossen: vermutlich ein Tippfehler, kein Regiehinweis.
  // Der Text bleibt dann erhalten, statt bis zum Absatzende zu verschwinden.
  if (depth && swallowed.trim()) cur += (cur ? ' ' : '') + swallowed.trim();
  if (cur) res.push({ text: cur, line: at });
  return res;
}

// Ganze Zeile ist Regieanweisung, wenn sie mit einer Klammer beginnt und
// ausserhalb der Klammern nichts uebrig bleibt. Eine hier nicht geschlossene
// Klammer zaehlt mit, damit auch "(Bild: ..." ohne Klammerzu stumm bleibt.
function isDirection(line) {
  if (!line.startsWith('(')) return false;
  let depth = 0, rest = '';
  for (const ch of line) {
    if (ch === '(') { depth++; continue; }
    if (ch === ')' && depth) { depth--; continue; }
    if (!depth) rest += ch;
  }
  return !rest.trim();
}

// Ausdrueckliche Pause: eine Zeile, die nur aus "(Pause: 1,5 s)" besteht. Erlaubt
// sind Punkt oder Komma als Dezimaltrennzeichen, Sekunden und Millisekunden.
const PAUSE_CMD = /^\(\s*pause\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(ms|millisekunden|s|sek|sec|sekunden)?\s*\)$/i;

// Laenger wird keine Pause. Zehn Minuten reichen fuer jede stille Strecke eines
// Films, den Martin neu vertont, und halten einen Tippfehler trotzdem in Grenzen.
const PAUSE_MAX = 600;

function pauseCommand(line) {
  const m = PAUSE_CMD.exec(line);
  if (!m) return null;
  let v = Number(m[1].replace(',', '.'));
  if (!isFinite(v)) return null;
  if (/^m/i.test(m[2] || '')) v /= 1000;              // Millisekunden
  return Math.min(PAUSE_MAX, Math.max(0, v));
}

/* ---------- Aussprache ---------- */

// Eine Zeile "(Chefarzt|Schähfarzt)" spricht das Wort links so aus, wie es
// rechts steht. Doppelpunkt und Semikolon sind ausgeschlossen, damit
// "(Bild: links | rechts)" eine Regieanweisung bleibt.
const SAY_CMD = /^\(\s*([^()|:;]+?)\s*\|\s*([^()|:;]+?)\s*\)$/;

function sayCommand(line) {
  const m = SAY_CMD.exec(line);
  if (!m) return null;
  const from = m[1].trim(), to = m[2].trim();
  return from && to ? { from, to } : null;
}

const rxEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Wortgrenze ohne \b: dort zaehlen Umlaute als Nicht-Wortzeichen, "(Ärztin|Erztin)"
// wuerde sonst nie greifen.
const wordRx = alts => new RegExp('(?<![\\p{L}\\p{N}])(?:' + alts + ')(?![\\p{L}\\p{N}])', 'giu');

let sayMark = null;      // Vorschau: nennt zur Lautschrift das geschriebene Wort
let sayGlobal = [];      // die Liste aus dem Bereich "Aussprache", siehe weiter unten

// Alle Regeln gelten fuer den ganzen Text, egal wo sie stehen — sie sind als
// Liste am Ende gedacht. Ersetzt wird in einem Durchgang: das laengste Wort
// gewinnt, und eine eingesetzte Lautschrift wird nicht noch einmal ersetzt.
//
// Vorne steht die Liste aus dem Bereich "Aussprache", die fuer jeden Text gilt.
// Die Zeilen des Textes kommen danach: nennen beide dasselbe Wort, steht die
// Zeile aus dem Text spaeter und gewinnt.
function saySetup(lines) {
  const rules = sayAktiv();
  for (const line of lines) {
    const r = sayCommand(line.trim());
    if (r) rules.push(r);
  }
  if (!rules.length) { sayMark = null; return t => t; }
  rules.sort((a, b) => b.from.length - a.from.length);

  const spoken = new Map(rules.map(r => [r.from.toLowerCase(), r.to]));
  const rx = wordRx(rules.map(r => rxEsc(r.from)).join('|'));
  // Die Vorschau arbeitet auf dem bereits maskierten Text, darum hier ebenso.
  sayMark = { rx: wordRx(rules.map(r => rxEsc(esc(r.to))).join('|')),
              written: new Map(rules.map(r => [esc(r.to).toLowerCase(), r.from])) };

  return t => t.replace(rx, m => spoken.get(m.toLowerCase()) || m);
}

function clean(line) {
  return line
    .replace(/[\[\]*_`~]/g, '')                // Markdown-Auszeichnung, Linktext bleibt
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')   // Aufzählungszeichen
    .replace(/^\s*>+\s*/, '')                  // Zitatzeichen
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')           // Leerraum vor Satzzeichen
    .replace(/^[\s:;,]+/, '')                  // Rest einer entfernten Klammer
    .trim();
}

/* ---------- Parser ---------- */

function parse(src) {
  const out = [];
  let run = [];                       // aufeinanderfolgende Textzeilen
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const say = saySetup(lines);

  const flushRun = () => {
    let first = true;
    for (const logical of stripParens(run)) {
      // "roh" ist der geschriebene Wortlaut, "text" der gesprochene. Die
      // Aussprache-Liste gilt der Stimme; im Untertitel steht das Wort so, wie
      // es geschrieben wird - "Schähfarzt" gehoert nicht ins Bild.
      const roh = clean(logical.text);
      const text = say(roh);
      if (!text) continue;
      const line = logical.line;
      if (!first) out.push({ type: 'pause', kind: 'line', line });   // Zeilenumbruch
      out.push({ type: 'text', text, roh, line });
      first = false;
    }
    run = [];
  };

  for (const [line, raw] of lines.entries()) {
    const t = raw.trim();
    const cmd = pauseCommand(t);
    const rule = sayCommand(t);

    if (!t) {                                            // Leerzeile
      flushRun();
      out.push({ type: 'pause', kind: 'paragraph', line });
    } else if (/^#{1,6}\s*\S/.test(t)) {                 // Überschrift -> Kapitelwechsel
      flushRun();
      out.push({ type: 'drop', what: 'heading', raw: t, line });
      out.push({ type: 'pause', kind: 'chapter', line });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {       // Trennlinie
      flushRun();
      out.push({ type: 'drop', what: 'divider', raw: t, line });
      out.push({ type: 'pause', kind: 'divider', line });
    } else if (cmd !== null) {                           // ausdrueckliche Pause
      flushRun();
      out.push({ type: 'pause', kind: 'custom', dur: cmd, line });
    } else if (rule) {                                   // Aussprache, keine Pause
      flushRun();
      out.push({ type: 'drop', what: 'say', raw: t, from: rule.from, to: rule.to, line });
    } else if (isDirection(t)) {                         // erzeugt bewusst keine Pause
      flushRun();
      out.push({ type: 'drop', what: 'direction', raw: t, line });
    } else {
      run.push({ text: t, line });
    }
  }
  flushRun();
  return collapse(out);
}

// Mehrere Pausen ohne Text dazwischen ergeben eine einzige: die stärkste.
// So bringt eine Regieanweisung samt der Leerzeilen um sie herum keine Extra-Pause.
function collapse(events) {
  const out = [];
  let run = [];                       // gesammelte Pausen des aktuellen Laufs
  let pendingDrops = [];

  const flush = () => {
    out.push(...pendingDrops);
    pendingDrops = [];
    // Vor dem ersten Abschnitt zaehlt nur die ausdrueckliche Pause aus dem Text.
    // Automatische Pausen (Ueberschrift, Leerzeile) am Anfang bleiben stumm, sonst
    // begaenne jeder Text mit Ueberschrift mit einer Kapitelpause.
    const usable = out.some(p => p.type === 'text') ? run : run.filter(p => p.kind === 'custom');
    if (usable.length) {
      const best = usable.reduce((a, b) => {
        if (KINDS[b.kind].rank !== KINDS[a.kind].rank) return KINDS[b.kind].rank > KINDS[a.kind].rank ? b : a;
        return b.kind === 'custom' && b.dur > a.dur ? b : a;   // die laengste Textpause gewinnt
      });
      const fixed = best.kind === 'custom';           // Laenge steht im Text, kein Standardwert
      out.push({ type: 'pause', kind: best.kind, dur: fixed ? best.dur : defaultFor(best.kind),
                 manual: fixed, line: best.line });
    }
    run = [];
  };

  for (const ev of events) {
    if (ev.type === 'pause') run.push(ev);
    else if (ev.type === 'drop') pendingDrops.push(ev);
    else { flush(); out.push(ev); }
  }
  out.push(...pendingDrops);
  // Automatische Pausen am Ende (z.B. eine Leerzeile ganz zum Schluss) verfallen
  // weiterhin. Eine ausdrueckliche "(Pause: ...)" bleibt aber bestehen, sonst
  // liesse sich Schlussstille gar nicht erzwingen.
  const trailingCustom = run.filter(p => p.kind === 'custom');
  if (trailingCustom.length) {
    const best = trailingCustom.reduce((a, b) => (b.dur > a.dur ? b : a));
    out.push({ type: 'pause', kind: 'custom', dur: best.dur, manual: true, line: best.line });
  }
  return out;
}

/* ---------- Vorschau ---------- */

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = s => esc(s).replace(/"/g, '&quot;');

// Gezeigt wird, was gesprochen wird: die Lautschrift. Das geschriebene Wort
// steht im Hinweis beim Zeigen darauf.
function markSaid(text) {
  const html = esc(text);
  if (!sayMark) return html;
  return html.replace(sayMark.rx, m =>
    '<span class="say" title="' + escAttr(sayMark.written.get(m.toLowerCase()) || '') + '">' + m + '</span>');
}

function render() {
  if (!parts.length) {
    preview.innerHTML = '<p class="hint">Noch kein Text.</p>';
    summary.textContent = '';
    updateEstimate();
    tlNeu();
    return;
  }
  preview.innerHTML = parts.map((p, i) => {
    if (p.type === 'text') return '<div class="seg">' + markSaid(p.text) + '</div>';
    if (p.type === 'drop') {
      const tag = '<div class="drop"><span class="tag">' + DROP_LABEL[p.what] + '</span>';
      return p.what === 'say'
        ? tag + esc(p.from) + ' → <b>' + esc(p.to) + '</b></div>'
        : tag + '<s>' + esc(p.raw) + '</s></div>';
    }
    const cls = 'pause' + (p.manual ? ' edited' : '') + (p.dur <= 0 ? ' zero' : '');
    return '<div class="' + cls + '"><span>' + KINDS[p.kind].label + '</span>' +
           '<input type="number" min="0" max="' + PAUSE_MAX + '" step="0.05" value="' + p.dur.toFixed(2) + '" data-i="' + i + '">' +
           '<span>s</span></div>';
  }).join('');

  preview.querySelectorAll('input[data-i]').forEach(inp => {
    inp.oninput = () => {
      const p = parts[Number(inp.dataset.i)];
      p.dur = Math.max(0, Number(inp.value) || 0);
      p.manual = true;
      inp.closest('.pause').classList.toggle('edited', true);
      inp.closest('.pause').classList.toggle('zero', p.dur <= 0);
      updateSummary();
      scheduleRefresh();              // sonst spielte und speicherte die Seite die alte Laenge
    };
  });
  updateSummary();
}

function updateSummary() {
  const { segs, gaps, lead, tail } = plan();
  const silence = lead + tail + gaps.reduce((a, b) => a + b, 0);
  const count = gaps.filter(g => g > 0).length + (lead > 0 ? 1 : 0) + (tail > 0 ? 1 : 0);
  summary.textContent = segs.length + ' Abschnitt(e) · ' +
    count + ' Pause(n) · ' + silence.toFixed(2) + ' s Stille';
  updateEstimate();
  tlNeu();                            // die Zeitleiste rechnet mit denselben Zahlen
  if (vInfo) sZeige();                // und der Untertitel-Bereich mit demselben Text
}

// Pausen mit 0 s trennen nicht, sondern ziehen die Nachbarn zusammen.
// Ohne Angabe gilt der Text im Feld; der Stapel reicht seine eigene Liste ein.
function plan(list = parts) {
  const segs = [], gaps = [];
  let lead = 0, tail = 0, pending = null;   // Stille vor dem ersten und nach dem letzten Abschnitt
  for (const p of list) {
    if (p.type === 'pause') pending = pending === null ? p.dur : Math.max(pending, p.dur);
    else if (p.type === 'text') {
      if (!segs.length) { lead = pending > 0 ? pending : 0; segs.push(p.text); }
      else if (pending === null || pending <= 0) segs[segs.length - 1] += ' ' + p.text;
      else { gaps.push(pending); segs.push(p.text); }
      pending = null;
    }
  }
  if (segs.length && pending > 0) tail = pending;
  return { segs, gaps, lead, tail };
}

// Dieselbe Rechnung wie plan(), nur mit Herkunft: zu jedem Abschnitt steht
// dabei, aus welchen Teilen der Vorschau er zusammengewachsen ist und welche
// Zeichen davon zu welchem Teil gehoeren. Darauf sitzt das Schnittfenster, das
// zu jeder Sekunde die Stelle im Text nennen koennen muss.
function layout(list = parts) {
  const segs = [], gaps = [];         // gaps[i] liegt zwischen segs[i] und segs[i+1]
  let lead = null, tail = null, pending = null;
  const anfang = (p, i) => ({ text: p.text, klar: p.roh || p.text,
                              stuecke: [{ part: i, von: 0, bis: p.text.length }] });

  for (const [i, p] of list.entries()) {
    if (p.type === 'pause') {
      if (!pending || p.dur > pending.dur) pending = { part: i, dur: p.dur };
    } else if (p.type === 'text') {
      if (!segs.length) {
        if (pending && pending.dur > 0) lead = pending;
        segs.push(anfang(p, i));
      } else if (!pending || pending.dur <= 0) {
        const s = segs[segs.length - 1];
        const von = s.text.length + 1;                 // das Leerzeichen der Naht
        s.text += ' ' + p.text;
        s.klar += ' ' + (p.roh || p.text);
        s.stuecke.push({ part: i, von, bis: s.text.length });
      } else {
        gaps.push(pending);
        segs.push(anfang(p, i));
      }
      pending = null;
    }
  }
  if (segs.length && pending && pending.dur > 0) tail = pending;
  return { segs, gaps, lead, tail };
}
