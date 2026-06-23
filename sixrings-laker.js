/* SixRings · Laker Mode — RAPTOR clone (blind draft)
   Data: window.PLAYERS = { "Franchise Name": [ {n,y,t,p,o,d,r,g,m}, ... ] }
   o=offense rating, d=defense rating, r=total rating, g=games, m=MPG

   Core idea: ratings are HIDDEN until revealed. You draft blind, spending
   limited powerups to peek, reroll, or manipulate the board.            */
(() => {
  "use strict";
  const DATA = window.PLAYERS || {};
  const TEAM_NAMES = Object.keys(DATA);
  const POSITIONS = ["PG", "SG", "SF", "PF", "C"];

  const CFG = {
    boardSize: 21,
    lineupSize: 5,
    charges: { magnify: 3, redeal: 1, swap: 1, position: 1, doubleDip: 1, reveal: 1, flashbang: 1 },
    posBonus: 3,        // full roster (all 5 positions filled)
    defThreshold: 11,   // sum eRD across lineup
    defBonus: 4,
    balanceMaxBonus: 2, // up to ±2 for offense/defense balance (can go negative if lopsided)
    balanceScale: 12,   // |sumO - sumD| at which balance bonus hits 0
    durabilityMaxBonus: 2,   // up to +2 for a long-tenured lineup
    durabilityBaseline: 2,   // avg career years at/below this = no bonus
    durabilityCapYears: 12,  // avg career years at/above this = full bonus
  };

  const uid = (p) => p.n + "|" + p.y + "|" + p.t;
  const $ = (id) => document.getElementById(id);
  const vcls = (v) => (v < 0 ? "v-neg" : "v-pos"); // positive = gold, negative = blue
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // How many distinct seasons (within this dataset) a player appears in —
  // used as a durability/career-length proxy.
  const CAREER_YEARS = (() => {
    const seen = {};
    for (const team in DATA) {
      for (const p of DATA[team]) {
        (seen[p.n] || (seen[p.n] = new Set())).add(p.y);
      }
    }
    const out = {};
    for (const n in seen) out[n] = seen[n].size;
    return out;
  })();
  const careerYears = (name) => CAREER_YEARS[name] || 1;

  const TEAM_LOGOS = window.TEAM_LOGOS || {};
  const PLAYER_PHOTOS = window.PLAYER_PHOTOS || {};
  // Transparent background so the team-logo watermark shows through, same as
  // the (also transparent-background) real headshot cutouts.
  const SILHOUETTE = "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
       <circle cx="32" cy="25" r="12" fill="#3a4470"/>
       <path d="M8 60c2-15 12-23 24-23s22 8 24 23" fill="#3a4470"/>
     </svg>`
  );
  const logoFor = (team) => TEAM_LOGOS[team] || "";
  const photoFor = (p) => PLAYER_PHOTOS[p.n] || SILHOUETTE;

  // ---- auto-sync via Cloudflare Worker (falls back to manual code if unreachable) ----
  const API_BASE = "https://sixrings-laker-api.skyprensky.workers.dev";
  function getPlayerId() {
    // sessionStorage (not localStorage) so two tabs of the same browser
    // get distinct ids — otherwise they'd filter each other out as "me".
    let id = sessionStorage.getItem("sixrings_playerId");
    if (!id) {
      id = "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem("sixrings_playerId", id);
    }
    return id;
  }
  async function submitResult(room, payload) {
    try {
      await fetch(`${API_BASE}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, playerId: getPlayerId(), payload }),
      });
    } catch (e) { /* offline / worker unreachable — manual code still works */ }
  }
  async function fetchOpponentResult(room) {
    try {
      const r = await fetch(`${API_BASE}/results?room=${encodeURIComponent(room)}`);
      const d = await r.json();
      const mine = getPlayerId();
      const others = (d.entries || []).filter((e) => e.playerId !== mine);
      if (!others.length) return null;
      others.sort((a, b) => b.ts - a.ts);
      return others[0].payload;
    } catch (e) { return null; }
  }

  // ---- multiplayer room / deterministic seeding ----
  // Everything that shapes the board (which team, which 21 cards, which
  // swap-destination, which flashbang reassignment) is derived from
  // ROOM + the current turn number + an action tag. Two players using the
  // SAME room code who take the SAME action on the SAME turn always see
  // identical results — independent of what either of them did on other
  // turns. That's what makes "swap on round 1" sync but "swap on round 2"
  // (by the other player) diverge.
  let ROOM;
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 (avoid confusion)
  function genCode() {
    let s = "";
    for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }
  function cleanCode(c) { return (c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8); }
  function syncRoomToUrl() {
    const url = new URL(location.href);
    url.searchParams.set("room", ROOM);
    history.replaceState(null, "", url);
  }
  (function initRoom() {
    const params = new URLSearchParams(location.search);
    ROOM = cleanCode(params.get("room")) || genCode();
    syncRoomToUrl();
  })();
  function setRoom(code) {
    ROOM = cleanCode(code) || genCode();
    syncRoomToUrl();
    $("roomInput").value = ROOM;
    newGame();
  }

  // Deterministic PRNG: a fresh, independent stream per string key.
  function seededRng(key) {
    let h = 2166136261 >>> 0; // FNV-1a basis
    const str = String(key);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    let s = h >>> 0;
    return function () {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededShuffle(arr, key) {
    const rng = seededRng(key);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function seededSample(arr, k, key) { return seededShuffle(arr, key).slice(0, Math.min(k, arr.length)); }

  let state;

  function newGame() {
    state = {
      turn: 1,             // RNG turn counter — separate from lineup.length (Double Dip fills 2 slots in 1 turn)
      lineup: [],
      charges: { ...CFG.charges },
      team: null,
      board: [],          // array of {p, revealed}
      doubleDipMode: false,
      doubleDipQueue: [],
      drafted: new Set(), // uids already in lineup
      finished: false,     // locks out draft/powerup actions once the lineup is complete
    };
    rollTeam("init");
    render();
  }

  function draftedSeasonIds() { return state.drafted; }

  function dealBoard(teamName, tag, posFilter) {
    let pool = (DATA[teamName] || []).filter((p) => !draftedSeasonIds().has(uid(p)));
    if (posFilter) pool = pool.filter((p) => p.p === posFilter);
    const key = `${ROOM}|r${state.turn}|cards|${tag}${posFilter ? ":" + posFilter : ""}`;
    const shuffled = seededShuffle(pool, key);
    const seenNames = new Set();
    const picked = [];
    for (const p of shuffled) {
      if (seenNames.has(p.n)) continue;
      seenNames.add(p.n);
      picked.push(p);
      if (picked.length >= CFG.boardSize) break;
    }
    return picked.map((p) => ({ p, revealed: false }));
  }

  function rollTeam(tag, exclude) {
    const rng = seededRng(`${ROOM}|r${state.turn}|team|${tag}`);
    let name;
    for (let tries = 0; tries < 25; tries++) {
      name = TEAM_NAMES[Math.floor(rng() * TEAM_NAMES.length)];
      if (!exclude || name !== exclude) break;
    }
    state.team = name;
    state.board = dealBoard(name, tag);
  }

  // ---- scoring ----
  function score() {
    const lu = state.lineup;
    const sumR = lu.reduce((s, p) => s + p.r, 0);
    const sumO = lu.reduce((s, p) => s + p.o, 0);
    const sumD = lu.reduce((s, p) => s + p.d, 0);
    const distinctPos = new Set(lu.map((p) => p.p));
    const full = lu.length === CFG.lineupSize;

    const posBonus = full && distinctPos.size === 5 ? CFG.posBonus : 0;
    const defOn = full && sumD > CFG.defThreshold;
    const defBonus = defOn ? CFG.defBonus : 0;

    const diff = Math.abs(sumO - sumD);
    const balanceBonus = full
      ? clamp(CFG.balanceMaxBonus * (1 - diff / CFG.balanceScale), -CFG.balanceMaxBonus, CFG.balanceMaxBonus)
      : 0;

    const avgYears = lu.length ? lu.reduce((s, p) => s + careerYears(p.n), 0) / lu.length : 0;
    const durabilityBonus = full
      ? clamp(CFG.durabilityMaxBonus * (avgYears - CFG.durabilityBaseline) /
          (CFG.durabilityCapYears - CFG.durabilityBaseline), 0, CFG.durabilityMaxBonus)
      : 0;

    const bonuses = posBonus + defBonus + balanceBonus + durabilityBonus;
    return {
      sumR, sumO, sumD, distinctPos, full, posBonus, defOn, defBonus, balanceBonus,
      avgYears, durabilityBonus, bonuses, total: sumR + bonuses,
    };
  }

  // ---- draft actions ----
  function draftPlayer(p) {
    // tag with the franchise board it was drafted from (for logo lookups later —
    // p.t is the *historical* abbreviation on the card, which may not match a
    // current franchise key after relocations/renames).
    state.lineup.push(Object.assign({}, p, { _team: state.team }));
    state.drafted.add(uid(p));
  }

  function afterPickAdvance() {
    state.doubleDipMode = false;
    state.doubleDipQueue = [];
    if (state.lineup.length >= CFG.lineupSize) return finish();
    state.turn++;
    rollTeam("init");
    render();
  }

  function selectCard(idx) {
    if (state.finished) return;
    const card = state.board[idx];
    if (!card) return;
    if (state.doubleDipMode) {
      if (state.doubleDipQueue.includes(idx)) {
        state.doubleDipQueue = state.doubleDipQueue.filter((i) => i !== idx);
      } else if (state.doubleDipQueue.length < 2) {
        state.doubleDipQueue.push(idx);
      }
      render();
      return;
    }
    draftPlayer(card.p);
    toast(`Drafted ${card.p.n} (${card.p.y}) — ${card.revealed ? card.p.r.toFixed(1) + " total" : "rating was hidden!"}`);
    afterPickAdvance();
  }

  function confirmDoubleDip() {
    if (state.finished || state.doubleDipQueue.length !== 2) return;
    const idxs = state.doubleDipQueue.slice().sort((a, b) => b - a);
    const names = idxs.map((i) => state.board[i].p.n);
    idxs.forEach((i) => draftPlayer(state.board[i].p));
    toast(`Double Dip: drafted ${names.reverse().join(" & ")}`);
    afterPickAdvance();
  }

  function magnify(idx) {
    if (state.finished || state.charges.magnify <= 0) return;
    const card = state.board[idx];
    if (!card || card.revealed) return;
    state.charges.magnify--;
    card.revealed = true;
    render();
    toast(`Revealed ${card.p.n} (${card.p.y})`);
  }

  function useRedeal() {
    if (state.finished || state.charges.redeal <= 0) return;
    state.charges.redeal--;
    state.board = dealBoard(state.team, "redeal");
    state.doubleDipMode = false; state.doubleDipQueue = [];
    render();
    toast("Redealt — 21 new players from " + state.team);
  }

  function useSwap() {
    if (state.finished || state.charges.swap <= 0) return;
    state.charges.swap--;
    rollTeam("swap", state.team);
    state.doubleDipMode = false; state.doubleDipQueue = [];
    render();
    toast("Swapped to " + state.team);
  }

  function usePosition(pos) {
    if (state.finished || state.charges.position <= 0) return;
    state.charges.position--;
    state.board = dealBoard(state.team, "position", pos);
    state.doubleDipMode = false; state.doubleDipQueue = [];
    closeOverlay();
    render();
    toast(`Position: ${pos} board from ${state.team}`);
  }

  function useDoubleDip() {
    if (state.finished || state.charges.doubleDip <= 0 || state.lineup.length > CFG.lineupSize - 2) return;
    state.charges.doubleDip--;
    state.doubleDipMode = true;
    state.doubleDipQueue = [];
    render();
    toast("Double Dip armed — pick 2 players from this board");
  }

  function useReveal() {
    if (state.finished || state.charges.reveal <= 0) return;
    state.charges.reveal--;
    state.board.forEach((c) => (c.revealed = true));
    state.board.sort((a, b) => b.p.r - a.p.r);
    render();
    toast("Revealed entire board, sorted by total impact");
  }

  function useFlashbang() {
    if (state.finished || state.charges.flashbang <= 0) return;
    state.charges.flashbang--;
    const fullPool = DATA[state.team] || [];
    const rng = seededRng(`${ROOM}|r${state.turn}|flash`);
    state.board = state.board.map((c) => {
      const alts = fullPool.filter((q) => q.n === c.p.n && uid(q) !== uid(c.p) && !draftedSeasonIds().has(uid(q)));
      const next = alts.length ? alts[Math.floor(rng() * alts.length)] : c.p;
      return { p: next, revealed: false };
    });
    render();
    toast("Flashbang! Years scrambled, ratings re-hidden");
  }

  // ---- rendering ----
  function cardHTML(card, idx) {
    const p = card.p;
    const queued = state.doubleDipQueue.includes(idx);
    const posTaken = state.lineup.some((lp) => lp.p === p.p);
    const stats = card.revealed
      ? `<div class="stats">
          <div class="stat"><small>Offense</small><b class="${vcls(p.o)}">${p.o.toFixed(1)}</b></div>
          <div class="stat"><small>Defense</small><b class="${vcls(p.d)}">${p.d.toFixed(1)}</b></div>
          <div class="stat"><small>Total</small><b class="${vcls(p.r)}">${p.r.toFixed(1)}</b></div>
        </div>`
      : `<div class="stats hidden3">
          <div class="stat"><small>Offense</small><b>?</b></div>
          <div class="stat"><small>Defense</small><b>?</b></div>
          <div class="stat"><small>Total</small><b>?</b></div>
        </div>`;
    const yy = String(p.y).slice(-2);
    return `<div class="pcard ${queued ? "queued" : ""} ${posTaken ? "taken" : ""}" data-i="${idx}">
        <div class="pctop">
          <div class="pavatar">
            <img class="plogo" src="${logoFor(state.team)}" alt="" onerror="this.style.display='none'">
            <img class="pphoto" src="${photoFor(p)}" alt="" onerror="this.src='${SILHOUETTE}'">
            <span class="pbadge">${p.p}</span>
          </div>
          <div class="pidentity">
            <div class="pyear">'${yy}</div>
            <div class="pname">${p.n}</div>
            <div class="pteam">${p.t}</div>
          </div>
        </div>
        ${stats}
        <div class="cardfoot">
          <span class="cf-label">${state.doubleDipMode ? (queued ? "Queued ✓" : "Pick Player") : "Pick Player"}</span>
          <div class="cf-btns">
            <button class="mag" data-i="${idx}" title="Reveal this player" ${state.finished || card.revealed || state.charges.magnify <= 0 ? "disabled" : ""}>🔍</button>
            <button class="sel ${queued ? "queued" : ""}" data-i="${idx}" title="Select" ${state.finished ? "disabled" : ""}>➜</button>
          </div>
        </div>
      </div>`;
  }

  function render() {
    const s = score();
    $("teamName").textContent = state.team;
    $("roundInfo").textContent = state.doubleDipMode
      ? `Double Dip active — choose 2 players from this board, then confirm`
      : `Pick ${state.lineup.length + 1} of ${CFG.lineupSize} — draft a player from this franchise`;
    $("hudRound").textContent = `${Math.min(state.lineup.length + 1, CFG.lineupSize)}/${CFG.lineupSize}`;
    $("hudRT").textContent = s.sumR.toFixed(1);
    $("hudBonus").textContent = s.bonuses.toFixed(1);
    $("hudTotal").textContent = s.total.toFixed(1);

    $("hand").innerHTML = state.board.map(cardHTML).join("");
    document.querySelectorAll(".pcard .sel").forEach((btn) =>
      btn.addEventListener("click", (e) => { e.stopPropagation(); selectCard(+btn.dataset.i); }));
    document.querySelectorAll(".pcard .mag").forEach((btn) =>
      btn.addEventListener("click", (e) => { e.stopPropagation(); magnify(+btn.dataset.i); }));

    // powerup bar — all locked once the lineup is complete
    $("chMag").textContent = state.charges.magnify;
    $("redeal").disabled = state.finished || state.charges.redeal <= 0;
    $("redealN").textContent = `(${state.charges.redeal})`;
    $("swap").disabled = state.finished || state.charges.swap <= 0;
    $("swapN").textContent = `(${state.charges.swap})`;
    $("position").disabled = state.finished || state.charges.position <= 0;
    $("positionN").textContent = `(${state.charges.position})`;
    $("doubleDip").disabled = state.finished || state.charges.doubleDip <= 0 || state.doubleDipMode || state.lineup.length > CFG.lineupSize - 2;
    $("doubleDipN").textContent = `(${state.charges.doubleDip})`;
    $("reveal").disabled = state.finished || state.charges.reveal <= 0;
    $("revealN").textContent = `(${state.charges.reveal})`;
    $("flashbang").disabled = state.finished || state.charges.flashbang <= 0;
    $("flashbangN").textContent = `(${state.charges.flashbang})`;

    $("confirmDip").style.display = state.doubleDipMode ? "inline-block" : "none";
    $("confirmDip").disabled = state.doubleDipQueue.length !== 2;

    // lineup slots
    let slots = "";
    for (let i = 0; i < CFG.lineupSize; i++) {
      const p = state.lineup[i];
      if (p) {
        slots += `<div class="slot filled">
          <div class="badge">${p.p}</div>
          <div class="info"><div class="n">${p.n}</div>
            <div class="m">${p.y} · ${p.t}</div></div>
          <div class="stats3">
            <div class="st"><small>Off</small><b class="${vcls(p.o)}">${p.o.toFixed(1)}</b></div>
            <div class="st"><small>Def</small><b class="${vcls(p.d)}">${p.d.toFixed(1)}</b></div>
            <div class="st"><small>Tot</small><b class="${vcls(p.r)}">${p.r.toFixed(1)}</b></div>
          </div></div>`;
      } else {
        slots += `<div class="slot empty">
          <div class="badge" style="background:#2a3358">${i + 1}</div>
          <div class="info"><div class="n">Empty slot</div><div class="m">awaiting pick</div></div>
          <div class="stats3">
            <div class="st"><small>Off</small><b style="color:var(--muted)">—</b></div>
            <div class="st"><small>Def</small><b style="color:var(--muted)">—</b></div>
            <div class="st"><small>Tot</small><b style="color:var(--muted)">—</b></div>
          </div></div>`;
      }
    }
    $("slots").innerHTML = slots;

    $("lhCount").textContent = `${state.lineup.length}/${CFG.lineupSize}`;

    $("netVal").textContent = (s.total >= 0 ? "+" : "") + s.total.toFixed(1);
    $("netVal").className = "net-val " + vcls(s.total);
    $("netOff").textContent = (s.sumO >= 0 ? "+" : "") + s.sumO.toFixed(1);
    $("netOff").className = vcls(s.sumO);
    $("netDef").textContent = (s.sumD >= 0 ? "+" : "") + s.sumD.toFixed(1);
    $("netDef").className = vcls(s.sumD);

    $("vPos").textContent = "+" + s.posBonus.toFixed(1);
    $("vPos").className = "v " + vcls(s.posBonus);
    $("bPosCard").className = "bonuscard" + (s.posBonus > 0 ? " on" : "");

    $("vBal").textContent = (s.balanceBonus >= 0 ? "+" : "") + s.balanceBonus.toFixed(1);
    $("vBal").className = "v " + vcls(s.balanceBonus);
    $("bBalCard").className = "bonuscard" + (s.balanceBonus > 1 ? " on" : "");

    $("vDur").textContent = (s.durabilityBonus >= 0 ? "+" : "") + s.durabilityBonus.toFixed(1);
    $("vDur").className = "v " + vcls(s.durabilityBonus);
    $("bDurCard").className = "bonuscard" + (s.durabilityBonus > 1 ? " on" : "");

    $("vDef").textContent = "+" + s.defBonus.toFixed(1);
    $("vDef").className = "lockdown-val v " + vcls(s.defBonus);
    $("bDefCard").className = "lockdown" + (s.defOn ? " on" : "");
    $("lockdownFill").style.width = `${Math.min(100, (s.sumD / CFG.defThreshold) * 100)}%`;
    $("lockdownCur").textContent = s.sumD.toFixed(1);
  }

  function ringsFor(total) {
    if (total >= 32) return 6;
    if (total >= 28) return 5;
    if (total >= 23) return 4;
    if (total >= 18) return 3;
    if (total >= 13) return 2;
    if (total >= 8) return 1;
    return 0;
  }
  const RING_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];
  function ringTitle(n) {
    return `${RING_WORDS[n]} Ring${n === 1 ? "" : "s"} Team`;
  }
  function ringsRowHTML(n) {
    let out = "";
    for (let i = 0; i < 6; i++) out += `<span class="ringicon ${i < n ? "lit" : ""}">💍</span>`;
    return out;
  }

  // Shared renderer for "I built a ___ rings team" result cards, used by both
  // the finish screen (your own lineup) and the side-by-side compare view.
  function resultCardHTML(rawPayload, label) {
    // defensive defaults: older/foreign result codes (different wire version)
    // may be missing fields we now expect — never let a stale entry crash render.
    const payload = Object.assign(
      { total: 0, base: 0, sumO: 0, sumD: 0, pos: 0, def: 0, bal: 0, dur: 0, seed: "—", lineup: [] },
      rawPayload
    );
    const rings = ringsFor(payload.total);
    const bonusImpact = Math.round((payload.pos + payload.def + payload.bal + payload.dur) * 10) / 10;
    const rows = payload.lineup.map((rawP) => {
      const p = Object.assign({ o: 0, d: 0, r: 0, tm: null }, rawP);
      const yy = String(p.y).slice(-2);
      const logo = logoFor(p.tm);
      const photo = PLAYER_PHOTOS[p.n] || SILHOUETTE;
      return `<div class="rrow">
        <div class="rrow-year"><div>'${yy}</div><div class="rrow-team">${p.t}</div></div>
        <div class="pavatar">
          ${logo ? `<img class="plogo" src="${logo}" alt="" onerror="this.style.display='none'">` : ""}
          <img class="pphoto" src="${photo}" alt="" onerror="this.src='${SILHOUETTE}'">
          <span class="pbadge">${p.p}</span>
        </div>
        <div class="rrow-name">${p.n}</div>
        <div class="rrow-stats">
          <div class="rrow-stat"><small>Off</small><b class="${vcls(p.o)}">${p.o >= 0 ? "+" : ""}${p.o.toFixed(1)}</b></div>
          <div class="rrow-stat"><small>Def</small><b class="${vcls(p.d)}">${p.d >= 0 ? "+" : ""}${p.d.toFixed(1)}</b></div>
        </div>
        <div class="rrow-total ${vcls(p.r)}">${p.r >= 0 ? "+" : ""}${p.r.toFixed(1)}</div>
      </div>`;
    }).join("");
    return `<div class="resultcard">
      ${label ? `<div class="resultwho">${label}</div>` : ""}
      <div class="resulthead">
        <div class="resulteyebrow">I Built A</div>
        <div class="resultrank">${ringTitle(rings)}</div>
        <div class="ringsrow">${ringsRowHTML(rings)}</div>
      </div>
      <div class="statchips3">
        <div class="schip"><small>Offense</small><b class="${vcls(payload.sumO)}">${payload.sumO >= 0 ? "+" : ""}${payload.sumO.toFixed(1)}</b></div>
        <div class="schip"><small>Defense</small><b class="${vcls(payload.sumD)}">${payload.sumD >= 0 ? "+" : ""}${payload.sumD.toFixed(1)}</b></div>
        <div class="schip"><small>Room</small><b style="color:var(--text)">${payload.seed}</b></div>
      </div>
      <div class="rrows">${rows}</div>
      <div class="bonusrow3">
        <div class="bmini"><small>Full Lineup</small><b class="${vcls(payload.pos)}">+${payload.pos.toFixed(1)}</b></div>
        <div class="bmini"><small>O/D Balance</small><b class="${vcls(payload.bal)}">${payload.bal >= 0 ? "+" : ""}${payload.bal.toFixed(1)}</b></div>
        <div class="bmini"><small>Lockdown</small><b class="${vcls(payload.def)}">+${payload.def.toFixed(1)}</b></div>
        <div class="bmini"><small>Durability</small><b class="${vcls(payload.dur)}">+${payload.dur.toFixed(1)}</b></div>
      </div>
      <div class="footstats3">
        <div class="fstat"><small>Bonus Impact</small><b class="${vcls(bonusImpact)}">${bonusImpact >= 0 ? "+" : ""}${bonusImpact.toFixed(1)}</b></div>
        <div class="fstat"><small>Impact</small><b class="${vcls(payload.base)}">${payload.base >= 0 ? "+" : ""}${payload.base.toFixed(1)}</b></div>
        <div class="fstat"><small>Total Score</small><b class="${vcls(payload.total)}">${payload.total >= 0 ? "+" : ""}${payload.total.toFixed(1)}</b></div>
      </div>
      <div class="brandbar">Six<span>Rings</span> · Laker Mode</div>
    </div>`;
  }

  // ---- async multiplayer: share a compact result code, compare side by side ----
  function buildResultPayload(s) {
    return {
      v: 4,
      seed: ROOM,
      total: Math.round(s.total * 10) / 10,
      base: Math.round(s.sumR * 10) / 10,
      sumO: Math.round(s.sumO * 10) / 10,
      sumD: Math.round(s.sumD * 10) / 10,
      pos: s.posBonus, def: s.defBonus,
      bal: Math.round(s.balanceBonus * 10) / 10,
      dur: Math.round(s.durabilityBonus * 10) / 10,
      lineup: state.lineup.map((p) => ({ n: p.n, y: p.y, t: p.t, p: p.p, o: p.o, d: p.d, r: p.r, tm: p._team })),
    };
  }
  // Compact array-based wire format (no object keys) + raw UTF-8 base64
  // (avoiding encodeURIComponent, which percent-encodes JSON punctuation and
  // triples the length before base64 even runs).
  function encodeResult(obj) {
    const compact = [
      obj.v, obj.seed, obj.total, obj.base, obj.sumO, obj.sumD, obj.pos, obj.def, obj.bal, obj.dur,
      obj.lineup.map((p) => [p.n, p.y, p.t, p.p, p.o, p.d, Math.round(p.r * 10) / 10, p.tm]),
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(compact));
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodeResult(code) {
    try {
      const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const c = JSON.parse(new TextDecoder().decode(bytes));
      const [v, seed, total, base, sumO, sumD, pos, def, bal, dur, lineupArr] = c;
      return {
        v, seed, total, base, sumO, sumD, pos, def, bal, dur,
        lineup: lineupArr.map(([n, y, t, p, o, d, r, tm]) => ({ n, y, t, p, o, d, r, tm })),
      };
    } catch (e) { return null; }
  }

  let pollHandle = null;
  function stopPolling() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  }

  function finish() {
    state.finished = true;
    const s = score();
    const payload = buildResultPayload(s);
    const code = encodeResult(payload);
    const room = ROOM;
    $("modal").innerHTML = `
      ${resultCardHTML(payload)}
      <div id="syncStatus" class="cmplabel">Room <b style="color:var(--gold)">${room}</b> — auto-syncing with your friend…</div>
      <div id="compareOut"></div>
      <details style="margin-top:10px">
        <summary class="cmplabel" style="cursor:pointer;display:inline">Or compare manually with a code</summary>
        <div class="cmprow">
          <input id="resultCode" class="miniinput" readonly value="${code}" />
          <button id="copyResult">Copy</button>
        </div>
        <div class="cmprow">
          <input id="theirCode" class="miniinput" placeholder="Paste their code…" />
          <button id="compareBtn">Compare</button>
        </div>
      </details>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
        <button class="primary" id="again">New Room &amp; Play Again</button>
      </div>`;
    openOverlay();
    $("again").addEventListener("click", () => { stopPolling(); closeOverlay(); setRoom(genCode()); });
    $("copyResult").addEventListener("click", () => {
      navigator.clipboard?.writeText(code).then(() => toast("Result code copied!"));
    });
    $("compareBtn").addEventListener("click", () => {
      const theirs = decodeResult($("theirCode").value.trim());
      if (!theirs || !theirs.lineup) { toast("That code doesn't look valid"); return; }
      stopPolling();
      $("syncStatus").textContent = `Room ${room} — compared manually.`;
      renderCompare(payload, theirs);
    });

    submitResult(room, payload);
    stopPolling();
    let tries = 0;
    pollHandle = setInterval(async () => {
      tries++;
      const theirs = await fetchOpponentResult(room);
      if (theirs) {
        stopPolling();
        $("syncStatus").textContent = `Room ${room} — synced automatically!`;
        renderCompare(payload, theirs);
      } else if (tries > 150) {
        stopPolling();
        $("syncStatus").textContent = `Room ${room} — still waiting (auto-sync timed out). Use the manual code below.`;
      }
    }, 3000);
  }

  function renderCompare(mine, theirs) {
    const sameRoom = mine.seed === theirs.seed;
    const winner = Math.abs(mine.total - theirs.total) < 0.05
      ? "It's a tie!"
      : mine.total > theirs.total ? "You win! 🏆" : "Your friend wins! 🏆";
    $("compareOut").innerHTML = `
      <div style="margin-top:10px">
        ${sameRoom ? "" : `<div style="color:var(--bad);font-size:12px;margin-bottom:8px">
          ⚠ Different room codes (${mine.seed} vs ${theirs.seed}) — you weren't drafting from the same boards.</div>`}
        <div style="text-align:center;margin-bottom:10px;color:var(--gold);font-weight:800;font-size:16px">${winner}</div>
        <div class="comparegrid">
          ${resultCardHTML(mine, "You")}
          ${resultCardHTML(theirs, "Friend")}
        </div>
      </div>`;
  }

  function openOverlay() { $("overlay").classList.add("show"); }
  function closeOverlay() { $("overlay").classList.remove("show"); }

  function howTo() {
    $("modal").innerHTML = `
      <h2>How to play</h2>
      <div style="text-align:left;font-size:14px;line-height:1.6">
        <p>You're shown a random NBA franchise and a board of <b>21 player-seasons</b>
        from its history. Names, years, and positions are visible — <b>ratings are hidden</b>.
        Draft <b>5 players</b> total to build your lineup, picking blind unless you reveal.</p>
        <p><b>Stats</b> (RAPTOR): <b>Total</b> impact, <b>Offense</b>, and <b>Defense</b>.
        Gold = positive rating, blue = negative rating.</p>
        <p><b>Powerups</b><br>
        🔍 <b>Magnify ×3</b> — reveal one card's ratings.<br>
        ↻ <b>Redeal ×1</b> — 21 new players, same team.<br>
        ⇄ <b>Swap Team ×1</b> — 21 players from a new team.<br>
        🎯 <b>Position ×1</b> — choose a position, get 21 players from this team who played it.<br>
        ✌️ <b>Double Dip ×1</b> — draft 2 players from the current board in one go.<br>
        👁️ <b>Reveal ×1</b> — reveal the whole board, sorted best to worst.<br>
        💣 <b>Flashbang ×1</b> — same 21 players, years (and ratings) get scrambled and re-hidden.</p>
        <p><b>End-game bonuses</b><br>
        • <b>+3</b> for a full roster (PG/SG/SF/PF/C all filled).<br>
        • <b>+4</b> if lineup ΣeRD &gt; 11.<br>
        • <b>±2</b> for offense/defense balance — closer ΣeRO ≈ ΣeRD scores higher, but a very
        lopsided lineup can score <b>negative</b> points here.<br>
        • <b>up to +2</b> Durability bonus for drafting players with long careers (based on how
        many seasons they appear across this dataset).</p>
        <p><b>Versus a friend</b><br>
        Share your <b>Room code</b> (top of the page) or the invite link. Whoever uses the same
        room code gets identical boards: the same starting team each turn, and if you both use a
        powerup like Swap Team on the <i>same turn number</i>, you'll get the same result — but
        using it on a different turn than your friend gives a different result, since each turn
        has its own roll. When you both finish, exchange the result code shown on the end screen
        to see a side-by-side comparison.</p>
      </div>
      <button class="primary" id="closeHow">Got it</button>`;
    openOverlay();
    $("closeHow").addEventListener("click", closeOverlay);
  }

  function positionPicker() {
    $("modal").innerHTML = `
      <h2>Choose a Position</h2>
      <div style="font-size:13px;color:var(--muted);margin-bottom:12px">
        Get a new 21-player board of ${state.team} players at this position.</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        ${POSITIONS.map((pos) => `<button class="primary posPick" data-pos="${pos}">${pos}</button>`).join("")}
      </div>
      <div style="margin-top:14px"><button id="cancelPos">Cancel</button></div>`;
    openOverlay();
    document.querySelectorAll(".posPick").forEach((b) => b.addEventListener("click", () => usePosition(b.dataset.pos)));
    $("cancelPos").addEventListener("click", closeOverlay);
  }

  let toastT;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800);
  }

  $("redeal").addEventListener("click", useRedeal);
  $("swap").addEventListener("click", useSwap);
  $("position").addEventListener("click", positionPicker);
  $("doubleDip").addEventListener("click", useDoubleDip);
  $("reveal").addEventListener("click", useReveal);
  $("flashbang").addEventListener("click", useFlashbang);
  $("confirmDip").addEventListener("click", confirmDoubleDip);
  $("howBtn").addEventListener("click", howTo);
  // backdrop click dismisses How-to-play/Position pickers, but not the
  // game-complete result modal — that can only be left via "New Room & Play Again".
  $("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay" && !state.finished) closeOverlay(); });

  $("roomInput").value = ROOM;
  $("joinRoom").addEventListener("click", () => setRoom($("roomInput").value));
  $("roomInput").addEventListener("keydown", (e) => { if (e.key === "Enter") setRoom($("roomInput").value); });
  $("newRoom").addEventListener("click", () => setRoom(genCode()));
  $("copyLink").addEventListener("click", () => {
    navigator.clipboard?.writeText(location.href)
      .then(() => toast("Invite link copied!"))
      .catch(() => toast("Couldn't copy — copy the URL bar manually"));
  });

  if (!TEAM_NAMES.length) {
    $("roundInfo").textContent = "Error: player data failed to load (players-data.js).";
  } else {
    newGame();
  }
})();
