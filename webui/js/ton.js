// TAV · Tonspur: WAV, Zwischenspeicher, Zusammensetzen, Synthese.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- WAV ---------- */

function parseWav(buf) {
  const dv = new DataView(buf);
  const tag = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Antwort ist keine WAV-Datei');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= dv.byteLength) {
    const id = tag(off), size = dv.getUint32(off + 4, true), body = off + 8;
    if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true),
                               rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    else if (id === 'data') data = { off: body, size: Math.min(size, dv.byteLength - body) };
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV ohne fmt- oder data-Chunk');
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1)
    throw new Error('Erwartet wird 16-Bit-PCM in Mono, geliefert wurde ' +
                    fmt.bits + " Bit, " + fmt.channels + ' Kanal/Kanäle');
  return { rate: fmt.rate, pcm: new Int16Array(buf.slice(data.off, data.off + (data.size & ~1))) };
}

// Kopf einer Mono-WAV-Datei. Gleitkomma steht als Format 3 im selben
// 44-Byte-Kopf; das lesen alle gaengigen Programme.
function wavHeader(dv, frames, rate, bits, float) {
  const bytes = bits / 8, size = frames * bytes;
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');  dv.setUint32(4, 36 + size, true);  str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, float ? 3 : 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * bytes, true);
  dv.setUint16(32, bytes, true); dv.setUint16(34, bits, true);
  str(36, 'data'); dv.setUint32(40, size, true);
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  wavHeader(new DataView(buf), samples.length, rate, 16, false);
  new Int16Array(buf, 44).set(samples);
  return new Blob([buf], { type: 'audio/wav' });
}

/* ---------- Zwischenspeicher ---------- */

// Fertig synthetisierte Abschnitte, damit geaenderte Pausen nur neu
// zusammengesetzt und nicht neu gesprochen werden muessen. Tempo und
// Satzpause gehen in den Schluessel ein, weil sie den Klang veraendern.
const cache = new Map();
let cacheSamples = 0, lastRate = 24000, built = false;

const cacheKey = text => Number(speed.value) + '|' + sentencePause() + '|' + text;

function cachePut(key, pcm) {
  if (cacheSamples > 60e6) { cache.clear(); cacheSamples = 0; }   // rund 40 Minuten Audio
  cache.set(key, pcm);
  cacheSamples += pcm.length;
}

/* ---------- Zusammensetzen ---------- */

// Baut die Datei aus dem Zwischenspeicher. Gibt null zurueck, wenn ein
// Abschnitt fehlt, dann muss erst gesprochen werden.
// Setzt Abschnitte und Pausen zu einer Tonspur zusammen. Woher die Abschnitte
// kommen, steht in "von": beim Text im Feld der Zwischenspeicher, beim Stapel
// die fuer diese Datei festgehaltenen Stuecke. Fehlt einer, kommt null.
function assemble({ segs, gaps, lead, tail }, rate, von) {
  if (!segs.length) return null;
  const pieces = [];
  if (lead > 0) pieces.push(new Int16Array(Math.round(rate * lead)));
  for (let i = 0; i < segs.length; i++) {
    const pcm = von.get(cacheKey(segs[i]));
    if (!pcm) return null;
    pieces.push(pcm);
    if (i < gaps.length && gaps[i] > 0) pieces.push(new Int16Array(Math.round(rate * gaps[i])));
  }
  if (tail > 0) pieces.push(new Int16Array(Math.round(rate * tail)));
  const all = new Int16Array(pieces.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of pieces) { all.set(c, at); at += c.length; }
  return all;
}

function stitch(resume) {
  const all = assemble(plan(), lastRate, cache);
  if (!all) return null;
  const total = all.length;
  const blob = encodeWav(all, lastRate);
  if (player.src) URL.revokeObjectURL(player.src);
  const url = URL.createObjectURL(blob);
  if (resume) {
    player.onloadedmetadata = () => {
      player.onloadedmetadata = null;
      player.currentTime = Math.min(resume.time, player.duration || 0);
      if (resume.playing) player.play().catch(() => {});
    };
  }
  player.src = url; player.hidden = false;
  built = true;
  setAudio(all, lastRate);
  return { seconds: total / lastRate, kb: blob.size / 1024 };
}

// Nach geaenderten Pausen reicht neu zusammensetzen, sofern schon
// gesprochen wurde. Position und Wiedergabe bleiben erhalten.
let refreshTimer = null;
function scheduleRefresh() {
  if (!built || controller || batchRunning) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const resume = { time: player.currentTime, playing: !player.paused };
    const r = stitch(resume);
    status.textContent = r
      ? 'Pausen neu gesetzt: ' + r.seconds.toFixed(1) + ' s, ohne neue Synthese.'
      : 'Tempo oder Satzpause geändert — bitte „Audio erzeugen“. Für eine andere Satzpause '
        + 'wird nichts neu gesprochen, die Sätze liegen schon auf dem Server.';
  }, 400);
}

/* ---------- Synthese ---------- */

// Was im Fehlerfall zurueckkommt, ist mal JSON vom Dienst, mal die HTML-Seite
// eines Zwischenstuecks. Roh ins Feld geschrieben steht dort dann Quelltext;
// hier wird daraus ein Satz.
async function fehlerText(res) {
  // Ein Abschnitt wird erst beantwortet, wenn er fertig gesprochen ist. Dauert
  // das dem Torwaechter oder nginx zu lange, schneiden sie mitten hinein - und
  // das heisst hier nichts weiter, als dass der Rechner ausgelastet ist.
  if (res.status === 502 || res.status === 503 || res.status === 504)
    return 'Der Sprachdienst hat zu lange gebraucht (HTTP ' + res.status + ') — der Rechner ist ' +
           'gerade ausgelastet. Noch einmal versuchen; schon gesprochene Abschnitte bleiben erhalten.';
  const roh = (await res.text()).trim();
  try {
    const d = JSON.parse(roh).detail;
    if (typeof d === 'string') return d;
  } catch (e) { /* kein JSON */ }
  const klar = roh.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return 'HTTP ' + res.status + (klar ? ' — ' + klar.slice(0, 160) : '');
}

// Spricht einen einzelnen Abschnitt. Der Aufrufer legt ihn in den
// Zwischenspeicher, denn nur er weiss, ob er ihn dort behalten will.
// Der Sprachdienst hat einen eigenen, der das Neuladen der Seite uebersteht:
// "cache" legt jeden Satz dort ab, und gesprochen wird nur, was fehlt. Wie
// viele Saetze neu waren und wie viele schon dalagen, zaehlt "zaehler" mit.
async function speakSegment(text, signal, zaehler) {
  const pause = sentencePause();
  const res = await fetch('/v1/audio/speech', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kokoro', voice: 'martin', input: text,
                           speed: Number(speed.value), pause_duration: pause, cache: true })
  });
  if (!res.ok) throw new Error(await fehlerText(res));
  if (zaehler) {
    zaehler.neu += Number(res.headers.get('X-Saetze-Neu')) || 0;
    zaehler.vorhanden += Number(res.headers.get('X-Saetze-Vorhanden')) || 0;
  }
  const { rate, pcm } = parseWav(await res.arrayBuffer());
  lastRate = rate;
  // Der Server haengt hinter den letzten Satz noch einmal die Satzpause an.
  // Die wird abgeschnitten, damit hier nur die eingestellten Pausen stehen.
  const trim = Math.min(Math.floor(rate * pause), pcm.length);
  return pcm.subarray(0, pcm.length - trim);
}

// Woher der Ton kam: aus dem Zwischenspeicher der Seite, vom Server oder
// frisch von der Stimme. Ein Sprachdienst, der nichts dazu sagt, hat eben
// alles gesprochen.
function herkunft(abschnitte, z, sekunden) {
  if (!abschnitte) return 'komplett aus dem Zwischenspeicher der Seite';
  const zeit = ' in ' + sekunden.toFixed(1) + ' s';
  if (!z.vorhanden) return abschnitte + ' Abschnitt(e) gesprochen' + zeit;
  if (!z.neu) return abschnitte + ' Abschnitt(e) vom Server geholt' + zeit + ', nichts neu gesprochen';
  return abschnitte + ' Abschnitt(e)' + zeit + ': ' + z.neu + ' Satz/Sätze neu gesprochen, ' +
         z.vorhanden + ' lagen schon auf dem Server';
}

// Der Abschnitt, an dem die Stimme gerade arbeitet - als Schluessel des
// Zwischenspeichers. Die Zeitleiste faerbt ihn damit ein.
let spricht = null;

// Ein geladenes Projekt bringt seinen Ton mit, ohne dass erst unter dem
// Sprechertext "Audio erzeugen" gedrueckt werden muss: was der Sprachdienst
// schon gesprochen hat, kommt aus seinem Speicher, gesprochen wird nur der
// Rest - mit Fortschritt unter dem Sprechertext und oben links im Bild.
// Laeuft noch der Ton des vorigen Textes, wird er abgebrochen; der Text ist
// weg, und danach ist der neue dran.
let tonNachLaden = false;
function projektTon() {
  if (batchRunning) return;             // der Stapel hat die Stimme; danach per Knopf
  if (controller) { tonNachLaden = true; controller.abort(); return; }
  player.pause();                       // der Ton des vorigen Textes spielte sonst weiter
  speak({ leise: true });
}

// "leise" kommt aus dem Schnittfenster: dort wird nach jeder Textaenderung
// nachgesprochen. Dabei darf die Wiedergabe weder von vorn beginnen noch die
// Stelle verlieren, an der gerade geschnitten wird.
async function speak(opts = {}) {
  const leise = !!opts.leise;
  const melde = t => { status.textContent = t; if (leise) tlSag(t); };
  reparseJetzt();                       // gesprochen wird, was jetzt im Feld steht
  const { segs } = plan();
  if (!segs.length) { melde('Kein sprechbarer Text.'); return; }

  controller = new AbortController();
  go.disabled = true; stopBtn.hidden = false;
  const missing = segs.filter(s => !cache.has(cacheKey(s))).length;
  prog.hidden = missing === 0; prog.max = Math.max(1, missing); prog.value = 0;
  const t0 = performance.now();
  const weiter = leise ? { time: player.currentTime, playing: !player.paused } : null;
  const z = { neu: 0, vorhanden: 0 };
  let nochmal = false;

  try {
    let done = 0;
    for (const seg of segs) {
      const key = cacheKey(seg);
      if (cache.has(key)) continue;
      melde('Abschnitt ' + (done + 1) + ' von ' + missing + '…');
      tlLaedt('ton', 'Ton: Abschnitt ' + (done + 1) + ' von ' + missing + ' …', done / missing);
      spricht = key;
      tlNeu();                          // der Abschnitt faerbt sich ein
      cachePut(key, await speakSegment(seg, controller.signal, z));
      spricht = null;
      prog.value = ++done;
      tlNeu();                          // und ist jetzt gemessen statt geschaetzt
    }

    // Jetzt ist gemessen, wie lange Martin braucht. Folgen die Pausen einem
    // Film, werden sie danach gesetzt, bevor die Tonspur entsteht.
    const nachgerechnet = anker ? ankerSetzen() : null;
    const r = stitch(weiter);
    // Waehrend gesprochen wurde, hat sich der Text geaendert: die neuen
    // Abschnitte fehlen noch. Gleich danach werden sie gesprochen.
    if (!r && plan().segs.some(s => !cache.has(cacheKey(s)))) {
      nochmal = true;
      melde('Der Text hat sich beim Sprechen geändert — der Rest wird gleich nachgesprochen …');
      return;
    }
    if (!r) throw new Error('Abschnitte fehlen im Zwischenspeicher');
    // Abgespielt wird erst auf Knopfdruck - im Player hier oder im Schnittfenster.
    melde(r.seconds.toFixed(1) + ' s Audio, ' + r.kb.toFixed(0) + ' KB, ' +
          herkunft(missing, z, (performance.now() - t0) / 1000) +
          (nachgerechnet ? ' · ' + nachgerechnet + ' Pause(n) nach dem Film gesetzt' : ''));
  } catch (e) {
    if (e.name === 'AbortError') tlNachspielen = false;     // abgebrochen ist abgebrochen
    melde(e.name === 'AbortError' ? 'Abgebrochen.' : 'Fehler: ' + e.message);
  } finally {
    spricht = null;
    controller = null;
    go.disabled = false; stopBtn.hidden = true; prog.hidden = true;
    tlLaedt('ton', '');
    tlNeu();
    if (z.neu) srvHoleSaetze();         // der Speicher des Sprachdienstes ist gewachsen
    // Waehrend des Sprechens ein anderes Projekt geladen: dessen Ton ist dran.
    // Sonst, waehrend der Synthese weitergetippt: gleich noch einmal, sonst
    // bliebe der letzte Stand ungesprochen.
    if (tonNachLaden) { tonNachLaden = false; setTimeout(projektTon, 0); }
    else if (nochmal) setTimeout(() => speak(opts), 0);
    else if (tlNachspielen) { tlNachspielen = false; setTimeout(tlSprich, 0); }
  }
}
