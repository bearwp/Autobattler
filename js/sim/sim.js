// The simulation. Owns ALL game state and runs on a fixed timestep.
// The render layer reads this object but never mutates it.

import { CONFIG } from './config.js';
import { Grid } from './grid.js';
import { Unit, nearestEnemy, lowestHpEnemy, lowestHpAlly } from './unit.js';
import { dist, norm, sub, add, scale, clampLen, clamp } from './vec.js';

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
    this.deadRoles = new Set(); // roles that died this run (perma-death)
    this._reset();
  }

  _reset() {
    this.level = 1;
    this.deadRoles = new Set();
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

  // Team enters through the bottom door one by one.
  _queueTeam() {
    const { entrance } = CONFIG.doors;
    const order = ['tank', 'soldier', 'archer', 'healer'];
    const gap = 0.8; // seconds between each member entering
    // Skip members that died in a previous level (perma-death).
    const alive = order.filter(role => !this.deadRoles.has(role));
    this._spawnQueue = alive.map((role, i) => ({
      role,
      pos: { x: entrance.x, y: entrance.y - 0.5 },
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
      const u = new Unit(CONFIG.bat, { team: 'enemy', role: 'bat', pos });
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
      const u = new Unit(CONFIG.units[s.role], { team: 'player', role: s.role, pos: s.pos });
      this.units.push(u);
      this.playerUnits.push(u);
    }

    for (const u of this.units) {
      if (!u.alive) continue;
      u.attackTimer -= dt;
      u.tauntTimer = Math.max(0, u.tauntTimer - dt);
      if (u.tauntTimer <= 0) u.taunted = false;
      u.healTimer = Math.max(0, u.healTimer - dt);
      u.kiteTimer = Math.max(0, u.kiteTimer - dt);
      u.abilityTimer = Math.max(0, u.abilityTimer - dt);
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
      if (u.role === 'bat') this._updateBat(u, dt);
      else this._updatePlayer(u, dt);
    }

    // Integrate positions.
    for (const u of this.units) {
      if (!u.alive) continue;
      u.pos.x += u.vel.x * dt;
      u.pos.y += u.vel.y * dt;
      this._clampToWorld(u);
    }

    // Death effects: emit a burst for units that just died this step.
    for (const u of this.units) {
      if (!u.alive && !u._deathFx) {
        u._deathFx = true;
        this.effects.push({
          type: 'death', pos: { ...u.pos }, color: u.def.color, life: 0.4,
        });
        // Record perma-death for team members.
        if (u.team === 'player') {
          this.deadRoles.add(u.role);
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

  _exitGoal() {
    return { x: CONFIG.doors.exit.x, y: CONFIG.doors.exit.y + 0.5 };
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
      if (Math.abs(u.pos.x - exit.x) <= exit.width / 2 && u.pos.y <= exit.y + 0.5) {
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

  // --- Player unit AI ---

  _updatePlayer(u, dt) {
    const enemies = this.enemyUnits.filter(e => e.alive);
    const allies = this.playerUnits.filter(a => a.alive);

    switch (u.role) {
      case 'tank':    this._aiTank(u, enemies, allies, dt); break;
      case 'soldier': this._aiSoldier(u, enemies, allies, dt); break;
      case 'archer':  this._aiArcher(u, enemies, allies, dt); break;
      case 'healer':  this._aiHealer(u, enemies, allies, dt); break;
    }
  }

  _aiTank(u, enemies, allies, dt) {
    // Taunt: periodically force nearby enemies to target the tank.
    if (u.abilityTimer <= 0 && enemies.length > 0) {
      this._taunt(u, enemies);
    }

    const target = nearestEnemy(u, enemies);
    if (target) {
      if (dist(u.pos, target.pos) <= u.range) {
        this._attack(u, target);
        u.vel = { x: 0, y: 0 };
        return;
      }
      // Engage the nearest enemy.
      this._moveAlongPath(u, target.pos, dt);
      this._separate(u, allies, dt);
      return;
    }
    // No enemies: head to the exit.
    this._moveAlongPath(u, this._exitGoal(), dt);
    this._separate(u, allies, dt);
  }

  _taunt(u, enemies) {
    const a = CONFIG.abilities.taunt;
    u.abilityTimer = a.cooldown;
    let hit = false;
    for (const e of enemies) {
      if (dist(u.pos, e.pos) <= a.radius) {
        e.addThreat(u, a.threat);
        // Mark the bat as taunted so the renderer can show it.
        e.taunted = true;
        e.tauntTimer = CONFIG.threat.tauntDuration;
        hit = true;
      }
    }
    if (hit) {
      this.effects.push({
        type: 'taunt', pos: { ...u.pos }, radius: a.radius, life: 0.5,
      });
    }
  }

  _aiSoldier(u, enemies, allies, dt) {
    // Follow tank, focus-fire tank's target.
    const tank = this.playerUnits.find(a => a.role === 'tank' && a.alive);
    let target = tank && tank.target && tank.target.alive ? tank.target : nearestEnemy(u, enemies);

    if (target && dist(u.pos, target.pos) <= u.range) {
      this._attack(u, target);
      // Cleave: hit all enemies in a small arc in front.
      if (u.abilityTimer <= 0) this._cleave(u, enemies);
      u.vel = { x: 0, y: 0 };
      return;
    }
    const goal = target ? target.pos : (tank ? tank.pos : this._exitGoal());
    this._moveAlongPath(u, goal, dt);
    this._separate(u, allies, dt);
  }

  _cleave(u, enemies) {
    const a = CONFIG.abilities.cleave;
    u.abilityTimer = CONFIG.combat.attackCooldown * 2;
    const dir = u.target ? norm(sub(u.target.pos, u.pos)) : { x: 1, y: 0 };
    let hit = false;
    for (const e of enemies) {
      if (dist(u.pos, e.pos) > a.range) continue;
      const toE = norm(sub(e.pos, u.pos));
      const dot = toE.x * dir.x + toE.y * dir.y;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (angle <= a.arc / 2) {
        e.takeDamage(u.atk * a.damage);
        hit = true;
      }
    }
    if (hit) {
      this.effects.push({
        type: 'cleave', pos: { ...u.pos }, dir, arc: a.arc, range: a.range, life: 0.25,
      });
    }
  }

  _aiArcher(u, enemies, allies, dt) {
    const target = lowestHpEnemy(u, enemies, u.range);
    if (target) {
      // Kite: if enemy too close, back away.
      const d = dist(u.pos, target.pos);
      if (d < u.range * 0.5) {
        const away = norm(sub(u.pos, target.pos));
        u.vel = scale(away, u.speed);
        u.kiteTimer = 0.3;
        return;
      }
      if (d <= u.range) {
        this._attack(u, target);
        // Piercing shot: hit the first enemy and one behind it.
        if (u.abilityTimer <= 0) this._pierce(u, target, enemies);
        u.vel = { x: 0, y: 0 };
        return;
      }
      // Move into range.
      this._moveAlongPath(u, target.pos, dt);
      this._separate(u, allies, dt);
      return;
    }
    // No target: advance toward exit.
    this._moveAlongPath(u, this._exitGoal(), dt);
    this._separate(u, allies, dt);
  }

  _pierce(u, target, enemies) {
    const a = CONFIG.abilities.pierce;
    u.abilityTimer = CONFIG.combat.attackCooldown * 2;
    const dir = norm(sub(target.pos, u.pos));
    // Find the enemy behind the target along the shot direction.
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
      behind.takeDamage(u.atk * a.damage);
      this.effects.push({
        type: 'pierce', from: { ...u.pos }, to: { ...behind.pos }, life: 0.2,
      });
    }
  }

  _aiHealer(u, enemies, allies, dt) {
    // Stay behind team, heal lowest-HP ally.
    const ally = lowestHpAlly(u, allies);
    if (ally && u.healTimer <= 0 && dist(u.pos, ally.pos) <= CONFIG.healer.healRange) {
      ally.heal(CONFIG.healer.healAmount);
      u.healTimer = CONFIG.healer.healCooldown;
      this.effects.push({
        type: 'heal', from: { ...u.pos }, to: { ...ally.pos }, life: 0.4,
      });
      // Healing generates threat.
      for (const e of enemies) {
        e.addThreat(u, CONFIG.threat.healThreat);
      }
    }

    // Keep distance from enemies.
    const near = nearestEnemy(u, enemies);
    if (near && dist(u.pos, near.pos) < 3) {
      const away = norm(sub(u.pos, near.pos));
      u.vel = scale(away, u.speed);
      return;
    }

    // No enemies: head to exit. Otherwise stay near the team.
    const goal = enemies.length === 0 ? this._exitGoal() : { x: CONFIG.doors.entrance.x, y: CONFIG.doors.entrance.y - 2 };
    this._moveAlongPath(u, goal, dt);
    this._separate(u, allies, dt);
  }

  // --- Bat AI (boids) ---

  _updateBat(u, dt) {
    const enemies = this.playerUnits.filter(e => e.alive);
    if (enemies.length === 0) { u.vel = { x: 0, y: 0 }; return; }

    // Pick target: bias toward squishy (archer/healer) and low-HP.
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
    u.vel = clampLen(add(u.vel, scale(force, dt)), u.speed);

    // Attack if in range.
    if (target && dist(u.pos, target.pos) <= u.range) {
      this._attack(u, target);
    }
  }

  _pickBatTarget(u, enemies) {
    // Score all enemies: prefer squishy (archer/healer) and low-HP, but the
    // tank is still targetable when it is nearest. Threat (from taunt) is a
    // strong override so a taunted tank pulls aggro.
    const bias = CONFIG.threat.backlineBias;
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      const d = dist(u.pos, e.pos);
      const hpFrac = e.hp / e.maxHp;
      const squishy = (e.role === 'archer' || e.role === 'healer') ? bias : 0;
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
    return norm(sub(targetPos, u.pos));
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
    u.vel = scale(dir, u.speed);
  }

  _separate(u, allies, dt) {
    const t = CONFIG.team;
    let steer = { x: 0, y: 0 };
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      const d = dist(u.pos, a.pos);
      if (d > 0 && d < t.separationRadius) {
        const diff = norm(sub(u.pos, a.pos));
        steer = add(steer, scale(diff, 1 / d));
      }
    }
    if (steer.x !== 0 || steer.y !== 0) {
      u.vel = clampLen(add(u.vel, scale(steer, t.separationWeight)), u.speed);
    }
  }

  _attack(u, target) {
    if (u.attackTimer > 0) return;
    u.attackTimer = CONFIG.combat.attackCooldown;
    u.target = target;
    target.takeDamage(u.atk);
    // Attacking generates threat.
    target.addThreat(u, u.atk);
    // Visual effect for every attack so damage is visible.
    this.effects.push({
      type: 'attack',
      from: { ...u.pos },
      to: { ...target.pos },
      color: u.team === 'player' ? '#fbbf24' : '#f87171',
      life: 0.15,
    });
  }
}
