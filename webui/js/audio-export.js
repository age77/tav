// TAV · Audio exportieren: WAV, FLAC, MP3 und Opus im Browser.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Audio exportieren ---------- */

// Die Stimme liefert 16 Bit Mono mit 24 kHz. Alles andere entsteht hier im
// Browser: WAV und FLAC selbst geschrieben, MP3 ueber lamejs (wird erst bei
// Bedarf geladen), Opus ueber WebCodecs in einem selbst gebauten Ogg-Container.
// So braucht der Server keinen Encoder.
const FORMATS = {
  wav:  { label: 'WAV — unkomprimiert', ext: 'wav', rates: true, def: '16',
          steps: [['16', '16 Bit — Standard'], ['24', '24 Bit'], ['32f', '32 Bit Gleitkomma']] },
  flac: { label: 'FLAC — verlustfrei gepackt', ext: 'flac', rates: true, def: '16',
          steps: [['16', '16 Bit — Standard'], ['24', '24 Bit']] },
  mp3:  { label: 'MP3 — überall abspielbar', ext: 'mp3', rates: true, def: '64',
          steps: [['32', '32 kbit/s — klein, hörbar gepresst'], ['48', '48 kbit/s'],
                  ['64', '64 kbit/s — gut für Sprache'], ['96', '96 kbit/s'],
                  ['128', '128 kbit/s — sehr gut'], ['160', '160 kbit/s — höchste Stufe']] },
  opus: { label: 'Opus — am kleinsten', ext: 'opus', rates: false, def: '32',
          steps: [['16', '16 kbit/s — sehr klein'], ['24', '24 kbit/s — gut für Sprache'],
                  ['32', '32 kbit/s — sehr gut'], ['48', '48 kbit/s'],
                  ['64', '64 kbit/s — kaum vom Original zu unterscheiden'], ['96', '96 kbit/s']] }
};
// Hoehere Raten als 24 kHz machen den Klang nicht besser, passen aber zu
// Schnittprogrammen, die 44,1 oder 48 kHz erwarten.
const RATES = [[16000, '16 kHz — kleiner, dumpfer'], [22050, '22,05 kHz'], [24000, '24 kHz — Original'],
               [44100, '44,1 kHz — CD'], [48000, '48 kHz — Video']];
const XSTORE = 'kokoro.export.v1';

let audio = null;        // {pcm: Int16Array, rate, silent: Sekunden Stille}
let exactSizes = new Map();
let exporting = false;

// Stille zaehlt nur ab 50 ms am Stueck; kurze Nulldurchgaenge im Sprechen nicht.
function setAudio(pcm, rate) {
  exactSizes = new Map();
  if (!pcm) { audio = null; updateEstimate(); tlNeu(); return; }
  const min = rate * 0.05;
  let silent = 0, run = 0;
  for (let i = 0; i < pcm.length; i++) {
    if (pcm[i] === 0) run++;
    else { if (run >= min) silent += run; run = 0; }
  }
  if (run >= min) silent += run;
  audio = { pcm, rate, silent: silent / rate };
  updateEstimate();
  tlNeu();                            // jetzt sind die Laengen gemessen, nicht geschaetzt
}

function exportChoice() {
  return { fmt: xFormat.value, q: xQuality.value, rate: FORMATS[xFormat.value].rates ? Number(xRate.value) : 48000 };
}

function fillQuality(pick) {
  const f = FORMATS[xFormat.value];
  xQuality.innerHTML = f.steps.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  xQuality.value = f.steps.some(s => s[0] === pick) ? pick : f.def;
  xRateWrap.hidden = !f.rates;
}

function saveChoice() {
  try { localStorage.setItem(XSTORE, JSON.stringify({ f: xFormat.value, q: xQuality.value, r: xRate.value })); }
  catch (e) { /* ohne Gedaechtnis */ }
}

function initExport() {
  xFormat.innerHTML = Object.entries(FORMATS).map(([k, f]) => '<option value="' + k + '">' + f.label + '</option>').join('');
  xRate.innerHTML = RATES.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(XSTORE) || '{}') || {}; } catch (e) { /* egal */ }
  xFormat.value = FORMATS[saved.f] ? saved.f : 'wav';
  xRate.value = RATES.some(r => String(r[0]) === saved.r) ? saved.r : '24000';
  fillQuality(saved.q);
  xFormat.onchange = () => { fillQuality(); saveChoice(); updateEstimate(); mdRender(); };
  xQuality.onchange = xRate.onchange = () => { saveChoice(); updateEstimate(); };
  xGo.onclick = () => exportAudio();
  // Derselbe Griff gleich unter dem Sprechertext: wer gesprochen hat, will den
  // Ton meist sofort haben - in dem Format, das im Reiter "Export" steht.
  $('x-dl').onclick = () => exportAudio(status);

  // Opus braucht WebCodecs, und das gibt es nur ueber HTTPS (oder localhost)
  // und nicht in Safari oder aelteren Firefox.
  opusSupported().then(ok => {
    if (ok) return;
    const o = xFormat.querySelector('option[value="opus"]');
    o.disabled = true; o.textContent += ' (nicht in diesem Browser)';
    if (xFormat.value === 'opus') { xFormat.value = 'mp3'; fillQuality(); updateEstimate(); }
  });
}

async function opusSupported() {
  try {
    return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined' &&
      (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000 })).supported;
  } catch (e) { return false; }
}

/* ----- Groesse schaetzen ----- */

// Gemessen an der Stimme Martin: bei Tempo 1 rund 17,8 Zeichen pro Sekunde.
// Das Tempo wirkt schwaecher als linear (1,25× ergibt nur 1,15× so schnell).
const CHARS_PER_SEC = 17.8, TEMPO_EXP = 0.62;

// Dauer und Stille: nach der Synthese gemessen, vorher aus dem Text geschaetzt.
function durations() {
  if (audio) return { total: audio.pcm.length / audio.rate, silent: audio.silent, measured: true };
  const { segs, gaps, lead, tail } = plan();
  if (!segs.length) return null;
  let chars = 0, sentenceGaps = 0;
  for (const s of segs) {
    chars += s.length;
    sentenceGaps += Math.max(0, (s.match(/[.!?](?=\s|$)/g) || []).length - 1);
  }
  const speech = chars / (CHARS_PER_SEC * Math.pow(Number(speed.value) || 1, TEMPO_EXP));
  const silent = lead + tail + gaps.reduce((a, b) => a + b, 0) + sentenceGaps * sentencePause();
  return { total: speech + silent, silent, measured: false };
}

// Liefert Bytes. WAV ist exakt, MP3 (konstante Bitrate) fast exakt; FLAC haengt
// vom Inhalt ab und ist an Aufnahmen dieser Stimme geeicht, Opus am Encoder von Chrome.
function estimateBytes(fmt, q, rate, total, silent) {
  const frames = Math.round(total * rate), speech = Math.max(0, total - silent);
  switch (fmt) {
    case 'wav':
      return 44 + frames * (q === '16' ? 2 : q === '24' ? 3 : 4) + (q === '24' ? frames & 1 : 0);
    case 'flac': {
      // Bits pro Sekunde Sprache; Stille kostet nur ein paar Bytes je Block.
      const perSample = flacBits(Number(q), rate);
      return 42 + speech * rate * perSample / 8 + Math.ceil(frames / 4096) * 16 + silent * rate / 4096 * 4;
    }
    case 'mp3': {
      const mpeg1 = rate >= 32000, spf = mpeg1 ? 1152 : 576;
      const frameBytes = (mpeg1 ? 144000 : 72000) * Number(q) / rate;
      return Math.ceil((frames + 1105 + spf) / spf) * frameBytes;
    }
    case 'opus':
      // Der Browser-Encoder haelt die Bitrate fast konstant, auch in Stille.
      // Dazu rund 77 Bytes Ogg-Seitenkopf je Sekunde.
      return 150 + total * (Number(q) * 125 * 0.97 + 77);
  }
  return 0;
}

// Eichwerte, gemessen mit dem Encoder dieser Seite an Sprachaufnahmen der Stimme:
// Bits je Abtastwert Sprache bei 16, 24 und 48 kHz, dazwischen interpoliert.
// Hochgerechnete Raten packen sich besser, weil der Verlauf glatter ist.
const FLAC_BITS = { 16: [9.4, 8.9, 7.15], 24: [20.7, 19.3, 15.7] };

function flacBits(bits, rate) {
  const t = FLAC_BITS[bits], x = Math.log2(rate / 24000);
  return x < 0 ? t[1] + (t[1] - t[0]) * x / 0.585 : t[1] + (t[2] - t[1]) * Math.min(x, 1);
}

// Ab einem Gigabyte in GB und TB - "645578 MB frei" liest niemand.
const fmtGross = (b, einheit) => b.toLocaleString('de-DE', { maximumFractionDigits: b >= 10 ? 0 : 1 }) + ' ' + einheit;
const fmtBytes = b => b >= 1099511627776 ? fmtGross(b / 1099511627776, 'TB')
                     : b >= 1073741824 ? fmtGross(b / 1073741824, 'GB')
                     : b >= 1048576 ? (b / 1048576).toFixed(b >= 10485760 ? 0 : 1).replace('.', ',') + ' MB'
                     : Math.max(1, Math.round(b / 1024)) + ' KB';
const fmtTime = s => s >= 60 ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') + ' min'
                    : s.toFixed(1).replace('.', ',') + ' s';

function updateEstimate() {
  scheduleVideoPlan();
  if (!xFormat.value) return;                      // noch nicht eingerichtet
  const d = durations();
  xGo.disabled = !audio || exporting;
  $('x-dl').disabled = !audio || exporting;
  if (!d) { updateAudioHead(); xSize.textContent = ''; xNote.textContent = 'Noch kein sprechbarer Text.'; return; }
  updateAudioHead();
  const { fmt, q, rate } = exportChoice();
  const exact = exactSizes.get(fmt + '|' + q + '|' + rate);
  const bytes = exact || estimateBytes(fmt, q, rate, d.total, d.silent);
  const sure = exact || (fmt === 'wav' && d.measured);
  xSize.innerHTML = (sure ? '' : 'ca. ') + '<b>' + fmtBytes(bytes) + '</b> für ' + (d.measured ? '' : 'rund ') + fmtTime(d.total);
  if (exporting) return;
  xNote.textContent = !audio
    ? 'Schätzung aus der Textlänge — nach „Audio erzeugen“ wird sie genauer.'
    : exact ? 'Größe der zuletzt gespeicherten Datei.'
    : fmt === 'wav' ? 'Genaue Größe.'
    : fmt === 'mp3' ? 'Konstante Bitrate — die Größe stimmt fast genau.'
    : 'Hängt vom Inhalt und vom Browser ab; die echte Größe steht nach dem Speichern hier.';
}

// Steht in der Kopfzeile der Karte, damit die Wahl auch zugeklappt sichtbar ist.
function updateAudioHead() {
  const f = FORMATS[xFormat.value];
  if (!f) return;
  $('x-dl').textContent = 'Ton speichern (' + f.ext.toUpperCase() + ')';
  const step = f.steps.find(x => x[0] === xQuality.value);
  xHead.textContent = f.ext.toUpperCase() + (step ? ' · ' + step[1].split(' — ')[0] : '');
}

/* ----- Kodieren ----- */

const tick = () => new Promise(r => setTimeout(r, 0));

// Abtastwerte als Gleitkomma in der Zielrate. Umgerechnet wird mit dem
// Resampler des Browsers.
async function floatsAt(rate, src = audio) {
  const { pcm } = src, f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  if (rate === src.rate) return f;
  const ctx = new OfflineAudioContext(1, Math.ceil(pcm.length * rate / src.rate), rate);
  const buf = ctx.createBuffer(1, pcm.length, src.rate);
  buf.copyToChannel(f, 0);
  const node = ctx.createBufferSource();
  node.buffer = buf; node.connect(ctx.destination); node.start();
  return (await ctx.startRendering()).getChannelData(0);
}

// Ganzzahlen mit der gewuenschten Bittiefe. In der Originalrate ohne Umweg
// ueber Gleitkomma, damit 16 Bit bitgenau bleibt.
async function intsAt(rate, bits, src = audio) {
  const out = new Int32Array(Math.ceil(src.pcm.length * rate / src.rate));
  if (rate === src.rate) {
    const shift = bits - 16;
    for (let i = 0; i < out.length; i++) out[i] = src.pcm[i] << shift;
    return out;
  }
  const f = await floatsAt(rate, src), scale = 2 ** (bits - 1), top = scale - 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-scale, Math.min(top, Math.round((f[i] || 0) * scale)));
  return out;
}

async function encodeAudio(fmt, q, rate, progress, src = audio) {
  if (fmt === 'wav') {
    if (q === '32f') {
      const f = await floatsAt(rate, src), buf = new ArrayBuffer(44 + f.length * 4);
      wavHeader(new DataView(buf), f.length, rate, 32, true);
      new Float32Array(buf, 44).set(f);                // WAV ist little endian wie alle ueblichen Rechner
      return new Blob([buf], { type: 'audio/wav' });
    }
    const bits = Number(q), x = await intsAt(rate, bits, src), bytes = bits / 8;
    // RIFF verlangt Bloecke gerader Laenge; 24 Bit kann ungerade enden.
    const pad = (x.length * bytes) & 1;
    const buf = new ArrayBuffer(44 + x.length * bytes + pad), dv = new DataView(buf);
    wavHeader(dv, x.length, rate, bits, false);
    dv.setUint32(4, dv.getUint32(4, true) + pad, true);
    if (bits === 16) for (let i = 0; i < x.length; i++) dv.setInt16(44 + i * 2, x[i], true);
    else for (let i = 0, o = 44; i < x.length; i++, o += 3) {
      const v = x[i];
      dv.setUint8(o, v & 255); dv.setUint8(o + 1, (v >> 8) & 255); dv.setUint8(o + 2, (v >> 16) & 255);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }
  if (fmt === 'flac') return encodeFlac(await intsAt(rate, Number(q), src), rate, Number(q), progress);
  if (fmt === 'mp3') return encodeMp3(await intsAt(rate, 16, src), rate, Number(q), progress);
  return encodeOpus(await floatsAt(48000, src), Number(q), src.rate, progress);
}

// "anzeige" ist die Zeile, unter der gefragt wurde - der Knopf unter dem
// Sprechertext meldet sich dort, nicht nur im Reiter "Export".
async function exportAudio(anzeige = xNote) {
  if (!audio || exporting) return;
  const { fmt, q, rate } = exportChoice(), f = FORMATS[fmt];
  const sag = t => { xNote.textContent = t; if (anzeige !== xNote) anzeige.textContent = t; };
  exporting = true; updateEstimate();
  const t0 = performance.now();
  try {
    sag('Kodiere…');
    const blob = await encodeAudio(fmt, q, rate, p => sag('Kodiere… ' + Math.round(p * 100) + ' %'));
    const name = projektDatei(f.ext);
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    exactSizes.set(fmt + '|' + q + '|' + rate, blob.size);
    exporting = false; updateEstimate();
    sag('Gespeichert: ' + name + ', ' + fmtBytes(blob.size) + ', kodiert in ' +
        ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',') + ' s.');
  } catch (e) {
    exporting = false; updateEstimate();
    sag('Fehler: ' + e.message);
  }
}

/* ----- FLAC ----- */

class BitWriter {
  constructor(bytes) { this.buf = new Uint8Array(Math.max(1024, bytes)); this.pos = 0; this.acc = 0; this.n = 0; }
  byte(b) {
    if (this.pos === this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
    this.buf[this.pos++] = b;
  }
  // v >= 0 und kleiner als 2^n, n bis 53
  put(v, n) {
    while (n > 24) { n -= 24; this.put(Math.floor(v / 2 ** n) % 16777216, 24); v %= 2 ** n; }
    this.acc = (this.acc << n) | v; this.n += n;
    while (this.n >= 8) { this.n -= 8; this.byte((this.acc >>> this.n) & 255); }
    this.acc &= (1 << this.n) - 1;
  }
  signed(v, n) { this.put(v < 0 ? v + 2 ** n : v, n); }
  align() { if (this.n) this.put(0, 8 - this.n); }
}

const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i, d = i << 8;
  for (let k = 0; k < 8; k++) {
    c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  }
  CRC8[i] = c; CRC16[i] = d;
}

const FLAC_BLOCK = 4096;

// Kodiert nach dem FLAC-Format mit festen Praediktoren (Ordnung 0 bis 4) und
// Rice-Partitionen. Das reicht fuer Sprache nahe an "flac -5" heran; Stille
// wird zu einem einzigen konstanten Wert je Block.
async function encodeFlac(x, rate, bits, progress) {
  const w = new BitWriter(x.length * bits / 16);
  w.put(0x664c6143, 32);                                  // "fLaC"
  w.put(0x80, 8); w.put(34, 24);                          // letzter Metadatenblock: STREAMINFO
  w.put(FLAC_BLOCK, 16); w.put(FLAC_BLOCK, 16); w.put(0, 24); w.put(0, 24);
  w.put(rate, 20); w.put(0, 3); w.put(bits - 1, 5); w.put(x.length, 36);
  for (let i = 0; i < 4; i++) w.put(0, 32);               // MD5 nicht berechnet (erlaubt)

  const res = new Int32Array(FLAC_BLOCK);
  for (let at = 0, frame = 0; at < x.length; at += FLAC_BLOCK, frame++) {
    const blk = x.subarray(at, Math.min(at + FLAC_BLOCK, x.length)), start = w.pos;
    w.put(0xfff8, 16);                                    // Sync, feste Blockgroesse
    w.put(0x70, 8);                                       // Groesse folgt als 16 Bit, Rate aus STREAMINFO
    w.put(0, 8);                                          // Mono, Bittiefe aus STREAMINFO
    putUtf8(w, frame);
    w.put(blk.length - 1, 16);
    w.put(crc8(w.buf, start, w.pos), 8);
    flacSubframe(w, blk, bits, res);
    w.align();
    w.put(crc16(w.buf, start, w.pos), 16);
    if (frame % 128 === 127) { progress(at / x.length); await tick(); }
  }
  return new Blob([w.buf.subarray(0, w.pos)], { type: 'audio/flac' });
}

function crc8(b, from, to) { let c = 0; for (let i = from; i < to; i++) c = CRC8[c ^ b[i]]; return c; }
function crc16(b, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
  return c;
}

function putUtf8(w, v) {
  if (v < 0x80) return w.put(v, 8);
  const n = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
  w.put(((0xff00 >> n) & 0xff) | (v >>> (6 * (n - 1))), 8);
  for (let i = n - 2; i >= 0; i--) w.put(0x80 | ((v >>> (6 * i)) & 0x3f), 8);
}

function fixedResidual(x, order, res) {
  const n = x.length;
  switch (order) {
    case 0: for (let i = 0; i < n; i++) res[i] = x[i]; break;
    case 1: for (let i = 1; i < n; i++) res[i] = x[i] - x[i - 1]; break;
    case 2: for (let i = 2; i < n; i++) res[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
    case 3: for (let i = 3; i < n; i++) res[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
    case 4: for (let i = 4; i < n; i++) res[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break;
  }
}

// Beste Aufteilung in 2^p Partitionen mit je eigenem Rice-Parameter. Die
// Kosten sind geschaetzt (Summe/2^k statt Summe der Quotienten), das genuegt
// fuer die Wahl.
function ricePlan(res, order, n) {
  let maxP = 0;
  while (maxP < 6 && n % (2 << maxP) === 0 && (n >> (maxP + 1)) > order) maxP++;
  let sums = new Float64Array(1 << maxP);
  const len = n >> maxP;
  for (let j = 0; j < sums.length; j++) {
    let s = 0;
    for (let i = j ? j * len : order, end = (j + 1) * len; i < end; i++) { const r = res[i]; s += r < 0 ? -2 * r - 1 : 2 * r; }
    sums[j] = s;
  }
  let best = null;
  for (let p = maxP; p >= 0; p--) {
    const ks = new Uint8Array(1 << p);
    let cost = 6;
    for (let j = 0; j < ks.length; j++) {
      const m = (n >> p) - (j ? 0 : order), s = sums[j];
      let bk = 0, bc = Infinity;
      for (let k = 0; k <= 14; k++) {
        const c = m * (k + 1) + Math.floor(s / 2 ** k);
        if (c < bc) { bc = c; bk = k; }
      }
      ks[j] = bk; cost += 4 + bc;
    }
    if (!best || cost < best.cost) best = { cost, p, ks };
    if (p) {
      const up = new Float64Array(sums.length / 2);
      for (let j = 0; j < up.length; j++) up[j] = sums[2 * j] + sums[2 * j + 1];
      sums = up;
    }
  }
  return best;
}

function flacSubframe(w, x, bits, res) {
  const n = x.length;
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) { w.put(0, 8); w.signed(x[0], bits); return; }

  let best = { cost: n * bits, order: -1 };               // VERBATIM als Rueckfall
  for (let order = 0; order <= 4 && order < n; order++) {
    fixedResidual(x, order, res);
    const plan = ricePlan(res, order, n);
    if (order * bits + plan.cost < best.cost) best = { cost: order * bits + plan.cost, order, plan };
  }
  if (best.order < 0) {
    w.put(0x02, 8);                                       // VERBATIM
    for (let i = 0; i < n; i++) w.signed(x[i], bits);
    return;
  }
  const { order, plan: { p, ks } } = best;
  w.put((8 | order) << 1, 8);                             // FIXED der Ordnung
  for (let i = 0; i < order; i++) w.signed(x[i], bits);
  fixedResidual(x, order, res);
  w.put(p, 6);                                            // Rice mit 4-Bit-Parameter, Partitionsordnung
  const len = n >> p;
  for (let j = 0; j < ks.length; j++) {
    const k = ks[j], mask = (1 << k) - 1;
    w.put(k, 4);
    for (let i = j ? j * len : order, end = (j + 1) * len; i < end; i++) {
      const r = res[i], u = r < 0 ? -2 * r - 1 : 2 * r, q = Math.floor(u / 2 ** k);
      if (q + 1 + k <= 24) w.put((1 << k) | (u & mask), q + 1 + k);
      else {
        for (let z = q; z > 0; z -= Math.min(z, 24)) w.put(0, Math.min(z, 24));
        w.put(1, 1);
        if (k) w.put(u & mask, k);
      }
    }
  }
}

/* ----- MP3 ----- */

let lamePromise = null;
function loadLame() {
  if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve();
  return lamePromise ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    s.integrity = 'sha384-xuasJXVcyv3hZq0eYpelEkBC8l4yufatZXDsKuyCU2rqfhDCb+ftuE/mSfZAteiK';
    s.crossOrigin = 'anonymous';
    s.onload = ok;
    s.onerror = () => { lamePromise = null; s.remove();
      fail(new Error('MP3-Encoder konnte nicht von cdn.jsdelivr.net geladen werden.')); };
    document.head.append(s);
  });
}

async function encodeMp3(x, rate, kbps, progress) {
  await loadLame();
  const enc = new lamejs.Mp3Encoder(1, rate, kbps), out = [], STEP = 1152 * 64;
  const pcm = new Int16Array(x.length);
  pcm.set(x);
  for (let at = 0; at < pcm.length; at += STEP) {
    out.push(enc.encodeBuffer(pcm.subarray(at, at + STEP)));
    progress(at / pcm.length);
    await tick();
  }
  out.push(enc.flush());
  return new Blob(out, { type: 'audio/mpeg' });
}

/* ----- Opus in Ogg ----- */

const OGG_CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  OGG_CRC[i] = r >>> 0;
}

function oggPage(packets, granule, serial, seq, flags) {
  const lace = [];
  for (const p of packets) { let l = p.length; for (; l >= 255; l -= 255) lace.push(255); lace.push(l); }
  const size = 27 + lace.length + packets.reduce((a, p) => a + p.length, 0);
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  b.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);              // "OggS", Version, Flags
  dv.setUint32(6, granule % 2 ** 32, true); dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
  dv.setUint32(14, serial, true); dv.setUint32(18, seq, true);
  b[26] = lace.length; b.set(lace, 27);
  let at = 27 + lace.length;
  for (const p of packets) { b.set(p, at); at += p.length; }
  let crc = 0;
  for (let i = 0; i < size; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ b[i]) & 0xff]) >>> 0;
  dv.setUint32(22, crc, true);
  return b;
}

async function encodeOpus(f, kbps, inputRate, progress) {
  if (typeof AudioEncoder === 'undefined')
    throw new Error('Dieser Browser kann hier kein Opus kodieren. Nötig sind Chrome, Edge oder Firefox ab ' +
                    'Version 130 und eine Verbindung über HTTPS.');
  const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: kbps * 1000 };
  if (!(await AudioEncoder.isConfigSupported(config)).supported)
    throw new Error('Opus mit ' + kbps + ' kbit/s wird von diesem Browser nicht unterstützt.');

  const packets = [];
  let head = null, failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push({ b, frames: Math.round((chunk.duration || 20000) * 48 / 1000) });
      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (d && !head) head = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
    },
    error: e => { failure = e; }
  });
  enc.configure(config);

  // 100 ms Stille hinten dran, damit der Encoder auch die letzten Werte
  // ausgibt; abgeschnitten wird ueber die Granulposition der letzten Seite.
  const input = new Float32Array(f.length + 4800), STEP = 48000;
  input.set(f);
  for (let at = 0; at < input.length && !failure; at += STEP) {
    const part = input.slice(at, at + STEP);
    const data = new AudioData({ format: 'f32', sampleRate: 48000, numberOfChannels: 1,
                                 numberOfFrames: part.length, timestamp: Math.round(at * 1e6 / 48000), data: part });
    enc.encode(data);
    data.close();
    while (enc.encodeQueueSize > 2) await tick();
    progress(at / input.length);
  }
  if (!failure) await enc.flush();
  enc.close();
  if (failure) throw failure;

  // Vorlauf des Encoders; steht in der Kopfzeile, die der Browser mitliefert.
  const isHead = head && head.length >= 19 && String.fromCharCode(...head.subarray(0, 8)) === 'OpusHead';
  const preSkip = isHead ? head[10] | (head[11] << 8) : 312;

  const opusHead = new Uint8Array(19), hv = new DataView(opusHead.buffer);
  opusHead.set([...'OpusHead'].map(c => c.charCodeAt(0)));
  opusHead[8] = 1; opusHead[9] = 1;                       // Version, Mono
  hv.setUint16(10, preSkip, true); hv.setUint32(12, inputRate, true);
  const vendor = new TextEncoder().encode('Kokoro TTS Weboberflaeche');
  const tags = new Uint8Array(16 + vendor.length), tv = new DataView(tags.buffer);
  tags.set([...'OpusTags'].map(c => c.charCodeAt(0)));
  tv.setUint32(8, vendor.length, true); tags.set(vendor, 12);

  const serial = (Math.random() * 2 ** 32) >>> 0, pages = [];
  let seq = 0;
  pages.push(oggPage([opusHead], 0, serial, seq++, 2));
  pages.push(oggPage([tags], 0, serial, seq++, 0));
  // Die Granulposition zaehlt dekodierte Werte samt Vorlauf. Die letzte Seite
  // endet genau hinter dem Original, das schneidet die angehaengte Stille ab.
  const end = preSkip + f.length;
  let granule = 0, page = [], segs = 0;
  for (let i = 0; i < packets.length; i++) {
    const pk = packets[i], need = Math.floor(pk.b.length / 255) + 1;
    if (page.length && (segs + need > 255 || page.length >= 50)) {
      pages.push(oggPage(page, Math.min(granule, end), serial, seq++, 0));
      page = []; segs = 0;
    }
    page.push(pk.b); segs += need; granule += pk.frames;
  }
  pages.push(oggPage(page, Math.min(granule, end), serial, seq++, 4));
  return new Blob(pages, { type: 'audio/ogg; codecs=opus' });
}
