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

export const MOVEMENTS = ['hold', 'keepDistance', 'kite', 'evade', 'follow', 'advance', 'flank', 'charge', 'guard', 'hunt'];

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

// Self-preservation instincts: situational movement overrides that kick in
// when a member is threatened or hurt. Unlike modifiers (which layer onto an
// attack), these run every frame in the movement phase and override the
// member's normal movement until the danger passes.
export const SELF_PRESERVATION = [
  { id: 'hide',     label: 'Hide',      desc: 'Retreat behind the tankiest ally when threatened' },
  { id: 'seekHeal', label: 'Seek heal', desc: 'Run to the healer when badly hurt' },
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
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'advance', leader: true,
    },
    {
      id: 'm2', name: 'Soldier', color: '#ef4444', shape: 'square',
      stats: { hp: 180, armor: 4, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'meleeCone', range: 1.8, atk: 30 },
      modifiers: ['lifesteal'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'charge', leader: false,
    },
    {
      id: 'm3', name: 'Archer', color: '#22c55e', shape: 'triangle',
      stats: { hp: 100, armor: 0, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'rangeOneShot', range: 7.0, atk: 20 },
      modifiers: ['pierce'],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'lowestHp' },
      movement: 'kite', leader: false,
    },
    {
      id: 'm4', name: 'Healer', color: '#f8fafc', shape: 'circle',
      stats: { hp: 80, armor: 0, speed: 3.0, size: 0.7 },
      attack: { type: 'heal', shape: 'rangeOneShot', range: 6.0, atk: 25 },
      modifiers: [],
      selfPreservation: ['hide'],
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

  // Map (Slay the Spire style): a branching node graph the player navigates
  // between rooms. Each node is a room with a type that changes its content.
  map: {
    floors: 6,              // number of columns (start + middle + boss)
    minPerFloor: 3,         // min nodes per middle floor
    maxPerFloor: 5,         // max nodes per middle floor
    eliteHpMult: 1.6,       // elite bats have more HP
    eliteAtkMult: 1.3,      // elite bats hit harder
    bossHp: 400,            // boss bat HP
    bossAtk: 30,            // boss bat attack
    treasureHpBonus: 10,    // permanent max-HP bonus from a treasure room
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
    separationRadius: 1.1,
    separationWeight: 2.0,
    followDistance: 1.5,    // distance a follower trails behind its leader
    followHysteresis: 0.4,  // dead-zone so follow doesn't oscillate at the boundary
    repathDistance: 1.0,    // goal must move this far before re-running A*
    keepDistance: 3.0,      // distance a keepDistance unit tries to hold
    kiteDistance: 3.0,      // distance at which a kite unit backs away
    evadeDistance: 3.0,     // distance at which an evade unit backs away
    evadeHysteresis: 0.5,   // dead-zone so evade doesn't oscillate
    protectRadius: 2.5,     // enemy within this of a squishy ally triggers protection
    protectEngageRange: 6.0, // how far a peel unit will travel to defend
    accel: 20,              // max speed change per second (smooths movement)
    turnRate: 3.5,          // max facing change per second (radians), smooths turning
    arrivalRadius: 0.6,     // ease to a stop within this distance of a goal
    slowRadius: 3.0,        // begin slowing within this distance of the goal
    minSpeedFactor: 0.25,   // fraction of full speed at the slowest (near goal)
    idleWander: 0.4,        // max speed of the subtle drift while holding still
    idleWanderPeriod: 1.7,  // seconds per full wander oscillation
    keepHysteresis: 0.5,    // dead-zone so keepDistance doesn't oscillate
    kiteHysteresis: 0.5,    // dead-zone so kite doesn't oscillate
    flankDistance: 2.5,     // how far to the side a flank unit circles its target
    chargeSpeedMult: 1.6,   // speed multiplier while a charge unit closes in
    chargeBonus: 15,        // bonus damage on a charge hit
    guardDistance: 2.0,      // distance a guard holds from its guarded ally
    guardEngageRange: 4.0,  // enemy within this of the guarded ally triggers engagement
    hideThreatRange: 4.0,   // enemy within this of the unit triggers hiding
    hideOffset: 1.5,        // how far behind the protector to stand
    healSeekThreshold: 0.4, // hp fraction below which a unit seeks healing
    healSeekHysteresis: 0.1, // dead-zone so seek-heal doesn't oscillate
  },

  // Synergy: persistent pair bonds between members. Bonds grow only from
  // coordinated action (focus fire, protect, heal) and from clearing a room
  // together. They have no stat effect; they bias the AI's decisions toward
  // the bonded ally (who to focus fire with, protect, and heal).
  synergy: {
    focusBond: 4,           // bond growth per hit on a target an ally is also attacking
    peelBond: 8,            // bond growth per peel (defending an ally)
    healBond: 10,           // bond growth per heal
    roomClearBond: 15,      // bond growth between all surviving members on room clear
    focusBias: 3.0,         // how much bond weights focus-fire target choice
    healBiasFactor: 0.5,    // how much bond weights a healer's target choice
    protectBias: 2.0,       // how much bond weights which ally to peel for
    bondCap: 100,           // bond value at which the visual line is fully opaque
  },
};
