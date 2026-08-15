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
    this.pos = { ...opts.pos };
    this.vel = { x: 0, y: 0 };
    this.facing = opts.facing ?? 0;   // radians, smoothed toward movement direction
    this.wanderPhase = Math.random() * Math.PI * 2; // per-unit idle drift offset

    // Stats come from def.stats (members) or def directly (bat).
    const stats = def.stats || def;
    this.hp = stats.hp;
    this.maxHp = stats.hp;
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
    this.tauntTimer = 0;
    this.taunted = false;
    this.kiteTimer = 0;
    this.slowTimer = 0;
    this.chargeReady = false;
    this.speakCooldown = 0;   // per-unit throttle for dialogue lines
    this.thinkTimer = 0;      // counts down to the next occasional "thinking" line
  }

  // Convenience accessors for member attributes.
  get attack() { return this.def.attack; }
  get targetRule() { return this.def.target; }
  get movement() { return this.def.movement; }
  get isLeader() { return !!this.def.leader; }
  get modifiers() { return this.def.modifiers || []; }
  get selfPreservation() { return this.def.selfPreservation || []; }

  // Effective speed, halved while slowed.
  get effSpeed() { return this.slowTimer > 0 ? this.speed * 0.5 : this.speed; }

  isEnemy(other) { return other.team !== this.team; }

  // Display name: the member's configured name, or a fallback for enemies.
  get displayName() { return this.def.name || (this.def.kind || 'unit'); }

  takeDamage(amount) {
    const dmg = Math.max(CONFIG.combat.minDamage, amount - this.armor);
    this.hp -= dmg;
    this._tookDamage = true;
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
