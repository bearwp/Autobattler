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

export const MOVEMENTS = ['keepDistance', 'kite', 'evade', 'follow', 'advance', 'flank', 'charge', 'guard', 'hunt'];

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
      stats: { hp: 230, armor: 6, speed: 2.2, size: 0.9 },
      attack: { type: 'taunt', shape: 'meleeOneShot', range: 4.0, atk: 11 },
      modifiers: ['peel'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'advance', leader: true,
    },
    {
      id: 'm2', name: 'Soldier', color: '#ef4444', shape: 'square',
      stats: { hp: 130, armor: 3, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'meleeCone', range: 1.8, atk: 22 },
      modifiers: ['lifesteal'],
      selfPreservation: [],
      target: { side: 'enemy', rule: 'closest' },
      movement: 'charge', leader: false,
    },
    {
      id: 'm3', name: 'Archer', color: '#22c55e', shape: 'triangle',
      stats: { hp: 75, armor: 0, speed: 3.0, size: 0.7 },
      attack: { type: 'damage', shape: 'rangeOneShot', range: 7.0, atk: 15 },
      modifiers: ['pierce'],
      selfPreservation: ['hide'],
      target: { side: 'enemy', rule: 'lowestHp' },
      movement: 'kite', leader: false,
    },
    {
      id: 'm4', name: 'Healer', color: '#f8fafc', shape: 'circle',
      stats: { hp: 60, armor: 0, speed: 3.0, size: 0.7, mana: { max: 100, cost: 25 } },
      attack: { type: 'heal', shape: 'rangeOneShot', range: 6.0, atk: 19 },
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
    atk: 6,                 // damage dealt by the secondary attack
    cooldown: 0.8,
  },

  // Enemy type definitions. Each has a `kind` that selects its AI behavior
  // (see sim._updateEnemy). `count` is the base swarm size for combat rooms.
  enemies: {
    bat: {
      kind: 'bat', hp: 40, atk: 22, range: 0.8, speed: 4.8, armor: 0,
      color: '#a855f7', shape: 'triangle', size: 0.4,
      count: 9, countPerLevel: 4,
    },
    brute: {
      kind: 'brute', hp: 130, atk: 38, range: 1.0, speed: 2.4, armor: 6,
      color: '#f97316', shape: 'square', size: 0.7,
      count: 4, countPerLevel: 1,
    },
    spitter: {
      kind: 'spitter', hp: 34, atk: 18, range: 6.0, speed: 3.4, armor: 0,
      color: '#22d3ee', shape: 'circle', size: 0.4,
      count: 5, countPerLevel: 2,
    },
    wisp: {
      kind: 'wisp', hp: 20, atk: 13, range: 0.8, speed: 6.4, armor: 0,
      color: '#e879f9', shape: 'triangle', size: 0.3,
      count: 7, countPerLevel: 3,
    },
  },

  // Weighted chance each enemy type is chosen for a combat room.
  enemyWeights: { bat: 0.4, brute: 0.2, spitter: 0.2, wisp: 0.2 },

  // Map (Slay the Spire style): a branching node graph the player navigates
  // between rooms. Each node is a room with a type that changes its content.
  map: {
    floors: 6,              // number of columns (start + middle + boss)
    minPerFloor: 3,         // min nodes per middle floor
    maxPerFloor: 5,         // max nodes per middle floor
    eliteHpMult: 1.7,       // elite bats have more HP
    eliteAtkMult: 1.4,      // elite bats hit harder
    bossHp: 500,            // boss bat HP
    bossAtk: 38,            // boss bat attack
    bossEscortCount: 8,     // number of escort enemies around the boss
    levelHpMult: 0.22,      // +HP% per level past 1 (compounding)
    levelAtkMult: 0.18,     // +ATK% per level past 1 (compounding)
    treasureHpBonus: 10,    // permanent max-HP bonus from a treasure room
  },

  // Boids parameters (bats)
  boids: {
    separationRadius: 1.0,
    separationWeight: 2.2,
    cohesionRadius: 2.5,
    cohesionWeight: 1.0,
    alignmentWeight: 0.6,
    seekWeight: 0.7,
    wallWeight: 2.0,
    arrivalRadius: 1.5,     // bats ease off within this distance of their target
    targetStickiness: 1.5,  // score bonus to a bat's current target (desync)
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
    separationRadius: 1.3,
    separationWeight: 2.4,
    followDistance: 2.2,    // distance a follower trails behind its leader
    followHysteresis: 0.4,  // dead-zone so follow doesn't oscillate at the boundary
    formationSpread: 1.2,   // sideways spacing between followers in the advance line
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
    cooldown: 3.0,          // min seconds between lines
    chance: 0.6,            // chance a unit speaks when its cooldown is ready
    maxLines: 3,            // max speech bubbles shown on screen at once
    bubbleLife: 2.4,        // seconds a bubble stays visible
    thinkInterval: 12.0,    // seconds between a unit's occasional "thinking" lines
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
    },
  },
};
