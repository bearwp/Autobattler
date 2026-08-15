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
    this.over = false;        // 'win' | 'lose' | null
    this.effects = [];        // transient visual effects (read by renderer)
    this._reset();
  }

  _reset() {
    this.units = [];
    this.playerUnits = [];
    this.enemyUnits = [];
    this.time = 0;
    this.started = false;
    this.over = null;
    this.effects = [];
    this._spawnTeam();
    this._spawnBats();
  }

  _spawnTeam() {
    const { entrance } = CONFIG.doors;
    // Team enters through the top door, spread slightly.
    const spawns = [
      { role: 'tank',    pos: { x: entrance.x, y: 2.0 } },
      { role: 'soldier', pos: { x: entrance.x - 1.2, y: 2.6 } },
      { role: 'archer',  pos: { x: entrance.x + 1.2, y: 2.6 } },
      { role: 'healer',  pos: { x: entrance.x, y: 3.4 } },
    ];
    for (const s of spawns) {
      const u = new Unit(CONFIG.units[s.role], { team: 'player', role: s.role, pos: s.pos });
      this.units.push(u);
      this.playerUnits.push(u);
    }
  }

  _spawnBats() {
    const { width, height } = CONFIG.world;
    const n = CONFIG.bat.count;
    for (let i = 0; i < n; i++) {
      // Bats spawn in the lower half, spread out.
      const pos = {
        x: 3 + Math.random() * (width - 6),
        y: height * 0.55 + Math.random() * (height * 0.4),
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

    for (const u of this.units) {
      if (!u.alive) continue;
      u.attackTimer -= dt;
      u.tauntTimer = Math.max(0, u.tauntTimer - dt);
      u.healTimer = Math.max(0, u.healTimer - dt);
      u.kiteTimer = Math.max(0, u.kiteTimer - dt);
      u.abilityTimer = Math.max(0, u.abilityTimer - dt);
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

  _checkEnd() {
    const { exit } = CONFIG.doors;
    // Win: any team member reaches exit.
    for (const u of this.playerUnits) {
      if (!u.alive) continue;
      if (Math.abs(u.pos.x - exit.x) <= exit.width / 2 && u.pos.y >= exit.y - 0.5) {
        this.over = 'win';
        return;
      }
    }
    // Lose: all team members dead.
    if (this.playerUnits.every(u => !u.alive)) {
      this.over = 'lose';
    }
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
    // Tank advances toward the exit, but stops to fight enemies that get close
    // so it can't simply sprint past the swarm.
    const target = nearestEnemy(u, enemies);

    // Taunt: periodically force nearby enemies to target the tank.
    if (u.abilityTimer <= 0 && enemies.length > 0) {
      this._taunt(u, enemies);
    }

    if (target && dist(u.pos, target.pos) <= u.range) {
      this._attack(u, target);
      u.vel = { x: 0, y: 0 };
      return;
    }
    if (target && dist(u.pos, target.pos) < 3) {
      // Engage: move toward the enemy to bring it into melee range.
      this._moveAlongPath(u, target.pos, dt);
      this._separate(u, allies, dt);
      return;
    }
    const goal = { x: CONFIG.doors.exit.x, y: CONFIG.doors.exit.y - 0.5 };
    this._moveAlongPath(u, goal, dt);
    this._separate(u, allies, dt);
  }

  _taunt(u, enemies) {
    const a = CONFIG.abilities.taunt;
    u.abilityTimer = a.cooldown;
    let hit = false;
    for (const e of enemies) {
      if (dist(u.pos, e.pos) <= a.radius) {
        e.addThreat(u, a.threat);
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
    const goal = target ? target.pos : (tank ? tank.pos : { x: CONFIG.doors.exit.x, y: CONFIG.doors.exit.y - 0.5 });
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
    this._moveAlongPath(u, { x: CONFIG.doors.exit.x, y: CONFIG.doors.exit.y - 0.5 }, dt);
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

    // Position behind the team (toward entrance side).
    const anchor = { x: CONFIG.doors.entrance.x, y: 3 };
    this._moveAlongPath(u, anchor, dt);
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

    const b = CONFIG.boids;
    let fx = sep.x * b.separationWeight + coh.x * b.cohesionWeight + ali.x * b.alignmentWeight + seek.x * b.seekWeight;
    let fy = sep.y * b.separationWeight + coh.y * b.cohesionWeight + ali.y * b.alignmentWeight + seek.y * b.seekWeight;

    const force = clampLen({ x: fx, y: fy }, b.maxForce);
    u.vel = clampLen(add(u.vel, scale(force, dt)), u.speed);

    // Attack if in range.
    if (target && dist(u.pos, target.pos) <= u.range) {
      this._attack(u, target);
    }
  }

  _pickBatTarget(u, enemies) {
    // Score all enemies: prefer squishy (archer/healer) and low-HP, but the
    // tank is still targetable when it is nearest. This keeps the tank from
    // sprinting to the exit unopposed.
    const bias = CONFIG.threat.backlineBias;
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      const d = dist(u.pos, e.pos);
      const hpFrac = e.hp / e.maxHp;
      const squishy = (e.role === 'archer' || e.role === 'healer') ? bias : 0;
      const score = -d + squishy + (1 - hpFrac) * 5;
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
        steer = add(steer, scale(diff, 1 / d));
        count++;
      }
    }
    if (count > 0) steer = scale(steer, 1 / count);
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
