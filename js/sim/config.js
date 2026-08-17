// Central tunable configuration. Everything balance-related lives here so the
// prototype can be tuned without touching logic.

// --- Member attribute vocabulary ---
// These are the options the customizer offers. The sim reads member bundles
// (see `members` below) and behaves generically; there are no fixed classes.

export const ATTACK_TYPES = ['damage', 'heal', 'taunt', 'shield', 'buff', 'mana', 'summon', 'push'];

export const TARGET_RULES = [
  'lowestHp', 'highestHp', 'closest', 'strongest', 'weakest', 'mostAtOnce', 'threatened',
];

export const ATTACK_SHAPES = [
  'rangeOneShot', 'rangeAoe', 'meleeOneShot', 'meleeCone', 'meleeAoe',
];

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
  { id: 'burn',      label: 'Burn',      desc: 'Ignite the target, dealing damage over time' },
  { id: 'stun',      label: 'Stun',       desc: 'Briefly immobilize the target' },
  { id: 'thorns',    label: 'Thorns',     desc: 'Reflect a portion of melee damage back at attackers' },
  { id: 'execute',   label: 'Execute',    desc: 'Deal bonus damage to enemies below half health' },
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
      stats: { hp: 320, armor: 10, speed: 2.2, size: 0.9 },
      attack: { type: 'taunt', shape: 'meleeOneShot', range: 4.0, atk: 14 },
      modifiers: ['peel'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'advance', leader: true, personality: 'stoic',
      confidence: 0.8, stamina: { max: 140, regen: 8 },
    },
    {
      id: 'm2', name: 'Soldier', color: '#ef4444', shape: 'square',
      stats: { hp: 130, armor: 3, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'meleeCone', range: 1.8, atk: 22 },
      modifiers: ['lifesteal'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'charge', leader: false, personality: 'cocky',
      confidence: 0.7,
    },
    {
      id: 'm3', name: 'Archer', color: '#22c55e', shape: 'triangle',
      stats: { hp: 75, armor: 0, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'rangeOneShot', range: 7.0, atk: 15 },
      modifiers: ['pierce'],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'lowestHp' },
      movement: 'kite', leader: false, personality: 'cautious',
      confidence: 0.45, stamina: { max: 100, regen: 18 },
    },
    {
      id: 'm4', name: 'Healer', color: '#f8fafc', shape: 'circle',
      stats: { hp: 60, armor: 0, speed: 3.0, size: 0.7, mana: { max: 100, cost: 25 } },
      attack: { type: 'heal', shape: 'rangeOneShot', range: 6.0, atk: 19 },
      modifiers: [],
      selfPreservation: ['hide'],
      target: { side: 'ally', rule: 'lowestHp' },
      movement: 'keepDistance', leader: false, personality: 'cheerful',
      confidence: 0.5,
    },
  ],

  // Roster of predefined classes the player can pick from on the character
  // selection screen. Each is a full member bundle (same shape as `members`),
  // plus a `role` and `blurb` used for the selection card. Picking one seeds
  // the customizer with a ready-made build the player can then tweak.
  roster: [
    {
      id: 'r-tank', name: 'Bulwark', role: 'Tank', color: '#3b82f6', shape: 'square',
      blurb: 'A walking wall. Taunts enemies, soaks damage, and peels for squishy allies.',
      stats: { hp: 320, armor: 10, speed: 2.2, size: 0.9 },
      attack: { type: 'taunt', shape: 'meleeOneShot', range: 4.0, atk: 14 },
      modifiers: ['peel'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'advance', leader: true, personality: 'stoic', confidence: 0.8, stamina: { max: 140, regen: 8 },
    },
    {
      id: 'r-soldier', name: 'Vanguard', role: 'Bruiser', color: '#ef4444', shape: 'square',
      blurb: 'A relentless front-liner. Charges in, cleaves crowds, and heals off every hit.',
      stats: { hp: 130, armor: 3, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'meleeCone', range: 1.8, atk: 22 },
      modifiers: ['lifesteal'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'charge', leader: false, personality: 'cocky', confidence: 0.7,
    },
    {
      id: 'r-archer', name: 'Ranger', role: 'Ranged', color: '#22c55e', shape: 'triangle',
      blurb: 'A skirmisher who kites from range, pierces through lines, and hides when threatened.',
      stats: { hp: 75, armor: 0, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'rangeOneShot', range: 7.0, atk: 15 },
      modifiers: ['pierce'],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'lowestHp' },
      movement: 'kite', leader: false, personality: 'cautious', confidence: 0.45, stamina: { max: 100, regen: 18 },
    },
    {
      id: 'r-healer', name: 'Cleric', role: 'Support', color: '#f8fafc', shape: 'circle',
      blurb: 'Keeps the team alive. Heals the lowest ally and stays safely at range.',
      stats: { hp: 60, armor: 0, speed: 3.0, size: 0.7, mana: { max: 100, cost: 25 } },
      attack: { type: 'heal', shape: 'rangeOneShot', range: 6.0, atk: 19 },
      modifiers: [],
      selfPreservation: ['hide'],
      target: { side: 'ally', rule: 'lowestHp' },
      movement: 'keepDistance', leader: false, personality: 'cheerful', confidence: 0.5,
    },
    {
      id: 'r-mage', name: 'Pyromancer', role: 'AOE', color: '#f97316', shape: 'circle',
      blurb: 'Burns whole clusters at once. Fragile, so it keeps distance and slows pursuers.',
      stats: { hp: 70, armor: 0, speed: 2.8, size: 0.6 },
      attack: { type: 'damage', shape: 'rangeAoe', range: 6.0, atk: 18 },
      modifiers: ['slow'],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'mostAtOnce' },
      movement: 'keepDistance', leader: false, personality: 'nervous', confidence: 0.4,
    },
    {
      id: 'r-assassin', name: 'Shadow', role: 'Assassin', color: '#a78bfa', shape: 'triangle',
      blurb: 'Hunts the weakest enemy and finishes it off. Evasive and deadly up close.',
      stats: { hp: 90, armor: 1, speed: 3.6, size: 0.6 },
      attack: { type: 'damage', shape: 'meleeOneShot', range: 1.4, atk: 30 },
      modifiers: ['evasive'],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'weakest' },
      movement: 'hunt', leader: false, personality: 'grumpy', confidence: 0.6, stamina: { max: 90, regen: 20 },
    },
    {
      id: 'r-guardian', name: 'Warden', role: 'Guard', color: '#22d3ee', shape: 'square',
      blurb: 'Sticks to a chosen ally and guards them, engaging anything that gets close.',
      stats: { hp: 200, armor: 7, speed: 2.6, size: 0.8 },
      attack: { type: 'damage', shape: 'meleeOneShot', range: 1.6, atk: 16 },
      modifiers: ['taunt'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'threatened' },
      movement: 'guard', leader: false, personality: 'stoic', confidence: 0.7,
    },
    {
      id: 'r-berserker', name: 'Berserker', role: 'Duelist', color: '#f472b6', shape: 'square',
      blurb: 'A glass cannon that flanks and shreds a single target with brutal strikes.',
      stats: { hp: 110, armor: 2, speed: 3.4, size: 0.7 },
      attack: { type: 'damage', shape: 'meleeOneShot', range: 1.5, atk: 34 },
      modifiers: ['lifesteal'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'strongest' },
      movement: 'flank', leader: false, personality: 'cocky', confidence: 0.85, stamina: { max: 80, regen: 16 },
    },
    {
      id: 'r-stormcaller', name: 'Stormcaller', role: 'Disruptor', color: '#22d3ee', shape: 'circle',
      blurb: 'Blasts a shockwave that knocks enemies far away, scattering the swarm and buying the team space.',
      stats: { hp: 80, armor: 1, speed: 3.0, size: 0.6 },
      attack: { type: 'push', shape: 'rangeAoe', range: 5.0, atk: 12 },
      modifiers: [],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'mostAtOnce' },
      movement: 'keepDistance', leader: false, personality: 'cautious', confidence: 0.45,
    },
    {
      id: 'r-sentinel', name: 'Sentinel', role: 'Protector', color: '#60a5fa', shape: 'square',
      blurb: 'Wraps the most threatened ally in a barrier, absorbing hits before they land.',
      stats: { hp: 150, armor: 5, speed: 2.8, size: 0.8, mana: { max: 100, cost: 25 } },
      attack: { type: 'shield', shape: 'rangeOneShot', range: 6.0, atk: 40 },
      modifiers: ['peel'],
      selfPreservation: [],
      target: { side: 'ally', rule: 'threatened' },
      movement: 'guard', leader: false, personality: 'stoic', confidence: 0.65,
    },
    {
      id: 'r-hexer', name: 'Hexer', role: 'Debuffer', color: '#c084fc', shape: 'circle',
      blurb: 'Curses the strongest enemy, stunning and slowing it so the team can shred it safely.',
      stats: { hp: 70, armor: 0, speed: 2.8, size: 0.6 },
      attack: { type: 'damage', shape: 'rangeOneShot', range: 6.0, atk: 12 },
      modifiers: ['stun', 'slow'],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'strongest' },
      movement: 'keepDistance', leader: false, personality: 'grumpy', confidence: 0.4,
    },
    {
      id: 'r-crusader', name: 'Crusader', role: 'Off-tank', color: '#fbbf24', shape: 'square',
      blurb: 'A second front line that clumps enemies with a sweeping arc and taunts them off the backline.',
      stats: { hp: 220, armor: 8, speed: 2.4, size: 0.8 },
      attack: { type: 'damage', shape: 'meleeAoe', range: 2.2, atk: 16 },
      modifiers: ['taunt'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'mostAtOnce' },
      movement: 'advance', leader: false, personality: 'stoic', confidence: 0.75, stamina: { max: 130, regen: 8 },
    },
    {
      id: 'r-warhorn', name: 'Warhorn', role: 'Buffer', color: '#fde047', shape: 'circle',
      blurb: 'Rallies the team, empowering the strongest ally to hit far harder for a while.',
      stats: { hp: 90, armor: 2, speed: 3.0, size: 0.6 },
      attack: { type: 'buff', shape: 'rangeOneShot', range: 6.0, atk: 0.5 },
      modifiers: [],
      selfPreservation: ['hide'],
      target: { side: 'ally', rule: 'strongest' },
      movement: 'keepDistance', leader: false, personality: 'cheerful', confidence: 0.5,
    },
    {
      id: 'r-necro', name: 'Necromancer', role: 'Summoner', color: '#a3e635', shape: 'circle',
      blurb: 'Raises a disposable minion that rushes the swarm, splitting aggro and soaking hits.',
      stats: { hp: 80, armor: 1, speed: 2.8, size: 0.6 },
      attack: { type: 'summon', shape: 'rangeOneShot', range: 6.0, atk: 1 },
      modifiers: [],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'keepDistance', leader: false, personality: 'nervous', confidence: 0.35,
    },
    {
      id: 'r-executioner', name: 'Executioner', role: 'Finisher', color: '#f87171', shape: 'triangle',
      blurb: 'Hunts the biggest threat and executes it, dealing bonus damage to wounded enemies.',
      stats: { hp: 120, armor: 3, speed: 3.2, size: 0.7 },
      attack: { type: 'damage', shape: 'meleeOneShot', range: 1.6, atk: 26 },
      modifiers: ['execute'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'highestHp' },
      movement: 'hunt', leader: false, personality: 'cocky', confidence: 0.7, stamina: { max: 100, regen: 15 },
    },
    {
      id: 'r-thorn', name: 'Thorn', role: 'Reflect tank', color: '#4ade80', shape: 'square',
      blurb: 'A living shield that reflects melee damage back at attackers, punishing anyone who hits it.',
      stats: { hp: 260, armor: 9, speed: 2.2, size: 0.9 },
      attack: { type: 'damage', shape: 'meleeOneShot', range: 1.6, atk: 12 },
      modifiers: ['thorns'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'advance', leader: false, personality: 'stoic', confidence: 0.8, stamina: { max: 150, regen: 6 },
    },
    {
      id: 'r-channeler', name: 'Channeler', role: 'Mana battery', color: '#38bdf8', shape: 'circle',
      blurb: 'Feeds mana to the most powerful ally, keeping healers and shielders casting nonstop.',
      stats: { hp: 70, armor: 0, speed: 2.8, size: 0.6, mana: { max: 120, cost: 20 } },
      attack: { type: 'mana', shape: 'rangeOneShot', range: 6.0, atk: 30 },
      modifiers: [],
      selfPreservation: ['hide'],
      target: { side: 'ally', rule: 'strongest' },
      movement: 'keepDistance', leader: false, personality: 'cheerful', confidence: 0.4,
    },
  ],

  // Universal secondary attack: every member has a short melee attack so a
  // healer/taunt/ranged unit can still defend itself up close.
  secondary: {
    range: 1.6,             // short melee reach
    atk: 6,                 // damage dealt by the secondary attack
    cooldown: 0.8,
  },

  // Buff (Warhorn): empower an ally to deal bonus damage for a while.
  buff: {
    duration: 4.0,          // seconds the buff lasts
    dmgMult: 0.5,           // +50% damage while buffed
  },

  // Mana transfer (Channeler): restore an ally's mana pool.
  mana: {
    transfer: 30,           // mana granted per cast
  },

  // Summon (Necromancer): raise a disposable minion.
  summon: {
    cooldown: 3.0,          // seconds between summons
    maxAlive: 2,            // cap on simultaneous minions
  },

  // Enemy type definitions. Each has a `kind` that selects its AI behavior
  // (see sim._updateEnemy). `count` is the base swarm size for combat rooms.
  enemies: {
    bat: {
      kind: 'bat', hp: 36, atk: 20, range: 0.8, speed: 4.8, armor: 0,
      color: '#a855f7', shape: 'triangle', size: 0.4,
      count: 8, countPerLevel: 3,
    },
    brute: {
      kind: 'brute', hp: 120, atk: 34, range: 1.0, speed: 2.4, armor: 5,
      color: '#f97316', shape: 'square', size: 0.7,
      count: 4, countPerLevel: 1,
    },
    spitter: {
      kind: 'spitter', hp: 30, atk: 12, range: 6.0, speed: 3.4, armor: 0,
      color: '#22d3ee', shape: 'circle', size: 0.4,
      count: 4, countPerLevel: 1, attackCooldown: 1.6,
    },
    wisp: {
      kind: 'wisp', hp: 18, atk: 12, range: 0.8, speed: 6.4, armor: 0,
      color: '#e879f9', shape: 'triangle', size: 0.3,
      count: 6, countPerLevel: 2,
    },
  },

  // Weighted chance each enemy type is chosen for a combat room.
  enemyWeights: { bat: 0.35, brute: 0.25, spitter: 0.2, wisp: 0.2 },

  // Summoned minion (Necromancer). A small, disposable ally that rushes the
  // nearest enemy and splits aggro so the real team stays safe.
  minion: {
    kind: 'minion', hp: 60, atk: 10, range: 0.8, speed: 4.2, armor: 0,
    color: '#a3e635', shape: 'circle', size: 0.4,
    life: 12,               // seconds before the minion crumbles
    attack: { type: 'damage', shape: 'meleeOneShot', range: 0.8, atk: 10 },
    target: { side: 'enemy', rule: 'closest' },
    movement: 'hunt',
  },

  // Map (Slay the Spire style): a branching node graph the player navigates
  // between rooms. Each node is a room with a type that changes its content.
  map: {
    floors: 7,              // number of columns (start + middle + boss)
    minPerFloor: 3,         // min nodes per middle floor
    maxPerFloor: 6,         // max nodes per middle floor
    eliteHpMult: 1.5,       // elite bats have more HP
    eliteAtkMult: 1.25,      // elite bats hit harder
    bossHp: 420,            // boss bat HP
    bossAtk: 32,            // boss bat attack
    bossEscortCount: 6,     // number of escort enemies around the boss
    levelHpMult: 0.16,      // +HP% per level past 1 (compounding)
    levelAtkMult: 0.13,     // +ATK% per level past 1 (compounding)
    treasureHpBonus: 10,    // (legacy) permanent max-HP bonus from a treasure room
    shopStock: 3,           // recruits offered at a shop node
    eventHealPct: 0.6,      // event: heal up to this fraction of missing HP
    eventGoldRisk: 40,      // event: gold gained for a HP gamble
    eventGoldRiskHp: 0.15,  // event: max-HP fraction paid as the gamble's cost
  },

  // Run economy: gold earned by clearing rooms and spent at rest points (heal,
  // upgrade, or hire). Run gold is banked back into the tavern on completion.
  economy: {
    goldPerClear: 25,        // gold earned for clearing a room
    treasureGold: 75,        // gold earned from a treasure room
    healCost: 15,            // rest: heal the whole team to full
    upgradeCost: 20,         // rest: boost one member's attack + max HP
    upgradeAtkMult: 1.3,    // attack multiplier from one upgrade
    upgradeHpMult: 1.2,     // max-HP multiplier from one upgrade
  },

  // Boids parameters (bats)
  boids: {
    separationRadius: 1.0,
    separationWeight: 0.9,
    cohesionRadius: 2.5,
    cohesionWeight: 0.7,
    alignmentWeight: 1.0,
    seekWeight: 5.0,
    tauntSeekWeight: 1.6,   // taunted bats charge their taunter, ignoring scatter
    wallWeight: 1.5,
    arrivalRadius: 0.8,     // bats ease off within this distance of their target
    targetStickiness: 1.5,  // score bonus to a bat's current target (desync)
    maxForce: 12,
  },

  // Combat
  combat: {
    attackCooldown: 0.8,    // seconds between attacks
    manaRegen: 8,           // mana restored per second during combat
    minDamage: 1,
    knockback: 3.2,        // impulse strength applied to a hit target
    knockbackDecay: 6.0,   // how fast a knockback impulse fades (per second)
    hitFlashDecay: 2.0,    // how fast the white damage flash fades (per second)
    windupTime: 0.4,       // enemy telegraph before a hit lands (gives a dodge window)
    shieldDecay: 6.0,      // shield pool lost per second (temporary barrier)
  },

  // Stamina: a per-member resource that powers dodges and sprints. It
  // regenerates over time, so a member can't dodge or run forever. Spending
  // stamina is a tactical choice: dodge an incoming hit, or sprint to escape
  // or close distance. A preservation floor keeps a reserve so a member is
  // never left completely dry when it needs to escape.
  stamina: {
    max: 100,              // stamina pool
    regen: 12,             // stamina restored per second
    dodgeCost: 30,         // stamina spent to dodge an incoming hit
    sprintCost: 20,        // stamina spent per second while sprinting
    sprintMult: 1.5,       // speed multiplier while sprinting
    dodgeWindow: 0.35,     // seconds of enemy windup during which a dodge is possible
    reserveFrac: 0.3,      // fraction of max kept in reserve; never spend below it
    dodgeMinDmg: 15,       // only dodge a hit that would deal at least this damage
  },

  // Threat / aggro
  threat: {
    tauntDuration: 2.5,
    tauntThreat: 200,       // threat added by a taunt attack
    healThreat: 20,         // threat added to a healer per heal
    backlineBias: 1.5,      // bats prefer squishy targets
    decayPerSec: 20,        // threat fades at this rate
    tauntCooldown: 8,       // min seconds between taunts (raid-style, not spam)
    tauntRefresh: 0.8,      // re-taunt when a taunted enemy's timer drops below this
  },

  // Team formation / behavior
  team: {
    separationRadius: 1.3,
    separationWeight: 2.4,
    followDistance: 2.2,    // distance a follower trails behind its leader
    followHysteresis: 0.4,  // dead-zone so follow doesn't oscillate at the boundary
    formationSpread: 1.2,   // sideways spacing between followers in the advance line
    formationWedge: 0.5,    // radians each follower swings out to the side behind the leader
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
    playDuration: 3.0,      // seconds a leader-called play stays active
    retreatHpThreshold: 0.35, // avg team HP fraction below which the leader calls a retreat
    holdOutnumberMult: 1.6,  // enemies:allies ratio above which the leader calls hold
    scatterClusterRadius: 2.5, // enemies within this of each other count as a cluster
    scatterClusterCount: 3,   // enemies in a cluster needed to trigger a scatter
    scatterRadius: 2.0,       // allies within this push each other apart while scattering
    scatterWeight: 2.5,       // strength of the scatter push
  },

  // Unified movement model. Replaces the old hard-coded `movement` role
  // ladder with three emergent layers that fall out of attributes instead of
  // class labels:
  //   1. Survival (universal): everyone backs off the enemy hunting them.
  //   2. Goal (kit-derived): the attack type decides what to do (heal/shield/
  //      buff -> ally, taunt -> enemies, damage -> focus target).
  //   3. Commitment (emergent): confidence and durability decide how hard a
  //      member pushes toward its goal. A fragile, shaken member hangs back;
  //      a durable, confident one commits.
  movement: {
    // Survival layer: how close a hunter must be before the member backs off.
    survivalDistance: 3.0,   // hunter within this triggers a retreat
    survivalHysteresis: 0.5, // dead-zone so survival doesn't oscillate
    // Goal layer: how close to the goal the member wants to be.
    goalRange: 0.5,          // stop easing within this of the goal point
    // Commitment layer: how confidence and durability map to forward drive.
    // commitment = clamp(conf * confWeight + dur * durWeight + backup, 0..1)
    confWeight: 1.0,         // how strongly confidence drives commitment
    durWeight: 0.6,          // how strongly durability drives commitment
    backupWeight: 0.4,       // how strongly nearby backup steadies commitment
    // A member below this commitment holds at range instead of pushing in.
    commitFloor: 0.35,        // below this, the member keeps distance from the goal
    // How far a low-commitment member keeps from the goal.
    holdRange: 2.5,          // distance a cautious member holds from its goal
    // Sprint to close on the goal when commitment is high.
    sprintCommit: 0.7,       // commitment above which the member sprints to engage
  },

  // Intel: per-member learned knowledge about enemy kinds. Members only fear
  // what they have personally experienced, so a fresh recruit dives in and
  // learns the hard way. `danger` is the average damage a kind has dealt to
  // this member; `killability` is how much of an enemy's HP this member has
  // personally chipped off. The two combine into a target score: avoid a
  // dangerous enemy at full HP, pounce on it once it is softened.
  intel: {
    avoidDanger: 18,        // avg hit damage above which a squishy member holds back
    unknownDanger: 14,      // assumed danger of an enemy kind the team has never been hit by (caution on the unknown)
    avoidHpFrac: 0.5,       // enemy HP fraction below which it is "vulnerable" (safe to engage)
    pounceWeight: 2.0,      // how much killability weights target choice
    dangerWeight: 1.0,      // how much learned danger weights target choice
    familiarityRamp: 0.7,   // how strongly shared danger affects a member vs. its personal familiarity
    pounceKillFrac: 0.4,    // killability above which a member finishes the enemy regardless of danger
    swarmRadius: 3.0,       // enemies within this of the member count toward being outnumbered
    swarmCount: 3,          // enemies within swarmRadius that make the member retreat
    rangeThreat: 1.5,       // how much a ranged enemy's reach inflates its danger (can't outrun it)
    speedEscape: 1.1,       // member speed must exceed target speed by this factor to flee effectively
    tankArmor: 5,           // armor at/above which a member is a tank
    tankDangerMult: 2.0,    // how much more danger a tank tolerates before avoiding
    // Emergent coordination weights (ally-aware target scoring). These make
    // focus fire, "kill the weak first," and off-tanking emerge from each
    // member reading what its allies are doing, instead of a leader calling
    // plays.
    allyFocusWeight: 2.0,   // pull toward what allies are already attacking
    tankEngageWeight: 3.0,  // commit when a tank is engaging the target
    offTankWeight: 2.0,     // a tanky member steps up when no tank is engaging
    weakestWeight: 2.5,     // prefer cheap kills (low maxHp) to thin the horde
    finishWeight: 2.0,      // prefer near-dead enemies to finish them off
  },

  // Confidence: a continuous 0..1 morale per member. Threats erode it (taking
  // a hit, being forced to back off), safety restores it (no enemies, winning,
  // healing). It feeds back into the avoid decision: a confident member is
  // braver (tolerates more danger), a shaken one is more cautious. This makes
  // the team's nerve an emergent, self-balancing quantity rather than a fixed
  // rule. Personality biases the starting value so a cocky member is naturally
  // bolder than a nervous one.
  confidence: {
    // Each member has its own base `confidence` (its composure, 0..1). It sets
    // the starting value and shapes how the value *changes*: a steady member
    // recovers nerve quickly and barely flinches when hit, a nervous one
    // recovers slowly and is easily rattled. Everyone drifts back to the same
    // shared fighting morale, so no member is ever permanently stuck below the
    // safety threshold. A small personality bias nudges the starting value.
    // There is no separate aggression axis anymore: one continuous confidence
    // value drives bravery, and it evolves dynamically as the fight plays out.
    personalityBias: {      // additive starting offset per personality
      cocky: 0.3, cheerful: 0.2, stoic: 0.1, cautious: -0.1, grumpy: -0.1, nervous: -0.3, chatty: 0.1,
    },
    hitDrop: 0.08,          // confidence lost each time the member is hit
    avoidDrop: 0.12,        // confidence lost each time the member backs off (retreat/hold)
    recoverScale: 1.0,      // base multiplier; recovery is further scaled by (0.5 + baseConfidence)
    recoverRate: 0.06,      // confidence gained per second while safe
    attackGain: 0.02,       // confidence gained each time the member lands a hit
    killGain: 0.15,         // confidence gained each time the member kills an enemy
    min: 0.1,               // floor (never fully fearless, never fully broken)
    max: 1.0,               // ceiling
    avoidMult: 1.0,         // how strongly confidence scales the danger threshold
    safetyThreshold: 0.3,   // confidence below which a member seeks safety instead of fighting
    safetyHysteresis: 0.1,  // dead-zone so seek-safety doesn't oscillate at the threshold
    safetyGain: 0.15,       // confidence gained when a shaken member reaches safety (near the team, no threat)
    safetyGainRadius: 2.0, // how close to the team cluster counts as "reached safety"
    safetyRecover: 0.08,    // confidence gained per second while fleeing (steadies over time)
    pressureRadius: 3.0,    // enemies within this sap confidence (close pressure)
    pressurePerSec: 0.05,   // confidence lost per second per nearby enemy
    pressureTargetMult: 2.0, // enemies actively targeting the member sap this much more
    // Ally-aware nerve: nearby backup (a tank or the healer) damps fear, so a
    // member is braver when the team is around and more rattled when isolated.
    // This is the "rely on each other" mechanic — alone you're scared, with
    // backup you commit.
    backupRadius: 3.0,      // allies within this count as backup
    backupTank: 1.0,        // fear damped by a nearby tank
    backupHealer: 0.8,      // fear damped by a nearby healer
    backupAlly: 0.4,        // fear damped by a nearby ally
    safety: {               // how a shaken member picks its safety direction
      threatWeight: 1.0,    // pull away from the nearest threat (secondary)
      healerWeight: 2.0,   // pull toward the healer
      tankWeight: 1.8,     // pull toward the tankiest ally
      spaceWeight: 0.8,    // pull away from nearby enemies (spacing)
      allyWeight: 1.5,     // pull toward high-confidence allies (strength in numbers)
      wallWeight: 2.0,     // pull away from walls so retreats don't pin into corners
    },
  },

  // Team morale: a single team-wide value derived from the average confidence
  // of the alive members. It feeds a small, shared combat bonus so the whole
  // team fights a touch harder when morale is high and a touch worse when it
  // sags. This makes confidence a team phenomenon, not just a per-member one.
  morale: {
    dmgMult: 0.15,          // attack damage scales by this * (morale - 0.5)
    speedMult: 0.10,        // movement speed scales by this * (morale - 0.5)
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

  // Team banter: members occasionally speak based on what they're thinking and
  // doing. Lines are chosen by the unit's current situation and shown as a
  // speech bubble. `cooldown` is the minimum seconds between any two lines.
  dialogue: {
    cooldown: 4.5,          // min seconds between lines
    chance: 0.45,           // chance a unit speaks when its cooldown is ready
    maxLines: 3,            // max speech bubbles shown on screen at once
    bubbleLife: 2.4,        // seconds a bubble stays visible
    thinkInterval: 18.0,    // seconds between a unit's occasional "thinking" lines
    // Situation -> pool of lines. {name} is replaced with the speaker's name,
    // {target} with the target's name.
    lines: {
      lowHp: [
        "{name}: I'm hurt, someone cover me!",
        '{name}: That stings...',
        '{name}: I need a healer!',
        '{name}: I can\'t take much more!',
        '{name}: Someone, please!',
        '{name}: My legs are going numb...',
        '{name}: Don\'t leave me behind!',
      ],
      seekingHeal: [
        '{name}: Coming to you, healer!',
        '{name}: Patch me up!',
        '{name}: Healer, over here!',
        '{name}: I\'m bleeding out!',
        '{name}: Get me back in the fight!',
        '{name}: I can still fight, just heal me!',
      ],
      healing: [
        '{name}: Hold still, {target}.',
        "{name}: You'll be fine, {target}.",
        '{name}: Healing {target}!',
        '{name}: Easy now, {target}.',
        '{name}: This will help, {target}.',
        '{name}: Breathe, {target}.',
        '{name}: There, good as new, {target}.',
      ],
      taunting: [
        '{name}: Over here, you fiends!',
        '{name}: Come at me!',
        '{name}: You want a fight? Take me!',
        '{name}: I\'m right here, cowards!',
        '{name}: Eyes on me!',
        '{name}: I\'m the one you want!',
        '{name}: Too scared to face me?',
      ],
      shielding: [
        '{name}: Shield up, {target}!',
        '{name}: I\'ve got you, {target}.',
        '{name}: Stay behind me, {target}.',
        '{name}: Barrier on {target}!',
        '{name}: You\'re protected, {target}.',
        '{name}: Nothing gets through to {target}.',
      ],
      buffing: [
        '{name}: Fight harder, {target}!',
        '{name}: I\'m empowering {target}!',
        '{name}: Feel the surge, {target}!',
        '{name}: {target}, strike true!',
        '{name}: Power to {target}!',
        '{name}: Rage on, {target}!',
      ],
      channeling: [
        '{name}: Mana to {target}!',
        '{name}: Take my energy, {target}.',
        '{name}: {target}, keep casting!',
        '{name}: I\'m feeding {target} power.',
        '{name}: Don\'t run dry, {target}.',
        '{name}: Here\'s your fuel, {target}.',
      ],
      summoning: [
        '{name}: Rise, my servant!',
        '{name}: To me, minion!',
        '{name}: Go, my little one!',
        '{name}: Serve me, creature!',
        '{name}: Another one joins the fray!',
        '{name}: My minion, attack!',
      ],
      killing: [
        '{name}: Got one!',
        '{name}: Down!',
        '{name}: That\'s one less!',
        '{name}: Ha! Too easy.',
        '{name}: And stay down!',
        '{name}: One down, more to go!',
        '{name}: That one won\'t bother us again.',
      ],
      allyDown: [
        '{name}: {target} is down!',
        '{name}: No! {target}!',
        '{name}: {target} fell!',
        '{name}: We lost {target}!',
        '{name}: {target}, no!',
        '{name}: They got {target}!',
        '{name}: {target} is gone...',
      ],
      charging: [
        '{name}: For the team!',
        '{name}: Here I come!',
        '{name}: Out of my way!',
        '{name}: Ramming speed!',
        '{name}: Brace yourselves!',
        '{name}: Through you!',
      ],
      retreating: [
        '{name}: Fall back!',
        '{name}: We need to regroup!',
        '{name}: Pull back, now!',
        '{name}: This isn\'t working, retreat!',
        '{name}: Everyone, back!',
        '{name}: We live to fight another day!',
      ],
      avoiding: [
        '{name}: Not that one, it hits too hard!',
        '{name}: I\'m not walking into that!',
        '{name}: That thing would shred me!',
        '{name}: Backing off, that one\'s dangerous!',
        '{name}: I\'ve seen what that does, no thanks!',
        '{name}: Let\'s soften it up first!',
      ],
      holding: [
        '{name}: I can\'t outrun it, holding ground!',
        '{name}: No point running, I\'ll hold!',
        '{name}: Can\'t escape, so I\'ll stand my ground!',
        '{name}: It\'s too fast, I\'ll fight here!',
        '{name}: Nowhere to go, holding!',
        '{name}: I\'ll hold it off as long as I can!',
      ],
      outnumbered: [
        '{name}: There\'s too many of them!',
        '{name}: We\'re surrounded!',
        '{name}: They\'re everywhere!',
        '{name}: Hold the line, don\'t break!',
        '{name}: They\'ve got us outnumbered!',
        '{name}: Stay together!',
      ],
      firstBlood: [
        '{name}: First blood!',
        '{name}: That\'s for the team!',
        '{name}: Let\'s keep this up!',
        '{name}: And so it begins!',
        '{name}: Off to a good start!',
      ],
      winning: [
        '{name}: We\'ve got this!',
        '{name}: Almost done!',
        '{name}: They\'re falling!',
        '{name}: Push through!',
        '{name}: Just a few left!',
        '{name}: We\'re winning this!',
      ],
      takingDamage: [
        '{name}: Ouch!',
        '{name}: They hit hard!',
        '{name}: Watch out!',
        '{name}: That hurt!',
        '{name}: Ow!',
        '{name}: They\'re focusing me!',
      ],
      bossFight: [
        '{name}: That\'s a big one!',
        '{name}: Focus the big one!',
        '{name}: Careful, it hits hard!',
        '{name}: This is it, the boss!',
        '{name}: Everyone, on the big one!',
      ],
      eliteFight: [
        '{name}: These aren\'t normal!',
        '{name}: They\'re tougher than the rest!',
        '{name}: Watch out, elites!',
        '{name}: Don\'t underestimate them!',
      ],
      lowMana: [
        '{name}: I\'m running low on mana...',
        '{name}: Almost out of mana!',
        '{name}: Save your strength, I\'m low!',
      ],
      noEnemies: [
        '{name}: All clear.',
        '{name}: Nothing left here.',
        '{name}: Let\'s keep moving.',
        '{name}: Quiet now.',
        '{name}: Onward.',
      ],
      quiet: [
        '{name}: Nice and quiet for once.',
        '{name}: I could get used to this.',
        '{name}: Anyone else hear that? No? Just me.',
        '{name}: Reminds me of home.',
        '{name}: Good weather for a walk.',
        '{name}: I wonder what\'s for dinner.',
        '{name}: This is the calm before the storm, I bet.',
      ],
      idle: [
        '{name}: Stay sharp.',
        '{name}: Keep moving.',
        "{name}: I've got your back.",
        '{name}: Quiet for now...',
        '{name}: Let\'s keep going.',
        '{name}: Eyes open.',
        '{name}: Steady.',
      ],
      advancing: [
        '{name}: Moving up.',
        '{name}: Pushing forward.',
        '{name}: On the move.',
        '{name}: Let\'s go.',
        '{name}: Advancing.',
        '{name}: Forward!',
        '{name}: Keep pace.',
      ],
      attacking: [
        '{name}: Engaging!',
        '{name}: On them!',
        '{name}: Take this!',
        '{name}: For the team!',
        '{name}: Here\'s a taste!',
        '{name}: Feel that!',
        '{name}: Not so tough now!',
      ],
      kiting: [
        '{name}: Keeping my distance.',
        '{name}: Stay back!',
        '{name}: Not today!',
        '{name}: Keep them at range!',
        '{name}: Too close!',
        '{name}: Back off!',
      ],
      guarding: [
        '{name}: I\'ve got you covered.',
        '{name}: Nothing gets past me.',
        '{name}: Stay behind me.',
        '{name}: I\'ll hold them off.',
        '{name}: You\'re safe with me.',
        '{name}: I won\'t let them through.',
      ],
      hunting: [
        '{name}: I see one!',
        '{name}: Got a target.',
        '{name}: There you are!',
        '{name}: Not getting away!',
        '{name}: Running? Come back!',
        '{name}: I\'ve got your scent!',
      ],
      outOfMana: [
        '{name}: I\'m out of mana...',
        '{name}: Need to rest to heal.',
        '{name}: I can\'t heal anymore!',
        '{name}: Save me some mana!',
        '{name}: I\'m spent, no mana left!',
      ],
      // Personality-flavored lines. Each personality has its own take on the
      // same situations, so the team feels distinct. {name} and {target} are
      // substituted as usual.
      personality: {
        stoic: {
          idle: [
            '{name}: Stay sharp.',
            '{name}: Keep moving.',
            '{name}: Quiet for now...',
            '{name}: Eyes open.',
            '{name}: Steady.',
          ],
          advancing: [
            '{name}: Moving up.',
            '{name}: Pushing forward.',
            '{name}: On the move.',
            '{name}: Advancing.',
            '{name}: Keep pace.',
          ],
          attacking: [
            '{name}: Engaging.',
            '{name}: On them.',
            '{name}: Take this.',
            '{name}: Feel that.',
          ],
          killing: [
            '{name}: One down.',
            '{name}: Target eliminated.',
            '{name}: Done.',
          ],
          lowHp: [
            '{name}: I\'m hurt.',
            '{name}: Wounded.',
            '{name}: I can\'t take much more.',
          ],
          noEnemies: [
            '{name}: All clear.',
            '{name}: Nothing left here.',
            '{name}: Onward.',
          ],
          quiet: [
            '{name}: Peaceful.',
            '{name}: I like the quiet.',
            '{name}: Good. Time to think.',
          ],
          avoiding: [
            '{name}: That one hits too hard. Withdrawing.',
            '{name}: Not worth the risk. Falling back.',
            '{name}: I\'ll engage when it\'s softened.',
          ],
          holding: [
            '{name}: Can\'t escape. Holding position.',
            '{name}: I\'ll hold here.',
            '{name}: Standing my ground.',
          ],
        },
        cocky: {
          idle: [
            '{name}: Try to keep up.',
            '{name}: This is too easy.',
            '{name}: Boring. Let\'s find a real fight.',
            '{name}: I could do this all day.',
          ],
          advancing: [
            '{name}: Let\'s go, slowpokes!',
            '{name}: Move it!',
            '{name}: I\'m already bored.',
          ],
          attacking: [
            '{name}: Ha! Too easy!',
            '{name}: Watch and learn!',
            '{name}: Is that all you\'ve got?',
            '{name}: I\'m just getting started!',
          ],
          killing: [
            '{name}: Ha! Too easy.',
            '{name}: Next!',
            '{name}: Who\'s next?',
            '{name}: I didn\'t even break a sweat.',
          ],
          lowHp: [
            '{name}: They actually got me?!',
            '{name}: This is nothing!',
            '{name}: I\'m fine, I\'m fine!',
          ],
          noEnemies: [
            '{name}: That was it?',
            '{name}: Boring. Let\'s find a real fight.',
            '{name}: I wanted more.',
          ],
          quiet: [
            '{name}: Too quiet. I\'m bored.',
            '{name}: This is the boring part.',
            '{name}: I could take on ten more.',
          ],
          avoiding: [
            '{name}: Ha! I\'m not stupid enough for that one!',
            '{name}: Even I know better than to dive in there!',
            '{name}: Let it come to me, I\'m not charging that!',
          ],
          holding: [
            '{name}: Can\'t run? Fine, I\'ll hold!',
            '{name}: I\'ll stand here and take it!',
            '{name}: Not backing down, even if I can\'t flee!',
          ],
        },
        cautious: {
          idle: [
            '{name}: Careful, everyone.',
            '{name}: Stay close.',
            '{name}: Watch the shadows.',
            '{name}: Something feels off...',
          ],
          advancing: [
            '{name}: Slowly now.',
            '{name}: Careful as we go.',
            '{name}: Watch your step.',
          ],
          attacking: [
            '{name}: Careful, it\'s dangerous!',
            '{name}: Keep your guard up!',
            '{name}: Don\'t get reckless!',
          ],
          killing: [
            '{name}: One less to worry about.',
            '{name}: Good. Stay alert.',
            '{name}: Careful, there may be more.',
          ],
          lowHp: [
            '{name}: I\'m hurt, be careful!',
            '{name}: I need to fall back!',
            '{name}: This is getting dangerous!',
          ],
          noEnemies: [
            '{name}: All clear... for now.',
            '{name}: Let\'s not linger.',
            '{name}: Quiet. Too quiet.',
          ],
          quiet: [
            '{name}: Too quiet. Something\'s coming.',
            '{name}: I don\'t trust this calm.',
            '{name}: Stay alert, everyone.',
          ],
          avoiding: [
            '{name}: Careful, that one\'s dangerous!',
            '{name}: Let\'s not rush into that one!',
            '{name}: I\'m backing off, it hits too hard!',
          ],
          holding: [
            '{name}: I can\'t outrun it, holding!',
            '{name}: No escape, I\'ll hold my ground!',
            '{name}: Staying put, it\'s too fast!',
          ],
        },
        cheerful: {
          idle: [
            '{name}: What a lovely day for a fight!',
            '{name}: We make a great team!',
            '{name}: I\'m glad we\'re together!',
            '{name}: Onward, friends!',
          ],
          advancing: [
            '{name}: Let\'s go, team!',
            '{name}: This is exciting!',
            '{name}: Adventure awaits!',
          ],
          attacking: [
            '{name}: Here we go!',
            '{name}: Let\'s do this!',
            '{name}: Yay, a fight!',
            '{name}: We\'ve got this!',
          ],
          killing: [
            '{name}: Great job, everyone!',
            '{name}: We did it!',
            '{name}: Nice work!',
          ],
          lowHp: [
            '{name}: Ouch! But I\'m okay!',
            '{name}: That hurt, but I\'ll be fine!',
            '{name}: Don\'t worry about me!',
          ],
          noEnemies: [
            '{name}: All clear, wonderful!',
            '{name}: Great work, team!',
            '{name}: On to the next!',
          ],
          quiet: [
            '{name}: A peaceful moment!',
            '{name}: I love these quiet times together.',
            '{name}: Let\'s enjoy the calm!',
          ],
          avoiding: [
            '{name}: Ooh, that one\'s scary! Let\'s not!',
            '{name}: I\'ll stay back, that one\'s mean!',
            '{name}: No thank you, I\'m retreating!',
          ],
          holding: [
            '{name}: I can\'t run, so I\'ll hold!',
            '{name}: Stuck here, but I\'ll be brave!',
            '{name}: I\'ll hold the line, friends!',
          ],
        },
        grumpy: {
          idle: [
            '{name}: Hmph.',
            '{name}: I\'m only here for the pay.',
            '{name}: Don\'t talk to me.',
            '{name}: This place stinks.',
          ],
          advancing: [
            '{name}: Fine, let\'s go.',
            '{name}: Hurry up.',
            '{name}: Whatever.',
          ],
          attacking: [
            '{name}: Get out of my way.',
            '{name}: You again?',
            '{name}: Annoying pests.',
            '{name}: Just die already.',
          ],
          killing: [
            '{name}: Finally.',
            '{name}: About time.',
            '{name}: One less nuisance.',
          ],
          lowHp: [
            '{name}: Tch. I\'m hurt.',
            '{name}: This is your fault.',
            '{name}: I\'m bleeding. Great.',
          ],
          noEnemies: [
            '{name}: Finally, some quiet.',
            '{name}: About time.',
            '{name}: Let\'s just go.',
          ],
          quiet: [
            '{name}: Finally, some peace.',
            '{name}: Don\'t ruin it.',
            '{name}: Hmph. Fine.',
          ],
          avoiding: [
            '{name}: Tch. Not walking into that.',
            '{name}: I\'m not getting shredded for this.',
            '{name}: Backing off. It\'s not worth it.',
          ],
          holding: [
            '{name}: Can\'t escape. Great. Holding.',
            '{name}: Stuck here. I\'ll hold.',
            '{name}: No point running. I\'ll stand my ground.',
          ],
        },
        nervous: {
          idle: [
            '{name}: Is it safe?',
            '{name}: I don\'t like this...',
            '{name}: What was that noise?',
            '{name}: Please don\'t be a trap...',
          ],
          advancing: [
            '{name}: Do we have to go this way?',
            '{name}: Careful, careful...',
            '{name}: I have a bad feeling...',
          ],
          attacking: [
            '{name}: Oh no, oh no!',
            '{name}: Please go away!',
            '{name}: I don\'t want to fight!',
            '{name}: Someone help!',
          ],
          killing: [
            '{name}: Oh thank goodness.',
            '{name}: It\'s gone, it\'s gone!',
            '{name}: I didn\'t like that at all.',
          ],
          lowHp: [
            '{name}: I\'m hurt, help!',
            '{name}: This is bad, really bad!',
            '{name}: I don\'t want to die!',
          ],
          noEnemies: [
            '{name}: Is it really over?',
            '{name}: Let\'s get out of here.',
            '{name}: I need a moment...',
          ],
          quiet: [
            '{name}: Is it safe to relax?',
            '{name}: I don\'t like how quiet it is.',
            '{name}: Can we leave now?',
          ],
          avoiding: [
            '{name}: Oh no, that one\'s dangerous! Backing off!',
            '{name}: I\'m not going near that thing!',
            '{name}: Retreating, retreating!',
          ],
          holding: [
            '{name}: I can\'t run! I\'m holding, I\'m holding!',
            '{name}: Stuck here, please don\'t hurt me!',
            '{name}: I\'ll hold, but I don\'t like it!',
          ],
        },
        chatty: {
          idle: [
            '{name}: So, anyone else think this place is creepy?',
            '{name}: I had a dream about a giant bat last night.',
            '{name}: Did you see that? No? Never mind.',
            '{name}: I could talk for hours, you know.',
            '{name}: Hey, tell me about your hometown!',
          ],
          advancing: [
            '{name}: Ooh, moving up! Exciting!',
            '{name}: Let\'s go, let\'s go!',
            '{name}: I\'ve got a good feeling about this!',
          ],
          attacking: [
            '{name}: Oh! Oh! My turn!',
            '{name}: Look at me go!',
            '{name}: Did you see that? I did that!',
            '{name}: This is so much fun!',
          ],
          killing: [
            '{name}: Did everyone see that?',
            '{name}: That was me! I did that!',
            '{name}: One down, and I\'m not even tired!',
          ],
          lowHp: [
            '{name}: Ow! Hey, that hurt!',
            '{name}: I\'m hurt! Someone, anyone!',
            '{name}: This is not fun anymore!',
          ],
          noEnemies: [
            '{name}: All clear! Great job, everyone!',
            '{name}: We did it! Let\'s celebrate!',
            '{name}: Onward, my friends!',
          ],
          quiet: [
            '{name}: So quiet! Perfect for a chat!',
            '{name}: I\'ve been meaning to tell you all something...',
            '{name}: Anyone want to hear a story?',
          ],
          avoiding: [
            '{name}: Ooh, that one looks mean! I\'m backing off!',
            '{name}: Not today, scary thing! Retreating!',
            '{name}: I\'ll let someone else poke that one!',
          ],
          holding: [
            '{name}: Can\'t run, so I\'ll hold! And talk about it!',
            '{name}: Stuck here! Anyone want to keep me company?',
            '{name}: I\'ll hold, but I\'m not happy about it!',
          ],
        },
      },
    },
  },
};
