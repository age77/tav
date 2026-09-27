// TAV · Fertige Videos zusammenfuegen.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Videos zusammenfuegen ---------- */

// Die fertigen Videos liegen schon beim Videodienst. Hier werden sie angehakt,
// in eine Reihenfolge gebracht und aneinandergehaengt - mit einer Ueberblendung
// dazwischen, die sich ihre Zeit aus dem Standbild am Ende des einen und am
// Anfang des naechsten nimmt. Gerechnet wird mit demselben Auftrag wie beim
// Export, nur kommt sein Bild aus der Ablage "output" statt aus den Clips.
const zEl = id => $('z-' + id);
let zListe = [];         // die fertigen Videos auf dem Server
let zWahl = [];          // ihre Kennungen in der gewaehlten Reihenfolge
let zJob = null;
let zPlanTimer = null, zPlanSeq = 0;

function zBusy() { return !!zJob && ['queued', 'running'].includes(zJob.status); }

async function initZusammen() {
  if (!vInfo) { zEl('offline').hidden = false; zEl('body').hidden = true; return; }
  zEl('transition').innerHTML = vInfo.transitions
    .map(o => '<option value="' + o.id + '">' + esc(o.label) + '</option>').join('');
  // Voreingestellt die laengste Ueberblendung, die das Standbild hergibt.
  const lang = vInfo.transitions.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
  zEl('transition').value = String(lang.id);
  zEl('transition').onchange = zPlanen;
  zEl('reload').onclick = () => zHolen(true);
  zEl('go').onclick = zStart;
  zEl('cancel').onclick = zCancel;
  zEl('dl').onclick = e => { e.preventDefault(); zDownload(); };
  await zHolen();
}

async function zHolen(sagen) {
  try {
    const d = await vFetch('/storage');
    zListe = (d.items.output || []).filter(e => e.duration > 0);
  } catch (e) {
    zEl('note').textContent = 'Die Liste ließ sich nicht holen: ' + e.message;
    return;
  }
  const da = new Set(zListe.map(e => e.id));
  zWahl = zWahl.filter(id => da.has(id));
  zRender();
  if (sagen) note(zListe.length + ' fertige(s) Video(s) auf dem Server.');
}

function zRender() {
  const list = zEl('list');
  if (!zListe.length) {
    list.innerHTML = '';
    zEl('head').textContent = 'Noch kein fertiges Video auf dem Server — erst eins im Reiter '
                            + '„Export“ erstellen.';
    zEl('go').disabled = true;
    return;
  }
  // Angehaktes zuerst, in seiner Reihenfolge; alles andere danach nach Datum.
  const sortiert = [...zWahl.map(id => zListe.find(e => e.id === id)).filter(Boolean),
                    ...zListe.filter(e => !zWahl.includes(e.id))];
  list.innerHTML = sortiert.map(e => {
    const platz = zWahl.indexOf(e.id);
    const drin = platz >= 0;
    return '<li data-id="' + escAttr(e.id) + '">' +
      '<label class="check"><input type="checkbox"' + (drin ? ' checked' : '') +
      (zBusy() ? ' disabled' : '') + '></label>' +
      '<span class="num">' + (drin ? platz + 1 : '–') + '</span>' +
      '<div class="what"><div class="name">' + esc(e.name) + '</div>' +
      '<div class="meta">' + esc([fmtTime(e.duration), e.width && e.height ? e.width + '×' + e.height : '',
                                  fmtBytes(e.size), new Date(e.created * 1000).toLocaleString('de-DE')]
                                 .filter(Boolean).join(' · ')) + '</div></div>' +
      '<button class="sec" data-act="up" title="Nach oben"' + (drin && platz ? '' : ' disabled') + '>↑</button>' +
      '<button class="sec" data-act="down" title="Nach unten"' +
      (drin && platz < zWahl.length - 1 ? '' : ' disabled') + '>↓</button></li>';
  }).join('');

  list.querySelectorAll('li').forEach(li => {
    const id = li.dataset.id;
    li.querySelector('input').onchange = () => {
      zWahl = zWahl.includes(id) ? zWahl.filter(x => x !== id) : zWahl.concat([id]);
      zRender();
      zPlanen();
    };
    li.querySelectorAll('button').forEach(b => b.onclick = () => {
      const i = zWahl.indexOf(id), j = b.dataset.act === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= zWahl.length) return;
      [zWahl[i], zWahl[j]] = [zWahl[j], zWahl[i]];
      zRender();
      zPlanen();
    });
  });
  zEl('go').disabled = zWahl.length < 2 || zBusy();
  zPlanen();
}

// Dieselben Einstellungen wie beim Export - nur ohne Sprachausgabe und
// Untertitel, dafuer mit dem Originalton der Teile und der Ueberblendung von hier.
function zOptions() {
  return Object.assign(vOptions(), {
    subtitles: { on: false }, clip_audio: 1, length: 'video', voice_offset: 0, still_seconds: 0,
    transition: Number(zEl('transition').value) || 0
  });
}

function zPlanen() {
  clearTimeout(zPlanTimer);
  zPlanTimer = setTimeout(zPlan, 250);
}

async function zPlan() {
  const teile = zWahl.map(id => zListe.find(e => e.id === id)).filter(Boolean);
  zEl('go').disabled = teile.length < 2 || zBusy();
  if (teile.length < 2) {
    zEl('head').textContent = zListe.length
      ? 'Mindestens zwei Videos anhaken — dann steht hier, was daraus wird.' : '';
    zEl('size').textContent = '';
    return;
  }
  const seq = ++zPlanSeq;
  try {
    const p = await vJson('POST', '/plan', {
      clips: teile.map(e => ({ width: e.width, height: e.height, duration: e.duration, fps: e.fps })),
      options: zOptions()
    });
    if (seq !== zPlanSeq) return;
    zEl('head').textContent = teile.length + ' Videos · ' + fmtTime(p.duration) + ' · ' +
      p.width + '×' + p.height + ' · ' + String(p.fps).replace('.', ',') + ' fps' +
      (p.warnings.length ? ' — ' + p.warnings.join(' ') : '');
    zEl('size').innerHTML = 'ca. <b>' + fmtBytes(p.estimated_bytes) + '</b>';
  } catch (e) {
    if (seq !== zPlanSeq) return;
    zEl('head').textContent = e.message;
    zEl('size').textContent = '';
    zEl('go').disabled = true;
  }
}

async function zStart() {
  if (zBusy() || zWahl.length < 2) return;
  const note2 = zEl('note'), prog = zEl('prog');
  zEl('dl').hidden = true;
  note2.classList.remove('err');
  zJob = { status: 'queued' };
  zEl('cancel').hidden = false;
  zRender();
  try {
    zJob = await vJson('POST', '/jobs', {
      source: 'output', clips: zWahl.map(id => ({ id })), options: zOptions(),
      name: dateiTauglich(zEl('name').value.trim() || mitVorsatz('Zusammen'))
    });
    prog.hidden = false; prog.value = 0;
    while (zBusy()) {
      zZeige();
      await new Promise(r => setTimeout(r, 1000));
      if (!zBusy()) break;
      zJob = await vFetch('/jobs/' + zJob.id);
    }
    zZeige();
  } catch (e) {
    zJob = { status: 'failed', error: e.message };
    zZeige();
  }
}

function zZeige() {
  const j = zJob, note2 = zEl('note'), prog = zEl('prog');
  zEl('cancel').hidden = !zBusy();
  prog.hidden = !zBusy();
  note2.classList.toggle('err', j.status === 'failed');
  if (j.status === 'queued') {
    prog.removeAttribute('value');
    note2.textContent = 'Wartet' + (j.ahead ? ' — ' + j.ahead + ' Auftrag/Aufträge davor' : '') + '…';
  } else if (j.status === 'running') {
    prog.value = j.progress;
    note2.textContent = 'Kodiere… ' + Math.round(j.progress * 100) + ' %' +
      (j.eta != null ? ' · noch ca. ' + fmtTime(j.eta) : '') + ' · bisher ' + fmtBytes(j.size);
  } else if (j.status === 'done') {
    const dl = zEl('dl');
    dl.href = VAPI + '/jobs/' + j.id + '/file';
    dl.download = j.name || 'video.' + j.plan.ext;
    dl.textContent = 'Video herunterladen (' + fmtBytes(j.size) + ')';
    dl.hidden = false;
    note2.textContent = 'Fertig: ' + j.name + ', ' + fmtBytes(j.size) + ', ' + fmtTime(j.plan.duration) +
      ', kodiert in ' + fmtTime(j.finished - j.started) + '. Das Video liegt jetzt auch hier in der Liste.';
    zDownload();
    zHolen();                                    // das Ergebnis steht selbst in der Liste
    if (vInfo) srvHoleDateien().catch(() => {});
  } else if (j.status === 'failed') {
    note2.textContent = 'Fehler: ' + (j.error || 'unbekannt');
  } else if (j.status === 'cancelled') {
    note2.textContent = 'Abgebrochen.';
  }
  zRender();
}

async function zCancel() {
  if (!zJob) return;
  if (zJob.id) {
    try { zJob = await vFetch('/jobs/' + zJob.id, { method: 'DELETE' }); } catch (e) { /* egal */ }
  } else {
    zJob = { status: 'cancelled' };
  }
  zZeige();
}

let zLaedt = false;

async function zDownload() {
  const note2 = zEl('note');
  if (zLaedt || !zJob || !zJob.id) return;
  zLaedt = true;
  const vorher = note2.textContent;
  try {
    const j = await vFetch('/jobs/' + zJob.id);
    if (!j || j.status !== 'done') throw new Error('Das Video ist nicht mehr fertig — bitte noch einmal zusammenfügen.');
    const a = document.createElement('a');
    a.href = VAPI + '/jobs/' + j.id + '/file';
    a.download = j.name || 'video.' + j.plan.ext;
    a.click();
    note2.textContent = vorher;
  } catch (e) {
    note2.classList.add('err');
    note2.textContent = e.message;
  } finally {
    zLaedt = false;
  }
}
