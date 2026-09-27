// TAV · Stapel aus Markdown-Dateien, ZIP, Sprechertext-Dateien.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Stapel aus Markdown-Dateien ---------- */

// Mehrere abgelegte Dateien ergeben je eine eigene Tondatei. Gesprochen wird
// mit denselben Pausenlaengen, demselben Tempo und denselben Exporteinstellungen
// wie der Text im Feld; gespeichert wird alles zusammen als ZIP, weil Browser
// viele Downloads hintereinander abwehren.
const MD_EXT = /\.(md|markdown|txt|text)$/i;

let mdFiles = [];        // {key, name, text, state, error, bytes, seconds}
let batchRunning = false;
let batchAbort = null;
let batchCancelled = false;

// Der Abbruch bricht die laufende Anfrage ab; das Kodieren laeuft im Browser
// und laesst sich nur zwischen zwei Schritten anhalten.
function haltIfCancelled() {
  if (batchCancelled) throw Object.assign(new Error('Abgebrochen'), { name: 'AbortError' });
}

const mdEl = id => $('md-' + id);

const mdBase = name => name.replace(/^.*[\\/]/, '').replace(MD_EXT, '').replace(/[\x00-\x1f]/g, '').trim() || 'text';

// Zwei Dateien duerfen denselben Rumpf haben (kapitel.md und kapitel.txt);
// im ZIP muss der Name trotzdem eindeutig sein.
function mdNames(ext) {
  const seen = new Map();
  return mdFiles.map(f => {
    const base = mdBase(f.name);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return mitVorsatz(base) + (n > 1 ? '-' + n : '') + '.' + ext;
  });
}

async function mdAdd(files) {
  const list = [...files].filter(f => MD_EXT.test(f.name) || f.type.startsWith('text/'));
  const weg = files.length - list.length;
  if (!list.length) {
    note(weg ? 'Nur Markdown- und Textdateien, bitte.' : 'Keine Datei dabei.');
    return;
  }
  const gelesen = [];
  for (const f of list) {
    try { gelesen.push({ key: Math.random().toString(36).slice(2), name: f.name, text: await f.text(), state: 'wartet' }); }
    catch (e) { note('„' + f.name + '“ ließ sich nicht lesen.'); }
  }
  if (!gelesen.length) return;

  // Eine einzelne Datei gehoert ins Feld — es sei denn, ein Stapel liegt schon
  // bereit, dann waechst er. Eingelesen wird im Browser, liegen soll die Datei
  // aber dort, wo auch die Clips liegen: sonst fehlt im Bereich "Auf dem
  // Server" gerade der Sprechertext, mit dem alles anfaengt. Das Ablegen
  // laeuft nebenher weiter.
  if (gelesen.length === 1 && !mdFiles.length) {
    textUebernehmen(gelesen[0].name, gelesen[0].text, null);
    textAblegen(gelesen[0].name, gelesen[0].text, { leise: true });
    note('Eingelesen: ' + gelesen[0].name);
    return;
  }
  mdFiles.push(...gelesen);
  mdRender();
  for (const f of gelesen)
    textAblegen(f.name, f.text, { leise: true, merken: false })
      .then(meta => { if (meta) f.sid = meta.id; });
  note(gelesen.length + ' Datei(en) im Stapel' + (weg ? ', ' + weg + ' übergangen' : '') + '.');
}

function mdDescribe(f, name) {
  const parts = [name];
  if (f.seconds) parts.push(fmtTime(f.seconds));
  if (f.bytes) parts.push(fmtBytes(f.bytes));
  if (f.state === 'wartet') parts.push('wartet');
  if (f.state === 'spricht') parts.push('wird gesprochen…');
  if (f.state === 'kodiert') parts.push('wird kodiert…');
  if (f.state === 'fehler') parts.push(f.error);
  return parts.join(' · ');
}

function mdRender() {
  const box = mdEl('box');
  box.hidden = !mdFiles.length;
  if (!mdFiles.length) { mdEl('note').textContent = ''; mdEl('size').textContent = ''; return; }
  const namen = mdNames(FORMATS[xFormat.value].ext);
  mdEl('list').innerHTML = mdFiles.map((f, i) =>
    '<li data-key="' + f.key + '"><span class="num">' + (i + 1) + '</span>' +
    '<div class="what"><div class="name">' + esc(f.name) + '</div>' +
    '<div class="meta' + (f.state === 'fehler' ? ' err' : '') + '">' + esc(mdDescribe(f, namen[i])) + '</div></div>' +
    '<button class="sec" data-act="show" title="In das Feld holen"' + (batchRunning ? ' disabled' : '') + '>Ansehen</button>' +
    '<button class="sec" data-act="del" title="Aus dem Stapel nehmen"' + (batchRunning ? ' disabled' : '') + '>✕</button></li>').join('');

  mdEl('list').querySelectorAll('li').forEach(li => li.querySelectorAll('button').forEach(b => b.onclick = () => {
    const i = mdFiles.findIndex(f => f.key === li.dataset.key);
    if (i < 0) return;
    if (b.dataset.act === 'del') { mdFiles.splice(i, 1); mdRender(); return; }
    textUebernehmen(mdFiles[i].name, mdFiles[i].text, mdFiles[i].sid || null);
    note('Im Feld: ' + mdFiles[i].name);
  }));
  mdUpdate();
}

function mdUpdate() {
  mdEl('go').disabled = batchRunning || !mdFiles.length;
  mdEl('clear').disabled = batchRunning;
  mdEl('stop').hidden = !batchRunning;
  go.disabled = batchRunning || !!controller;
  const fertig = mdFiles.filter(f => f.bytes);
  mdEl('size').innerHTML = fertig.length
    ? fertig.length + ' von ' + mdFiles.length + ' · <b>' + fmtBytes(fertig.reduce((n, f) => n + f.bytes, 0)) + '</b>'
    : mdFiles.length + ' Datei(en)';
}

async function mdRun() {
  if (batchRunning || !mdFiles.length) return;
  const { fmt, q, rate } = exportChoice(), ext = FORMATS[fmt].ext;
  const namen = mdNames(ext);
  const note_ = mdEl('note'), prog = mdEl('prog');
  batchRunning = true;
  batchCancelled = false;
  batchAbort = new AbortController();
  note_.classList.remove('err');
  prog.hidden = false; prog.value = 0;
  mdFiles.forEach(f => { f.state = 'wartet'; f.error = null; f.bytes = 0; f.seconds = 0; });
  mdRender();
  const t0 = performance.now();
  const eintraege = [];
  const z = { neu: 0, vorhanden: 0 };

  try {
    for (let i = 0; i < mdFiles.length; i++) {
      haltIfCancelled();
      const f = mdFiles[i];
      const schritt = (x) => { prog.value = (i + x) / mdFiles.length; };
      const wo = 'Datei ' + (i + 1) + ' von ' + mdFiles.length + ': ' + f.name;
      // Eine Datei, die sich nicht sprechen laesst, haelt die anderen nicht
      // auf; sie bleibt mit ihrem Fehler in der Liste stehen.
      try {
        const p = plan(parse(f.text));
        if (!p.segs.length) throw new Error('kein sprechbarer Text');

        f.state = 'spricht';
        mdRender();
        // Die Stuecke bleiben hier liegen: ein volllaufender Zwischenspeicher
        // darf die schon gesprochenen Teile dieser Datei nicht mitnehmen.
        const stuecke = new Map();
        const offen = [...new Set(p.segs)].filter(t => !cache.has(cacheKey(t))).length;
        let gesprochen = 0;
        for (const seg of p.segs) {
          const key = cacheKey(seg);
          if (stuecke.has(key)) continue;
          let pcm = cache.get(key);
          if (!pcm) {
            note_.textContent = wo + ' — Abschnitt ' + (gesprochen + 1) + ' von ' + offen + '…';
            pcm = await speakSegment(seg, batchAbort.signal, z);
            cachePut(key, pcm);
            schritt(0.9 * ++gesprochen / Math.max(1, offen));
          }
          stuecke.set(key, pcm);
        }

        const pcm = assemble(p, lastRate, stuecke);
        if (!pcm) throw new Error('Abschnitte fehlen');
        f.seconds = pcm.length / lastRate;
        f.state = 'kodiert';
        mdRender();
        note_.textContent = wo + ' — kodiere…';
        const blob = await encodeAudio(fmt, q, rate, x => schritt(0.9 + 0.1 * x), { pcm, rate: lastRate });
        haltIfCancelled();
        eintraege.push({ name: namen[i], data: new Uint8Array(await blob.arrayBuffer()) });
        f.bytes = blob.size;
        f.state = 'fertig';
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        f.state = 'fehler';
        f.error = e.message;
      }
      schritt(1);
      mdRender();
    }

    haltIfCancelled();
    const schlecht = mdFiles.filter(f => f.state === 'fehler').length;
    if (!eintraege.length) throw new Error('Keine der Dateien ließ sich sprechen.');
    note_.textContent = 'Packe…';
    const zip = makeZip(eintraege);
    const name = VORSATZ + '_Stapel_' + new Date().toISOString().slice(0, 10) + '.zip';
    const url = URL.createObjectURL(zip), a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    note_.textContent = 'Gespeichert: ' + name + ' mit ' + eintraege.length + ' Tondatei(en), ' +
      fmtBytes(zip.size) + ', fertig in ' + fmtTime((performance.now() - t0) / 1000) + '.' +
      (z.vorhanden ? ' ' + z.vorhanden + ' Satz/Sätze lagen schon auf dem Server, ' + z.neu + ' neu gesprochen.' : '') +
      (schlecht ? ' ' + schlecht + ' Datei(en) blieben außen vor — siehe Liste.' : '');
  } catch (e) {
    const abgebrochen = e.name === 'AbortError';
    note_.classList.toggle('err', !abgebrochen);
    note_.textContent = abgebrochen ? 'Abgebrochen.' : 'Fehler: ' + e.message;
  } finally {
    batchRunning = false;
    batchAbort = null;
    prog.hidden = true;
    mdRender();
    reparse();                                     // Aussprache-Regeln des Feldes wiederherstellen
    if (z.neu) srvHoleSaetze();
  }
}

/* ----- ZIP ----- */

const CRC32 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32[i] = c >>> 0;
}

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC32[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Ein ZIP, das nur ablegt und nicht packt: Tondateien sind schon komprimiert,
// und so braucht die Seite keinen zweiten Packer. Die Namen stehen in UTF-8,
// darum ist Kennbit 11 gesetzt.
function makeZip(entries) {
  const enc = new TextEncoder(), now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const body = [], dir = [];
  let at = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data), size = e.data.length;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 0, true);
    head.setUint16(10, time, true); head.setUint16(12, date, true);
    head.setUint32(14, crc, true); head.setUint32(18, size, true); head.setUint32(22, size, true);
    head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    body.push(new Uint8Array(head.buffer), name, e.data);

    const ref = new DataView(new ArrayBuffer(46));
    ref.setUint32(0, 0x02014b50, true);
    ref.setUint16(4, 20, true); ref.setUint16(6, 20, true);
    ref.setUint16(8, 0x0800, true); ref.setUint16(10, 0, true);
    ref.setUint16(12, time, true); ref.setUint16(14, date, true);
    ref.setUint32(16, crc, true); ref.setUint32(20, size, true); ref.setUint32(24, size, true);
    ref.setUint16(28, name.length, true);
    ref.setUint32(42, at, true);
    dir.push(new Uint8Array(ref.buffer), name);
    at += 30 + name.length + size;
  }
  const dirSize = dir.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true); end.setUint32(16, at, true);
  return new Blob([...body, ...dir, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ----- Verdrahtung ----- */

mdEl('go').onclick = mdRun;
mdEl('stop').onclick = () => { batchCancelled = true; if (batchAbort) batchAbort.abort(); };
mdEl('clear').onclick = () => { if (!batchRunning) { mdFiles = []; mdRender(); } };

{
  const box = $('sec-text');
  box.ondragover = e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('dragover'); } };
  box.ondragleave = e => { if (!box.contains(e.relatedTarget)) box.classList.remove('dragover'); };
  box.ondrop = e => {
    box.classList.remove('dragover');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    if (!batchRunning) mdAdd(e.dataTransfer.files);
  };

  // Bisher ging der Sprechertext nur durch Ziehen herein. Ein Knopf dafuer
  // gehoert an dieselbe Stelle wie bei Abschrift und Clips - und daneben der,
  // der ihn vom Server holt.
  $('text-add').onclick = () => $('text-file').click();
  $('text-file').onchange = () => { if (!batchRunning) mdAdd($('text-file').files); $('text-file').value = ''; };
  $('text-up').onclick = () => textAblegen(textDateiName(), textEl.value);
  $('text-srv').onclick = async () => {
    const [w] = await pickVom({
      titel: 'Sprechertext vom Server holen',
      hinweis: 'Die Markdown-Dateien, die auf dem Server liegen. Der Text im Feld wird dabei ersetzt.',
      arten: ['texts'],
      leer: 'Noch kein Sprechertext auf dem Server — eine Textdatei einlesen oder „Auf dem Server ablegen“ drücken.'
    });
    if (w) srvTextHolen(w.id, w.name);
  };
}
