// Unit base class. Holds all mutable per-unit state. The sim mutates units;
// the render layer only reads them.

import { CONFIG } from './config.js';
import { dist, norm, sub, add, scale, clampLen, clamp } from './vec.js';

let NEXT_ID = 1;

export class Unit {
  constructor(def, opts = {}) {
    this.id = NEXT_ID++;
    this.def = def;                 // reference to CONFIG.units.* or CONFIG.bat
    this.team = opts.team;          // 'player' | 'enemy'
    this.role = opts.role;          // 'tank' | 'soldier' | 'archer' | 'healer' | 'bat'
    this.pos = { ...opts.pos };
    this.vel = { x: 0, y: 0 };
    this.hp = def.hp;
    this.maxHp = def.hp;
    this.alive = true;

    // Combat
    this.attackTimer = 0;           // counts down to next attack
    this.target = null;             // Unit reference
    this.threat = new Map();        // enemyId -> threat value

    // AI
    this.state = 'idle';
    this.path = null;               // array of waypoints (ground units)
    this.pathIndex = 0;
    this.tauntTimer = 0;
    this.healTimer = 0;
    this.kiteTimer = 0;
    this.abilityTimer = 0;          // cooldown for role ability (taunt/cleave/pierce)
  }

  get speed() { return this.def.speed; }
  get range() { return this.def.range; }
  get atk() { return this.def.atk; }
  get armor() { return this.def.armor; }

  isEnemy(other) { return other.team !== this.team; }

  takeDamage(amount) {
    const dmg = Math.max(CONFIG.combat.minDamage, amount - this.armor);
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
    return dmg;
  }
  heal(amount) {
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

// --- Targeting helpers (role-specific) ---

export function nearestEnemy(unit, enemies) {
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = dist(unit.pos, e.pos);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
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

export function lowestHpAlly(unit, allies) {
  let best = null, bestHp = Infinity;
  for (const a of allies) {
    if (!a.alive || a === unit) continue;
    if (a.hp < a.maxHp && a.hp < bestHp) { bestHp = a.hp; best = a; }
  }
  return best;
}
