// Entry point. Wires sim + render together with a fixed-timestep loop.

import { CONFIG, ATTACK_TYPES, TARGET_RULES, ATTACK_SHAPES, SHAPES, MODIFIERS, SELF_PRESERVATION } from './sim/config.js';
import { Sim } from './sim/sim.js';
import { Renderer } from './render/renderer.js';
import { getMeta, addGold, spendGold, salaryOf, startingHero, rollTavernRecruits, completeRun, resetMeta } from './meta.js';

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const teamUiEl = document.getElementById('team-ui');
const customizerEl = document.getElementById('customizer');
const memberListEl = document.getElementById('member-list');
const btnStart = document.getElementById('btn-start');
const btnRestartRoom = document.getElementById('btn-restart-room');
const btnRestartRun = document.getElementById('btn-restart-run');
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
const shopOverlayEl = document.getElementById('shop-overlay');
const eventOverlayEl = document.getElementById('event-overlay');
const rosterOverlayEl = document.getElementById('roster-overlay');
const rosterGridEl = document.getElementById('roster-grid');
const rosterCountEl = document.getElementById('roster-count');
const btnRosterClear = document.getElementById('btn-roster-clear');
const btnRosterDone = document.getElementById('btn-roster-done');
const goldHudEl = document.getElementById('gold-hud');
const tavernOverlayEl = document.getElementById('tavern-overlay');
const tavernGoldEl = document.getElementById('tavern-gold');
const tavernSubEl = document.getElementById('tavern-sub');
const tavernCompanyEl = document.getElementById('tavern-company');
const tavernProgressEl = document.getElementById('tavern-progress');
const tinderCardWrapEl = document.getElementById('tinder-card-wrap');
const tavernCountEl = document.getElementById('tavern-count');
const btnTavernSkip = document.getElementById('btn-tavern-skip');
const btnTavernHire = document.getElementById('btn-tavern-hire');
const btnTavernLeave = document.getElementById('btn-tavern-leave');
const btnTavernReset = document.getElementById('btn-tavern-reset');
const restGoldEl = document.getElementById('rest-gold');
const btnRestHeal = document.getElementById('btn-rest-heal');
const btnRestUpgrade = document.getElementById('btn-rest-upgrade');
const restUpgradeRowEl = document.getElementById('rest-upgrade-row');
const restUpgradeMembersEl = document.getElementById('rest-upgrade-members');

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

function optionList(id, options, labels, value, tips) {
  return options.map((o, i) =>
    `<option value="${o}" ${o === value ? 'selected' : ''}${tips && tips[i] ? ` title="${tips[i]}"` : ''}>${labels ? labels[i] : o}</option>`
  ).join('');
}

const ATK_TYPE_LABELS = { damage: 'Damage', heal: 'Heal', taunt: 'Taunt', shield: 'Shield', push: 'Push' };
const SHAPE_LABELS = {
  rangeOneShot: 'Range one-shot', rangeAoe: 'Range AOE', meleeOneShot: 'Melee one-shot',
  meleeCone: 'Melee cone', meleeAoe: 'Melee AOE',
};
const RULE_LABELS = { lowestHp: 'Lowest HP', highestHp: 'Highest HP', closest: 'Closest', strongest: 'Strongest', weakest: 'Weakest', mostAtOnce: 'Most at once', threatened: 'Threatened' };

// Plain-language explanations for every buildable keyword. Keyed by the id
// used in the vocab arrays; surfaced as native option tooltips (hover the
// dropdown) and in the in-game glossary ("?" button).
const KEYWORD_DESC = {
  // Attack types
  damage: 'Strike the target for your Pwr as damage.',
  heal: 'Restore Pwr HP to an ally. Costs mana if you have it.',
  taunt: 'Force nearby enemies to attack you for a few seconds.',
  shield: 'Grant an ally a Pwr-sized barrier that absorbs damage.',
  buff: 'Boost an ally\u2019s damage by +50% for 4s.',
  mana: 'Transfer 30 mana to an ally so they can keep casting.',
  summon: 'Raise a disposable minion (up to 2 at once) that rushes the enemy.',
  push: 'Knock the target and nearby enemies far away, scattering them.',
  // Attack shapes
  rangeOneShot: 'Ranged attack that hits a single target.',
  rangeAoe: 'Ranged attack that hits all enemies within range of the target.',
  meleeOneShot: 'Melee attack that hits a single target.',
  meleeCone: 'Melee arc attack that hits enemies in front of you.',
  meleeAoe: 'Melee attack that hits all enemies around you.',
  // Target rules
  lowestHp: 'Target the enemy with the lowest HP.',
  highestHp: 'Target the enemy with the highest HP.',
  closest: 'Target the nearest enemy.',
  strongest: 'Target the enemy with the highest attack power.',
  weakest: 'Target the enemy with the lowest attack power.',
  mostAtOnce: 'Target the spot where an attack will hit the most enemies.',
  threatened: 'Target the enemy that poses the most threat to you.',
  // Self-preservation instincts
  hide: 'Retreat behind your tankiest ally when threatened.',
  seekHeal: 'Run to a healer ally when badly hurt.',
  // Misc
  leader: 'Calls coordinated plays for the whole team, directing focus fire and retreats.',
  confidence: 'How brave this member is (0-1). It falls under pressure, recovers over time toward this base, and drives how much danger the member tolerates before backing off.',
  stamina: 'This member\u2019s stamina pool size. Stamina powers dodging and sprinting.',
  staminaRegen: 'How fast this member\u2019s stamina refills each second. High regen means dodging and sprinting often.',
};

function keywordTip(key) { return KEYWORD_DESC[key] || ''; }

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
  const summary = `${ATK_TYPE_LABELS[a.type]} · ${SHAPE_LABELS[a.shape]}`;
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
          <select class="matktype">${optionList('atktype', ATTACK_TYPES, ATTACK_TYPES.map(t => ATK_TYPE_LABELS[t] || t), a.type, ATTACK_TYPES.map(t => keywordTip(t)))}</select>
          <select class="matkshape">${optionList('atkshape', ATTACK_SHAPES, ['Range one-shot', 'Range AOE', 'Melee one-shot', 'Melee cone', 'Melee AOE'], a.shape, ATTACK_SHAPES.map(s => keywordTip(s)))}</select>
          <span class="chip-num">Rng <input class="matkrange" type="number" value="${a.range}" min="0.5" step="0.1" /></span>
          <span class="chip-num">Pwr <input class="matk" type="number" value="${a.atk}" min="0" /></span>
        </div>

        <div class="chip tgt" title="Targeting">
          <span class="chip-emoji">🎯</span>
          <select class="mtside">${optionList('tside', ['enemy', 'ally'], ['Enemy', 'Ally'], m.target.side)}</select>
          <select class="mtrule">${optionList('trule', TARGET_RULES, ['Lowest HP', 'Highest HP', 'Closest', 'Strongest', 'Weakest', 'Most at once', 'Threatened'], m.target.rule, TARGET_RULES.map(r => keywordTip(r)))}</select>
        </div>

        <div class="chip move" title="Leader">
          <span class="chip-emoji">🧠</span>
          <label class="leader-toggle"><input class="mleaderchk" type="checkbox" ${m.leader ? 'checked' : ''} /> Leader</label>
        </div>

        <div class="chip trait" title="Morale & stamina">
          <span class="chip-emoji">🎗</span>
          <span class="chip-num" title="${keywordTip('confidence')}">Conf <input class="mconfidence" type="number" value="${m.confidence ?? 0.5}" min="0.1" max="1" step="0.05" /></span>
          <span class="chip-num" title="${keywordTip('stamina')}">Stam <input class="mstammax" type="number" value="${(s.stamina && s.stamina.max) || CONFIG.stamina.max}" min="10" /></span>
          <span class="chip-num" title="${keywordTip('staminaRegen')}">Regen <input class="mstamregen" type="number" value="${(s.stamina && s.stamina.regen) || CONFIG.stamina.regen}" min="0" step="1" /></span>
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
  card.querySelector('.msummary').textContent =
    `${ATK_TYPE_LABELS[type]} · ${SHAPE_LABELS[shape]}`;
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
        ...(card.querySelector('.mstammax') ? { stamina: { max: num('.mstammax'), regen: num('.mstamregen') } } : {}),
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
      leader: card.querySelector('.mleaderchk').checked,
      confidence: num('.mconfidence'),
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
    stats: { hp: 100, armor: 0, speed: 3.0, size: 0.7, stamina: { max: 100, regen: 12 } },
    attack: { type: 'damage', shape: 'meleeOneShot', range: 1.2, atk: 15 },
    modifiers: [],
    selfPreservation: [],
    target: { side: 'enemy', rule: 'closest' },
    leader: false,
    confidence: 0.5,
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

// Live-update the card summary line when attack selections change.
customizerEl.addEventListener('change', (e) => {
  if (e.target.matches('.matktype, .matkshape')) {
    const card = e.target.closest('.mcard');
    if (card) updateCardSummary(card);
  }
});

document.getElementById('btn-add-member').addEventListener('click', addMember);
document.getElementById('btn-apply').addEventListener('click', applyMembers);

// --- Glossary ---
const glossaryOverlayEl = document.getElementById('glossary-overlay');
const glossaryBodyEl = document.getElementById('glossary-body');

function glossarySections() {
  return [
    { title: 'Attack types', items: ATTACK_TYPES.map(t => [ATK_TYPE_LABELS[t] || t, keywordTip(t)]) },
    { title: 'Attack shapes', items: ATTACK_SHAPES.map(s => [SHAPE_LABELS[s], keywordTip(s)]) },
    { title: 'Target rules', items: TARGET_RULES.map(r => [RULE_LABELS[r], keywordTip(r)]) },
    { title: 'Modifiers', items: MODIFIERS.map(m => [m.label, m.desc]) },
    { title: 'Instincts', items: SELF_PRESERVATION.map(m => [m.label, m.desc]) },
    { title: 'Traits', items: [['Confidence', keywordTip('confidence')], ['Stamina', keywordTip('stamina')], ['Stamina regen', keywordTip('staminaRegen')]] },
  ].filter(s => s.items.every(([, d]) => d));
}

function renderGlossary() {
  glossaryBodyEl.innerHTML = glossarySections().map(s => `
    <div class="glossary-group-title">${s.title}</div>
    ${s.items.map(([name, desc]) => `<div class="glossary-item"><b>${name}</b><span>${desc}</span></div>`).join('')}
  `).join('');
  glossaryOverlayEl.classList.remove('hidden');
}

document.getElementById('btn-glossary').addEventListener('click', renderGlossary);
document.getElementById('btn-glossary-close').addEventListener('click', () => glossaryOverlayEl.classList.add('hidden'));
glossaryOverlayEl.addEventListener('click', (e) => {
  if (e.target === glossaryOverlayEl) glossaryOverlayEl.classList.add('hidden');
});

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
        <div class="name"><span class="conf" title="Confidence"></span>${m.name}</div>
        <div class="ability">${m.attack.type} · ${m.attack.shape}</div>
        <div class="status"></div>
        <div class="bar"><span class="barlabel">HP</span><div class="hpbar"><div class="hpfill"></div></div></div>
        <div class="bar"><span class="barlabel">ST</span><div class="stambar"><div class="stamfill"></div></div></div>
        <div class="confrow"><span class="barlabel">CF</span><div class="confbar"><div class="conffill"></div></div><span class="conflabel"></span></div>
      </div>
    `;
    teamUiEl.appendChild(root);
    memberEls.set(m.id, {
      root,
      hpfill: root.querySelector('.hpfill'),
      stamfill: root.querySelector('.stamfill'),
      status: root.querySelector('.status'),
      conf: root.querySelector('.conf'),
      conffill: root.querySelector('.conffill'),
      conflabel: root.querySelector('.conflabel'),
    });
  }
}

buildCustomizer();
buildTeamUi();

// --- Character selection (roster) ---
// Before the run starts, the player picks up to 4 classes from the roster.
// Selections seed the customizer with ready-made builds that can be tweaked.

const MAX_PARTY = 4;
const selectedRoster = new Set(); // roster ids chosen for the party

function rosterCard(c) {
  const s = c.stats;
  const a = c.attack;
  const selected = selectedRoster.has(c.id);
  return `
    <div class="roster-card ${selected ? 'selected' : ''}" data-id="${c.id}">
      <div class="rc-head">
        <div class="icon">${iconSvg(c)}</div>
        <span class="rc-name">${c.name}</span>
        <span class="rc-role">${c.role}</span>
      </div>
      <div class="rc-blurb">${c.blurb}</div>
      <div class="rc-stats">HP ${s.hp} · Arm ${s.armor} · Spd ${s.speed.toFixed(1)}</div>
      <div class="rc-attack" title="${keywordTip(a.type)}">${ATK_TYPE_LABELS[a.type]} · ${SHAPE_LABELS[a.shape]}</div>
      <div class="rc-trait">Conf ${c.confidence ?? 0.5} · Stam ${(s.stamina && s.stamina.max) || CONFIG.stamina.max}</div>
      <div class="rc-pick">${selected ? 'Selected' : 'Add to party'}</div>
    </div>`;
}

function renderRoster() {
  rosterGridEl.innerHTML = CONFIG.roster.map(rosterCard).join('');
  updateRosterFooter();
}

function updateRosterFooter() {
  const n = selectedRoster.size;
  rosterCountEl.textContent = `${n} / ${MAX_PARTY} selected`;
  btnRosterDone.disabled = n === 0;
}

// Apply the selected roster to the sim's members and rebuild the UI.
function applyRoster() {
  const chosen = CONFIG.roster.filter(c => selectedRoster.has(c.id));
  sim.members = chosen.map(c => ({ ...c }));
  sim.reset();
  buildCustomizer();
  buildTeamUi();
}

// --- Tavern (meta) ---
// The persistent hub between runs: swipe through adventurers one at a time
// (Tinder style), recruit the ones you want with banked gold, or skip them.
// Survivors return to the tavern afterwards.

const TAVERN_POOL = 5; // adventurers offered per tavern visit

let tavernRecruits = rollTavernRecruits(TAVERN_POOL); // candidates in the tavern
let tavernIndex = 0;                                  // which candidate is on the table

function roleOf(m) {
  const t = m.attack.type, side = m.target && m.target.side;
  if (t === 'taunt') return side === 'ally' ? 'Protector' : 'Frontline Tank';
  if (t === 'heal' || t === 'shield' || t === 'buff' || t === 'mana') return 'Support';
  if (t === 'summon') return 'Summoner';
  if (t === 'push') return 'Disruptor';
  if (t === 'damage') return m.attack.shape && m.attack.shape.startsWith('range') ? 'Ranged DPS' : 'Melee Fighter';
  return 'Adventurer';
}

// Natural-language recruiting pitch: what they do, their standout strength,
// their weakness, and any unique tricks. Reads like a person, not a sheet.
const TRICK_PHRASE = {
  taunt: 'taunt nearby enemies',
  lifesteal: 'heal off the damage they deal',
  pierce: 'hit an enemy behind their target',
  slow: 'slow their target',
  peel: 'rush to defend squishy allies',
  evasive: 'back away from whoever targets them',
  burn: 'ignite targets, dealing damage over time',
  stun: 'stun their target',
  thorns: 'reflect melee damage back at attackers',
  execute: 'finish off enemies below half health',
  hide: 'retreat behind the tankiest ally when threatened',
  seekHeal: 'run to the healer when badly hurt',
};

const ATTACK_VERB = {
  damage: 'Strikes',
  heal: 'Heals',
  taunt: 'Taunts',
  shield: 'Shields',
  buff: 'Buffs',
  mana: 'Feeds mana to',
  push: 'Pushes',
};

function targetPhrase(m) {
  const side = m.target.side === 'ally' ? 'ally' : 'enemy';
  const plural = m.target.side === 'ally' ? 'allies' : 'enemies';
  switch (m.target.rule) {
    case 'lowestHp': return `the ${side} with the lowest HP`;
    case 'highestHp': return `the ${side} with the highest HP`;
    case 'closest': return `the closest ${side}`;
    case 'strongest': return `the strongest ${side}`;
    case 'weakest': return `the weakest ${side}`;
    case 'mostAtOnce': return `the most ${plural} at once`;
    case 'threatened': return `threatened ${plural}`;
    default: return `the ${side}`;
  }
}

function tavernBlurb(m) {
  const s = m.stats, a = m.attack;
  const sentences = [];
  if (a.type === 'summon') {
    sentences.push('Summons a minion to rush the enemy.');
  } else {
    const verb = ATTACK_VERB[a.type] || 'Attacks';
    sentences.push(`${verb} ${targetPhrase(m)}.`);
  }

  const scale = { damage: 60, range: 9, hp: 400, armor: 10, speed: 4.5, mana: 160 };
  const cands = [
    ['damage', a.atk || 0, scale.damage],
    ['range', a.range, scale.range],
    ['hp', s.hp, scale.hp],
    ['armor', s.armor, scale.armor],
    ['speed', s.speed, scale.speed],
  ];
  if (s.mana) cands.push(['mana', s.mana.max, scale.mana]);
  const sorted = cands.slice().sort((x, y) => y[1] / y[2] - x[1] / x[2]);
  const best = sorted[0], worst = sorted[sorted.length - 1];

  const bPct = best[1] / best[2];
  if (bPct >= 0.85) sentences.push(`Their ${best[0]} is the best in the tavern.`);
  else if (bPct >= 0.6) sentences.push(`Their ${best[0]} is a real strength.`);
  else sentences.push(`Their ${best[0]} is dependable, if not flashy.`);

  if (worst[1] / worst[2] < 0.4) sentences.push(`But their ${worst[0]} is on the low side.`);

  const tricks = [...(m.modifiers || []), ...(m.selfPreservation || [])]
    .map(id => TRICK_PHRASE[id]).filter(Boolean);
  if (tricks.length) {
    const joined = tricks.length === 1 ? tricks[0]
      : tricks.slice(0, -1).join(', ') + ', and ' + tricks[tricks.length - 1];
    sentences.push(`They can ${joined}.`);
  }

  const conf = Math.round((m.confidence ?? 0.5) * 100);
  sentences.push(`${conf}% brave.`);

  return sentences.join(' ');
}

function tinderCard(m) {
  const salary = m.salary ?? salaryOf(m);
  const owned = m._owned;
  const costBadge = owned
    ? '<span class="tc-cost owned">Owned</span>'
    : `<span class="tc-cost">🪙 ${salary}</span>`;

  return `
    <div class="tinder-card" data-id="${m.id}">
      <div class="tc-head">
        <div class="icon">${iconSvg(m)}</div>
        <span class="tc-name">${m.name}</span>
        <span class="tc-role">${roleOf(m)}</span>
        ${costBadge}
      </div>
      <div class="tc-cap">${tavernBlurb(m)}</div>
    </div>`;
}

function currentCandidate() {
  return tavernIndex < tavernRecruits.length ? tavernRecruits[tavernIndex] : null;
}

function renderTavern() {
  const meta = getMeta();
  tavernGoldEl.textContent = '🪙 ' + meta.gold;
  const owns = (id) => meta.heroes.some(h => h.id === id) || meta.known.some(k => k.id === id);

  // Company already owned (fieldable).
  const company = [...meta.heroes, ...meta.known];
  tavernCompanyEl.innerHTML = company.map(m => {
    const c = { ...m, _owned: true, salary: salaryOf(m) };
    return `<div class="tavern-hire-card owned" data-id="${m.id}">
      <div class="th-head">
        <div class="icon">${iconSvg(m)}</div>
        <span class="th-name">${m.name}</span>
        <span class="th-role">${roleOf(m)}</span>
      </div>
      <div class="th-stats">${m.attack ? (ATK_TYPE_LABELS[m.attack.type] || m.attack.type) + ' · ' + (SHAPE_LABELS[m.attack.shape] || m.attack.shape) : ''}</div>
      <div class="th-buy">Owned</div>
    </div>`;
  }).join('');

  const cand = currentCandidate();
  const remaining = tavernRecruits.length - tavernIndex;
  tavernProgressEl.textContent = remaining > 0 ? `${remaining} left` : 'done';

  if (cand) {
    const c = { ...cand, salary: salaryOf(cand), _owned: owns(cand.id) };
    tinderCardWrapEl.innerHTML = tinderCard(c);
    const affordable = c._owned || meta.gold >= c.salary;
    btnTavernHire.disabled = !affordable;
    btnTavernHire.textContent = c._owned ? 'Advance →' : `Recruit — 🪙 ${c.salary}`;
    btnTavernSkip.disabled = false;
  } else {
    tinderCardWrapEl.innerHTML = '<div class="tinder-empty">No more adventurers to review.<br>Take your company and start the run.</div>';
    btnTavernHire.disabled = true;
    btnTavernHire.textContent = 'Recruit';
    btnTavernSkip.disabled = true;
  }

  tavernCountEl.textContent = `${company.length} in your company · ${meta.wins}/${meta.runs} runs won`;
  btnTavernLeave.disabled = company.length === 0;
}

function showTavern(message) {
  if (message) tavernSubEl.textContent = message;
  renderTavern();
  tavernOverlayEl.classList.remove('hidden');
  mapOverlayEl.classList.add('hidden');
  restOverlayEl.classList.add('hidden');
  shopOverlayEl.classList.add('hidden');
  eventOverlayEl.classList.add('hidden');
}

function advanceTinder() {
  tavernIndex += 1;
  renderTavern();
}

btnTavernHire.addEventListener('click', () => {
  const cand = currentCandidate();
  if (!cand) return;
  const meta = getMeta();
  if (meta.heroes.some(h => h.id === cand.id) || meta.known.some(k => k.id === cand.id)) {
    // Already owned: just move on.
    advanceTinder();
    return;
  }
  const salary = salaryOf(cand);
  if (meta.gold < salary) return;
  addGold(-salary);
  meta.heroes.push(cand); // buy the hire outright, owned from now on
  advanceTinder();
});

btnTavernSkip.addEventListener('click', () => {
  if (!currentCandidate()) return;
  advanceTinder();
});

btnTavernReset.addEventListener('click', () => {
  resetMeta();
  tavernRecruits = rollTavernRecruits(TAVERN_POOL);
  tavernIndex = 0;
  showTavern('Save wiped. A fresh purse and a clean slate.');
});

btnTavernLeave.addEventListener('click', () => {
  const meta = getMeta();
  // The company you own becomes the party for this run.
  const party = [...meta.heroes, ...meta.known].map(m => {
    const clone = { ...m, stats: { ...m.stats } };
    if (clone.stats) clone.stats.currentHp = clone.stats.hp; // fresh run, full health
    return clone;
  });
  if (party.length === 0) return;
  sim.members = party;
  sim.reset();
  buildCustomizer();
  buildTeamUi();
  tavernOverlayEl.classList.add('hidden');
  statusEl.textContent = 'Level 1 — press Space to start';
  statusEl.className = 'status';
});

rosterGridEl.addEventListener('click', (e) => {
  const card = e.target.closest('.roster-card');
  if (!card) return;
  const id = card.dataset.id;
  if (selectedRoster.has(id)) {
    selectedRoster.delete(id);
  } else {
    if (selectedRoster.size >= MAX_PARTY) return;
    selectedRoster.add(id);
  }
  renderRoster();
});

btnRosterClear.addEventListener('click', () => {
  selectedRoster.clear();
  renderRoster();
});

btnRosterDone.addEventListener('click', () => {
  applyRoster();
  rosterOverlayEl.classList.add('hidden');
});

// Show the tavern on first load (before any run has started).
showTavern('Welcome back. Hire a company and start a run.');

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

  renderer.render(sim, elapsed);
  updateHud();
  updateTeamUi();
  updateMap();
  updateDebug();
  updateRest();
  updateShop();
  updateEvent();
  updateGoldHud();
  updateRunOver();
  requestAnimationFrame(frame);
}

// Run gold in the HUD (the meta gold shows in the tavern).
function updateGoldHud() {
  goldHudEl.textContent = '🪙 ' + sim.gold;
}

// When a run ends, automatically open the tavern for the next cycle.
let runOverHandled = false;
function updateRunOver() {
  if (sim.over && !runOverHandled) {
    runOverHandled = true;
    showTavern(sim.over === 'win'
      ? 'Victory! The survivors have returned and are ready to be hired again.'
      : 'The company fell. Return with what you earned.');
  } else if (!sim.over) {
    runOverHandled = false;
  }
}

function updateHud() {
  if (sim.over === 'win') {
    statusEl.textContent = 'Victory! The boss is slain. Return to the tavern.';
    statusEl.className = 'status win';
  } else if (sim.over === 'lose') {
    statusEl.textContent = 'Defeat! The company was wiped out. Return to the tavern.';
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
      el.stamfill.style.width = '0%';
      el.stamfill.classList.remove('sprinting');
      el.status.textContent = 'dead';
      el.conf.style.background = '#f87171';
      el.conffill.style.width = '0%';
      el.conffill.style.background = '#f87171';
      el.conflabel.textContent = '—';
      continue;
    }
    if (!u) {
      el.root.classList.remove('dead');
      el.hpfill.style.width = '100%';
      el.stamfill.style.width = '100%';
      el.stamfill.classList.remove('sprinting');
      el.status.textContent = 'waiting';
      el.conf.style.background = '#888';
      el.conffill.style.width = '0%';
      el.conffill.style.background = '#888';
      el.conflabel.textContent = '—';
      continue;
    }
    el.root.classList.toggle('dead', !u.alive);
    el.hpfill.style.width = Math.round((u.hp / u.maxHp) * 100) + '%';
    el.stamfill.style.width = Math.round((u.stamina / u.staminaMax) * 100) + '%';
    el.stamfill.classList.toggle('sprinting', !!u.sprinting);

    // Confidence dot: green = bold, amber = nervous, red = shaken.
    const c = u.confidence;
    el.conf.style.background = c > 0.6 ? '#4ade80' : c > 0.4 ? '#fbbf24' : '#f87171';
    el.conf.style.color = el.conf.style.background;
    // Confidence bar: a readable fill + percentage label.
    el.conffill.style.width = Math.round(c * 100) + '%';
    el.conffill.style.background = c > 0.6 ? '#4ade80' : c > 0.4 ? '#fbbf24' : '#f87171';
    el.conflabel.textContent = Math.round(c * 100) + '%';

    // Status line: what they're doing, and who they're doing it to.
    let status = u.intent || '—';
    if (u.target && u.target.alive) {
      const tname = u.target.def.name || 'target';
      status += ` <span class="st-target">→ ${tname}</span>`;
    }
    el.status.innerHTML = status;
  }
}

btnStart.addEventListener('click', () => {
  // If the tavern is still open, route through it.
  if (!tavernOverlayEl.classList.contains('hidden')) {
    btnTavernLeave.click();
    return;
  }
  if (sim.over) {
    // A run just ended; return to the tavern to start the next cycle.
    showTavern('The run is over. Spend your earnings or head out again.');
    return;
  }
  sim.start();
});
btnRestartRoom.addEventListener('click', () => sim.restartRoom());
btnRestartRun.addEventListener('click', () => sim.reset());

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

let dbgTab = 'units'; // 'units' | 'bonds' | 'plays' | 'intel'

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

// Overlay layer toggles (pills). Each maps to a renderer.show* flag; the
// pill's .on class mirrors the flag so the UI stays in sync.
const LAYER_FLAG = {
  aggro: 'showAggro',
  confidence: 'showConfidence',
  backup: 'showBackup',
  safety: 'showSafety',
  targets: 'showTargets',
  intent: 'showIntent',
};
debugPanelEl.querySelectorAll('.dbg-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const flag = LAYER_FLAG[pill.dataset.layer];
    renderer[flag] = !renderer[flag];
    pill.classList.toggle('on', renderer[flag]);
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
  else if (dbgTab === 'intel') renderDebugIntel();
  else renderDebugPlays();
}

function renderDebugUnits() {
  const team = sim.playerUnits.filter(u => u.alive);
  const enemies = sim.enemyUnits.filter(e => e.alive);
  let html = '';

  if (team.length) {
    html += `<div class="dbg-section">Team — morale ${Math.round(sim.morale * 100)}%</div>`;
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

  // --- Combat state ---
  // Threat: which enemies are focusing this unit (the data behind the Aggro
  // overlay). Sorted highest first so the biggest threat is always visible.
  let threatHtml = '';
  if (u.threat && u.threat.size) {
    const rows = [...u.threat.entries()]
      .map(([id, v]) => ({ id, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
      .map(({ id, v }) => {
        const e = sim.units.find(x => x.id === id);
        const name = e ? (e.def.name || 'enemy') : '?';
        return `${name} ${v.toFixed(0)}`;
      })
      .join(' · ');
    threatHtml = `<div class="dbg-row"><b>Threat</b><span class="dbg-aggro">${rows}</span></div>`;
  }
  // Target score breakdown: why this target was picked (player only).
  let scoreHtml = '';
  if (u.team === 'player' && u.targetScore && u.target && u.target.alive) {
    const s = u.targetScore;
    const terms = [
      s.bond > 0 ? `bond +${s.bond.toFixed(1)}` : null,
      s.allyFocus > 0 ? `allies +${s.allyFocus.toFixed(1)}` : null,
      s.tankEngaging > 0 ? `tank +${s.tankEngaging.toFixed(1)}` : null,
      s.offTank > 0 ? `off-tank +${s.offTank.toFixed(1)}` : null,
      s.pounce > 0 ? `pounce +${s.pounce.toFixed(1)}` : null,
      s.danger < 0 ? `danger ${s.danger.toFixed(1)}` : null,
      s.finish > 0 ? `finish +${s.finish.toFixed(1)}` : null,
      s.weakest > 0 ? `weak +${s.weakest.toFixed(1)}` : null,
    ].filter(Boolean).join(' ');
    scoreHtml = `<div class="dbg-row"><b>Score</b><span class="dbg-target">${s.total.toFixed(1)} · ${terms || '—'}</span></div>`;
  }

  // --- Morale state ---
  // Confidence: current boldness/shaken-ness (the data behind the Confidence
  // overlay). Player only.
  let moraleHtml = '';
  if (u.team === 'player') {
    const confPct = Math.round(u.confidence * 100);
    const confCls = u.confidence < 0.4 ? 'dbg-hp low' : u.confidence > 0.6 ? 'dbg-hp ok' : '';
    moraleHtml += `<div class="dbg-row"><b>Confidence</b><span class="${confCls}">${confPct}%</span></div>`;
    // Safety direction, if this member is retreating this frame.
    if (u.safetyDir && (u.safetyDir.x !== 0 || u.safetyDir.y !== 0)) {
      moraleHtml += `<div class="dbg-row"><b>Safety</b><span class="dbg-goal">(${u.safetyDir.x.toFixed(2)}, ${u.safetyDir.y.toFixed(2)})</span></div>`;
    }
    // Commitment: how hard this member is pushing toward its goal (0..1).
    if (u.commitment !== undefined) {
      const c = Math.round(u.commitment * 100);
      moraleHtml += `<div class="dbg-row"><b>Commit</b><span class="dbg-intent">${c}%</span></div>`;
    }
  }

  return `
    <div class="dbg-unit" data-id="${u.id}">
      <div class="dbg-name">
        <span class="dbg-swatch" style="background:${u.def.color}"></span>
        ${u.def.name || 'unit'}
        <span class="dbg-team">${u.team === 'player' ? 'team' : 'enemy'}</span>
        <span class="${hpCls}">${Math.round(u.hp)}/${u.maxHp}</span>
      </div>
      <div class="dbg-sub">Combat</div>
      <div class="dbg-row"><b>Intent</b><span class="dbg-intent">${u.intent || '—'}</span></div>
      <div class="dbg-row"><b>Target</b><span class="dbg-target">${targetName}</span></div>
      <div class="dbg-row"><b>Goal</b><span class="dbg-goal">${goalTxt}</span></div>
      ${u.team === 'player' ? `<div class="dbg-row"><b>Stamina</b><span class="dbg-intent">${Math.round(u.stamina)}${u.sprinting ? ' · sprinting' : ''}${u.dodgeTimer > 0 ? ' · dodging' : ''}</span></div>` : ''}
      ${threatHtml}
      ${scoreHtml}
      ${moraleHtml ? `<div class="dbg-sub">Morale</div>${moraleHtml}` : ''}
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

  // Backup: which allies are steadying each member (the data behind the
  // Backup overlay). Relational, so it lives here with bonds.
  html += '<div class="dbg-section">Backup</div>';
  const withBackup = alive.filter(u => u.backup && u.backup.parts.length);
  if (withBackup.length === 0) {
    html += '<div class="dbg-empty">No one is being steadied right now</div>';
  } else {
    for (const u of withBackup) {
      html += `
        <div class="dbg-bond">
          <span class="dbg-swatch" style="background:${u.def.color}"></span>
          ${u.def.name || 'unit'}
          <span class="dbg-bond-val">+${u.backup.total.toFixed(1)}</span>
        </div>
        <div class="dbg-row"><span class="dbg-intent">${u.backup.parts.join(', ')}</span></div>`;
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

// Intel tab: the team's shared knowledge about enemy kinds (danger), plus each
// member's personal familiarity and killability that drive the avoid/pounce
// behavior.
function renderDebugIntel() {
  const alive = sim.playerUnits.filter(u => u.alive);
  let html = '<div class="dbg-section">Team knowledge (shared)</div>';
  const kinds = Object.entries(sim.intel).filter(([, r]) => r && r.hitsTaken > 0);
  if (kinds.length === 0) {
    html += '<div class="dbg-empty">The team knows nothing yet — get hit to learn</div>';
  } else {
    for (const [kind, r] of kinds) {
      const avg = (r.dmgTaken / r.hitsTaken).toFixed(1);
      html += `
        <div class="dbg-row">
          <b>${kind}</b>
          <span>avg ${avg} dmg/hit (${r.hitsTaken} hits, ${r.dmgTaken} total)</span>
        </div>`;
    }
  }

  html += '<div class="dbg-section">Member familiarity</div>';
  if (alive.length === 0) {
    html += '<div class="dbg-empty">No members alive</div>';
  } else {
    for (const u of alive) {
      const entries = Object.entries(u.intel).filter(([, r]) => r && (r.hitsTaken > 0 || r.hitsDealt > 0));
      html += `
        <div class="dbg-unit" data-id="${u.id}">
          <div class="dbg-name">
            <span class="dbg-swatch" style="background:${u.def.color}"></span>
            ${u.def.name || 'unit'}
          </div>`;
      if (entries.length === 0) {
        html += '<div class="dbg-row"><span class="dbg-intent">No personal experience yet</span></div>';
      } else {
        for (const [kind, r] of entries) {
          const eff = sim.memberDanger(u, kind).toFixed(1);
          html += `
            <div class="dbg-row">
              <b>${kind}</b>
              <span>hit ${r.hitsTaken}x · dealt ${r.dmgDealt} (${r.hitsDealt}) · eff danger ${eff}</span>
            </div>`;
        }
      }
      html += '</div>';
    }
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

// --- Map overlay ---

const NODE_COLORS = {
  start: '#64748b', combat: '#f87171', elite: '#fb923c',
  rest: '#4ade80', treasure: '#fbbf24', boss: '#f43f5e',
  shop: '#38bdf8', event: '#a78bfa',
};
const NODE_LABELS = {
  start: 'Start', combat: 'Fight', elite: 'Elite',
  rest: 'Rest', treasure: 'Treasure', boss: 'Boss',
  shop: 'Shop', event: 'Event',
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
  mapSvgEl.removeAttribute('width');
  mapSvgEl.removeAttribute('height');

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
  restGoldEl.textContent = '🪙 ' + sim.gold;
  btnRestHeal.disabled = sim.gold < sim.restHealCost || !sim.playerUnits.some(u => u.alive && u.hp < u.maxHp);
  btnRestUpgrade.disabled = sim.gold < sim.restUpgradeCost || sim.playerUnits.filter(u => u.alive).length === 0;

  // Upgrade member chooser.
  const living = sim.playerUnits.filter(u => u.alive);
  restUpgradeMembersEl.innerHTML = living.map(u => `
    <div class="rest-upgrade-chip" data-uid="${u.id}">
      <div class="ru-icon">${iconSvg(u.def)}</div>
      <span>${u.def.name}</span>
      <span class="ru-salary">ATK ${u.def.attack.atk} → ${Math.round(u.def.attack.atk * CONFIG.economy.upgradeAtkMult)}</span>
    </div>`).join('') || '<span class="rest-sub">No living members to upgrade.</span>';
  restUpgradeRowEl.classList.toggle('hidden', living.length === 0);

  // Hire candidates.
  restCandidatesEl.innerHTML = '';
  for (const c of sim.restCandidates) {
    const el = document.createElement('div');
    el.className = 'rest-candidate';
    el.dataset.id = c.id;
    el.innerHTML = `
      <div class="rc-name">${c.name}</div>
      <div class="rc-stats">HP ${c.stats.hp} · Arm ${c.stats.armor} · Spd ${c.stats.speed.toFixed(1)}</div>
      <div class="rc-trait">Conf ${c.confidence ?? 0.5} · Stam ${(c.stats.stamina && c.stats.stamina.max) || CONFIG.stamina.max} · Regen ${(c.stats.stamina && c.stats.stamina.regen) || CONFIG.stamina.regen}</div>
      <div class="rc-attack" title="${keywordTip(c.attack.type)}">${ATK_TYPE_LABELS[c.attack.type] || c.attack.type} · ${SHAPE_LABELS[c.attack.shape] || c.attack.shape}</div>
      <div class="rc-cost" style="color:#fbbf24;font-weight:600;margin-top:auto;">Hire — 🪙 ${c.salary}</div>
    `;
    el.addEventListener('click', () => {
      sim.recruitMember(c.id);
      renderRest(); // refresh gold + affordability
    });
    restCandidatesEl.appendChild(el);
  }
}

btnRestHeal.addEventListener('click', () => {
  sim.restHealAll();
  renderRest();
  buildTeamUi();
});

btnRestUpgrade.addEventListener('click', () => {
  restUpgradeRowEl.classList.toggle('hidden');
});

restUpgradeMembersEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.rest-upgrade-chip');
  if (!chip) return;
  sim.restUpgrade(parseInt(chip.dataset.uid, 10));
  renderRest();
  buildTeamUi();
});

document.getElementById('btn-finish-rest').addEventListener('click', () => {
  sim.finishRest();
  restRendered = false;
  buildTeamUi();
});

// --- Shop overlay ---

const shopGoldEl = document.getElementById('shop-gold');
const shopStockEl = document.getElementById('shop-stock');
let shopRendered = false;

function updateShop() {
  if (!sim.shopOpen) {
    if (!shopOverlayEl.classList.contains('hidden')) {
      shopOverlayEl.classList.add('hidden');
      shopRendered = false;
    }
    return;
  }
  shopOverlayEl.classList.remove('hidden');
  if (!shopRendered) {
    renderShop();
    shopRendered = true;
  }
}

function renderShop() {
  shopGoldEl.textContent = '🪙 ' + sim.gold;
  shopStockEl.innerHTML = '';
  for (const c of sim.shopStock) {
    const el = document.createElement('div');
    el.className = 'rest-candidate';
    el.dataset.id = c.id;
    el.innerHTML = `
      <div class="rc-name">${c.name}</div>
      <div class="rc-stats">HP ${c.stats.hp} · Arm ${c.stats.armor} · Spd ${c.stats.speed.toFixed(1)}</div>
      <div class="rc-trait">Conf ${c.confidence ?? 0.5} · Stam ${(c.stats.stamina && c.stats.stamina.max) || CONFIG.stamina.max} · Regen ${(c.stats.stamina && c.stats.stamina.regen) || CONFIG.stamina.regen}</div>
      <div class="rc-attack" title="${keywordTip(c.attack.type)}">${ATK_TYPE_LABELS[c.attack.type] || c.attack.type} · ${SHAPE_LABELS[c.attack.shape] || c.attack.shape}</div>
      <div class="rc-cost" style="color:#fbbf24;font-weight:600;margin-top:auto;">Hire — 🪙 ${c.salary}</div>
    `;
    el.addEventListener('click', () => {
      sim.shopBuy(c.id);
      renderShop();
      buildTeamUi();
    });
    shopStockEl.appendChild(el);
  }
}

document.getElementById('btn-finish-shop').addEventListener('click', () => {
  sim.finishShop();
  shopRendered = false;
  buildTeamUi();
});

// --- Event overlay ---

const eventTextEl = document.getElementById('event-text');
const eventChoicesEl = document.getElementById('event-choices');
let eventRendered = false;

function updateEvent() {
  if (!sim.eventOpen) {
    if (!eventOverlayEl.classList.contains('hidden')) {
      eventOverlayEl.classList.add('hidden');
      eventRendered = false;
    }
    return;
  }
  eventOverlayEl.classList.remove('hidden');
  if (!eventRendered) {
    renderEvent();
    eventRendered = true;
  }
}

function renderEvent() {
  const choices = sim.eventChoices();
  const resolved = sim.eventState ? sim.eventState.resolved : null;
  eventTextEl.textContent = resolved
    ? (resolved === 'heal' ? 'A soft light washes over your party, mending every wound.' :
       resolved === 'gamble' ? 'You give of your vitality, and coin spills into your purse.' :
       resolved === 'hire' ? 'A grateful adventurer pledges their blade to your cause.' :
       'The shrine grows quiet.')
    : 'In a hidden alcove you find an old shrine, its voice a whisper. What will you offer?';
  eventChoicesEl.innerHTML = choices.map(c => `
    <button class="event-choice" data-id="${c.id}" ${resolved ? 'disabled' : ''}>
      <span class="ec-label">${c.label}</span>
      <span class="ec-effect">${c.effect}</span>
    </button>`).join('');
  eventChoicesEl.querySelectorAll('.event-choice').forEach(b => {
    b.addEventListener('click', () => {
      sim.resolveEvent(b.dataset.id);
      renderEvent();
    });
  });
}

document.getElementById('btn-finish-event').addEventListener('click', () => {
  sim.finishEvent();
  eventRendered = false;
  buildTeamUi();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (!tavernOverlayEl.classList.contains('hidden')) {
      btnTavernLeave.click();
      return;
    }
    if (sim.over) {
      btnStart.click();
      return;
    }
    sim.start();
  } else if (e.code === 'KeyR') {
    btnRestartRoom.click();
  } else if (e.code === 'KeyD') {
    setDebug(!renderer.showDebug);
  } else if (e.code === 'KeyP') {
    setPaused(!sim.paused);
  }
});

requestAnimationFrame(frame);
