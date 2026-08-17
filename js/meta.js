// Persistent meta layer: the tavern, gold, and known characters that survive
// across runs. State is saved to localStorage so the cycle (tavern -> run ->
// survivors return to the tavern) persists across page reloads.

const STORAGE_KEY = 'autobattler.meta.v1';

// A member's hire salary, derived from its power so stronger hires cost more.
export function salaryOf(m) {
  const s = m.stats, a = m.attack;
  return Math.max(15, Math.round(s.hp * 0.03 + a.atk * 1.2 + s.armor * 2 + s.speed * 3));
}

// Default starting party: one hero you always own, free to field.
export function startingHero() {
  return {
    id: 'hero',
    name: 'Veteran',
    color: '#3b82f6', shape: 'square',
    stats: { hp: 320, armor: 10, speed: 2.2, size: 0.9 },
    attack: { type: 'taunt', shape: 'meleeOneShot', range: 4.0, atk: 14 },
    modifiers: ['peel'],
    selfPreservation: [],
    target: { side: 'enemy', rule: 'closest' },
    movement: 'advance', leader: true, confidence: 0.8, stamina: { max: 140, regen: 8 },
    runs: 0, wins: 0,
  };
}

function defaultState() {
  const hero = startingHero();
  return {
    gold: 150,         // tavern currency, carries across runs
    heroes: [hero],    // members you own (hero always free; survivors rehired)
    known: [],         // survivors from past runs who now appear in the tavern
    wins: 0,
    runs: 0,
    bestFloor: 0,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    // Defensive: ensure required fields exist.
    return {
      gold: typeof s.gold === 'number' ? s.gold : 150,
      heroes: Array.isArray(s.heroes) ? s.heroes : [],
      known: Array.isArray(s.known) ? s.known : [],
      wins: s.wins || 0,
      runs: s.runs || 0,
      bestFloor: s.bestFloor || 0,
    };
  } catch (e) {
    return defaultState();
  }
}

let state = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* storage unavailable: run stays in-memory */ }
}

export function getMeta() { return state; }

export function resetMeta() {
  state = defaultState();
  save();
  return state;
}

export function addGold(n) {
  state.gold += n;
  save();
  return state.gold;
}

export function spendGold(n) {
  if (state.gold < n) return false;
  state.gold -= n;
  save();
  return true;
}

// Roll a handful of fresh, random tavern recruits. Returns full member bundles
// with an assigned salary tag and a role guess for the card.
export function rollTavernRecruits(count) {
  const recruits = [];
  const names = ['Rogue', 'Knight', 'Mage', 'Ranger', 'Cleric', 'Berserker', 'Scout', 'Warden',
    'Aria', 'Bram', 'Cora', 'Dax', 'Elara', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jax',
    'Kira', 'Liam', 'Mara', 'Niko', 'Owen', 'Pia', 'Quinn', 'Rhea', 'Soren', 'Tessa',
    'Ulf', 'Vera', 'Wren', 'Xander', 'Yara', 'Zane', 'Bryn', 'Cade', 'Della', 'Emmett',
    'Freya', 'Galen', 'Hazel', 'Ivo', 'Juno', 'Kade', 'Liora', 'Milo', 'Nadia', 'Orin',
    'Petra', 'Ronan', 'Sable', 'Talon', 'Una', 'Vance', 'Willa', 'Yuri', 'Zelda'];
  const colors = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#22d3ee', '#a78bfa', '#f472b6', '#94a3b8'];
  const shapes = ['square', 'triangle', 'circle'];
  const atkTypes = ['damage', 'damage', 'damage', 'damage', 'heal', 'taunt', 'shield', 'buff', 'mana', 'summon', 'push'];
  const atkShapes = ['rangeOneShot', 'rangeAoe', 'meleeOneShot', 'meleeCone', 'meleeAoe'];
  const rules = ['lowestHp', 'highestHp', 'closest', 'strongest', 'weakest', 'mostAtOnce', 'threatened'];
  const modPool = ['taunt', 'lifesteal', 'pierce', 'slow', 'peel', 'evasive', 'burn', 'stun', 'thorns', 'execute'];
  const spPool = ['hide', 'seekHeal'];

  for (let i = 0; i < count; i++) {
    const type = atkTypes[Math.floor(Math.random() * atkTypes.length)];
    const shape = atkShapes[Math.floor(Math.random() * atkShapes.length)];
    const mods = [];
    // Usually one modifier, sometimes two, occasionally a self-preservation instinct.
    if (Math.random() < 0.7) mods.push(modPool[Math.floor(Math.random() * modPool.length)]);
    if (Math.random() < 0.3) mods.push(modPool[Math.floor(Math.random() * modPool.length)]);
    const sp = Math.random() < 0.3 ? [spPool[Math.floor(Math.random() * spPool.length)]] : [];
    const support = type === 'heal' || type === 'shield' || type === 'buff' || type === 'mana' || type === 'summon';
    const m = {
      id: 'rec' + Date.now().toString(36) + i,
      name: names[Math.floor(Math.random() * names.length)],
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: shapes[Math.floor(Math.random() * shapes.length)],
      stats: {
        hp: 80 + Math.floor(Math.random() * 220),
        armor: Math.floor(Math.random() * 9),
        speed: 2 + Math.random() * 2,
        size: 0.6 + Math.random() * 0.4,
        ...(support ? { mana: { max: 100 + Math.floor(Math.random() * 40), cost: 20 + Math.floor(Math.random() * 15) } } : {}),
      },
      attack: {
        type,
        shape,
        range: shape.startsWith('range') ? 4 + Math.random() * 4 : 1 + Math.random() * 2,
        atk: 10 + Math.floor(Math.random() * 25),
      },
      modifiers: mods,
      selfPreservation: sp,
      target: { side: (support && type !== 'taunt' && type !== 'summon') ? 'ally' : 'enemy', rule: rules[Math.floor(Math.random() * rules.length)] },
      leader: false,
      confidence: Math.round((0.2 + Math.random() * 0.7) * 100) / 100,
      stamina: { max: 60 + Math.floor(Math.random() * 80), regen: 6 + Math.floor(Math.random() * 14) },
      runs: 0, wins: 0,
    };
    recruits.push(m);
  }
  return recruits;
}

// Record a finished run: bank the run gold, promote survivors into the tavern
// pool (so they can be rehired next cycle), and update career stats.
// `members` are the party that went in; `deadIds` the ones who died.
export function completeRun(members, deadIds, runGold, floor, result) {
  state.runs += 1;
  if (result === 'win') state.wins += 1;
  state.bestFloor = Math.max(state.bestFloor, floor);
  state.gold += runGold;

  // Survivors become known tavern characters, rehireable at their salary.
  // The dead are gone for good: permadeath applies to everyone, hero included.
  for (const m of members) {
    if (deadIds.has(m.id)) continue;
    m.runs = (m.runs || 0) + 1;
    if (result === 'win') m.wins = (m.wins || 0) + 1;
    const existing = state.known.find(k => k.id === m.id);
    if (existing) {
      Object.assign(existing, m);
    } else {
      state.known.push(m);
    }
  }

  // Remove any owned hero that died this run (permadeath).
  state.heroes = state.heroes.filter(h => !deadIds.has(h.id));

  // If the whole company fell, hand the player a fresh hero so the cycle can
  // always continue. Permadeath is real, but the game stays playable.
  if (state.heroes.length === 0 && state.known.length === 0) {
    state.heroes.push(startingHero());
  }
  save();
}
