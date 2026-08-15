// Central tunable configuration. Everything balance-related lives here so the
// prototype can be tuned without touching logic.

// --- Member attribute vocabulary ---
// These are the options the customizer offers. The sim reads member bundles
// (see `members` below) and behaves generically; there are no fixed classes.

export const ATTACK_TYPES = ['damage', 'heal', 'taunt'];

export const TARGET_RULES = [
  'lowestHp', 'highestHp', 'closest', 'strongest', 'weakest', 'mostAtOnce', 'threatened',
];

export const ATTACK_SHAPES = [
  'rangeOneShot', 'rangeAoe', 'meleeOneShot', 'meleeCone', 'meleeAoe',
];

export const MOVEMENTS = ['hold', 'keepDistance', 'kite', 'evade', 'follow', 'advance'];

export const SHAPES = ['square', 'triangle', 'circle'];

// Modifiers are composable extras attached to a member's primary attack.
// They stack freely and are applied after the base attack resolves.
export const MODIFIERS = [
  { id: 'taunt',     label: 'Taunt',     desc: 'Attacks also taunt nearby enemies' },
  { id: 'lifesteal', label: 'Lifesteal', desc: 'Heal 30% of damage dealt' },
  { id: 'pierce',    label: 'Pierce',    desc: 'Ranged shots hit one enemy behind' },
  { id: 'slow',      label: 'Slow',      desc: 'Halve target speed briefly' },
  { id: 'peel',      label: 'Peel',      desc: 'Rush to defend squishy allies under attack' },
  { id: 'evasive',   label: 'Evasive',   desc: 'Back away from whoever is targeting you' },
];

export const CONFIG = {
  // Simulation
  sim: {
    hz: 30,                 // fixed timestep (updates per second)
    maxSubSteps: 4,         // clamp catch-up steps per frame
  },

  // World geometry (in meters; 1 unit = 1 meter)
  world: {
    width: 32,
    height: 18,
    cellSize: 0.5,          // grid overlay cell size for A*
  },

  // Doors (left-to-right progression: enter left, exit right)
  doors: {
    entrance: { x: 0,  y: 9,  width: 2, orientation: 'vertical' },  // left wall
    exit:     { x: 32, y: 9,  width: 2, orientation: 'vertical' },  // right wall
  },

  // Obstacles (pillars/rocks): axis-aligned rects {x, y, w, h}
  obstacles: [
    { x: 7,  y: 4,  w: 1.5, h: 1.5 },
    { x: 23, y: 4,  w: 1.5, h: 1.5 },
    { x: 7,  y: 12, w: 1.5, h: 1.5 },
    { x: 23, y: 12, w: 1.5, h: 1.5 },
    { x: 15, y: 8,  w: 2,   h: 2 },
  ],

  // Default team members. Each is a bundle of attributes the player can edit
  // in the customizer before starting. Add/remove freely.
  members: [
    {
      id: 'm1', name: 'Tank', color: '#3b82f6', shape: 'square',
      stats: { hp: 300, armor: 8, speed: 2.2, size: 0.9 },
      attack: { type: 'taunt', shape: 'meleeOneShot', range: 4.0, atk: 15 },
      modifiers: ['peel'],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'advance', leader: true,
    },
    {
      id: 'm2', name: 'Soldier', color: '#ef4444', shape: 'square',
      stats: { hp: 180, armor: 4, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'meleeCone', range: 1.8, atk: 30 },
      modifiers: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'follow', leader: false,
    },
    {
      id: 'm3', name: 'Archer', color: '#22c55e', shape: 'triangle',
      stats: { hp: 100, armor: 0, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'rangeOneShot', range: 7.0, atk: 20 },
      modifiers: ['pierce'],
      target: { side: 'enemy', rule: 'lowestHp' },
      movement: 'kite', leader: false,
    },
    {
      id: 'm4', name: 'Healer', color: '#f8fafc', shape: 'circle',
      stats: { hp: 80, armor: 0, speed: 3.0, size: 0.7 },
      attack: { type: 'heal', shape: 'rangeOneShot', range: 6.0, atk: 25 },
      modifiers: [],
      target: { side: 'ally', rule: 'lowestHp' },
      movement: 'keepDistance', leader: false,
    },
  ],

  // Universal secondary attack: every member has a short melee attack so a
  // healer/taunt/ranged unit can still defend itself up close.
  secondary: {
    range: 1.0,             // short melee reach
    atk: 8,                 // damage dealt by the secondary attack
    cooldown: 0.8,
  },

  // Bat definition
  bat: {
    hp: 30, atk: 18, range: 0.8, speed: 4.5, armor: 0,
    color: '#a855f7', shape: 'triangle', size: 0.4,
    count: 8,               // base count for level 1
    countPerLevel: 4,       // extra bats added per level
  },

  // Boids parameters (bats)
  boids: {
    separationRadius: 0.8,
    separationWeight: 1.6,
    cohesionRadius: 2.5,
    cohesionWeight: 0.6,
    alignmentWeight: 0.3,
    seekWeight: 1.0,
    wallWeight: 2.0,
    arrivalRadius: 1.5,     // bats ease off within this distance of their target
    maxForce: 12,
  },

  // Combat
  combat: {
    attackCooldown: 0.8,    // seconds between attacks
    minDamage: 1,
  },

  // Threat / aggro
  threat: {
    tauntDuration: 2.5,
    tauntThreat: 200,       // threat added by a taunt attack
    healThreat: 20,         // threat added to a healer per heal
    backlineBias: 1.5,      // bats prefer squishy targets
    decayPerSec: 20,        // threat fades at this rate
  },

  // Team formation / behavior
  team: {
    separationRadius: 0.7,
    separationWeight: 2.0,
    followDistance: 1.5,    // distance a follower holds from its leader
    keepDistance: 3.0,      // distance a keepDistance unit tries to hold
    kiteDistance: 3.0,      // distance at which a kite unit backs away
    evadeDistance: 3.0,     // distance at which an evade unit backs away
    evadeHysteresis: 0.5,   // dead-zone so evade doesn't oscillate
    protectRadius: 2.5,     // enemy within this of a squishy ally triggers protection
    protectEngageRange: 6.0, // how far a peel unit will travel to defend
    accel: 20,              // max speed change per second (smooths movement)
    keepHysteresis: 0.5,    // dead-zone so keepDistance doesn't oscillate
    kiteHysteresis: 0.5,    // dead-zone so kite doesn't oscillate
  },
};
