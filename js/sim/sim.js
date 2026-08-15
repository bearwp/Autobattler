// The simulation. Owns ALL game state and runs on a fixed timestep.
// The render layer reads this object but never mutates it.

import { CONFIG } from './config.js';
import { Grid } from './grid.js';
import { Unit, pickTarget, nearestEnemy, lowestHpAlly, threatenedEnemy } from './unit.js';
import { dist, len, norm, sub, add, scale, clampLen, clamp } from './vec.js';

export class Sim {
  constructor() {
    this.grid = new Grid();
    this.units = [];          // all units (player + enemy)
    this.playerUnits = [];
    this.enemyUnits = [];
    this.time = 0;
    this.started = false;
    this.over = null;         // 'win' | 'lose' | null
    this.level = 1;
    this.effects = [];        // transient visual effects (read by renderer)
    this._spawnQueue = [];    // team members waiting to enter the room
    this.deadIds = new Set(); // member ids that died this run (perma-death)
    this.members = CONFIG.members.map(m => ({ ...m })); // active roster
    this._reset();
  }

  _reset() {
    this.level = 1;
    this.deadIds = new Set();
    this._startLevel();
  }

  // Set up a fresh level: spawn bats and queue the team to enter one by one.
  _startLevel() {
    this.units = [];
    this.playerUnits = [];
    this.enemyUnits = [];
    this.time = 0;
    this.started = false;
    this.over = null;
    this.effects = [];
    this._spawnQueue = [];
    this._queueTeam();
    this._spawnBats();
  }

  // Team enters through the left door one by one.
  _queueTeam() {
    const { entrance } = CONFIG.doors;
    const gap = 0.8; // seconds between each member entering
    // Skip members that died in a previous level (perma-death).
    const alive = this.members.filter(m => !this.deadIds.has(m.id));
    this._spawnQueue = alive.map((m, i) => ({
      member: m,
      pos: { x: entrance.x + 0.5, y: entrance.y },
      at: i * gap,
    }));
  }

  _spawnBats() {
    const { width, height } = CONFIG.world;
    const n = CONFIG.bat.count + (this.level - 1) * CONFIG.bat.countPerLevel;
    for (let i = 0; i < n; i++) {
      // Bats spawn spread across the room.
      const pos = {
        x: 3 + Math.random() * (width - 6),
        y: 2 + Math.random() * (height - 4),
      };
      const u = new Unit(CONFIG.bat, { team: 'enemy', pos });
      this.units.push(u);
      this.enemyUnits.push(u);
    }
  }

  start() {
    if (this.over) this._reset();
    this.started = true;
  }

  reset() {
    this._reset();
  }

  // Advance the sim by one fixed timestep (dt in seconds).
  step(dt) {
    if (!this.started || this.over) return;
    this.time += dt;

    // Release queued team members as their entry time arrives.
    while (this._spawnQueue.length > 0 && this._spawnQueue[0].at <= this.time) {
      const s = this._spawnQueue.shift();
      const u = new Unit(s.member, { team: 'player', pos: s.pos });
      this.units.push(u);
      this.playerUnits.push(u);
    }

    for (const u of this.units) {
      if (!u.alive) continue;
      u.attackTimer -= dt;
      u.secondaryTimer -= dt;
      u.tauntTimer = Math.max(0, u.tauntTimer - dt);
      if (u.tauntTimer <= 0) u.taunted = false;
      u.kiteTimer = Math.max(0, u.kiteTimer - dt);
      u.slowTimer = Math.max(0, u.slowTimer - dt);
      // Decay threat so taunt/heal aggro fades over time.
      for (const [id, v] of u.threat) {
        const nv = v - dt * CONFIG.threat.decayPerSec;
        if (nv <= 0) u.threat.delete(id);
        else u.threat.set(id, nv);
      }
    }

    // Age out expired effects.
    for (let i = this.effects.length - 1; i >= 0; i--) {
      this.effects[i].life -= dt;
      if (this.effects[i].life <= 0) this.effects.splice(i, 1);
    }

    // Update each unit's AI.
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.isBat) this._updateBat(u, dt);
      else this._updateMember(u, dt);
    }

    // Integrate positions.
    for (const u of this.units) {
      if (!u.alive) continue;
      u.pos.x += u.vel.x * dt;
      u.pos.y += u.vel.y * dt;
      this._clampToWorld(u);
    }

    // Soft collision: push overlapping units apart so bats bump into members
    // instead of passing through them.
    this._resolveCollisions();

    // Death effects: emit a burst for units that just died this step.
    for (const u of this.units) {
      if (!u.alive && !u._deathFx) {
        u._deathFx = true;
        this.effects.push({
          type: 'death', pos: { ...u.pos }, color: u.def.color, life: 0.4,
        });
        // Record perma-death for team members.
        if (u.team === 'player') {
          this.deadIds.add(u.def.id);
        }
      }
    }

    this._checkEnd();
  }

  _clampToWorld(u) {
    const { width, height } = CONFIG.world;
    const wall = 0.5;
    u.pos.x = clamp(u.pos.x, wall, width - wall);
    u.pos.y = clamp(u.pos.y, wall, height - wall);
  }

  // Softly separate overlapping units (bats vs members, bats vs bats) by
  // pushing them apart along the overlap axis. Gentle, so bats bump and
  // jostle rather than being repelled from a distance.
  _resolveCollisions() {
    const alive = this.units.filter(u => u.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const minD = (a.size + b.size) * 0.5;
        const d = dist(a.pos, b.pos);
        if (d >= minD || d === 0) continue;
        const overlap = minD - d;
        const dir = norm(sub(a.pos, b.pos));
        // Push each apart by half the overlap (soft, not a hard snap).
        const push = scale(dir, overlap * 0.5);
        a.pos = add(a.pos, push);
        b.pos = add(b.pos, scale(push, -1));
      }
    }
  }

  _exitGoal() {
    return { x: CONFIG.doors.exit.x - 0.5, y: CONFIG.doors.exit.y };
  }

  _checkEnd() {
    // Lose: all team members dead and none left to enter.
    if (this._spawnQueue.length === 0 && this.playerUnits.every(u => !u.alive)) {
      this.over = 'lose';
      return;
    }

    // Advance: all mobs cleared AND a team member reaches the exit door.
    const mobsCleared = this.enemyUnits.every(e => !e.alive);
    if (!mobsCleared) return;
    const { exit } = CONFIG.doors;
    for (const u of this.playerUnits) {
      if (!u.alive) continue;
      if (Math.abs(u.pos.y - exit.y) <= exit.width / 2 && u.pos.x >= exit.x - 0.5) {
        this._nextLevel();
        return;
      }
    }
  }

  _nextLevel() {
    this.level += 1;
    this._startLevel();
    this.started = true; // continue playing into the next level
  }

  // --- Member AI (generic, driven by the member's attribute bundle) ---

  _updateMember(u, dt) {
    const enemies = this.enemyUnits.filter(e => e.alive);
    const allies = this.playerUnits.filter(a => a.alive);

    // Determine the target side and candidates.
    const side = u.targetRule.side;
    const candidates = side === 'ally' ? allies : enemies;

    // Pick a target by the configured rule.
    let target = pickTarget(u, candidates, u.attack.range);

    // Movement decision.
    this._applyMovement(u, target, enemies, allies, dt);

    // Peel: units with the peel modifier rush to defend squishy allies.
    this._peelForAllies(u, enemies, allies, dt);

    // Evasive: units with the evasive modifier back away from their hunter.
    this._evasiveRetreat(u, enemies, dt);

    // Resolve attacks (primary + universal secondary).
    this._resolveAttacks(u, target, enemies, allies);
  }

  // A unit with the 'peel' modifier abandons its own target to engage an
  // enemy that is menacing a squishy ally, shielding the back line.
  _peelForAllies(u, enemies, allies, dt) {
    if (!u.modifiers.includes('peel')) return;
    const t = CONFIG.team;

    for (const a of allies) {
      if (a === u || !a.alive) continue;
      const squishy = a.armor <= 0 || a.hp < a.maxHp * 0.5;
      if (!squishy) continue;
      const threat = nearestEnemy(a, enemies);
      if (!threat) continue;
      if (dist(a.pos, threat.pos) > t.protectRadius) continue;
      if (dist(u.pos, threat.pos) > t.protectEngageRange) continue;
      // Peel: move toward the enemy menacing the ally.
      this._moveAlongPath(u, threat.pos, dt);
      this._separate(u, allies, dt);
      return;
    }
  }

  // A unit with the 'evasive' modifier backs away from the enemy currently
  // hunting it (highest threat), layered on top of its normal movement.
  _evasiveRetreat(u, enemies, dt) {
    if (!u.modifiers.includes('evasive')) return;
    const hunter = threatenedEnemy(u, enemies);
    if (!hunter) return;
    if (dist(u.pos, hunter.pos) >= CONFIG.team.evadeDistance) return;
    const away = norm(sub(u.pos, hunter.pos));
    const toExit = norm(sub(this._exitGoal(), u.pos));
    const dir = norm(add(away, scale(toExit, 0.8)));
    this._setVel(u, scale(dir, u.effSpeed), dt);
  }

  _applyMovement(u, target, enemies, allies, dt) {
    const mv = u.movement;

    // Hold: stay put (still attack in range).
    if (mv === 'hold') {
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Follow: follow the leader (or advance if no leader alive).
    if (mv === 'follow') {
      const leader = this.playerUnits.find(a => a.alive && a.isLeader);
      const goal = leader ? leader.pos : this._exitGoal();
      // Stop once close enough to the leader so separation doesn't fight the
      // pathfinding and cause jitter.
      if (leader && dist(u.pos, leader.pos) <= CONFIG.team.followDistance) {
        u.vel = { x: 0, y: 0 };
        return;
      }
      this._moveAlongPath(u, goal, dt);
      this._separate(u, allies, dt);
      return;
    }

    // Kite: keep enemies at arm's length. Back away if one gets too close,
    // otherwise close in to attack range, and advance to the exit when clear.
    if (mv === 'kite') {
      const near = nearestEnemy(u, enemies);
      if (!near) {
        // No enemies: advance toward the exit.
        this._moveAlongPath(u, this._exitGoal(), dt);
        this._separate(u, allies, dt);
        return;
      }
      const dNear = dist(u.pos, near.pos);
      if (dNear < CONFIG.team.kiteDistance - CONFIG.team.kiteHysteresis) {
        // Back away from the enemy, but bias the retreat toward the exit so
        // the unit doesn't get pinned against the entrance wall.
        const away = norm(sub(u.pos, near.pos));
        const toExit = norm(sub(this._exitGoal(), u.pos));
        const dir = norm(add(away, scale(toExit, 0.8)));
        this._setVel(u, scale(dir, u.effSpeed), dt);
        u.kiteTimer = 0.3;
        return;
      }
      if (dNear > u.attack.range) {
        // Too far to shoot: close in on the nearest enemy.
        this._moveAlongPath(u, near.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      // In range: hold and shoot.
      u.vel = { x: 0, y: 0 };
      return;
    }

    // KeepDistance: hold a comfortable distance from enemies.
    if (mv === 'keepDistance') {
      const near = nearestEnemy(u, enemies);
      if (near && dist(u.pos, near.pos) < CONFIG.team.keepDistance - CONFIG.team.keepHysteresis) {
        const away = norm(sub(u.pos, near.pos));
        this._setVel(u, scale(away, u.effSpeed), dt);
        return;
      }
      const goal = enemies.length === 0 ? this._exitGoal() : { x: CONFIG.doors.entrance.x + 2, y: CONFIG.doors.entrance.y };
      this._moveAlongPath(u, goal, dt);
      this._separate(u, allies, dt);
      return;
    }

    // Evade: like kite, but reacts to the enemy actually hunting this unit
    // (highest threat) rather than the nearest one. Back away from the hunter,
    // biased toward the exit, and advance when no one is targeting it.
    if (mv === 'evade') {
      const hunter = threatenedEnemy(u, enemies);
      if (!hunter) {
        this._moveAlongPath(u, this._exitGoal(), dt);
        this._separate(u, allies, dt);
        return;
      }
      const dH = dist(u.pos, hunter.pos);
      if (dH < CONFIG.team.evadeDistance - CONFIG.team.evadeHysteresis) {
        const away = norm(sub(u.pos, hunter.pos));
        const toExit = norm(sub(this._exitGoal(), u.pos));
        const dir = norm(add(away, scale(toExit, 0.8)));
        this._setVel(u, scale(dir, u.effSpeed), dt);
        return;
      }
      if (dH > u.attack.range) {
        this._moveAlongPath(u, hunter.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Advance (default): move toward target, else toward exit.
    if (target && dist(u.pos, target.pos) > u.attack.range) {
      this._moveAlongPath(u, target.pos, dt);
      this._separate(u, allies, dt);
      return;
    }
    if (!target) {
      this._moveAlongPath(u, this._exitGoal(), dt);
      this._separate(u, allies, dt);
      return;
    }
    u.vel = { x: 0, y: 0 };
  }

  _resolveAttacks(u, target, enemies, allies) {
    // Primary attack (if a valid target is in range).
    if (target && target.alive && dist(u.pos, target.pos) <= u.attack.range) {
      this._doPrimaryAttack(u, target, enemies, allies);
    }

    // Universal secondary attack: short melee vs any enemy in reach.
    if (u.secondaryTimer <= 0) {
      const near = nearestEnemy(u, enemies);
      if (near && dist(u.pos, near.pos) <= CONFIG.secondary.range) {
        this._doSecondaryAttack(u, near);
      }
    }
  }

  _doPrimaryAttack(u, target, enemies, allies) {
    if (u.attackTimer > 0) return;
    const atk = u.attack;
    u.attackTimer = CONFIG.combat.attackCooldown;
    u.target = target;

    switch (atk.type) {
      case 'heal': {
        // Heal the target (an ally).
        target.heal(atk.atk);
        this.effects.push({
          type: 'heal', from: { ...u.pos }, to: { ...target.pos }, life: 0.4,
        });
        // Healing generates threat.
        for (const e of enemies) e.addThreat(u, CONFIG.threat.healThreat);
        break;
      }
      case 'taunt': {
        // Taunt: force nearby enemies to target this unit.
        const radius = atk.range;
        let hit = false;
        for (const e of enemies) {
          if (dist(u.pos, e.pos) <= radius) {
            e.addThreat(u, CONFIG.threat.tauntThreat);
            e.taunted = true;
            e.tauntTimer = CONFIG.threat.tauntDuration;
            hit = true;
          }
        }
        if (hit) {
          this.effects.push({
            type: 'taunt', pos: { ...u.pos }, radius, life: 0.5,
          });
        }
        break;
      }
      case 'damage':
      default: {
        this._applyDamageShape(u, target, enemies, atk);
        break;
      }
    }

    // Apply composable modifiers after the base attack resolves.
    this._applyModifiers(u, target, enemies, atk);
  }

  _applyModifiers(u, target, enemies, atk) {
    for (const mod of u.modifiers) {
      switch (mod) {
        case 'taunt': {
          // Taunt nearby enemies (same as the taunt attack type).
          const radius = atk.range;
          let hit = false;
          for (const e of enemies) {
            if (dist(u.pos, e.pos) <= radius) {
              e.addThreat(u, CONFIG.threat.tauntThreat);
              e.taunted = true;
              e.tauntTimer = CONFIG.threat.tauntDuration;
              hit = true;
            }
          }
          if (hit) {
            this.effects.push({ type: 'taunt', pos: { ...u.pos }, radius, life: 0.5 });
          }
          break;
        }
        case 'lifesteal': {
          // Heal self for a fraction of the attack's power.
          u.heal(atk.atk * 0.3);
          break;
        }
        case 'pierce': {
          // Ranged shots hit one enemy behind the target.
          if (atk.shape !== 'rangeOneShot') break;
          const dir = norm(sub(target.pos, u.pos));
          let behind = null, bestD = Infinity;
          for (const e of enemies) {
            if (e === target || !e.alive) continue;
            const toE = sub(e.pos, target.pos);
            const along = toE.x * dir.x + toE.y * dir.y;
            if (along <= 0) continue;
            const perp = Math.hypot(toE.x - dir.x * along, toE.y - dir.y * along);
            if (perp < 0.8 && along < bestD) { bestD = along; behind = e; }
          }
          if (behind) {
            behind.takeDamage(atk.atk * 0.7);
            behind.addThreat(u, atk.atk * 0.7);
            this.effects.push({
              type: 'pierce', from: { ...u.pos }, to: { ...behind.pos }, life: 0.2,
            });
          }
          break;
        }
        case 'slow': {
          // Halve the target's speed briefly.
          target.slowTimer = 1.5;
          break;
        }
      }
    }
  }

  _applyDamageShape(u, target, enemies, atk) {
    const shape = atk.shape;
    const range = atk.range;

    if (shape === 'rangeOneShot' || shape === 'meleeOneShot') {
      target.takeDamage(atk.atk);
      target.addThreat(u, atk.atk);
      this.effects.push({
        type: 'attack', from: { ...u.pos }, to: { ...target.pos },
        color: u.team === 'player' ? '#fbbf24' : '#f87171', life: 0.15,
      });
      return;
    }

    if (shape === 'rangeAoe' || shape === 'meleeAoe') {
      // AOE: hit all enemies within `range` of the target point.
      const center = target.pos;
      let hit = false;
      for (const e of enemies) {
        if (!e.alive) continue;
        if (dist(center, e.pos) <= range) {
          e.takeDamage(atk.atk);
          e.addThreat(u, atk.atk);
          hit = true;
        }
      }
      if (hit) {
        this.effects.push({
          type: 'aoe', pos: { ...center }, radius: range, life: 0.25,
        });
      }
      return;
    }

    if (shape === 'meleeCone') {
      // Cone: hit all enemies in an arc in front of the unit.
      const dir = norm(sub(target.pos, u.pos));
      const arc = Math.PI * 0.6;
      let hit = false;
      for (const e of enemies) {
        if (!e.alive) continue;
        if (dist(u.pos, e.pos) > range) continue;
        const toE = norm(sub(e.pos, u.pos));
        const dot = toE.x * dir.x + toE.y * dir.y;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (angle <= arc / 2) {
          e.takeDamage(atk.atk);
          e.addThreat(u, atk.atk);
          hit = true;
        }
      }
      if (hit) {
        this.effects.push({
          type: 'cleave', pos: { ...u.pos }, dir, arc, range, life: 0.25,
        });
      }
      return;
    }
  }

  _doSecondaryAttack(u, target) {
    u.secondaryTimer = CONFIG.secondary.cooldown;
    target.takeDamage(CONFIG.secondary.atk);
    target.addThreat(u, CONFIG.secondary.atk);
    this.effects.push({
      type: 'attack', from: { ...u.pos }, to: { ...target.pos },
      color: u.team === 'player' ? '#fbbf24' : '#f87171', life: 0.15,
    });
  }

  // --- Bat AI (boids) ---

  _updateBat(u, dt) {
    const enemies = this.playerUnits.filter(e => e.alive);
    if (enemies.length === 0) { u.vel = { x: 0, y: 0 }; return; }

    // Pick target: bias toward squishy (low-HP) and low-armor units.
    const target = this._pickBatTarget(u, enemies);

    // Boids forces.
    const others = this.enemyUnits.filter(e => e.alive && e !== u);
    const sep = this._boidSeparation(u, others);
    const coh = this._boidCohesion(u, others);
    const ali = this._boidAlignment(u, others);
    const seek = this._boidSeek(u, target.pos);
    const wall = this._boidWallAvoidance(u);

    const b = CONFIG.boids;
    let fx = sep.x * b.separationWeight + coh.x * b.cohesionWeight + ali.x * b.alignmentWeight + seek.x * b.seekWeight + wall.x * b.wallWeight;
    let fy = sep.y * b.separationWeight + coh.y * b.cohesionWeight + ali.y * b.alignmentWeight + seek.y * b.seekWeight + wall.y * b.wallWeight;

    const force = clampLen({ x: fx, y: fy }, b.maxForce);
    u.vel = clampLen(add(u.vel, scale(force, dt)), u.effSpeed);

    // Attack if in range.
    if (target && dist(u.pos, target.pos) <= u.def.range) {
      if (u.attackTimer <= 0) {
        u.attackTimer = CONFIG.combat.attackCooldown;
        u.target = target;
        target.takeDamage(u.def.atk);
        target.addThreat(u, u.def.atk);
        this.effects.push({
          type: 'attack', from: { ...u.pos }, to: { ...target.pos },
          color: '#f87171', life: 0.15,
        });
      }
    }
  }

  _pickBatTarget(u, enemies) {
    // A taunted bat is forced onto its taunter (highest threat) regardless of
    // squishiness or distance, so taunt actually holds aggro.
    if (u.taunted) {
      const taunter = u.highestThreatEnemy(enemies);
      if (taunter) return taunter;
    }
    // Score all enemies: prefer squishy (low-HP / low-armor) and low-HP, but
    // threat (from taunt) is a strong override so a taunted unit pulls aggro.
    const bias = CONFIG.threat.backlineBias;
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      const d = dist(u.pos, e.pos);
      const hpFrac = e.hp / e.maxHp;
      const squishy = e.armor <= 0 ? bias : 0;
      const threat = u.threat.get(e.id) ?? 0;
      const score = -d + squishy + (1 - hpFrac) * 5 + threat;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  _boidSeparation(u, others) {
    const b = CONFIG.boids;
    let steer = { x: 0, y: 0 };
    let count = 0;
    for (const o of others) {
      const d = dist(u.pos, o.pos);
      if (d > 0 && d < b.separationRadius) {
        const diff = norm(sub(u.pos, o.pos));
        // Cap the 1/d term so overlapping bats don't produce huge forces.
        const strength = 1 / Math.max(d, 0.2);
        steer = add(steer, scale(diff, strength));
        count++;
      }
    }
    if (count > 0) steer = scale(steer, 1 / count);
    return steer;
  }

  _boidWallAvoidance(u) {
    const { width, height } = CONFIG.world;
    const margin = 1.5; // start steering away within this distance of a wall
    let steer = { x: 0, y: 0 };
    const dLeft = u.pos.x;
    const dRight = width - u.pos.x;
    const dTop = u.pos.y;
    const dBottom = height - u.pos.y;
    if (dLeft < margin) steer.x += (margin - dLeft) / margin;
    if (dRight < margin) steer.x -= (margin - dRight) / margin;
    if (dTop < margin) steer.y += (margin - dTop) / margin;
    if (dBottom < margin) steer.y -= (margin - dBottom) / margin;
    return steer;
  }

  _boidCohesion(u, others) {
    const b = CONFIG.boids;
    let center = { x: 0, y: 0 };
    let count = 0;
    for (const o of others) {
      if (dist(u.pos, o.pos) < b.cohesionRadius) {
        center = add(center, o.pos);
        count++;
      }
    }
    if (count === 0) return { x: 0, y: 0 };
    center = scale(center, 1 / count);
    return norm(sub(center, u.pos));
  }

  _boidAlignment(u, others) {
    const b = CONFIG.boids;
    let avg = { x: 0, y: 0 };
    let count = 0;
    for (const o of others) {
      if (dist(u.pos, o.pos) < b.cohesionRadius) {
        avg = add(avg, o.vel);
        count++;
      }
    }
    if (count === 0) return { x: 0, y: 0 };
    return norm(scale(avg, 1 / count));
  }

  _boidSeek(u, targetPos) {
    const to = sub(targetPos, u.pos);
    const d = len(to);
    if (d === 0) return { x: 0, y: 0 };
    const dir = scale(to, 1 / d);
    // Arrival: ease off as the bat closes in so it doesn't overshoot and
    // circle the target. Full speed beyond the slow radius, ramping to zero.
    const slow = CONFIG.boids.arrivalRadius;
    const speed = d < slow ? (d / slow) : 1;
    return scale(dir, speed);
  }

  // --- Shared movement / combat ---

  _moveAlongPath(u, goal, dt) {
    // Recompute path if needed (throttled by pathIndex reset).
    if (!u.path || u.pathIndex >= u.path.length) {
      u.path = this.grid.findPath(u.pos, goal);
      u.pathIndex = 0;
      if (!u.path) { u.vel = { x: 0, y: 0 }; return; }
    }
    const wp = u.path[u.pathIndex];
    if (dist(u.pos, wp) < 0.3) {
      u.pathIndex++;
      if (u.pathIndex >= u.path.length) {
        u.vel = { x: 0, y: 0 };
        return;
      }
    }
    const dir = norm(sub(u.path[u.pathIndex], u.pos));
    this._setVel(u, scale(dir, u.effSpeed), dt);
  }

  // Smoothly accelerate toward a desired velocity instead of snapping to it.
  // This removes the jitter caused by instant velocity changes each step.
  _setVel(u, desired, dt) {
    const accel = CONFIG.team.accel * dt;
    const dv = sub(desired, u.vel);
    const dl = len(dv);
    if (dl <= accel) {
      u.vel = desired;
    } else {
      u.vel = add(u.vel, scale(dv, accel / dl));
    }
  }

  _separate(u, allies, dt) {
    const t = CONFIG.team;
    let steer = { x: 0, y: 0 };
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      const d = dist(u.pos, a.pos);
      if (d > 0 && d < t.separationRadius) {
        const diff = norm(sub(u.pos, a.pos));
        // Linear falloff (not 1/d) so the push is gentle and doesn't blow up
        // as units overlap, which caused jitter.
        const strength = 1 - d / t.separationRadius;
        steer = add(steer, scale(diff, strength));
      }
    }
    if (steer.x !== 0 || steer.y !== 0) {
      this._setVel(u, clampLen(add(u.vel, scale(steer, t.separationWeight)), u.effSpeed), dt);
    }
  }
}
