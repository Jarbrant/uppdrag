# Naturjakt / Skattjakt — MVP (FAS 1)

Mobil-first demo för QR-start → paket → uppdrag/checkpoints → foto → poäng/XP → level/streak/historik (lokalt).

## Snabb överblick
- **Start:** `index.html`
- **Boot routing (QR-start):** `src/boot.js`
- **Zon-läge (Naturjakt):** `pages/play.html` + `src/play.js`
- **Party-läge (Skattjakt):** `pages/party.html` + `src/party.js` (demo)
- **Profil:** `pages/profile.html` + `src/profile.js`
- **Packs data:**
  - `data/zones.index.json` → pekar på zonpack i `data/packs/`
  - `data/parties.index.json` → pekar på partypack i `data/packs/`
  - `data/packs/zone_skogsrundan.json` (demo)

> **State lagras lokalt** i `localStorage` under `GAME_STATE_V1`.

---

## Repo-struktur (viktig)# uppdrag

---

## Deploy: GitHub Pages (KRAV)

### Alternativ A — Rekommenderat (för att absolut-paths ska funka)
Eftersom vissa datafetchar använder paths som börjar med `/data/...`, fungerar det bäst om siten ligger på **domänens root**.

1) Skapa ett repo, t.ex. `jakt-spelet`
2) Lägg filerna i repo-root enligt strukturen ovan
3) Gå till **Settings → Pages**
4) Under **Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: `main`
   - Folder: `/ (root)`
5) Spara — GitHub Pages publicerar en URL

> För att få **root-path** (så `/data/...` fungerar perfekt), använd helst:
- **User/Org Pages** repo: `USERNAME.github.io` (lägg projektet i root), **eller**
- Custom domain som pekar till Pages

### Alternativ B — Project Pages (om din URL blir /<repo>/)
Om GitHub Pages URL blir `https://USERNAME.github.io/<repo>/` kan absoluta paths `/data/...` peka fel.
Då behöver du justera i koden (senare AO):
- `src/packs.js`: byt `'/data/...'` till relativa paths (t.ex. `'./data/...'` eller base-url via `new URL(...)`)

> I FAS 1: välj Alternativ A om du vill demo-testa snabbast utan ändringar.

---

## QR-länkar (KRAV)

### Zon (Naturjakt)
- `/?mode=zone&id=skogsrundan`
  - Routas automatiskt till:
  - `/pages/play.html?mode=zone&id=skogsrundan`

### Party (Skattjakt)
- `/?mode=party&id=kalas_demo`
  - Routas automatiskt till:
  - `/pages/party.html?mode=party&id=kalas_demo`

### Fel (fail-closed)
Om `mode` eller `id` saknas/är ogiltigt:
- `index.html` visar en **Error Card** med felkod via `err=...`

---

## Demo-flöde (snabbtest)
1) Öppna `index.html`
2) Klicka **Naturjakt** → **Starta**
3) Välj uppdrag → ta foto → tryck **Klar**
4) Gå till **Profil** (om du länkar dit manuellt) och se historik/level/streak

---

## Mobil-testchecklista (KRAV)

### 1) HTTPS
- [ ] Siten laddar över **https** (GitHub Pages gör detta automatiskt)

### 2) Kamera (AO-7)
- [ ] På `play.html` kan du ta/välja bild via:
  - `<input type="file" accept="image/*" capture="environment">`
- [ ] Preview syns i UI
- [ ] **Fail-closed:** “Klar” blockas om ingen bild är vald → toast visas

### 3) QR-start (AO-11)
- [ ] `/?mode=zone&id=skogsrundan` routar direkt till play
- [ ] `/?mode=party&id=kalas_demo` routar direkt till party
- [ ] Ogiltig URL ger Error Card på index:
  - Ex: `/?mode=zone` → `err=MISSING_ID`

### 4) Offline-ish
- [ ] Slå på flygplansläge efter att sidan laddat
- [ ] UI kraschar inte
- [ ] Om pack behövs och fetch misslyckas → Error Card + “Tillbaka” + “Försök igen”
- [ ] Progression (som redan finns) ligger kvar lokalt (localStorage)

### 5) Fail-closed & robusthet
- [ ] Pack saknas/404 → tydlig felkod i Error Card (från `packs.js`)
- [ ] Tom missions → Error Card + CTAs disabled
- [ ] Inga okontrollerade exceptions (inga “vita skärmar”)

### 6) A11y basics
- [ ] Synlig focus-ring på knappar/länkar
- [ ] Knappar minst 44px höjd
- [ ] Modal går att stänga med ESC och overlay-klick

---

## Vanliga demo-URL:er
- Start: `/index.html`
- Play direkt: `/pages/play.html?mode=zone&id=skogsrundan`
- Party direkt: `/pages/party.html?mode=party&id=kalas_demo`
- Profil: `/pages/profile.html`

---

## Reset demo
På profilsidan finns **Reset demo** (confirm modal) som nollställer lokal state.
{
  "id": "skogsrundan",
  "name": "Skogsrundan (Demo)",
  "missions": [
    {
      "id": "m1_vitsippa",
      "title": "Hitta en vitsippa",
      "instruction": "Ta ett foto på en vitsippa eller en liknande vit blomma.",
      "difficulty": "easy",
      "points": 10,
      "xp": 20
    },
    {
      "id": "m2_tall",
      "title": "Hitta en tall",
      "instruction": "Ta ett foto på en tall (en barrväxt med tydlig stam).",
      "difficulty": "easy",
      "points": 10,
      "xp": 20
    },
    {
      "id": "m3_kotte",
      "title": "Hitta en kotte",
      "instruction": "Ta ett foto på en kotte. Den kan ligga på marken eller sitta i ett träd.",
      "difficulty": "easy",
      "points": 10,
      "xp": 20
    },
    {
      "id": "m4_mossa",
      "title": "Hitta mossa",
      "instruction": "Ta ett foto på ett område med mossa (på sten, mark eller träd).",
      "difficulty": "easy",
      "points": 10,
      "xp": 20
    },
    {
      "id": "m5_stigskylt",
      "title": "Hitta en stigskylt",
      "instruction": "Ta ett foto på en skylt, markering eller pil som visar en stig/led.",
      "difficulty": "easy",
      "points": 15,
      "xp": 25
    },
    {
      "id": "m6_spår",
      "title": "Normal: Hitta djurspår",
      "instruction": "Ta ett foto på spår i marken (t.ex. tassavtryck) eller tydliga tecken på djur (ej levande djur).",
      "difficulty": "normal",
      "points": 25,
      "xp": 35
    },
    {
      "id": "m7_textur",
      "title": "Normal: Hitta en spännande bark-textur",
      "instruction": "Ta ett foto på bark med tydlig struktur (sprickor, mönster eller grov yta).",
      "difficulty": "normal",
      "points": 25,
      "xp": 35
    }
  ]
}
