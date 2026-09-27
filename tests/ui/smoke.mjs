// Rauchtest fuer die Seite: spielt die wichtigsten Wege einmal im Browser
// durch - Text sprechen, Ton speichern, Aussprache, Projekt, Clips, Schnitt,
// Video, Zusammenfuegen, Abschrift, Stapel, Zuruecksetzen. Gedacht fuer den
// Teststapel aus tests/ui/run.sh, nie fuer die laufenden Dienste: der Test
// legt Projekte, Clips und Videos an und loescht nichts davon.
//
// Jede Gruppe laeuft in einem frischen Browserprofil. Ein Fehler in der Seite
// (pageerror) laesst den Schritt scheitern, in dem er auftritt.
//
//   TAV_URL=http://127.0.0.1:18884/ node smoke.mjs [gruppe ...]

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.TAV_URL || 'http://127.0.0.1:18884/';
const MEDIA = process.env.TAV_MEDIA || path.resolve('.media');
const RAUS = process.env.TAV_RAUS || path.resolve('.raus');
const NUR = new Set(process.argv.slice(2));
fs.mkdirSync(RAUS, { recursive: true });

const browser = await chromium.launch();
const fehler = [];
let gruppe = '';

function log(zeichen, text) { console.log(zeichen + ' ' + (gruppe ? gruppe + ' · ' : '') + text); }

// Ein Schritt: laeuft, misst und meldet. Scheitert er, geht es mit der
// naechsten Gruppe weiter - die Schritte einer Gruppe bauen aufeinander auf.
async function schritt(p, name, fn) {
  const t0 = Date.now();
  // Fehler der Seite sammeln sich seit dem Laden: einer, der schon beim Laden
  // auftrat, laesst den ersten Schritt scheitern.
  try {
    await fn();
    if (p.__fehler.length) throw new Error('Fehler in der Seite: ' + p.__fehler.join(' | '));
    log('ok  ', name + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  } catch (e) {
    p.__fehler = [];
    fehler.push(gruppe + ' · ' + name + ': ' + e.message.split('\n')[0]);
    log('FAIL', name + ': ' + e.message.split('\n')[0]);
    await p.screenshot({ path: path.join(RAUS, 'fehler-' + gruppe + '-' + name.replace(/\W+/g, '_') + '.png'),
                         fullPage: true }).catch(() => {});
    throw e;
  }
}

async function neueSeite() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.__fehler = [];
  p.on('pageerror', e => p.__fehler.push(e.message));
  p.on('dialog', d => d.accept());
  await p.goto(BASE);
  await p.waitForFunction(() => document.getElementById('text').value.length > 0 ||
                                document.readyState === 'complete');
  await p.waitForTimeout(800);
  return p;
}

// Bringt ein Element in Sicht, gleich wo es in der Seite steckt: der Bereich
// darum wird geoeffnet, so wie es die Sprungleiste tut.
async function zeige(p, id) {
  await p.evaluate(id => {
    const el = document.getElementById(id);
    const bereich = el && el.closest('details.card');
    if (bereich) openCard(bereich.id);
    el.scrollIntoView({ block: 'center' });
  }, id);
  await p.waitForTimeout(150);
}

async function neuLaden(p) {
  await p.reload();
  await p.waitForFunction(() => typeof arbeitBereit !== 'undefined' && arbeitBereit, null, { timeout: 30000 });
}

async function standIst(p, text) {
  await p.waitForFunction(t => document.getElementById('projekt-stand').textContent === t, text, { timeout: 10000 });
}

async function download(p, klick, name) {
  const [d] = await Promise.all([p.waitForEvent('download', { timeout: 120000 }), klick()]);
  const ziel = path.join(RAUS, name || d.suggestedFilename());
  await d.saveAs(ziel);
  return { name: d.suggestedFilename(), ziel, groesse: fs.statSync(ziel).size };
}

async function audioErzeugen(p) {
  await zeige(p, 'go');
  await p.click('#go');
  // Fertig ist es, wenn nichts mehr gesprochen wird und die Tonspur steht. Die
  // Meldung darunter kann schon wieder eine andere sein - etwa "Pausen neu gesetzt".
  await p.waitForFunction(() => !controller && built && !document.getElementById('player').hidden,
                          null, { timeout: 120000 });
  const st = await p.textContent('#status');
  if (/Fehler/.test(st)) throw new Error(st);
}

// Text ins Feld und warten, bis die Seite ihn zerlegt hat - die Vorschau folgt
// dem Tippen erst nach einer kurzen Ruhe.
async function schreibe(p, text) {
  await zeige(p, 'text');
  await p.fill('#text', text);
  await p.waitForFunction(() =>
    plan().segs.join('|') === plan(parse(document.getElementById('text').value)).segs.join('|'), null, { timeout: 5000 });
}

const TEXT = '# Testfilm\n\nDie Heizung läuft seit drei Stunden.\n\nDanach schaltet sie ab. Der Bericht folgt.';

async function laufe(name, fn) {
  if (NUR.size && !NUR.has(name)) return;
  gruppe = name;
  const p = await neueSeite();
  const vorher = fehler.length;
  try { await fn(p); } catch (e) {
    // Was nicht in einem Schritt scheiterte, meldet sich hier - sonst fiele
    // eine ganze Gruppe stumm aus.
    if (fehler.length === vorher) { fehler.push(name + ': ' + e.message.split('\n')[0]); log('FAIL', e.message.split('\n')[0]); }
  }
  await p.context().close();
  gruppe = '';
}

/* ---------- Text und Ton ---------- */

await laufe('ton', async p => {
  await schritt(p, 'Seite laedt mit Beispieltext', async () => {
    const t = await p.inputValue('#text');
    if (!t.startsWith('# Beispiel')) throw new Error('Beispieltext fehlt: ' + JSON.stringify(t.slice(0, 30)));
  });
  await schritt(p, 'Vorschau zerlegt den Text', async () => {
    await schreibe(p, TEXT);
    await p.waitForFunction(() => document.querySelectorAll('#preview .seg').length === 2);
    const s = await p.textContent('#summary');
    if (!/2 Abschnitt/.test(s)) throw new Error('Zusammenfassung: ' + s);
  });
  await schritt(p, 'Audio erzeugen', () => audioErzeugen(p));
  await schritt(p, 'Pause in der Vorschau aendern setzt neu zusammen', async () => {
    await zeige(p, 'preview');
    const feld = p.locator('#preview input[data-i]').first();
    await feld.fill('1.5');
    await p.waitForFunction(() => /Pausen neu gesetzt/.test(document.getElementById('status').textContent),
                            null, { timeout: 10000 });
  });
  await schritt(p, 'Nach dem Neuladen stehen Text, Pausen und Ton wieder da', async () => {
    await neuLaden(p);
    const t = await p.inputValue('#text');
    if (t !== TEXT) throw new Error('Text nach dem Neuladen: ' + JSON.stringify(t.slice(0, 40)));
    const wert = await p.locator('#preview input[data-i]').first().inputValue();
    if (Number(wert) !== 1.5) throw new Error('Pause nach dem Neuladen: ' + wert);
    await p.waitForFunction(() => built && !controller && !document.getElementById('player').hidden,
                            null, { timeout: 60000 });
  });
  await schritt(p, 'WAV speichern', async () => {
    await zeige(p, 'x-format');
    await p.selectOption('#x-format', 'wav');
    const d = await download(p, () => p.click('#x-go'), 'ton.wav');
    if (!d.name.endsWith('.wav') || d.groesse < 10000) throw new Error(d.name + ', ' + d.groesse + ' Bytes');
  });
  await schritt(p, 'MP3 speichern', async () => {
    await p.selectOption('#x-format', 'mp3');
    const d = await download(p, () => p.click('#x-go'));
    if (!d.name.endsWith('.mp3') || d.groesse < 5000) throw new Error(d.name + ', ' + d.groesse + ' Bytes');
  });
  await schritt(p, 'Text als Markdown speichern', async () => {
    await zeige(p, 'text-md');
    const d = await download(p, () => p.click('#text-md'));
    const inhalt = fs.readFileSync(d.ziel, 'utf8');
    if (!inhalt.includes('Die Heizung läuft')) throw new Error('Inhalt: ' + inhalt.slice(0, 60));
  });
  await schritt(p, 'Ton speichern gleich unter dem Sprechertext', async () => {
    await zeige(p, 'x-dl');
    const knopf = await p.textContent('#x-dl');
    if (!/MP3/.test(knopf)) throw new Error('Knopf nennt das Format nicht: ' + knopf);
    const d = await download(p, () => p.click('#x-dl'));
    if (!d.name.endsWith('.mp3')) throw new Error(d.name);
  });
  await schritt(p, 'Strg+Enter spricht', async () => {
    await zeige(p, 'text');
    await p.fill('#text', TEXT + '\n\nMit der Tastatur gesprochen.');
    await p.keyboard.press('Control+Enter');
    await p.waitForFunction(() => !controller && built &&
      plan().segs.some(s => /Tastatur/.test(s)) && plan().segs.every(s => cache.has(cacheKey(s))),
      null, { timeout: 60000 });
  });
  await schritt(p, 'Sofort nach dem Einfuegen sprechen nimmt den neuen Text', async () => {
    await zeige(p, 'text');
    await p.fill('#text', TEXT + '\n\nEin Satz, gleich gesprochen.');
    await p.click('#go');                             // ohne auf die Vorschau zu warten
    await p.waitForFunction(() => !controller && built, null, { timeout: 60000 });
    const st = await p.textContent('#status');
    if (/Fehler/.test(st)) throw new Error(st);
    const fehlt = await p.evaluate(() => plan().segs.filter(s => !cache.has(cacheKey(s))).length);
    if (fehlt || !/gleich gesprochen/.test(await p.evaluate(() => plan().segs.join(' '))))
      throw new Error('gesprochen wurde der alte Text');
  });
  await schritt(p, 'Aussprache-Regel wirkt und wird gespeichert', async () => {
    await zeige(p, 'say-add');
    await p.click('#say-add');
    const zeile = p.locator('#say-list li').last();
    await zeile.locator('.say-von').fill('Bericht');
    await zeile.locator('.say-nach').fill('Berikt');
    await p.waitForFunction(() => /gespeichert/.test(document.getElementById('say-state').textContent) &&
                                  !/noch nicht/.test(document.getElementById('say-state').textContent),
                            null, { timeout: 10000 });
    await p.waitForFunction(() => [...document.querySelectorAll('#preview .say')].some(s => s.textContent === 'Berikt'));
    await zeile.locator('[data-act="del"]').click();
    await p.waitForFunction(() => /0 Regeln · gespeichert/.test(document.getElementById('say-state').textContent),
                            null, { timeout: 10000 });
  });
});

/* ---------- Projekt auf dem Server ---------- */

await laufe('projekt', async p => {
  const name = 'Rauchtest ' + Date.now();
  await schritt(p, 'Als neues Projekt speichern', async () => {
    await schreibe(p, TEXT + '\n\nProjekt ' + name + '.');
    await zeige(p, 'srv-name');
    await p.fill('#srv-name', name);
    await p.click('#srv-save');
    await p.waitForFunction(n => document.getElementById('srv-list').textContent.includes(n), name, { timeout: 15000 });
  });
  await schritt(p, 'Kopfleiste nennt das Projekt und seinen Stand', async () => {
    await p.waitForFunction(n => document.getElementById('projekt-name').textContent === n, name);
    await standIst(p, 'gespeichert');
    await schreibe(p, TEXT + '\n\nProjekt ' + name + ', geändert.');
    await standIst(p, 'nicht gespeichert');
    await p.keyboard.press('Control+s');
    await standIst(p, 'gespeichert');
  });
  await schritt(p, 'Nach dem Neuladen bleibt es gespeichert', async () => {
    await neuLaden(p);
    await p.waitForFunction(n => document.getElementById('projekt-name').textContent === n, name, { timeout: 10000 });
    await standIst(p, 'gespeichert');
    if (!(await p.inputValue('#text')).includes('geändert.')) throw new Error('Text fehlt nach dem Neuladen');
  });
  await schritt(p, 'Projekt vom Server laden', async () => {
    await zeige(p, 'text');
    await p.fill('#text', 'etwas ganz anderes');
    await zeige(p, 'srv-list');
    await p.locator('#srv-list li', { hasText: name }).locator('[data-act="load"]').click();
    await p.waitForFunction(n => document.getElementById('text').value.includes('Projekt ' + n), name, { timeout: 15000 });
  });
  await schritt(p, 'Projektdatei exportieren und wieder einlesen', async () => {
    const d = await download(p, async () => {
      await p.click('#menu-btn');
      await p.click('#export');
    });
    const o = JSON.parse(fs.readFileSync(d.ziel, 'utf8'));
    if (!o.text.includes(name)) throw new Error('Projektdatei ohne Text');
    await zeige(p, 'text');
    await p.fill('#text', 'weg damit');
    await p.setInputFiles('#file', d.ziel);
    await p.waitForFunction(n => document.getElementById('text').value.includes(n), name, { timeout: 15000 });
  });
  await schritt(p, 'Neues Projekt leert den Text', async () => {
    await p.click('#menu-btn');
    await p.click('#neu');
    await p.waitForFunction(() => document.getElementById('text').value === '', null, { timeout: 5000 });
    await p.waitForFunction(() => document.getElementById('projekt-name').textContent === 'Neues Projekt');
  });
  await schritt(p, 'Neues Projekt aus der Kopfleiste speichern fragt nach dem Namen', async () => {
    await schreibe(p, 'Ein ganz neuer Text für ein neues Projekt.');
    await standIst(p, 'noch nicht gespeichert');
    await p.click('#projekt-sichern');
    await p.waitForSelector('#namen[open]');
    await p.fill('#namen-feld', name + ' zwei');
    await p.click('#namen-ok');
    await p.waitForFunction(n => document.getElementById('projekt-name').textContent === n, name + ' zwei', { timeout: 10000 });
    await standIst(p, 'gespeichert');
  });
});

/* ---------- Clips, Schnitt und Video ---------- */

await laufe('video', async p => {
  await schritt(p, 'Text und Ton', async () => {
    await schreibe(p, TEXT);
    await audioErzeugen(p);
  });
  await schritt(p, 'Zwei Clips hochladen', async () => {
    await zeige(p, 'v-add');
    await p.setInputFiles('#v-file', [path.join(MEDIA, 'clip-a.webm'), path.join(MEDIA, 'clip-b.webm')]);
    await p.waitForFunction(() => vClips.length === 2 && vClips.every(c => c.state === 'ready'), null, { timeout: 60000 });
  });
  await schritt(p, 'Schnittfenster zeigt beide Clips und den Text', async () => {
    await zeige(p, 'tl-screen');
    await p.waitForFunction(() => document.querySelectorAll('#tl-lane-v .tl-clip').length === 2 &&
                                  document.querySelectorAll('#tl-lane-a .tl-say').length === 2, null, { timeout: 10000 });
  });
  await schritt(p, 'Standbild einfuegen und Clip wieder ganz', async () => {
    await p.evaluate(() => tlSpringZu(tlModel().clips.items[0].t0 + 1.2));
    await p.click('#tl-hold');
    await p.waitForFunction(() => /Standbild/.test(document.querySelector('#v-list li .meta').textContent));
    await p.click('#tl-cutreset');
    await p.waitForFunction(() => !/Standbild/.test(document.querySelector('#v-list li .meta').textContent));
  });
  await schritt(p, 'Pause im Schnittfenster entfernen und einfuegen schreibt den Text', async () => {
    // Zwischen den Absaetzen steht schon eine Pause: "einfuegen" waehlt sie nur aus.
    await p.evaluate(() => tlSpringZu(tlModel().versatz + 0.1 + tlModel().sprache.items.find(s => s.art === 'text').t1));
    await p.click('[data-tl="addpause"]');
    await p.waitForFunction(() => !document.getElementById('tl-delpause').disabled);
    await p.click('#tl-delpause');
    await p.waitForFunction(() => /\(Pause: 0 s\)/.test(document.getElementById('text').value), null, { timeout: 5000 });
    await p.click('[data-tl="addpause"]');
    await p.waitForFunction(() => /\(Pause: 0,5 s\)/.test(document.getElementById('text').value), null, { timeout: 5000 });
  });
  await schritt(p, 'Voreinstellung setzt Format und Groesse', async () => {
    await zeige(p, 'v-preset');
    await p.selectOption('#v-preset', 'klein');
    const werte = await p.evaluate(() => [vEl('height').value, vEl('quality').value, vEl('fps').value]);
    if (werte.join() !== '720,small,30') throw new Error('nach "klein": ' + werte.join());
    await p.evaluate(() => { vEl('mehr').open = true; });
    await p.selectOption('#v-quality', 'high');
    if (await p.inputValue('#v-preset') !== 'eigen') throw new Error('eigene Einstellung nicht erkannt');
    await p.selectOption('#v-preset', 'standard');
  });
  await schritt(p, 'Untertitel einschalten', async () => {
    await zeige(p, 's-on');
    await p.check('#s-on');
    await p.waitForFunction(() => /Einblendung/.test(document.getElementById('s-note').textContent));
  });
  await schritt(p, 'Video erstellen und herunterladen', async () => {
    await audioErzeugen(p);                          // der Text hat eine neue Pause
    await zeige(p, 'v-go');
    await p.waitForFunction(() => !document.getElementById('v-go').disabled, null, { timeout: 15000 });
    const d = await download(p, () => p.click('#v-go'));
    if (d.groesse < 20000) throw new Error('Video nur ' + d.groesse + ' Bytes');
    await p.waitForSelector('#v-dl:not([hidden])');
  });
  await schritt(p, 'Zweites Video erstellen', async () => {
    await p.uncheck('#s-on');
    await zeige(p, 'v-go');
    await p.waitForFunction(() => !document.getElementById('v-go').disabled, null, { timeout: 15000 });
    await download(p, () => p.click('#v-go'));
  });
  await schritt(p, 'Zwei Videos zusammenfuegen', async () => {
    await zeige(p, 'z-reload');
    await p.click('#z-reload');
    await p.waitForFunction(() => document.querySelectorAll('#z-list li').length >= 2, null, { timeout: 10000 });
    // Angehakt wird ueber die Kennung: die Liste sortiert Angehaktes nach oben.
    const ids = await p.$$eval('#z-list li', lis => lis.slice(0, 2).map(li => li.dataset.id));
    for (const id of ids) await p.locator('#z-list li[data-id="' + id + '"] input').check();
    await p.waitForFunction(() => !document.getElementById('z-go').disabled, null, { timeout: 10000 });
    const d = await download(p, () => p.click('#z-go'));
    if (d.groesse < 20000) throw new Error('Ergebnis nur ' + d.groesse + ' Bytes');
  });
});

/* ---------- Abschrift ---------- */

await laufe('abschrift', async p => {
  const wav = path.join(RAUS, 'abschrift.wav');
  await schritt(p, 'Tondatei zum Mitschreiben erzeugen', async () => {
    await schreibe(p, TEXT);
    await audioErzeugen(p);
    await zeige(p, 'x-format');
    await p.selectOption('#x-format', 'wav');
    await download(p, () => p.click('#x-go'), 'abschrift.wav');
  });
  await schritt(p, 'Datei waehlen schreibt von selbst mit', async () => {
    await zeige(p, 'w-add');
    await p.selectOption('#w-model', 'tiny');
    await p.setInputFiles('#w-file', wav);
    await p.waitForSelector('#w-result:not([hidden])', { timeout: 240000 });
    await p.waitForFunction(() => wJob && wJob.status === 'done', null, { timeout: 240000 });
    const t = await p.inputValue('#w-out');
    if (!/heizung/i.test(t)) throw new Error('Abschrift: ' + t.slice(0, 80));
  });
  await schritt(p, 'In den Sprechertext uebernehmen', async () => {
    await p.selectOption('#w-form', 'pausen');
    await p.click('#w-use');
    await p.waitForFunction(() => /heizung/i.test(document.getElementById('text').value));
  });
});

/* ---------- Stapel ---------- */

await laufe('stapel', async p => {
  await schritt(p, 'Zwei Textdateien werden ein Stapel und ein ZIP', async () => {
    await zeige(p, 'text-add');
    await p.setInputFiles('#text-file', [path.join(MEDIA, 'stapel-1.md'), path.join(MEDIA, 'stapel-2.md')]);
    await p.waitForSelector('#md-box:not([hidden])');
    await zeige(p, 'md-go');
    const d = await download(p, () => p.click('#md-go'));
    if (!d.name.endsWith('.zip') || d.groesse < 10000) throw new Error(d.name + ', ' + d.groesse + ' Bytes');
  });
});

/* ---------- Reiter ---------- */

await laufe('reiter', async p => {
  const sichtbar = () => p.evaluate(() => [...document.querySelectorAll('main > .tab')]
    .filter(t => !t.hidden).map(t => t.dataset.tab));
  await schritt(p, 'Jeder Reiter zeigt nur seinen Teil', async () => {
    for (const name of ['text', 'schnitt', 'export', 'abschrift', 'zusammen', 'projekte', 'anleitung']) {
      await p.click('#reiter-' + name);
      const s = await sichtbar();
      if (s.join() !== name) throw new Error(name + ': sichtbar ' + s.join());
      if (await p.getAttribute('#reiter-' + name, 'aria-selected') !== 'true') throw new Error(name + ' nicht gewaehlt');
    }
  });
  await schritt(p, 'Die Vorschau wandert mit', async () => {
    await p.click('#reiter-schnitt');
    if (await p.evaluate(() => $('sec-vorschau').parentElement.id) !== 'platz-schnitt') throw new Error('nicht im Schnitt');
    await p.click('#reiter-text');
    if (await p.evaluate(() => $('sec-vorschau').parentElement.id) !== 'platz-text') throw new Error('nicht beim Text');
    const rest = await p.evaluate(() => (!$('tl-caret') || $('tl-caret').hidden) && !document.querySelector('#preview .at'));
    if (!rest) throw new Error('Cursor des Schnittfensters steht noch in der Vorschau');
  });
  await schritt(p, 'Pfeiltasten wechseln den Reiter', async () => {
    await p.focus('#reiter-text');
    await p.keyboard.press('ArrowRight');
    if ((await sichtbar()).join() !== 'schnitt') throw new Error('sichtbar ' + (await sichtbar()).join());
  });
  await schritt(p, 'Der Reiter bleibt nach dem Neuladen', async () => {
    await p.click('#reiter-export');
    await neuLaden(p);
    if ((await sichtbar()).join() !== 'export') throw new Error('sichtbar ' + (await sichtbar()).join());
  });
  await schritt(p, 'Sprungmarke oeffnet den Reiter des Bereichs', async () => {
    await p.goto(BASE + '#sec-aussprache');
    await p.waitForFunction(() => typeof arbeitBereit !== 'undefined' && arbeitBereit, null, { timeout: 30000 });
    if ((await sichtbar()).join() !== 'text') throw new Error('sichtbar ' + (await sichtbar()).join());
    if (!(await p.evaluate(() => $('sec-aussprache').open))) throw new Error('Aussprache nicht aufgeklappt');
  });
  await schritt(p, 'Verweis im Text wechselt den Reiter', async () => {
    await p.click('#reiter-zusammen');
    await p.click('#sec-zusammen details.erklaerung > summary');
    await p.click('#sec-zusammen details.erklaerung a[href="#sec-server"]');
    if ((await sichtbar()).join() !== 'projekte') throw new Error('sichtbar ' + (await sichtbar()).join());
  });
});

/* ---------- Zuruecksetzen ---------- */

await laufe('zurueck', async p => {
  await schritt(p, 'Alles zuruecksetzen bringt den Beispieltext', async () => {
    await zeige(p, 'text');
    await p.fill('#text', 'nur ein Versuch');
    await p.click('#menu-btn');
    await Promise.all([p.waitForEvent('load'), p.click('#wipe')]);
    await p.waitForFunction(() => document.getElementById('text').value.startsWith('# Beispiel'), null, { timeout: 10000 });
  });
});

await browser.close();
console.log(fehler.length ? '\n' + fehler.length + ' Fehler:\n  ' + fehler.join('\n  ') : '\nAlles gut.');
process.exit(fehler.length ? 1 : 0);
