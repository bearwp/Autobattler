// Entry point. Wires sim + render together with a fixed-timestep loop.

import { CONFIG, ATTACK_TYPES, TARGET_RULES, ATTACK_SHAPES, MOVEMENTS, SHAPES, MODIFIERS, SELF_PRESERVATION } from './sim/config.js';
import { Sim } from './sim/sim.js';
import { Renderer } from './render/renderer.js';

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const teamUiEl = document.getElementById('team-ui');
const customizerEl = document.getElementById('customizer');
const memberListEl = document.getElementById('member-list');
const btnStart = document.getElementById('btn-start');
const btnRestart = document.getElementById('btn-restart');
const btnDebug = document.getElementById('btn-debug');
const btnPlays = document.getElementById('btn-plays');
const debugPanelEl = document.getElementById('debug-panel');
const dbgBodyEl = document.getElementById('dbg-body');
const dbgPlayEl = document.getElementById('dbg-play');
const btnPause = document.getElementById('btn-pause');
const mapOverlayEl = document.getElementById('map-overlay');
const mapSvgEl = document.getElementById('map-svg');
const restOverlayEl = document.getElementById('rest-overlay');
const restCandidatesEl = document.getElementById('rest-candidates');

const sim = new Sim();
const renderer = new Renderer(canvas);

// Ensure the canvas has a size before the first render.
renderer._resize();

// --- Customizer ---
// Before the game starts, the player edits their roster of members. Each
// member is a bundle of attributes; members can be added/removed freely.

const memberEls = new Map(); // member id -> { root, hpfill }

function iconSvg(def) {
  const s = 24;
  const c = def.color;
  switch (def.shape) {
    case 'square':
      return `<svg width="${s}" height="${s}"><rect x="3" y="3" width="18" height="18" fill="${c}"/></svg>`;
    case 'triangle':
      return `<svg width="${s}" height="${s}"><polygon points="12,3 3,21 21,21" fill="${c}"/></svg>`;
    case 'circle':
      return `<svg width="${s}" height="${s}"><circle cx="12" cy="12" r="9" fill="${c}"/></svg>`;
    default:
      return '';
  }
}

function optionList(id, options, labels, value) {
  return options.map((o, i) =>
    `<option value="${o}" ${o === value ? 'selected' : ''}>${labels ? labels[i] : o}</option>`
  ).join('');
}

const ATK_TYPE_LABELS = { damage: 'Damage', heal: 'Heal', taunt: 'Taunt' };
const SHAPE_LABELS = {
  rangeOneShot: 'Range one-shot', rangeAoe: 'Range AOE', meleeOneShot: 'Melee one-shot',
  meleeCone: 'Melee cone', meleeAoe: 'Melee AOE',
};
const MOVE_LABELS = { keepDistance: 'Keep distance', kite: 'Kite', evade: 'Evade', follow: 'Follow', advance: 'Advance', flank: 'Flank', charge: 'Charge', guard: 'Guard', hunt: 'Hunt' };
const RULE_LABELS = { lowestHp: 'Lowest HP', highestHp: 'Highest HP', closest: 'Closest', strongest: 'Strongest', weakest: 'Weakest', mostAtOnce: 'Most at once', threatened: 'Threatened' };

function modifierChips(mods) {
  return mods.map(mid => {
    const def = MODIFIERS.find(x => x.id === mid);
    if (!def) return '';
    return `<span class="chip mod" data-mod="${mid}" title="${def.desc}">${def.label}<button class="chip-x" data-mod="${mid}">×</button></span>`;
  }).join('');
}

function selfPreservationChips(sp) {
  return (sp || []).map(id => {
    const def = SELF_PRESERVATION.find(x => x.id === id);
    if (!def) return '';
    return `<span class="chip sp" data-sp="${id}" title="${def.desc}">${def.label}<button class="chip-x" data-sp="${id}">×</button></span>`;
  }).join('');
}

function memberCard(m) {
  const s = m.stats;
  const a = m.attack;
  const mods = m.modifiers || [];
  const summary = `${ATK_TYPE_LABELS[a.type]} · ${SHAPE_LABELS[a.shape]} · ${MOVE_LABELS[m.movement]}`;
  return `
    <div class="mcard" data-id="${m.id}">
      <div class="mhead">
        <div class="icon">${iconSvg(m)}</div>
        <input class="mname" type="text" value="${m.name}" />
        <span class="msummary">${summary}</span>
        <button class="mdup" title="Duplicate member">⧉</button>
        <button class="mremove" title="Remove member">×</button>
      </div>
      <div class="mbody">
        <div class="row">
          <input class="mcolor" type="color" value="${m.color}" title="Color" />
          <select class="mshape" title="Shape">${optionList('shape', SHAPES, ['Square', 'Triangle', 'Circle'], m.shape)}</select>
          <span class="stat"><i>HP</i><input class="mhp" type="number" value="${s.hp}" min="1" /></span>
          <span class="stat"><i>Arm</i><input class="marmor" type="number" value="${s.armor}" min="0" /></span>
          <span class="stat"><i>Spd</i><input class="mspeed" type="number" value="${s.speed}" min="0.1" step="0.1" /></span>
          <span class="stat"><i>Sz</i><input class="msize" type="number" value="${s.size}" min="0.2" step="0.1" /></span>
        </div>

        <div class="chip atk" title="Attack">
          <span class="chip-emoji">⚔</span>
          <select class="matktype">${optionList('atktype', ATTACK_TYPES, ['Damage', 'Heal', 'Taunt'], a.type)}</select>
          <select class="matkshape">${optionList('atkshape', ATTACK_SHAPES, ['Range one-shot', 'Range AOE', 'Melee one-shot', 'Melee cone', 'Melee AOE'], a.shape)}</select>
          <span class="chip-num">Rng <input class="matkrange" type="number" value="${a.range}" min="0.5" step="0.1" /></span>
          <span class="chip-num">Pwr <input class="matk" type="number" value="${a.atk}" min="0" /></span>
        </div>

        <div class="chip tgt" title="Targeting">
          <span class="chip-emoji">🎯</span>
          <select class="mtside">${optionList('tside', ['enemy', 'ally'], ['Enemy', 'Ally'], m.target.side)}</select>
          <select class="mtrule">${optionList('trule', TARGET_RULES, ['Lowest HP', 'Highest HP', 'Closest', 'Strongest', 'Weakest', 'Most at once', 'Threatened'], m.target.rule)}</select>
        </div>

        <div class="chip move" title="Movement">
          <span class="chip-emoji">🏃</span>
          <select class="mmove">${optionList('move', MOVEMENTS, ['Hold', 'Keep distance', 'Kite', 'Evade', 'Follow', 'Advance', 'Flank', 'Charge', 'Guard', 'Hunt'], m.movement)}</select>
          <label class="leader-toggle"><input class="mleaderchk" type="checkbox" ${m.leader ? 'checked' : ''} /> Leader</label>
        </div>

        <div class="mod-row">
          <span class="mod-chips">${modifierChips(mods)}</span>
          <button class="add-mod" title="Add modifier">+</button>
        </div>

        <div class="mod-row">
          <span class="mod-chips">${selfPreservationChips(m.selfPreservation)}</span>
          <button class="add-sp" title="Add instinct">+</button>
        </div>
      </div>
    </div>
  `;
}

function updateCardSummary(card) {
  const type = card.querySelector('.matktype').value;
  const shape = card.querySelector('.matkshape').value;
  const move = card.querySelector('.mmove').value;
  card.querySelector('.msummary').textContent =
    `${ATK_TYPE_LABELS[type]} · ${SHAPE_LABELS[shape]} · ${MOVE_LABELS[move]}`;
}

function buildCustomizer() {
  memberListEl.innerHTML = '';
  for (const m of sim.members) {
    const div = document.createElement('div');
    div.innerHTML = memberCard(m);
    memberListEl.appendChild(div.firstElementChild);
  }
}

function readMembers() {
  const cards = memberListEl.querySelectorAll('.mcard');
  const members = [];
  cards.forEach((card, i) => {
    const num = (sel) => parseFloat(card.querySelector(sel).value) || 0;
    const str = (sel) => card.querySelector(sel).value;
    members.push({
      id: 'm' + (i + 1),
      name: str('.mname') || 'Member',
      color: str('.mcolor'),
      shape: str('.mshape'),
      stats: {
        hp: num('.mhp'),
        armor: num('.marmor'),
        speed: num('.mspeed'),
        size: num('.msize'),
      },
      attack: {
        type: str('.matktype'),
        shape: str('.matkshape'),
        range: num('.matkrange'),
        atk: num('.matk'),
      },
      modifiers: Array.from(card.querySelectorAll('.mod-chips .chip.mod')).map(c => c.dataset.mod),
      selfPreservation: Array.from(card.querySelectorAll('.mod-chips .chip.sp')).map(c => c.dataset.sp),
      target: { side: str('.mtside'), rule: str('.mtrule') },
      movement: str('.mmove'),
      leader: card.querySelector('.mleaderchk').checked,
    });
  });
  return members;
}

function applyMembers() {
  sim.members = readMembers();
  sim.reset();
  buildTeamUi();
}

function addMember() {
  const last = sim.members[sim.members.length - 1];
  const m = {
    id: 'm' + (sim.members.length + 1),
    name: 'Member ' + (sim.members.length + 1),
    color: '#94a3b8',
    shape: 'square',
    stats: { hp: 100, armor: 0, speed: 3.0, size: 0.7 },
    attack: { type: 'damage', shape: 'meleeOneShot', range: 1.2, atk: 15 },
    modifiers: [],
    selfPreservation: [],
    target: { side: 'enemy', rule: 'closest' },
    movement: 'advance',
    leader: false,
  };
  sim.members.push(m);
  const div = document.createElement('div');
  div.innerHTML = memberCard(m);
  memberListEl.appendChild(div.firstElementChild);
}

// Duplicate a member: read its current card values and insert a copy after it.
function duplicateMember(card) {
  const members = readMembers();
  const idx = Array.from(memberListEl.querySelectorAll('.mcard')).indexOf(card);
  const src = members[idx];
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = 'm' + (sim.members.length + 1);
  copy.name = src.name + ' copy';
  copy.leader = false;
  sim.members.splice(idx + 1, 0, copy);
  const div = document.createElement('div');
  div.innerHTML = memberCard(copy);
  card.after(div.firstElementChild);
}

// Add a modifier chip to a member card.
function addModifier(card, modId) {
  const container = card.querySelector('.mod-chips');
  if (container.querySelector(`.chip.mod[data-mod="${modId}"]`)) return; // already present
  const def = MODIFIERS.find(x => x.id === modId);
  if (!def) return;
  const chip = document.createElement('span');
  chip.className = 'chip mod';
  chip.dataset.mod = modId;
  chip.title = def.desc;
  chip.innerHTML = `${def.label}<button class="chip-x" data-mod="${modId}">×</button>`;
  container.appendChild(chip);
}

// Add a self-preservation instinct chip to a member card.
function addSelfPreservation(card, spId) {
  const container = card.querySelectorAll('.mod-chips')[1];
  if (container.querySelector(`.chip.sp[data-sp="${spId}"]`)) return; // already present
  const def = SELF_PRESERVATION.find(x => x.id === spId);
  if (!def) return;
  const chip = document.createElement('span');
  chip.className = 'chip sp';
  chip.dataset.sp = spId;
  chip.title = def.desc;
  chip.innerHTML = `${def.label}<button class="chip-x" data-sp="${spId}">×</button>`;
  container.appendChild(chip);
}

customizerEl.addEventListener('click', (e) => {
  // Toggle a member card's expanded/collapsed state.
  if (e.target.classList.contains('mhead') || (e.target.closest('.mhead') && !e.target.closest('.mremove') && !e.target.closest('.mname') && !e.target.closest('.mdup'))) {
    const card = e.target.closest('.mcard');
    if (card) card.classList.toggle('collapsed');
    return;
  }
  // Remove a member.
  if (e.target.classList.contains('mremove')) {
    const card = e.target.closest('.mcard');
    if (memberListEl.querySelectorAll('.mcard').length <= 1) return;
    card.remove();
    return;
  }
  // Duplicate a member.
  if (e.target.classList.contains('mdup')) {
    const card = e.target.closest('.mcard');
    duplicateMember(card);
    return;
  }
  // Remove a modifier or instinct chip.
  if (e.target.classList.contains('chip-x')) {
    e.target.closest('.chip').remove();
    return;
  }
  // Add a modifier: show a small inline picker.
  if (e.target.classList.contains('add-mod')) {
    const card = e.target.closest('.mcard');
    const existing = Array.from(card.querySelectorAll('.mod-chips .chip.mod')).map(c => c.dataset.mod);
    const available = MODIFIERS.filter(m => !existing.includes(m.id));
    if (available.length === 0) return;
    showModPicker(e.target, available, (modId) => addModifier(card, modId));
  }
  // Add a self-preservation instinct.
  if (e.target.classList.contains('add-sp')) {
    const card = e.target.closest('.mcard');
    const existing = Array.from(card.querySelectorAll('.mod-chips .chip.sp')).map(c => c.dataset.sp);
    const available = SELF_PRESERVATION.filter(m => !existing.includes(m.id));
    if (available.length === 0) return;
    showModPicker(e.target, available, (id) => addSelfPreservation(card, id));
  }
});

// A small popup listing available modifiers to attach.
function showModPicker(anchor, available, onPick) {
  closeModPicker();
  const menu = document.createElement('div');
  menu.className = 'mod-picker';
  for (const m of available) {
    const item = document.createElement('button');
    item.className = 'mod-picker-item';
    item.innerHTML = `<strong>${m.label}</strong><span>${m.desc}</span>`;
    item.addEventListener('click', () => { onPick(m.id); closeModPicker(); });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  // Position above the anchor if there isn't room below (the customizer sits
  // at the bottom of the screen, so a downward popup would fall off-screen).
  const menuH = menu.offsetHeight;
  const spaceBelow = window.innerHeight - r.bottom;
  if (spaceBelow < menuH + 8 && r.top > menuH + 8) {
    menu.style.top = (r.top - menuH - 4) + 'px';
  } else {
    menu.style.top = (r.bottom + 4) + 'px';
  }
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu._anchor = anchor;
}

function closeModPicker() {
  document.querySelectorAll('.mod-picker').forEach(el => el.remove());
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.mod-picker') && !e.target.closest('.add-mod') && !e.target.closest('.add-sp')) {
    closeModPicker();
  }
});

// Live-update the card summary line when attack/movement selections change.
customizerEl.addEventListener('change', (e) => {
  if (e.target.matches('.matktype, .matkshape, .mmove')) {
    const card = e.target.closest('.mcard');
    if (card) updateCardSummary(card);
  }
});

document.getElementById('btn-add-member').addEventListener('click', addMember);
document.getElementById('btn-apply').addEventListener('click', applyMembers);

const btnToggleCustomizer = document.getElementById('btn-toggle-customizer');
btnToggleCustomizer.addEventListener('click', () => {
  const collapsed = customizerEl.classList.toggle('collapsed');
  btnToggleCustomizer.textContent = collapsed ? 'Show' : 'Hide';
});

// --- Team UI (bottom bar) ---

function buildTeamUi() {
  teamUiEl.innerHTML = '';
  memberEls.clear();
  for (const m of sim.members) {
    const root = document.createElement('div');
    root.className = 'member';
    root.innerHTML = `
      <div class="icon">${iconSvg(m)}</div>
      <div class="info">
        <div class="name">${m.name}</div>
        <div class="ability">${m.attack.type} · ${m.attack.shape} · ${m.movement}</div>
        <div class="hpbar"><div class="hpfill"></div></div>
      </div>
    `;
    teamUiEl.appendChild(root);
    memberEls.set(m.id, {
      root,
      hpfill: root.querySelector('.hpfill'),
    });
  }
}

buildCustomizer();
buildTeamUi();

const dt = 1 / CONFIG.sim.hz;
let accumulator = 0;
let lastTime = performance.now();

function frame(now) {
  const elapsed = (now - lastTime) / 1000;
  lastTime = now;
  accumulator += Math.min(elapsed, 0.1);

  let steps = 0;
  while (accumulator >= dt && steps < CONFIG.sim.maxSubSteps) {
    sim.step(dt);
    accumulator -= dt;
    steps++;
  }
  if (steps === CONFIG.sim.maxSubSteps) accumulator = 0;

  renderer.render(sim);
  updateHud();
  updateTeamUi();
  updateMap();
  updateDebug();
  updateRest();
  requestAnimationFrame(frame);
}

function updateHud() {
  if (sim.over === 'win') {
    statusEl.textContent = 'Victory! Team reached the exit.';
    statusEl.className = 'status win';
  } else if (sim.over === 'lose') {
    statusEl.textContent = 'Defeat! The team was wiped out.';
    statusEl.className = 'status lose';
  } else if (sim.mapOpen) {
    statusEl.textContent = 'Choose your next room';
    statusEl.className = 'status';
  } else if (sim.restOpen) {
    statusEl.textContent = 'Rest — recruit an ally';
    statusEl.className = 'status';
  } else if (sim.started) {
    statusEl.textContent = 'Level ' + sim.level + ' — fighting...';
    statusEl.className = 'status';
  } else {
    statusEl.textContent = 'Level ' + sim.level + ' — press Space to start';
    statusEl.className = 'status';
  }
}

function updateTeamUi() {
  for (const m of sim.members) {
    const el = memberEls.get(m.id);
    if (!el) continue;
    const u = sim.playerUnits.find(p => p.def.id === m.id);
    if (sim.deadIds.has(m.id)) {
      el.root.classList.add('dead');
      el.hpfill.style.width = '0%';
      continue;
    }
    if (!u) {
      el.root.classList.remove('dead');
      el.hpfill.style.width = '100%';
      continue;
    }
    el.root.classList.toggle('dead', !u.alive);
    el.hpfill.style.width = Math.round((u.hp / u.maxHp) * 100) + '%';
  }
}

btnStart.addEventListener('click', () => sim.start());
btnRestart.addEventListener('click', () => sim.reset());

// --- Debug panel ---

const PLAY_LABELS = {
  focus: 'Focus fire',
  backline: 'Focus backline',
  retreat: 'Retreat',
  hold: 'Hold the line',
  scatter: 'Scatter',
};

const PLAY_DESC = {
  focus: 'Concentrate damage on one target',
  backline: 'Focus the exposed squishy enemy',
  retreat: 'Fall back to the exit to regroup',
  hold: 'Dig in and defend, don\'t push',
  scatter: 'Spread out to avoid AOE',
};

let dbgTab = 'units'; // 'units' | 'bonds' | 'plays'

// Toggle the debug side panel (button + D key stay in sync).
function setDebug(on) {
  renderer.showDebug = on;
  debugPanelEl.classList.toggle('hidden', !on);
  btnDebug.classList.toggle('on', on);
  btnDebug.textContent = on ? 'Debug: On' : 'Debug';
  if (!on) renderer.highlightId = null;
}
btnDebug.addEventListener('click', () => setDebug(!renderer.showDebug));

// Leader plays toggle (off by default).
function setPlays(on) {
  sim.playsEnabled = on;
  btnPlays.classList.toggle('on', on);
  if (!on) sim.play = null;
}
btnPlays.addEventListener('click', () => setPlays(!sim.playsEnabled));

// Tab switching.
debugPanelEl.querySelectorAll('.dbg-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    dbgTab = tab.dataset.tab;
    debugPanelEl.querySelectorAll('.dbg-tab').forEach(t => t.classList.toggle('on', t === tab));
    renderer.highlightId = null;
  });
});

// Pause/resume (button + P key stay in sync).
function setPaused(paused) {
  sim.paused = paused;
  btnPause.textContent = paused ? 'Resume' : 'Pause';
  btnPause.classList.toggle('on', paused);
}
btnPause.addEventListener('click', () => setPaused(!sim.paused));

// Rebuild the debug panel contents each frame. Only the active tab is
// rendered, so the list stays focused and doesn't flicker.
function updateDebug() {
  if (!renderer.showDebug) return;

  // Leader's active play (always shown in the header).
  if (sim.play) {
    const target = sim.units.find(x => x.id === sim.play.targetId);
    const label = PLAY_LABELS[sim.play.type] || sim.play.type;
    dbgPlayEl.textContent = target
      ? `Play: ${label} → ${target.def.name || 'target'}`
      : `Play: ${label}`;
  } else {
    dbgPlayEl.textContent = '';
  }

  if (dbgTab === 'units') renderDebugUnits();
  else if (dbgTab === 'bonds') renderDebugBonds();
  else renderDebugPlays();
}

function renderDebugUnits() {
  const team = sim.playerUnits.filter(u => u.alive);
  const enemies = sim.enemyUnits.filter(e => e.alive);
  let html = '';

  if (team.length) {
    html += '<div class="dbg-section">Team</div>';
    for (const u of team) html += unitCard(u);
  }
  if (enemies.length) {
    html += '<div class="dbg-section">Enemies</div>';
    for (const u of enemies) html += unitCard(u);
  }
  if (!team.length && !enemies.length) {
    html = '<div class="dbg-empty">No units alive</div>';
  }
  dbgBodyEl.innerHTML = html;

  // Hover a card to highlight the matching unit on the canvas.
  dbgBodyEl.querySelectorAll('.dbg-unit').forEach(card => {
    card.addEventListener('mouseenter', () => {
      renderer.highlightId = parseInt(card.dataset.id, 10);
    });
    card.addEventListener('mouseleave', () => {
      if (renderer.highlightId === parseInt(card.dataset.id, 10)) renderer.highlightId = null;
    });
  });
}

function unitCard(u) {
  const hpFrac = u.hp / u.maxHp;
  const hpCls = hpFrac <= 0.25 ? 'dbg-hp low' : 'dbg-hp ok';
  const targetName = u.target && u.target.alive ? (u.target.def.name || 'target') : '—';
  const goal = u.path && u.path.length ? u.path[u.path.length - 1] : null;
  const goalTxt = goal ? `(${goal.x.toFixed(1)}, ${goal.y.toFixed(1)})` : '—';
  return `
    <div class="dbg-unit" data-id="${u.id}">
      <div class="dbg-name">
        <span class="dbg-swatch" style="background:${u.def.color}"></span>
        ${u.def.name || 'unit'}
        <span class="dbg-team">${u.team === 'player' ? 'team' : 'enemy'}</span>
        <span class="${hpCls}">${Math.round(u.hp)}/${u.maxHp}</span>
      </div>
      <div class="dbg-row"><b>Intent</b><span class="dbg-intent">${u.intent || '—'}</span></div>
      <div class="dbg-row"><b>Target</b><span class="dbg-target">${targetName}</span></div>
      <div class="dbg-row"><b>Goal</b><span class="dbg-goal">${goalTxt}</span></div>
    </div>`;
}

function renderDebugBonds() {
  const alive = sim.playerUnits.filter(u => u.alive);
  const pairs = [];
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const bond = sim._getBond(alive[i], alive[j]);
      if (bond <= 0) continue;
      pairs.push({ a: alive[i], b: alive[j], bond });
    }
  }
  pairs.sort((x, y) => y.bond - x.bond);

  let html = '<div class="dbg-section">Pair bonds</div>';
  if (pairs.length === 0) {
    html += '<div class="dbg-empty">No bonds yet — members bond by fighting together</div>';
  } else {
    for (const p of pairs) {
      html += `
        <div class="dbg-bond">
          <span class="dbg-swatch" style="background:${p.a.def.color}"></span>
          ${p.a.def.name || 'unit'}
          <span class="dbg-swatch" style="background:${p.b.def.color}"></span>
          ${p.b.def.name || 'unit'}
          <span class="dbg-bond-val">${Math.round(p.bond)}</span>
        </div>`;
    }
  }
  dbgBodyEl.innerHTML = html;
}

function renderDebugPlays() {
  let html = '<div class="dbg-section">Leader plays</div>';
  if (!sim.play) {
    html += '<div class="dbg-empty">No active play</div>';
  } else {
    const target = sim.units.find(x => x.id === sim.play.targetId);
    const label = PLAY_LABELS[sim.play.type] || sim.play.type;
    const desc = PLAY_DESC[sim.play.type] || '';
    const targetTxt = target ? ` → ${target.def.name || 'target'}` : '';
    const remain = Math.max(0, sim.play.until - sim.time).toFixed(1);
    html += `
      <div class="dbg-play-row">
        <b>${label}</b>${targetTxt}
        <div>${desc}</div>
        <div>${remain}s remaining</div>
      </div>`;
  }
  html += '<div class="dbg-section">Priority</div>';
  html += '<div class="dbg-play-row">Retreat → Hold → Scatter → Backline → Focus</div>';
  dbgBodyEl.innerHTML = html;
}

// --- Map overlay ---

const NODE_COLORS = {
  start: '#64748b', combat: '#f87171', elite: '#fb923c',
  rest: '#4ade80', treasure: '#fbbf24', boss: '#f43f5e',
};
const NODE_LABELS = {
  start: 'Start', combat: 'Fight', elite: 'Elite',
  rest: 'Rest', treasure: 'Treasure', boss: 'Boss',
};

let mapRendered = false;

function updateMap() {
  if (!sim.mapOpen) {
    if (!mapOverlayEl.classList.contains('hidden')) {
      mapOverlayEl.classList.add('hidden');
      mapRendered = false;
    }
    return;
  }
  mapOverlayEl.classList.remove('hidden');
  if (!mapRendered) {
    renderMap();
    mapRendered = true;
  }
}

function renderMap() {
  const { nodes, edges } = sim.map;
  const choices = sim._nextChoices();
  const choiceIds = new Set(choices.map(c => c.id));

  // Layout: columns by floor, rows spread vertically.
  const floors = Math.max(...nodes.map(n => n.floor)) + 1;
  const colW = 120, rowH = 90, pad = 40;
  const width = floors * colW + pad;
  const byFloor = {};
  for (const n of nodes) (byFloor[n.floor] ||= []).push(n);
  const maxRows = Math.max(...Object.values(byFloor).map(a => a.length));
  const height = maxRows * rowH + pad;

  mapSvgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
  mapSvgEl.setAttribute('width', width);
  mapSvgEl.setAttribute('height', height);

  const pos = {};
  for (const n of nodes) {
    const arr = byFloor[n.floor];
    const idx = arr.indexOf(n);
    const x = pad / 2 + n.floor * colW + colW / 2;
    const y = pad / 2 + (idx + (maxRows - arr.length) / 2) * rowH + rowH / 2;
    pos[n.id] = { x, y };
  }

  let svg = '';
  // Edges.
  for (const e of edges) {
    const a = pos[e.from], b = pos[e.to];
    const cls = choiceIds.has(e.to) ? 'map-edge available' : 'map-edge';
    svg += `<line class="${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
  }
  // Nodes.
  for (const n of nodes) {
    const p = pos[n.id];
    const isCurrent = n.id === sim.currentNodeId;
    const isChoice = choiceIds.has(n.id);
    const isDone = n.floor < (sim.map.nodes.find(x => x.id === sim.currentNodeId)?.floor ?? 0);
    const cls = isCurrent ? 'current' : isChoice ? 'available' : isDone ? 'done' : '';
    const color = NODE_COLORS[n.type] || '#64748b';
    svg += `<g class="map-node ${cls}" data-id="${n.id}">
      <circle cx="${p.x}" cy="${p.y}" r="22" fill="${color}" />
      <text x="${p.x}" y="${p.y + 4}">${NODE_LABELS[n.type] || n.type}</text>
    </g>`;
  }
  mapSvgEl.innerHTML = svg;

  // Click handler: choose an available node.
  mapSvgEl.querySelectorAll('.map-node.available').forEach(g => {
    g.addEventListener('click', () => sim.chooseNode(g.dataset.id));
  });
}

// --- Rest overlay ---

let restRendered = false;

function updateRest() {
  if (!sim.restOpen) {
    if (!restOverlayEl.classList.contains('hidden')) {
      restOverlayEl.classList.add('hidden');
      restRendered = false;
    }
    return;
  }
  restOverlayEl.classList.remove('hidden');
  if (!restRendered) {
    renderRest();
    restRendered = true;
  }
}

function renderRest() {
  restCandidatesEl.innerHTML = '';
  for (const c of sim.restCandidates) {
    const el = document.createElement('div');
    el.className = 'rest-candidate';
    el.dataset.id = c.id;
    el.innerHTML = `
      <div class="rc-name">${c.name}</div>
      <div class="rc-stats">HP ${c.stats.hp} · Arm ${c.stats.armor} · Spd ${c.stats.speed.toFixed(1)}</div>
      <div class="rc-attack">${c.attack.type} · ${c.attack.shape} · ${c.movement}</div>
    `;
    el.addEventListener('click', () => {
      sim.recruitMember(c.id);
      el.classList.add('recruited');
    });
    restCandidatesEl.appendChild(el);
  }
}

document.getElementById('btn-finish-rest').addEventListener('click', () => {
  sim.finishRest();
  restRendered = false;
  buildTeamUi();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    sim.start();
  } else if (e.code === 'KeyR') {
    sim.reset();
  } else if (e.code === 'KeyD') {
    setDebug(!renderer.showDebug);
  } else if (e.code === 'KeyP') {
    setPaused(!sim.paused);
  }
});

requestAnimationFrame(frame);
