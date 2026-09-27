<!-- Diese Anleitung steht inhaltsgleich als eingeklappter Block am Ende von
     webui/index.html. Wer hier etwas ändert, zieht es dort nach. -->

# Sprechtext mit Pausen schreiben

Anleitung für alle, die Text für die Kokoro-Sprachausgabe (Stimme Martin) verfassen —
Menschen wie Modelle. Der fertige Text wird in die Web-Oberfläche eingefügt, dort auf
Wunsch feinjustiert und gesprochen.

Der Grundsatz: **Der Rhythmus steckt in der Struktur des Textes, nicht in Sonderzeichen.**
Überschriften, Leerzeilen und Trennlinien werden nicht gesprochen, sondern in Stille
umgerechnet. Klammerangaben verschwinden ganz. Für den Ausnahmefall, in dem eine
bestimmte Länge im Text festgehalten werden soll, gibt es zusätzlich die Anweisung
`(Pause: 1,5 s)`. Falsch betonte Wörter bekommen am Ende der Datei eine Aussprache-Liste
aus Zeilen wie `(Chefarzt|Schähfarzt)`; was in jedem Text gleich klingen soll, steht
stattdessen im Bereich *Aussprache* der Oberfläche.

---

## 1. Die Bausteine

| Im Text | Wird gesprochen? | Ergibt | Standardlänge |
|---|---|---|---|
| Normale Zeile | ja | Sprechtext | — |
| Satzende `.` `!` `?` | — | Satzpause | 0,25 s |
| Zeilenumbruch im Absatz | — | Zeilenpause | 0,15 s |
| Leerzeile | — | Absatzpause | 0,45 s |
| Trennlinie `---` | nein | Trennlinienpause | 0,90 s |
| Überschrift `#` … `######` | nein | Kapitelpause | 1,20 s |
| `(Klammertext)` | nein | **keine** Pause | 0 s |
| `(Pause: 1,5 s)` | nein | genau diese Pause | wie angegeben |
| `(Chefarzt\|Schähfarzt)` | nein | Aussprache für den ganzen Text | — |

Alle fünf Längen sind in der Oberfläche global einstellbar, jede einzelne Pause zusätzlich
von Hand. Die Werte oben sind die Voreinstellung.

### Satzpause
Entsteht automatisch nach `.`, `!` und `?`. Doppelpunkt, Semikolon und Komma trennen
**nicht** — sie ergeben keine Pause. Wer nach einem Doppelpunkt Luft holen will, macht
daraus zwei Sätze oder einen Zeilenumbruch.

### Zeilenumbruch
Ein einfacher Umbruch zwischen zwei Textzeilen ergibt die kürzeste Pause. Gut für
Aufzählungen, Kontraste und kurze Reihungen.

### Leerzeile
Der normale Absatzwechsel. Der übliche Taktgeber innerhalb eines Kapitels.

### Trennlinie
Eine Zeile, die nur aus mindestens drei `-`, `*` oder `_` besteht (`---`, `***`, `___`).
Kein weiterer Text in dieser Zeile. Nützlich als "große Pause ohne neues Kapitel" —
etwa vor einer Pointe oder einem Themenwechsel innerhalb eines Kapitels.

### Überschrift
Erzeugt die längste Pause. Der Überschriftentext selbst wird **nicht** gesprochen; er
dient nur der Gliederung und dem Regieteam. Steht die Information in der Überschrift,
muss sie im Fließtext wiederholt werden, sonst fehlt sie in der Tonspur.

### Klammern — der Kanal für Regie und Animation
Alles in runden Klammern wird stumm entfernt. **Eine Klammerzeile erzeugt bewusst keine
zusätzliche Pause**, sie stört den Rhythmus also nicht. Das ist der Ort für
Bildbeschreibungen, Animationshinweise, Timing-Notizen:

```
(Bild: die fünf Status erscheinen nacheinander von oben)
```

Eine Klammer darf über mehrere Zeilen laufen; der Umbruch verschwindet dann mit ihr.
Klammern mitten im Satz werden ebenfalls entfernt — deshalb **keine Klammern für
Einschübe verwenden, die gesprochen werden sollen**. Aus "Der Brief (also das Dokument)
geht weiter" wird "Der Brief geht weiter". Für Einschübe Gedankenstriche oder Kommas
nehmen.

Eine nie geschlossene Klammer bleibt als Text erhalten (Tippfehlerschutz) — sie wird
dann gesprochen. Also immer schließen.

### Die Anweisung `(Pause: …)`
Eine Zeile, die **nur** aus dieser Anweisung besteht, setzt an dieser Stelle eine Pause
mit genau der angegebenen Länge:

```
(Pause: 1,5 s)
```

Erlaubt sind Komma oder Punkt als Dezimaltrennzeichen, mit oder ohne Doppelpunkt, in
Sekunden oder Millisekunden — `(Pause: 1,5 s)`, `(Pause 2)`, `(pause = 800 ms)`,
`(PAUSE: 0,75 sek)`. Werte über 600 s — zehn Minuten — werden auf 600 s gekappt; so lang
darf auch eine stille Strecke in einem Film sein, der neu vertont wird.

Eine so gesetzte Pause ist **stärker als jede automatische Pause**: Leerzeilen oder eine
Überschrift direkt daneben treten hinter ihr zurück, die angegebene Länge gilt. Sie
erscheint in der Vorschau blau als *Pause aus dem Text*, das Feld *Pausen zurücksetzen*
lässt sie unangetastet, und die Standardlängen oben verändern sie nicht. Wer sie doch
anders haben will, ändert entweder den Wert im Text oder überschreibt ihn in der Vorschau.

`(Pause: 0 s)` verbindet die Nachbarn zu einem Stück — der Übergang wird dann ohne jede
Zäsur gesprochen und klingt flüssiger als eine sehr kurze Pause.

Sparsam einsetzen: Der Text bleibt lesbarer, wenn der Rhythmus aus Absätzen und Kapiteln
entsteht und die Anweisung den Sonderfällen vorbehalten bleibt — dem langen Halt vor
einer Pointe, der Standzeit für eine Animation, dem bewusst nahtlosen Übergang.

Solche Zeilen schreibt auch das *Schnittfenster*: wer dort eine Pause länger oder kürzer
zieht, findet ihre Länge danach hier im Text. Die Pausen aus dem Aufbau bleiben davon
unberührt — geschrieben wird nur, was von Hand gesetzt wurde. Eine *Abschrift aus Video* in
der Form *Mit Pausen* besteht fast nur aus solchen Zeilen: zwischen je zwei Sätzen steht die
Stille, die im Film an dieser Stelle liegt (siehe Abschnitt 5).

**Achtung:** Die Anweisung muss allein auf ihrer Zeile stehen. Mitten im Satz wird sie
wie jede andere Klammer stillschweigend entfernt und wirkt nicht. Was nicht als Zahl
lesbar ist — `(Pause: drei)` — gilt ebenfalls als gewöhnliche Regieanweisung und bleibt
wirkungslos.

### Die Aussprache-Liste `(Wort|Aussprache)`
Manche Wörter spricht die Stimme falsch aus. Eine Zeile, die **nur** aus Wort, senkrechtem
Strich und Lautschrift besteht, legt fest, wie das Wort klingen soll:

```
(Chefarzt|Schähfarzt)
```

Links steht das Wort so, wie es im Text geschrieben ist — dort bleibt es unverändert
lesbar. Rechts steht die Schreibweise, die tatsächlich gesprochen wird. Die Lautschrift
wird einfach hingeschrieben, wie man das Wort hören will; es gibt kein Lautalphabet.

**Die Regeln gelten für den ganzen Text, unabhängig davon, wo sie stehen.** Sie gehören
deshalb gesammelt ans **Ende der Datei** — dort stören sie den Lesefluss nicht und lassen
sich pflegen wie ein Wörterbuch:

```
Den Bericht dazu liest der Chefarzt.

(Chefarzt|Schähfarzt)
(kWh|Kilowattstunden)
(Herr Meier|Herr Maier)
```

Was dabei zu beachten ist:

- **Nur ganze Wörter.** `(Arzt|Artzt)` trifft nicht den `Chefarzt` und nicht die `Ärzte`.
  Beugungen und Zusammensetzungen brauchen eigene Zeilen.
- **Groß- und Kleinschreibung spielt keine Rolle** beim Suchen; gesprochen wird immer
  genau das, was rechts steht.
- **Mehrere Wörter sind erlaubt** — `(Herr Meier|Herr Maier)` ersetzt die ganze Wortfolge.
- **Trifft mehr als eine Regel zu, gewinnt die längste.** Ersetzt wird in einem Durchgang:
  Was einmal eingesetzt wurde, wird nicht von einer weiteren Regel noch einmal verändert.
- **Kein Doppelpunkt.** Er bleibt der Regie vorbehalten, damit `(Bild: links | rechts)`
  eine stumme Regieanweisung bleibt und keine Aussprache-Regel wird.
- **Nur als eigene Zeile.** Mitten im Satz verschwindet die Klammer samt beider Wörter,
  wie jede andere Klammer auch.
- Die Zeile selbst wird **nicht gesprochen** und erzeugt **keine Pause**.

In der Vorschau steht jede erkannte Regel als *Aussprache* mit dem Pfeil `→`; im
Sprechtext sind die ersetzten Stellen blau gepunktet unterstrichen und nennen beim
Zeigen darauf das geschriebene Wort. Wird eine Zeile stattdessen als *Regieanweisung*
angezeigt, stimmt etwas nicht — meist ein Doppelpunkt oder eine fehlende Hälfte.

Das Verfahren taugt für mehr als Namen: Abkürzungen und Einheiten (`(kWh|Kilowattstunden)`),
englische Begriffe (`(Cloud|Klaud)`) oder Fachwörter, die die Stimme nicht kennt.

#### Die Liste, die für jeden Text gilt

Wörter, die in **jedem** Text gleich klingen sollen — Namen aus dem Haus, Abkürzungen,
Fachwörter —, gehören nicht in jede Datei einzeln, sondern in den Bereich *Aussprache*
der Oberfläche. Dort steht links das geschriebene Wort und rechts die Lautschrift, eine
Zeile je Regel. Diese Liste liegt auf dem Server, nicht im Browser: sie wird beim Öffnen
der Seite geladen und gilt an jedem Platz, für jedes Projekt und auch für den Stapel aus
mehreren Dateien. Gespeichert wird von selbst, kurz nach der letzten Taste.

Was am Ende gilt, ergibt sich aus beidem: erst die Liste vom Server, dann die Zeilen aus
dem Text. **Nennen beide dasselbe Wort, gewinnt die Zeile im Text** — eine allgemeine
Festlegung lässt sich also für einen einzelnen Sprechertext übersteuern, ohne sie für alle
anderen zu ändern. Treffen verschiedene Wörter aufeinander, gilt wie gehabt die längste
Regel.

Ist der Ton schon erzeugt, zieht er nach: eine geänderte Regel lässt genau die Abschnitte
neu sprechen, in denen das Wort vorkommt. Die übrigen bleiben liegen, und vor dem ersten
*Audio erzeugen* geschieht nichts von selbst.

Eine Schreibweise zu finden ist Probieren: der Knopf **▶** neben einer Regel spricht die
Lautschrift allein, im Tempo des Sprechertextes, ohne dass dafür der ganze Text gesprochen
werden muss. Klingt sie noch nicht richtig, wird rechts weitergeschrieben und noch einmal
gehört.

Für die Vorschau macht die Herkunft keinen Unterschied: ersetzte Stellen sind so oder so
blau gepunktet unterstrichen. Als eigene Zeile *Aussprache* steht dort nur, was im Text
selbst steht; was vom Server kommt, steht im Bereich *Aussprache*.

---

## 2. Regeln, die man kennen muss

**Mehrere Pausen hintereinander werden zu einer.** Es gilt die stärkste:
Zeilenumbruch < Absatz < Trennlinie < Kapitel < `(Pause: …)`. Eine Überschrift mit
Leerzeilen davor und danach ergibt also genau eine Kapitelpause, keine Summe. Treffen
mehrere `(Pause: …)`-Anweisungen aufeinander, gilt die längste.

**Automatische Pausen am Anfang und am Ende verfallen.** Eine Überschrift oder Leerzeile
ganz oben oder ganz unten erzeugt also weder Vorlauf noch Schlussstille. Wer das
trotzdem braucht, schreibt es ausdrücklich hin: eine `(Pause: …)`-Zeile vor dem ersten
bzw. nach dem letzten Sprechtext gilt und steht als Stille am Anfang bzw. am Ende der
Datei.

**Markdown-Auszeichnung wird entfernt.** `*`, `_`, `` ` ``, `~`, `[` und `]` fallen weg,
der Linktext bleibt. Betonung lässt sich so nicht steuern — Betonung entsteht über
Wortstellung und Satzlänge.

**Listenzeichen und Zitatzeichen am Zeilenanfang fallen weg.** `- Punkt eins` wird zu
`Punkt eins`. Eine Liste klingt danach wie eine Reihe kurzer Zeilen mit Zeilenpausen
dazwischen. Deshalb: **Vollsätze schreiben**, keine Stichworte. "Fünf Status" statt
"- Status: 5".

**Eine Pause von 0 s trennt nicht** — sie zieht die Nachbarn zu einem Stück zusammen und
klingt flüssiger. Wer zwei Absätze bewusst verbinden will, setzt die betreffende Pause in
der Oberfläche auf 0.

**Kein YAML-Vorspann nötig.** Ein `---` ganz oben wäre nur eine Trennlinie, deren Pause
ohnehin verfällt.

---

## 3. Schreibregeln für die Stimme

- **Abkürzungen ausschreiben.** "zum Beispiel", "das heißt", "unter anderem", "zirka".
  Der Server ersetzt zwar viele Kürzel, aber ausgeschrieben ist es verlässlich.
- **Zahlen und Einheiten ausschreiben**, wenn die Aussprache zählt: "fünf Status",
  "rund fünf Minuten", "zwanzig Prozent".
- **Keine Sonderzeichen** wie `«`, `‹`, `–`, `"` — sie werden vor der Synthese durch
  Kommas ersetzt und zerhacken den Satz. Normale Bindestriche und Kommas sind in Ordnung.
- **Kurze Hauptsätze.** Jeder Satz ist eine eigene Syntheseeinheit; lange Schachtelsätze
  klingen gehetzt.
- **Keine Klammern im gesprochenen Text** (siehe oben).
- **Tempo einplanen:** ruhiges Tempo ≈ 145 Wörter pro Minute. 20 Sekunden Kapitel sind
  also rund 50 Wörter. Das Tempo lässt sich beim Sprechen zusätzlich stufenlos regeln.

---

## 4. Aufbau eines Sprechtextes

```markdown
# Sprechertext – <Titel>

(Regievorspann: Zweck, Gesamtlänge, Tempo. Wird nicht gesprochen.)

---

## Kapitel 1 · <Name> — ca. 20 s

(Bild: was in diesem Kapitel zu sehen ist)

Erster Absatz, gesprochen. Kurze Hauptsätze.

Zweiter Absatz nach einer Leerzeile.

(Pause: 2 s)

(Bild: die Grafik baut sich auf — hier steht die Tonspur still)

## Kapitel 2 · <Name> — ca. 60 s

(Bild: …)

Fließtext.

(Chefarzt|Schähfarzt)
(kWh|Kilowattstunden)
```

Überschriften und Klammern tragen die ganze Regie-Information, ohne die Tonspur zu
belasten. Die Aussprache-Liste steht am Schluss und gilt rückwirkend für den ganzen Text.

---

## 5. Feinschliff in der Oberfläche

1. *Abschrift aus Video* ist der Weg hinein, wenn der Text noch gar nicht geschrieben ist —
   etwa, um einen Film mit der Stimme Martin neu zu vertonen. Eine gewählte oder hierher
   gezogene Datei schreibt Whisper gleich nach dem Hochladen mit, und *In den Sprechertext
   übernehmen* setzt das Ergebnis in das Feld unten. In der Form *Mit Pausen* steht dort jeder
   Satz auf einer eigenen Zeile und die Stille dazwischen als Zeile `(Pause: … s)` — so lang,
   dass Martin jeden Satz dort beginnt, wo er im Film beginnt. Die Pausen folgen dem Film auch
   danach: nach *Audio erzeugen* rechnet die Seite sie mit Martins gemessenen Längen nach, und
   ein Standbild oder ein neuer Anfang im *Schnittfenster* verschiebt sie mit. Braucht Martin
   für einen Satz länger als das Original, folgt die kürzeste Pause, und die nächste längere
   Stille im Film holt das wieder auf; wo er am weitesten zurückliegt, steht unter dem
   Sprechertext. Eine im Schnittfenster von Hand gezogene Pause bleibt, wie sie ist, und
   *Pausen freigeben* löst den Text ganz vom Film. Die Abschrift ist ein Entwurf, kein
   fertiger Sprechertext — Füllwörter, Versprecher und falsch verstandene Namen stehen mit
   darin, und die Regeln dieser Anleitung gelten für sie genauso. Verbessern geht Zeile für
   Zeile; wer dabei Sätze zusammenzieht oder teilt, dessen Zeilen passen nicht mehr zu ihren
   Zeiten im Film, und die Pausen bleiben stehen, wie sie sind.
2. Text in das Feld einfügen. Die Vorschau zeigt jeden Sprechabschnitt, jede gestrichene
   Regieanweisung, jede Aussprache-Regel und jede Pause mit ihrer Länge.
3. **Mehrere Dateien auf einmal:** Werden mehrere Markdown-Dateien auf den Bereich
   *Sprechertext* gezogen, entsteht daraus ein Stapel. *Alle sprechen und als ZIP speichern*
   macht daraus je Datei eine eigene Tondatei, benannt wie die Markdown-Datei mit `TAV`
   davor — ein Vorsatz wie `TTS_` wird ersetzt. Es gelten die Pausenlängen, das Tempo und die Einstellungen aus *Audio
   exportieren*; eine Datei ohne sprechbaren Text bleibt mit ihrem Fehler in der Liste stehen
   und hält die anderen nicht auf. Eine einzelne Datei landet dagegen im Feld.
4. **Wörter, die überall gleich klingen sollen:** Der Bereich *Aussprache* hält die Liste, die
   für jeden Sprechertext gilt — links das geschriebene Wort, rechts die Lautschrift. Sie liegt
   auf dem Server, wird beim Öffnen der Seite geladen und gilt damit an jedem Platz und für
   jedes Projekt. Was nur für einen Text gilt, bleibt als Zeile `(Chefarzt|Schähfarzt)` in
   diesem Text stehen und sticht die Liste, wenn beide dasselbe Wort nennen.
5. Die fünf Standardlängen oben anpassen — sie gelten für alle Pausen, die noch nicht von Hand
   geändert wurden. Sie werden im Browser gemerkt.
6. Einzelne Pausen direkt in der Vorschau überschreiben; sie werden dann blau markiert und von
   Änderungen an den Standardwerten nicht mehr angefasst.
7. *Audio erzeugen* synthetisiert und legt die Tonspur in den Player darunter; abgespielt wird
   sie erst auf Knopfdruck. Wer danach nur Pausen ändert, bekommt die neue Fassung ohne
   neue Synthese. Jeder gesprochene Satz bleibt außerdem auf dem Server liegen, und gesprochen
   wird nur, was dort fehlt: nach einem Neuladen der Seite, einem geladenen Projekt oder einer
   geänderten **Satz**pause ist der Ton nach Sekunden wieder da, und derselbe Satz klingt jedes
   Mal gleich. Neu gesprochen wird, was den Klang selbst verändert — ein anderes Tempo den
   ganzen Text, ein geänderter Satz nur diesen Satz. Eine neue oder geänderte Aussprache-Regel
   trifft nur die Sätze, in denen das Wort vorkommt, und die spricht die Seite von selbst nach,
   sobald der erste Lauf einmal gelaufen ist.
8. *Projekt exportieren* schreibt eine JSON-Datei mit Text, Tempo, Standardlängen und allen
   einzeln gesetzten Pausen — die Arbeitsfassung zum Weitergeben und Zurückladen.
9. *Text als Markdown speichern* schreibt den Sprechertext als `.md`-Datei heraus — mit
   Auszeichnung, Klammern und Aussprache-Zeilen, also so, wie er hereinkam. Kam er aus einer
   Datei, behält er deren Namen, sonst trägt die Datei das Datum. Das ist der Weg zurück, wenn
   im *Schnittfenster* am Text gearbeitet wurde: dort wird derselbe Text geändert, und hier geht
   er wieder als Datei heraus.
10. *Audio exportieren* speichert die fertige Tonspur als WAV, FLAC, MP3 oder Opus, jeweils in
    mehreren Qualitätsstufen, und zeigt vorher die voraussichtliche Dateigröße. Für Sprache
    reichen MP3 mit 64 kbit/s oder Opus mit 24 kbit/s; für den Videoschnitt WAV mit 48 kHz. Opus
    gibt es nur in Chrome, Edge und Firefox ab Version 130 und nur über HTTPS. Die Datei heißt
    wie das Projekt, mit `TAV` davor.
11. *Video exportieren mit Sprachausgabe* hängt mehrere Videoclips in der Reihenfolge der Liste aneinander
    und legt die Sprachausgabe darunter. Format (H.264, H.265, VP9), Seitenverhältnis,
    Auflösung, Bildrate, Qualität und Ton sind wählbar; die geschätzte Dateigröße steht daneben.
    Sind Video und Sprache verschieden lang, entscheidet die Längen-Einstellung, ob das letzte
    Bild gehalten, das Video gekürzt oder Stille angehängt wird. Kodiert wird auf dem Server.
    Die Sprachausgabe geht dafür als Tonspur hinauf, und zwar nur einmal: liegt dieselbe schon
    dort, genügt ihre Kennung. Video, Tonspur, Audiodatei und Projektdatei heißen wie das
    Projekt, mit `TAV` davor; ein Vorsatz in Großbuchstaben wird ersetzt statt verdoppelt — aus
    `TTS_01_Anlage` wird `TAV_01_Anlage.mp4`. Ohne geöffnetes Projekt gilt der Name des
    Sprechertextes. *Standbild am Anfang und Ende* legt vor und hinter den Film das erste
    beziehungsweise letzte Bild, stehend und ohne Ton — voreingestellt zwei Sekunden. Das gibt
    Luft, bevor das erste Wort fällt, und beim Zusammenfügen kann die Überblendung darin liegen,
    ohne ein Wort zu verschlucken. Die Sprachausgabe beginnt dahinter.
12. *Untertitel* schreibt den Sprechertext ins Bild: jeder Abschnitt erscheint dort, wo er
    gesprochen wird. Ein Abschnitt wird gleichmäßig auf so wenige Einblendungen verteilt, wie
    *Zeichen je Zeile* und *Zeilen je Einblendung* erlauben — geschnitten wird lieber am
    Satzende, an Doppelpunkt oder Komma und vor „und“ oder „oder“ als mitten in einer
    Wortgruppe, und nie so, dass ein „in“ oder „der“ am Zeilenende hängen bleibt. Mehr Zeilen
    als eingestellt werden es nie; passt eine Zeile bei dieser Schriftgröße nicht ins Bild, wird
    früher umbrochen. Die Vorschau hat das Seitenverhältnis des Videos und dieselbe Schrift
    (DejaVu) und zeigt die Einblendung so, wie sie im Video steht. Schrift,
    Größe, Farbe, Position, Abstand vom Rand, Umriss und der Kasten dahinter samt Deckkraft
    lassen sich einstellen; der Kasten hat runde Ecken und umschließt alle Zeilen einer
    Einblendung. Auf hellem Bild braucht weiße Schrift einen dunklen Kasten (oder umgekehrt), sonst hilft er nicht. Eingebrannt
    wird beim Kodieren, zuletzt und auf dem fertig geschnittenen Bild. Im Untertitel steht das
    Wort so, wie es geschrieben ist — die Aussprache-Liste gilt nur der Stimme.
13. *Schnittfenster* legt Bild und Sprechertext übereinander, ohne dass etwas kodiert wird. Das
    Rad unter dem Bild sucht Bild für Bild; `J`, `K` und `L` fahren wie am Schnittplatz, die
    Pfeiltasten gehen ein Bild weiter, mit Umschalt eine Sekunde. `F` oder der Knopf rechts in
    der Transportleiste macht das Fenster groß; Bild, Transport und Zeitleiste gehen dabei
    zusammen ins Vollbild, `Escape` beendet es. Zu jedem Bild steht in der *Vorschau* ein Cursor
    auf dem Wort, das an dieser Stelle gesprochen wird. Die Pausen liegen als gestrichelte
    Kästchen auf der Tonspur: am rechten Rand ziehen macht sie länger oder kürzer, und Bild und
    Text verschieben sich sofort gegeneinander — ohne neue Synthese. Die gezogene Länge steht
    danach als Zeile `(Pause: 3 s)` im Sprechertext und geht damit auch in die gespeicherte
    Markdown-Datei mit. *Pause einfügen* setzt an der nächstgelegenen Naht zwischen zwei
    Abschnitten eine Pause von 0,50 s; mitten im Satz geht das nicht, dort gibt es keine Naht.
    *Pause entfernen* nimmt die Zeile wieder heraus. Am Bild schneiden *Anfang hier* und
    *Ende hier* den Clip unter dem Abspielkopf zu; ein Stück aus der Mitte nehmen *Marke setzen*
    und *Stück entfernen*: die Marke steht, wo das Stück anfängt, der Abspielkopf, wo es aufhört,
    und dazwischen verschwindet alles aus dem Clip. Auf der Zeitleiste bleibt ein gestrichelter
    Strich, wo geschnitten wurde. *Ganzer Clip* nimmt den Schnitt zurück,
    und *Standbild einfügen* hält das Bild dort für die eingestellte Zeit an — als rotes
    Band im Clip zu sehen, *Standbild entfernen* nimmt es wieder weg. So wartet das Bild,
    wenn der Text länger braucht als die Bewegung; der Clip wird dadurch länger, und die
    hochgeladene Datei bleibt, wie sie ist. Folgen die Pausen einer Abschrift, rücken sie mit
    dem Bild: nach einem Standbild wartet Martin, bis der Film weiterläuft. Die Farbe eines
    Abschnitts sagt, woran er ist:
    gefüllt liegt sein Ton vor, schraffiert ist er noch nicht gesprochen und seine Länge nur
    geschätzt, im Warnton arbeitet die Stimme gerade an ihm. Was noch nachkommt, steht oben
    links im Bild: der Clip, solange der Browser ihn vom Server holt, und der Ton, solange er
    Abschnitt für Abschnitt kommt — jeweils mit einem Balken. Ein Klick auf einen Abschnitt
    öffnet ihn zum Ändern — im Feld steht die Zeile so, wie sie im Sprechertext steht, mit
    Auszeichnung, Klammern und Aussprache-Regeln, denn es ist dieselbe Stelle in einem anderen
    Fenster. Was dort entsteht, steht sofort auch im Sprechertext; kurz nach der letzten Taste
    wird nachgesprochen, und zwar nur der geänderte Abschnitt. Ein Zeilenumbruch im Feld macht
    zwei Abschnitte daraus, ein leeres Feld entfernt ihn, `Escape` legt es weg. Nachgesprochen
    wird nur, wenn *Audio erzeugen* schon einmal gelaufen ist — der erste Lauf über den ganzen
    Text soll nicht aus Versehen beginnen.
14. *Videos zusammenfügen* hängt fertige Videos aneinander — die aus *Video exportieren mit
    Sprachausgabe*, wie sie auf dem Server liegen. Angehakt wird, was zusammensoll, die Pfeile
    bringen es in die Reihenfolge, und der *Übergang* blendet zwischen zwei Teilen über. Seine
    Zeit nimmt er sich aus dem Standbild am Ende des einen und am Anfang des nächsten, darum
    geht dabei kein Wort verloren. Kodiert wird noch einmal, mit Format, Auflösung, Bildrate und
    Qualität aus *Video exportieren*; der Ton der Teile bleibt, wie er ist, und ein neuer
    Sprechertext kommt nicht darunter. Das Ergebnis liegt wie jedes andere Video auf dem Server
    und lässt sich selbst wieder zusammenfügen.
15. *Auf dem Server* hält die Projekte und die Dateien. Ein Projekt ist dieselbe
    Arbeitsfassung, die *Projekt exportieren* als Datei schreibt — Sprechertext, Pausen,
    Audio-, Video- und Untertiteleinstellungen und die Clips mit ihrem Schnitt —, nur liegt
    sie auf dem Server und geht an jedem Platz wieder auf. *Als neues Projekt speichern* legt
    eines an, *Speichern* an der Zeile überschreibt es, *Laden* holt es zurück — mit seinem
    Ton: was die Stimme schon gesprochen hat, kommt aus dem Speicher des Sprachdienstes, nur
    der Rest wird gesprochen, ohne dass erst *Audio erzeugen* nötig wäre. Darunter steht,
    was sonst noch auf dem Server liegt: hochgeladene Clips, Tonspuren, fertige Videos und die
    Dateien der Abschrift, mit Größe, Datum und dem Hinweis, ob ein Projekt sie noch braucht.
    Von selbst verschwindet dort nichts mehr — gelöscht wird hier, auf Nachfrage. Ganz unten
    steht, wie viele gesprochene Sätze der Sprachdienst aufhebt und wie viel Platz sie
    brauchen; *Leeren* wirft sie weg.
16. *Neues Projekt* im Menü fängt leer an: Sprechertext, Clips und Ton gehen aus der Seite,
    die Einstellungen bleiben — Format, Untertitel und Pausenlängen muss niemand neu wählen.
    Auf dem Server bleibt alles liegen, auch das bisher geöffnete Projekt, so wie es zuletzt
    gespeichert wurde. Gespeichert wird das neue wie jedes andere im Bereich *Auf dem Server*.
17. *Alles zurücksetzen* im Menü räumt die Seite auf den Stand des ersten Besuchs ab:
    Sprechertext, Pausen, Stapel, Clips und Abschrift sind weg, alle Einstellungen stehen wieder
    auf ihren Standardwerten. Was auf dem Server liegt, bleibt dabei liegen — Projekte,
    Clips, Tonspuren, fertige Videos —, das wird im Bereich *Auf dem Server* gelöscht. Die
    Farbwahl bleibt, und die Aussprache-Liste bleibt auch: sie liegt auf dem Server und gehört
    keinem einzelnen Projekt. Läuft gerade etwas — Synthese, Stapel, Kodierung, Abschrift —,
    sagt die Seite das und setzt nichts zurück.

Beim Import werden die gespeicherten Pausen der Reihe nach auf den neu geparsten Text
gelegt. Ändert man den Text außerhalb des Werkzeugs, passt die Reihenfolge nicht mehr und
es gelten wieder die Standardwerte. Deshalb: **erst Text festzurren, dann Pausen
feinjustieren.**

---

## 6. Auftragsblock für Claude Design (Animation)

Dieser Abschnitt lässt sich unverändert zusammen mit dem inhaltlichen Auftrag übergeben.

> **Format des Sprechertextes**
>
> Liefere den Sprechertext als Markdown nach diesen Regeln. Der Rhythmus entsteht aus der
> Struktur, es gibt keine Pausen-Auszeichnung.
>
> - Nur normale Textzeilen werden gesprochen. Schreibe Vollsätze, kurze Hauptsätze,
>   keine Stichpunkte, keine Abkürzungen, Zahlen und Einheiten ausgeschrieben.
> - `## Überschrift` gliedert und ergibt 1,2 s Stille. Die Überschrift wird **nicht**
>   gesprochen — was zu hören sein soll, steht im Fließtext.
> - Leerzeile = 0,45 s, einfacher Zeilenumbruch = 0,15 s, `---` als eigene Zeile = 0,9 s,
>   Satzende `.` `!` `?` = 0,25 s. Doppelpunkt und Komma erzeugen keine Pause.
> - Eine Zeile, die nur aus `(Pause: 1,5 s)` besteht, setzt genau diese Länge und sticht
>   jede automatische Pause daneben. `(Pause: 0 s)` verbindet zwei Absätze nahtlos. Setze
>   sie nur dort, wo eine bestimmte Länge wirklich gebraucht wird — etwa als Standzeit
>   für eine Animation.
> - Mehrere Pausen direkt hintereinander zählen nur einmal (die längste). Automatische
>   Pausen am Anfang und am Ende verfallen. Eine ausdrückliche `(Pause: …)`-Zeile davon
>   ausgenommen: vor dem ersten bzw. nach dem letzten Sprechtext gilt sie als Vor- bzw.
>   Schlusslauf.
> - Alles in runden Klammern wird stumm entfernt und erzeugt keine Pause. Nutze Klammern
>   für Bild- und Animationsregie, je eine eigene Zeile direkt unter der Kapitel-
>   überschrift: `(Bild: …)`. Verwende Klammern **niemals** für gesprochene Einschübe.
> - Wörter, die die Stimme falsch betont — Namen, Fachwörter, englische Begriffe —, bekommen
>   am **Ende der Datei** eine Liste aus Zeilen der Form `(Chefarzt|Schähfarzt)`: links das
>   geschriebene Wort, rechts die gesprochene Schreibweise. Sie gilt für den ganzen Text,
>   trifft nur ganze Wörter und darf keinen Doppelpunkt enthalten.
> - Keine Sonderzeichen `« ‹ – "`, keine Fett-/Kursivauszeichnung, keine Listenzeichen im
>   Sprechtext — sie werden entfernt.
> - Plane rund 145 Wörter pro Minute und notiere die Zielzeit in jeder Kapitel-
>   überschrift, zum Beispiel `## Kapitel 3 · Der Regelweg — ca. 45 s`.
>
> Gib genau eine Markdown-Datei aus: Titelüberschrift, Regievorspann in Klammern,
> danach die Kapitel in dieser Form.

---

## 7. Checkliste vor der Übergabe

- [ ] Kein gesprochener Inhalt steckt in einer Überschrift oder in Klammern.
- [ ] Alle Klammern sind geschlossen.
- [ ] Jede `(Pause: …)`-Anweisung steht allein auf ihrer Zeile und nennt eine Zahl.
- [ ] Die Aussprache-Regeln stehen gesammelt am Ende und erscheinen in der Vorschau als
      *Aussprache*, nicht als *Regieanweisung*.
- [ ] Keine Stichpunktlisten, keine Abkürzungen, keine Sonderzeichen.
- [ ] Absätze markieren die gewünschten Atempausen; Trennlinien nur, wo eine deutlich
      längere Stille gewollt ist.
- [ ] Die Vorschau zeigt die erwartete Zahl an Abschnitten und Pausen.
- [ ] Gesamtstille und Sprechdauer passen zur Zielzeit.
