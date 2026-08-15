// Entry point. Wires sim + render together with a fixed-timestep loop.

import { CONFIG, ATTACK_TYPES, TARGET_RULES, ATTACK_SHAPES, MOVEMENTS, SHAPES, MODIFIERS } from './sim/config.js';
import { Sim } from './sim/sim.js';
import { Renderer } from './render/renderer.js';

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const teamUiEl = document.getElementById('team-ui');
const customizerEl = document.getElementById('customizer');
const memberListEl = document.getElementById('member-list');
const btnStart = document.getElementById('btn-start');
const btnRestart = document.getElementById('btn-restart');

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
const MOVE_LABELS = { hold: 'Hold', keepDistance: 'Keep distance', kite: 'Kite', evade: 'Evade', follow: 'Follow', advance: 'Advance' };
const RULE_LABELS = { lowestHp: 'Lowest HP', highestHp: 'Highest HP', closest: 'Closest', strongest: 'Strongest', weakest: 'Weakest', mostAtOnce: 'Most at once', threatened: 'Threatened' };

function modifierChips(mods) {
  return mods.map(mid => {
    const def = MODIFIERS.find(x => x.id === mid);
    if (!def) return '';
    return `<span class="chip mod" data-mod="${mid}" title="${def.desc}">${def.label}<button class="chip-x" data-mod="${mid}">×</button></span>`;
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
          <select class="mmove">${optionList('move', MOVEMENTS, ['Hold', 'Keep distance', 'Kite', 'Evade', 'Follow', 'Advance'], m.movement)}</select>
          <label class="leader-toggle"><input class="mleaderchk" type="checkbox" ${m.leader ? 'checked' : ''} /> Leader</label>
        </div>

        <div class="mod-row">
          <span class="mod-chips">${modifierChips(mods)}</span>
          <button class="add-mod" title="Add modifier">+</button>
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
  // Remove a modifier chip.
  if (e.target.classList.contains('chip-x')) {
    e.target.closest('.chip.mod').remove();
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
  if (!e.target.closest('.mod-picker') && !e.target.closest('.add-mod')) {
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
  requestAnimationFrame(frame);
}

function updateHud() {
  if (sim.over === 'win') {
    statusEl.textContent = 'Victory! Team reached the exit.';
    statusEl.className = 'status win';
  } else if (sim.over === 'lose') {
    statusEl.textContent = 'Defeat! The team was wiped out.';
    statusEl.className = 'status lose';
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

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    sim.start();
  } else if (e.code === 'KeyR') {
    sim.reset();
  }
});

requestAnimationFrame(frame);
