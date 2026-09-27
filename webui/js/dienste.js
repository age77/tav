// TAV · Anfragen an Video- und Abschriftdienst, Hochladen in Stuecken.
// Eines der Skripte der Seite: alle teilen sich einen Namensraum und laufen
// in der Reihenfolge, in der index.html sie nennt.

/* ---------- Dienste ansprechen ---------- */

// Video- und Abschriftdienst sind gleich gebaut: Fehler stehen als "detail"
// im JSON, und Dateien gehen in Stuecken hoch — erst anmelden, dann die
// Stuecke schieben, dann abschliessen. Zerstueckelt wird, weil Traefik jede
// einzelne Anfrage nach 60 Sekunden Lesezeit abbricht.
function apiFor(base) {
  const get = async (path, opts = {}) => {
    let r;
    try {
      r = await fetch(base + path, { credentials: 'same-origin', ...opts });
    } catch (e) {
      // Steht eine Anmeldung vor der Seite und ist die Sitzung abgelaufen,
      // leitet sie auf eine fremde Adresse um; die Abfrage scheitert dann
      // schon hier. Dasselbe Bild gibt ein Dienst ab, der nicht laeuft.
      throw new Error('Keine Antwort vom Dienst — er läuft nicht, oder die Anmeldung ist abgelaufen; dann hilft ein Neuladen der Seite.');
    }
    // Weitergeleitet heisst: es kommt die Anmeldeseite, nicht die Antwort.
    if (r.redirected) throw new Error('Die Anmeldung ist abgelaufen — bitte die Seite neu laden.');
    let body = null;
    try { body = await r.json(); } catch (e) { /* kein JSON */ }
    if (!r.ok) {
      const d = body && body.detail;
      throw new Error(typeof d === 'string' ? d : 'HTTP ' + r.status);
    }
    return body;
  };
  const json = (method, path, body) =>
    get(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // Jedes Stueck wird bis zu dreimal versucht. "extra" geht mit der Anmeldung
  // hinaus - die Tonspur nennt dort ihre Pruefsumme, und liegt sie schon auf
  // dem Server, kommt die Anmeldung gleich fertig zurueck.
  const upload = async (kind, part, blob, name, onSent, aborted = () => false, extra = {}) => {
    const start = await json('POST', '/' + kind, { name, size: blob.size, ...extra });
    if (start.done) return start;
    try {
      for (let off = 0; off < blob.size;) {
        if (aborted()) throw new Error('Entfernt.');
        const piece = blob.slice(off, off + part);
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await get('/' + kind + '/' + start.id + '?offset=' + off, { method: 'PUT', body: piece });
            off = r.received;
            break;
          } catch (e) {
            if (attempt >= 3) throw e;
            await new Promise(r => setTimeout(r, 1000 * attempt));
          }
        }
        onSent(off);
      }
      return await get('/' + kind + '/' + start.id + '/done', { method: 'POST' });
    } catch (e) {
      get('/' + kind + '/' + start.id, { method: 'DELETE' }).catch(() => {});
      throw e;
    }
  };
  return { get, json, upload };
}

// Pruefsumme einer Datei als Hex. crypto.subtle gibt es nur ueber HTTPS und
// auf localhost - sonst eben keine, dann rechnet der Dienst sie selbst.
async function sha256Hex(blob) {
  if (!(window.crypto && crypto.subtle)) return null;
  try {
    const summe = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(summe)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}
