<!-- ============================================================
     FIL: pages/party.html  (HEL FIL)
     AO 4/8 (FAS 1.5) — Deltagarvy: karta + checkpoint 1 + kod-inmatning
     AO 5/8 (FAS 1.5) — Clear + reveal circle + nästa aktiv
     AO 6/8 (FAS 2.0) — Fog-of-war “papper/sepia”-look
     AO 7/8 (FAS 2.0) — Grid-läge (alternativ vy): Toggle Karta/Grid + grid container
     AO 1/3 (FAS 1.0) — Loot-val “Välj 1 av 3” efter checkpoint (UI hooks)
     Policy: UI-only, Leaflet via CDN (OK)
============================================================ -->
<!doctype html>
<html lang="sv">
<head>
  <!-- ==========================================================
       BLOCK 1 — Meta + CSS
  =========================================================== -->
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Skattjakt — Deltagare</title>
  <meta name="description" content="Skattjakt med karta och kod." />
  <link rel="stylesheet" href="../styles/main.css" />

  <!-- ==========================================================
       BLOCK 1.1 — Leaflet CSS (CDN)
  =========================================================== -->
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
</head>

<!-- AO 6/8: theme hook -->
<body class="theme-party">
  <!-- ==========================================================
       BLOCK 2 — Skip link (A11y light)
  =========================================================== -->
  <a class="skipLink" href="#mainContent">Hoppa till innehåll</a> <!-- HOOK: skip-link -->

  <!-- ==========================================================
       BLOCK 3 — App Root
  =========================================================== -->
  <div id="app" class="app partyApp"> <!-- HOOK: app-root -->

    <!-- ========================================================
         BLOCK 4 — Header
    ========================================================= -->
    <header class="topbar partyTopbar">
      <div class="topbar__inner">
        <div class="row row--header">
          <button id="backBtn" class="btn btn-ghost btn--icon" type="button" aria-label="Tillbaka">
            ←
          </button>
          <!-- HOOK: back-button -->

          <div class="headerTitle">
            <div class="muted small">Skattjakt</div>
            <div id="partyName" class="headerName">—</div>
            <!-- HOOK: party-name -->
          </div>

          <div class="headerRight">
            <span id="stepPill" class="pill pill--level">Checkpoint 1</span>
            <!-- HOOK: step-pill -->
          </div>
        </div>
      </div>
    </header>

    <!-- ========================================================
         BLOCK 5 — Main
    ========================================================= -->
    <main id="mainContent" class="main" role="main"> <!-- HOOK: main -->
      <div class="container">
        <!-- Status / error slot -->
        <div id="statusSlot" class="slot" aria-live="polite"></div> <!-- HOOK: status-slot -->

        <!-- ======================================================
             AO 7/8 — Toggle (Karta / Grid)
        ======================================================= -->
        <section class="card paperCard" aria-label="Vyval">
          <div class="card__head">
            <div class="card__meta">
              <h1 class="h2" style="margin:0">Vy</h1>
              <p class="muted small" style="margin:6px 0 0 0">
                Välj hur du vill se checkpoints.
              </p>
            </div>
          </div>

          <div class="viewToggle" role="tablist" aria-label="Välj vy">
            <button id="viewMapBtn" class="btn btn-ghost viewTab is-active" type="button" role="tab" aria-selected="true">
              Karta
            </button>
            <!-- HOOK: view-map-btn -->
            <button id="viewGridBtn" class="btn btn-ghost viewTab" type="button" role="tab" aria-selected="false">
              Grid
            </button>
            <!-- HOOK: view-grid-btn -->
          </div>
        </section>

        <!-- ======================================================
             AO 7/8 — View: Map
        ======================================================= -->
        <section id="mapView" class="card paperCard" aria-label="Karta"> <!-- HOOK: map-view -->
          <div class="card__head">
            <div class="card__meta">
              <h2 class="h2" style="margin:0">Karta</h2>
              <p class="muted small" style="margin:6px 0 0 0">
                Gå till checkpointen och skriv in koden.
              </p>
            </div>
          </div>

          <div class="mapWrap fogWrap">
            <div id="partyMap" class="map partyMap" role="application" aria-label="Karta"></div>
            <!-- HOOK: party-map -->

            <div class="fogOverlay" aria-hidden="true"></div>
            <!-- HOOK: fog-overlay -->

            <div id="mapError" class="errorText" role="alert"></div>
            <!-- HOOK: map-error -->
          </div>
        </section>

        <!-- ======================================================
             AO 7/8 — View: Grid
        ======================================================= -->
        <section id="gridView" class="card paperCard is-hidden" aria-label="Grid"> <!-- HOOK: grid-view -->
          <div class="card__head">
            <div class="card__meta">
              <h2 class="h2" style="margin:0">Grid</h2>
              <p class="muted small" style="margin:6px 0 0 0">
                Checkpoints som rutor: låst / aktiv / klar.
              </p>
            </div>
          </div>

          <div id="gridWrap" class="gridWrap" role="list" aria-label="Checkpoint grid"></div>
          <!-- HOOK: grid-wrap -->

          <div id="gridHint" class="muted small" style="margin-top:10px"></div>
          <!-- HOOK: grid-hint -->
        </section>

        <!-- Checkpoint panel -->
        <section class="card paperCard" aria-label="Aktiv checkpoint">
          <div class="card__head">
            <div class="card__meta">
              <h2 class="h2" style="margin:0">Aktiv checkpoint</h2>
              <p id="clueText" class="muted small" style="margin:6px 0 0 0">Laddar…</p>
              <!-- HOOK: clue-text -->
            </div>
            <div class="card__side">
              <span class="pill pill--difficulty" id="cluePill">kod</span>
              <!-- HOOK: clue-pill -->
            </div>
          </div>

          <div class="form" style="margin-top:12px">
            <div class="field">
              <label class="label2" for="codeInput">Kod</label>
              <input id="codeInput" class="input" type="text" autocomplete="off" placeholder="Skriv koden här…" />
              <!-- HOOK: code-input -->
              <div id="errCode" class="errorText" role="alert"></div>
              <!-- HOOK: err-code -->
            </div>

            <button id="okBtn" class="btn btn-primary" type="button">
              OK
            </button>
            <!-- HOOK: ok-button -->
          </div>
        </section>

        <!-- ======================================================
             AO 1/3 — Mina belöningar (MVP panel)
             - Ingen redeem i AO 1
        ======================================================= -->
        <section class="card paperCard" aria-label="Mina belöningar">
          <div class="card__head">
            <div class="card__meta">
              <h2 class="h2" style="margin:0">Mina belöningar</h2>
              <p class="muted small" style="margin:6px 0 0 0">
                Valda belöningar visas här. Status: Ej inlöst (MVP).
              </p>
            </div>
          </div>

          <div id="rewardsPanel" class="rewardsPanel">
            <div id="rewardsEmpty" class="muted small">Inga belöningar ännu.</div>
            <ul id="rewardsList" class="rewardsList" aria-label="Lista med upplåsta belöningar"></ul>
            <!-- HOOK: rewards-list -->
          </div>
        </section>

        <div class="muted small footerNote">
          Deltagarvy (AO 7/8). Toggle Karta/Grid. UI-state i party-map.js.
        </div>
      </div>
    </main>

    <!-- ========================================================
         AO 1/3 — Loot modal (dold som standard)
         XSS-safe: dynamiskt innehåll sätts i JS via textContent
    ========================================================= -->
    <div id="lootOverlay" class="lootOverlay is-hidden" aria-hidden="true"> <!-- HOOK: loot-overlay -->
      <div class="lootBackdrop" data-close="1"></div>

      <section
        id="lootModal"
        class="lootModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lootTitle"
        aria-describedby="lootDesc"
      >
        <header class="lootHead">
          <div class="lootHead__meta">
            <h3 id="lootTitle" class="h3" style="margin:0">Välj en belöning</h3>
            <p id="lootDesc" class="muted small" style="margin:6px 0 0 0">Du får 1 av 3</p>
          </div>
        </header>

        <div id="lootCards" class="lootCards" role="list" aria-label="Belöningsval">
          <!-- 3 cards renderas av JS -->
        </div>

        <div class="lootActions">
          <button id="lootSkipBtn" class="btn btn-ghost" type="button">Hoppa över</button>
          <!-- HOOK: loot-skip -->
        </div>
      </section>
    </div>

  </div>

  <!-- ==========================================================
       BLOCK 6 — Page-only inline styles (minimal)
  =========================================================== -->
  <style>
    .row { display:flex; align-items:center; gap: var(--sp-3); }
    .row--header { width:100%; }
    .btn--icon { width:44px; padding: 10px 10px; }
    .headerTitle { flex: 1; min-width: 0; }
    .headerName { font-weight: 800; font-size: var(--fs-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .headerRight { display:flex; align-items:center; gap: var(--sp-2); }

    .pill { display:inline-flex; align-items:center; justify-content:center; padding: 7px 10px; border-radius: 999px; border: 1px solid var(--border); background: rgba(255,255,255,.06); font-weight: 800; font-size: var(--fs-1); }
    .pill--level { border-color: rgba(110,231,255,.30); background: rgba(110,231,255,.10); color: rgba(255,255,255,.92); }
    .pill--difficulty { border-color: rgba(255,255,255,.14); }

    .slot { margin-top: var(--sp-4); }

    .form { display:grid; gap: 14px; }
    .field { display:grid; gap: 6px; }
    .label2 { font-weight: 800; font-size: var(--fs-2); }
    .input {
      min-height: 44px;
      padding: 12px 12px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.05);
      color: var(--text);
      outline: none;
    }
    .input::placeholder { color: rgba(255,255,255,.45); }
    .input:focus-visible { box-shadow: var(--focus); }
    .errorText { min-height: 18px; font-size: var(--fs-2); color: rgba(251,113,133,.95); }

    .mapWrap { margin-top: 10px; display:grid; gap: 8px; position: relative; }
    .map {
      width: 100%;
      min-height: 340px;
      border-radius: 14px;
      border: 1px solid var(--border);
      overflow: hidden;
      background: rgba(255,255,255,.03);
    }
    @media (min-width: 900px) {
      .map { min-height: 460px; }
    }

    .footerNote { margin-top: var(--sp-6); text-align:center; opacity:.85; }

    .fogOverlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-radius: 14px;
    }

    /* AO 7/8 toggle + grid (light styles here, main polish can be moved to main.css later) */
    .viewToggle { margin-top: 12px; display:flex; gap: 10px; flex-wrap: wrap; }
    .viewTab.is-active { border-color: rgba(110,231,255,.40); background: rgba(110,231,255,.10); }
    .is-hidden { display:none !important; }

    .gridWrap { margin-top: 12px; display:grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    @media (min-width: 720px) { .gridWrap { grid-template-columns: repeat(8, 1fr); } }
    .gridCell {
      min-height: 44px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.05);
      display:flex;
      align-items:center;
      justify-content:center;
      font-weight: 900;
      cursor: pointer;
      user-select:none;
    }
    .gridCell[aria-disabled="true"] { opacity: .50; cursor: not-allowed; }
    .gridCell.is-active { border-color: rgba(110,231,255,.55); background: rgba(110,231,255,.10); }
    .gridCell.is-cleared { border-color: rgba(74,222,128,.45); background: rgba(74,222,128,.10); }
    .gridCell.is-locked { border-style: dashed; }

    /* ==========================================================
       AO 1/3 — Rewards panel + Loot modal (page-local, minimal)
    =========================================================== */
    .rewardsPanel { margin-top: 12px; display:grid; gap: 10px; }
    .rewardsList { margin:0; padding:0; list-style:none; display:grid; gap: 10px; }
    .rewardItem {
      border: 1px solid var(--border);
      background: rgba(255,255,255,.05);
      border-radius: 14px;
      padding: 12px 12px;
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap: 12px;
    }
    .rewardItem__meta { min-width:0; display:grid; gap: 4px; }
    .rewardPartner { font-weight: 900; }
    .rewardTitle { font-weight: 900; }
    .rewardStatus { white-space: nowrap; }

    .lootOverlay {
      position: fixed;
      inset: 0;
      z-index: 2500;
      display:flex;
      align-items:flex-end;
      justify-content:center;
      padding: 12px;
    }
    .lootBackdrop {
      position:absolute;
      inset:0;
      background: rgba(0,0,0,.55);
      backdrop-filter: blur(6px);
    }
    .lootModal {
      position: relative;
      width: 100%;
      max-width: 720px;
      border: 1px solid var(--border);
      background: rgba(16, 26, 47, .92);
      border-radius: 16px;
      box-shadow: 0 20px 50px rgba(0,0,0,.45);
      padding: 14px;
      display:grid;
      gap: 12px;
    }
    .lootHead { display:flex; align-items:flex-start; justify-content:space-between; gap: 12px; }
    .lootCards { display:grid; gap: 10px; grid-template-columns: 1fr; }
    @media (min-width: 720px) {
      .lootOverlay { align-items:center; padding: 16px; }
      .lootCards { grid-template-columns: repeat(3, 1fr); }
    }
    .lootCardBtn {
      width: 100%;
      text-align:left;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(255,255,255,.06);
      border-radius: 16px;
      padding: 12px;
      min-height: 88px;
      cursor: pointer;
      display:grid;
      gap: 6px;
    }
    .lootCardBtn:focus-visible { box-shadow: var(--focus); }
    .lootCardTitle { font-weight: 900; }
    .lootCardPartner { font-weight: 900; opacity: .92; }
    .lootCardShort { opacity: .88; }
    .lootActions { display:flex; justify-content:flex-end; gap: 10px; }
  </style>

  <!-- ==========================================================
       BLOCK 7 — Leaflet JS (CDN) + participant logic
  =========================================================== -->
  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>

  <script type="module" src="../src/party-map.js"></script>
</body>
</html>
