// Unit base class. Holds all mutable per-unit state. The sim mutates units;
// the render layer only reads them.

import { CONFIG } from './config.js';
import { dist, norm, sub, add, scale, clampLen, clamp } from './vec.js';

let NEXT_ID = 1;

export class Unit {
  constructor(def, opts = {}) {
    this.id = NEXT_ID++;
    this.def = def;                 // member bundle (CONFIG.members[i]) or CONFIG.bat
    this.team = opts.team;          // 'player' | 'enemy'
    this.isBat = opts.team === 'enemy';
    this.personality = def.personality || 'stoic'; // drives flavor of banter lines
    this.pos = { ...opts.pos };
    this.vel = { x: 0, y: 0 };
    this.knockback = { x: 0, y: 0 }; // impulse from being hit; decays each step
    this.hitFlash = 0;            // 0..1 white damage flash; set by takeDamage, decays each step
    this.facing = opts.facing ?? 0;   // radians, smoothed toward movement direction
    this.wanderPhase = Math.random() * Math.PI * 2; // per-unit idle drift offset

    // Stats come from def.stats (members) or def directly (bat).
    const stats = def.stats || def;
    this.maxHp = stats.hp;
    // Start at persisted HP when a member carries damage between rooms.
    this.hp = Math.min(typeof stats.currentHp === 'number' ? stats.currentHp : stats.hp, stats.hp);
    this.armor = stats.armor ?? 0;
    this.speed = stats.speed;
    this.size = stats.size ?? 0.5;
    this.alive = true;

    // Mana: only units with a `mana` stat (e.g. the healer) use it. It only
    // refills when the team rests, so a healer can't spam heals forever. The
    // current value persists on the member def so it carries across rooms.
    this.maxMana = stats.mana ? stats.mana.max : 0;
    this.manaCost = stats.mana ? stats.mana.cost : 0;
    if (stats.mana) {
      if (typeof stats.mana.current !== 'number') stats.mana.current = stats.mana.max;
      this.mana = stats.mana.current;
    } else {
      this.mana = 0;
    }

    // Combat
    this.attackTimer = 0;           // counts down to next primary attack
    this.secondaryTimer = 0;        // counts down to next secondary attack
    this.target = null;             // Unit reference
    this.threat = new Map();        // enemyId -> threat value

    // AI
    this.state = 'idle';
    this.intent = '';               // human-readable "what am I doing" (debug overlay)
    this.slot = 0;                  // formation slot index (spreads followers out)
    this.path = null;               // array of waypoints (ground units)
    this.pathIndex = 0;
    this.pathGoal = null;           // goal the current path was computed for
    this.following = false;         // follower is inside its follow distance
    this.seekingHeal = false;       // self-preservation: currently fleeing to healer
    this.seekingSafety = false;     // low confidence: currently retreating to safety
    this.tauntTimer = 0;
    this.tauntCooldown = 0;   // raid-style: min seconds between taunts
    this.taunted = false;
    this.kiteTimer = 0;
    this.slowTimer = 0;
    this.stunTimer = 0;       // seconds of immobilization (stun modifier)
    this.burn = null;         // { dps, life } damage-over-time from the burn modifier
    this.shield = 0;          // temporary barrier absorbing damage (shield attack type)
    this.shieldMax = 0;       // peak shield value, for the visual bar
    this.buffTimer = 0;       // seconds of bonus damage remaining (buff attack type)
    this.buffMult = 0;        // damage multiplier while buffed (e.g. 0.5 = +50%)
    this.thorns = 0;          // fraction of melee damage reflected back (thorns modifier)
    this.summonTimer = 0;     // cooldown before the next summon (summon attack type)
    this.minionLife = 0;      // seconds before a summoned minion crumbles
    this.minionOwner = null;  // the member that summoned this minion (for cleanup)
    this.chargeReady = false;
    this.avoid = null;        // last intel avoid decision: { action, danger, outnumbered, engaged, canEscape, reason } or null
    this.speakCooldown = 0;   // per-unit throttle for dialogue lines
    this.thinkTimer = 0;      // counts down to the next occasional "thinking" line

    // Confidence: continuous 0..1 morale. Threats erode it, safety restores it,
    // and it scales how much danger the member tolerates before backing off.
    // The member's own `confidence` base (its composure) sets both the starting
    // value and the recovery target, so a naturally brave member steadies high
    // while a nervous one settles low. A small personality bias nudges it.
    // Persists on the member def so it carries across rooms (a member that got
    // beaten down stays shaken).
    const cf = CONFIG.confidence;
    this.baseConfidence = clamp(def.confidence ?? 0.5, cf.min, cf.max);
    this.confidence = clamp(
      this.baseConfidence + (cf.personalityBias[this.personality] || 0),
      cf.min, cf.max
    );

    // Stamina: powers dodges and sprints. Regenerates over time; spending it
    // is a tactical choice (dodge an incoming hit vs. sprint to escape/close).
    // A member can vary its pool size and regen rate via an optional
    // `stamina: { max, regen }` stat, so an agile skirmisher can dodge far more
    // often than a heavy brawler.
    const stDef = (stats.stamina) || {};
    this.staminaMax = stDef.max ?? CONFIG.stamina.max;
    this.staminaRegen = stDef.regen ?? CONFIG.stamina.regen;
    this.stamina = this.staminaMax;
    this.sprinting = false;   // currently sprinting (drains stamina, moves faster)
    this.dodgeTimer = 0;     // brief invulnerability window after a successful dodge
    this.windup = 0;         // enemy telegraph countdown before a hit lands (dodge window)
    this.windupTarget = null; // the member this enemy is about to hit
  }

  // Convenience accessors for member attributes.
  get attack() { return this.def.attack; }
  get targetRule() { return this.def.target; }
  get isLeader() { return !!this.def.leader; }
  get modifiers() { return this.def.modifiers || []; }
  get selfPreservation() { return this.def.selfPreservation || []; }

  // Effective speed, halved while slowed.
  get effSpeed() { return this.slowTimer > 0 ? this.speed * 0.5 : this.speed; }

  isEnemy(other) { return other.team !== this.team; }

  // Display name: the member's configured name, or a fallback for enemies.
  get displayName() { return this.def.name || (this.def.kind || 'unit'); }

  takeDamage(amount, attacker = null) {
    let dmg = Math.max(CONFIG.combat.minDamage, amount - this.armor);
    // A shield absorbs damage before it reaches health. The shield pool is
    // consumed first; any overflow carries through to HP.
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      dmg -= absorbed;
      if (dmg <= 0) return 0; // fully absorbed, no HP loss
    }
    // Thorns: reflect a portion of the damage back at the attacker. Only
    // reflects when the attacker is a real unit (not a burn tick or fall).
    if (this.thorns > 0 && attacker && attacker.alive && attacker !== this) {
      const reflected = dmg * this.thorns;
      attacker.takeDamage(reflected);
    }
    this.hp -= dmg;
    this._tookDamage = true;
    // Flash white when hit, proportional to the damage taken relative to max
    // health: a big chunk flashes bright, a small tick only tints.
    this.hitFlash = dmg / this.maxHp;
    // Getting hit shakes a member's confidence (only player units have morale).
    // The drop scales with how much damage actually landed relative to max HP,
    // so a tank that shrugs off a hit (high armor, big pool) barely flinches
    // while a squishy eating a big chunk is rattled hard.
    if (this.team === 'player') {
      const cf = CONFIG.confidence;
      const frac = dmg / this.maxHp;
      // baseConfidence shapes *how fragile* a member is: a steady unit barely
      // flinches, a nervous one is rattled hard by the same hit.
      const drop = cf.hitDrop * (0.25 + frac * 3) * (1.5 - this.baseConfidence);
      this.confidence = clamp(this.confidence - drop, cf.min, cf.max);
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
    return dmg;
  }  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  addThreat(enemy, amount) {
    const cur = this.threat.get(enemy.id) ?? 0;
    this.threat.set(enemy.id, cur + amount);
  }

  // Pick the enemy with the highest threat toward this unit.
  highestThreatEnemy(enemies) {
    let best = null, bestVal = -Infinity;
    for (const e of enemies) {
      if (!e.alive) continue;
      const v = this.threat.get(e.id) ?? 0;
      if (v > bestVal) { bestVal = v; best = e; }
    }
    return best;
  }

  // --- Per-member intel ---
  // Danger (how hard a kind hits) is shared team knowledge, held on the Sim.
  // What stays personal here is (a) how much damage this member has dealt to
  // each kind (drives killability / pounce) and (b) how many times this member
  // has personally been hit by each kind (familiarity). Familiarity ramps how
  // strongly the shared danger affects this member: a veteran is fully scared,
  // a fresh recruit only mildly cautious even though it has heard the tank
  // grunt. Both live on the member def so they persist across rooms.
  get intel() {
    if (!this.def.intel) this.def.intel = {};
    return this.def.intel;
  }

  _intelRec(kind) {
    const r = this.intel[kind] || (this.intel[kind] = { hitsTaken: 0, hitsDealt: 0, dmgDealt: 0 });
    return r;
  }

  // Record that this member was personally hit by an enemy of `kind`. Only the
  // count matters (familiarity); the damage itself feeds the shared pool.
  recordHit(kind) {
    this._intelRec(kind).hitsTaken++;
  }

  // Record damage this member dealt to an enemy of `kind`. Landing a hit
  // builds confidence (successful combat is morale-boosting).
  recordDeal(kind, dmg) {
    const r = this._intelRec(kind);
    r.hitsDealt++;
    r.dmgDealt += dmg;
    if (this.team === 'player') {
      const cf = CONFIG.confidence;
      this.confidence = clamp(this.confidence + cf.attackGain, cf.min, cf.max);
    }
  }

  // How many times this member has personally been hit by `kind`. Used to ramp
  // the shared danger so a recruit is less scared than a veteran.
  familiarityOf(kind) {
    const r = this.intel[kind];
    return r ? r.hitsTaken : 0;
  }

  // Fraction of this enemy's max HP this member has personally chipped off.
  // 0 means "never touched it" (unknowable / not vulnerable), 1 means "I've
  // basically killed it myself."
  killabilityOf(e) {
    const r = this.intel[e.def.kind];
    if (!r || e.maxHp <= 0) return 0;
    return Math.min(1, r.dmgDealt / e.maxHp);
  }
}

// --- Targeting helpers (rule-based, generic) ---

export function nearestEnemy(unit, enemies) {
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = dist(unit.pos, e.pos);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// Pick the enemy that is currently targeting (threatening) this unit, i.e. the
// one with the highest threat toward it. Falls back to the strongest enemy if
// no threat has been recorded yet.
export function threatenedEnemy(unit, enemies) {
  let best = null, bestVal = 0;
  for (const e of enemies) {
    if (!e.alive) continue;
    const v = unit.threat.get(e.id) ?? 0;
    if (v > bestVal) { bestVal = v; best = e; }
  }
  if (best) return best;
  return strongestEnemy(unit, enemies);
}

export function lowestHpEnemy(unit, enemies, maxRange = Infinity) {
  let best = null, bestHp = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (dist(unit.pos, e.pos) > maxRange) continue;
    if (e.hp < bestHp) { bestHp = e.hp; best = e; }
  }
  return best;
}

export function highestHpEnemy(unit, enemies, maxRange = Infinity) {
  let best = null, bestHp = -Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (dist(unit.pos, e.pos) > maxRange) continue;
    if (e.hp > bestHp) { bestHp = e.hp; best = e; }
  }
  return best;
}

// Attack power of a unit: members store it under def.attack.atk, bats under def.atk.
function unitAtk(e) {
  return e.def.attack ? e.def.attack.atk : e.def.atk;
}

export function strongestEnemy(unit, enemies, maxRange = Infinity) {
  let best = null, bestAtk = -Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (dist(unit.pos, e.pos) > maxRange) continue;
    if (unitAtk(e) > bestAtk) { bestAtk = unitAtk(e); best = e; }
  }
  return best;
}

export function weakestEnemy(unit, enemies, maxRange = Infinity) {
  let best = null, bestAtk = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (dist(unit.pos, e.pos) > maxRange) continue;
    if (unitAtk(e) < bestAtk) { bestAtk = unitAtk(e); best = e; }
  }
  return best;
}

// "most-at-once": the target whose position lets an AOE hit the most enemies.
export function mostAtOnceEnemy(unit, enemies, maxRange = Infinity) {
  let best = null, bestCount = -1;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (dist(unit.pos, e.pos) > maxRange) continue;
    let count = 0;
    for (const o of enemies) {
      if (!o.alive) continue;
      if (dist(e.pos, o.pos) <= 2.0) count++;
    }
    if (count > bestCount) { bestCount = count; best = e; }
  }
  return best;
}

// Pick a target for a member using its configured target rule.
export function pickTarget(unit, candidates, maxRange = Infinity) {
  if (candidates.length === 0) return null;
  const rule = unit.targetRule.rule;
  switch (rule) {
    case 'lowestHp':   return lowestHpEnemy(unit, candidates, maxRange);
    case 'highestHp':  return highestHpEnemy(unit, candidates, maxRange);
    case 'strongest':  return strongestEnemy(unit, candidates, maxRange);
    case 'weakest':    return weakestEnemy(unit, candidates, maxRange);
    case 'mostAtOnce': return mostAtOnceEnemy(unit, candidates, maxRange);
    case 'threatened': return threatenedEnemy(unit, candidates);
    case 'closest':
    default:           return nearestEnemy(unit, candidates);
  }
}

export function lowestHpAlly(unit, allies) {
  let best = null, bestHp = Infinity;
  for (const a of allies) {
    if (!a.alive || a === unit) continue;
    if (a.hp < a.maxHp && a.hp < bestHp) { bestHp = a.hp; best = a; }
  }
  return best;
}
