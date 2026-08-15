// The simulation. Owns ALL game state and runs on a fixed timestep.
// The render layer reads this object but never mutates it.

import { CONFIG } from './config.js';
import { Grid } from './grid.js';
import { Unit, pickTarget, nearestEnemy, threatenedEnemy, lowestHpAlly } from './unit.js';
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
    this.map = null;          // { nodes, edges } generated at reset
    this.currentNodeId = null;
    this.mapOpen = false;     // true while the player is choosing the next room
    this.restOpen = false;    // true while the player is at a rest screen
    this.restCandidates = []; // members offered at a rest point
    this._recruitSeq = 0;     // unique id counter for recruited members
    this.bonds = new Map();   // "idA|idB" (sorted) -> bond value, persists across rooms
    this._reset();
  }

  _reset() {
    this.level = 1;
    this.deadIds = new Set();
    this._generateMap();
    this._enterNode(this.map.nodes[0].id);
  }

  // --- Synergy (pair bonds) ---

  // Canonical key for a pair of members, sorted so order doesn't matter.
  _bondKey(a, b) {
    return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
  }

  _getBond(a, b) {
    return this.bonds.get(this._bondKey(a, b)) ?? 0;
  }

  _growBond(a, b, amount) {
    if (a === b) return;
    const key = this._bondKey(a, b);
    this.bonds.set(key, (this.bonds.get(key) ?? 0) + amount);
  }

  // Generate a Slay-the-Spire-style branching map: a start node, several
  // middle floors of random nodes, and a boss node. Edges connect each node to
  // one or more nodes on the next floor.
  _generateMap() {
    const m = CONFIG.map;
    const nodes = [];
    const edges = [];
    let id = 0;
    const addNode = (floor, type) => {
      const n = { id: 'n' + (id++), floor, type };
      nodes.push(n);
      return n;
    };

    // Start node.
    const start = addNode(0, 'start');
    let prevFloor = [start];

    // Middle floors.
    for (let f = 1; f < m.floors - 1; f++) {
      const count = m.minPerFloor + Math.floor(Math.random() * (m.maxPerFloor - m.minPerFloor + 1));
      const floorNodes = [];
      for (let i = 0; i < count; i++) {
        const type = this._randomNodeType();
        floorNodes.push(addNode(f, type));
      }
      // Connect every previous node to at least one node on this floor.
      for (const p of prevFloor) {
        const targets = this._sample(floorNodes, 1 + Math.floor(Math.random() * 2));
        for (const t of targets) edges.push({ from: p.id, to: t.id });
      }
      prevFloor = floorNodes;
    }

    // Boss node.
    const boss = addNode(m.floors - 1, 'boss');
    for (const p of prevFloor) edges.push({ from: p.id, to: boss.id });

    // Prune nodes that can't be reached from the start (or can't reach the
    // boss), so the map only shows rooms the player can actually visit.
    this.map = this._pruneMap({ nodes, edges }, start.id, boss.id);
  }

  // Remove nodes unreachable from `startId` and nodes that can't reach
  // `endId`, along with their edges. Keeps the map a clean, fully-traversable
  // DAG.
  _pruneMap(map, startId, endId) {
    const out = new Map(map.nodes.map(n => [n.id, []]));
    for (const e of map.edges) out.get(e.from).push(e.to);

    // Forward reachability from the start.
    const reachable = new Set();
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const to of out.get(cur) || []) stack.push(to);
    }

    // Reverse reachability from the end (nodes that can reach the boss).
    const rev = new Map(map.nodes.map(n => [n.id, []]));
    for (const e of map.edges) rev.get(e.to).push(e.from);
    const canReachEnd = new Set();
    const rstack = [endId];
    while (rstack.length) {
      const cur = rstack.pop();
      if (canReachEnd.has(cur)) continue;
      canReachEnd.add(cur);
      for (const from of rev.get(cur) || []) rstack.push(from);
    }

    const keep = new Set([...reachable].filter(id => canReachEnd.has(id)));
    const nodes = map.nodes.filter(n => keep.has(n.id));
    const edges = map.edges.filter(e => keep.has(e.from) && keep.has(e.to));
    return { nodes, edges };
  }

  _randomNodeType() {
    const r = Math.random();
    if (r < 0.55) return 'combat';
    if (r < 0.75) return 'elite';
    if (r < 0.9) return 'rest';
    return 'treasure';
  }

  _sample(arr, n) {
    const copy = arr.slice();
    const out = [];
    while (out.length < n && copy.length > 0) {
      out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
  }

  // Enter a node: set it as current and start its room.
  _enterNode(nodeId) {
    this.currentNodeId = nodeId;
    this.mapOpen = false;
    const node = this.map.nodes.find(n => n.id === nodeId);
    if (node && node.type === 'rest') {
      // Rest nodes open a rest screen instead of a combat room.
      this.restOpen = true;
      this.restCandidates = this._rollRecruits();
      this.started = false;
      this.over = null;
      return;
    }
    this._startLevel(node);
  }

  // Generate a small pool of random members to offer at a rest point.
  _rollRecruits() {
    const pool = [];
    for (let i = 0; i < 3; i++) {
      pool.push(this._randomMember());
    }
    return pool;
  }

  // A random member drawn from the attribute vocabulary.
  _randomMember() {
    const id = 'r' + (++this._recruitSeq);
    const names = ['Rogue', 'Knight', 'Mage', 'Ranger', 'Cleric', 'Berserker', 'Scout', 'Warden'];
    const colors = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#22d3ee', '#a78bfa', '#f472b6', '#94a3b8'];
    const shapes = ['square', 'triangle', 'circle'];
    const atkTypes = ['damage', 'damage', 'damage', 'heal', 'taunt'];
    const atkShapes = ['rangeOneShot', 'rangeAoe', 'meleeOneShot', 'meleeCone', 'meleeAoe'];
    const moves = ['hold', 'keepDistance', 'kite', 'evade', 'follow', 'advance'];
    const rules = ['lowestHp', 'highestHp', 'closest', 'strongest', 'weakest', 'mostAtOnce', 'threatened'];
    const modPool = ['taunt', 'lifesteal', 'pierce', 'slow', 'peel', 'evasive'];

    const type = atkTypes[Math.floor(Math.random() * atkTypes.length)];
    const shape = atkShapes[Math.floor(Math.random() * atkShapes.length)];
    const mods = [];
    if (Math.random() < 0.5) mods.push(modPool[Math.floor(Math.random() * modPool.length)]);

    return {
      id,
      name: names[Math.floor(Math.random() * names.length)],
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: shapes[Math.floor(Math.random() * shapes.length)],
      stats: {
        hp: 80 + Math.floor(Math.random() * 220),
        armor: Math.floor(Math.random() * 9),
        speed: 2 + Math.random() * 2,
        size: 0.6 + Math.random() * 0.4,
      },
      attack: {
        type,
        shape,
        range: shape.startsWith('range') ? 4 + Math.random() * 4 : 1 + Math.random() * 2,
        atk: 10 + Math.floor(Math.random() * 25),
      },
      modifiers: mods,
      target: { side: type === 'heal' ? 'ally' : 'enemy', rule: rules[Math.floor(Math.random() * rules.length)] },
      movement: moves[Math.floor(Math.random() * moves.length)],
      leader: false,
    };
  }

  // Recruit a member offered at a rest point.
  recruitMember(candidateId) {
    const c = this.restCandidates.find(x => x.id === candidateId);
    if (!c) return;
    this.members.push(c);
    this.restCandidates = this.restCandidates.filter(x => x.id !== candidateId);
  }

  // Leave the rest screen and open the map to choose the next node.
  finishRest() {
    this.restOpen = false;
    this.mapOpen = true;
    this.started = false;
  }

  // Nodes reachable from the current node (the player's next choices).
  _nextChoices() {
    return this.map.edges
      .filter(e => e.from === this.currentNodeId)
      .map(e => this.map.nodes.find(n => n.id === e.to));
  }

  // Set up a fresh level: spawn bats and queue the team to enter one by one.
  _startLevel(node) {
    this.units = [];
    this.playerUnits = [];
    this.enemyUnits = [];
    this.time = 0;
    this.started = false;
    this.over = null;
    this.effects = [];
    this._spawnQueue = [];
    this._queueTeam();
    this._spawnBats(node);
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

  _spawnBats(node) {
    const { width, height } = CONFIG.world;
    const type = node ? node.type : 'combat';
    const m = CONFIG.map;

    // Rest and treasure rooms have no enemies.
    if (type === 'rest' || type === 'treasure') {
      if (type === 'treasure') this._applyTreasure();
      return;
    }

    // Boss room: a single large bat.
    if (type === 'boss') {
      const pos = { x: width * 0.7, y: height / 2 };
      const bossDef = {
        ...CONFIG.bat,
        hp: m.bossHp, atk: m.bossAtk, size: 1.2, color: '#f43f5e',
      };
      const u = new Unit(bossDef, { team: 'enemy', pos });
      this.units.push(u);
      this.enemyUnits.push(u);
      return;
    }

    // Combat / elite: a swarm of bats (elite bats are tougher).
    const n = CONFIG.bat.count + (this.level - 1) * CONFIG.bat.countPerLevel;
    const elite = type === 'elite';
    for (let i = 0; i < n; i++) {
      const pos = {
        x: 3 + Math.random() * (width - 6),
        y: 2 + Math.random() * (height - 4),
      };
      const def = elite
        ? { ...CONFIG.bat, hp: CONFIG.bat.hp * m.eliteHpMult, atk: CONFIG.bat.atk * m.eliteAtkMult, color: '#fb923c' }
        : CONFIG.bat;
      const u = new Unit(def, { team: 'enemy', pos });
      this.units.push(u);
      this.enemyUnits.push(u);
    }
  }

  // Treasure room: grant a permanent max-HP bonus to all living members.
  _applyTreasure() {
    for (const m of this.members) {
      if (this.deadIds.has(m.id)) continue;
      m.stats.hp += CONFIG.map.treasureHpBonus;
    }
  }

  start() {
    if (this.over) this._reset();
    if (this.mapOpen) return; // wait for the player to pick a node
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
      this._smoothFacing(u, dt);
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

  // Smoothly rotate a unit's facing toward its movement direction, so units
  // turn gradually instead of snapping. Idle units keep their last heading.
  _smoothFacing(u, dt) {
    const speed = len(u.vel);
    if (speed < 0.05) return; // too slow to infer a heading; keep current facing
    const target = Math.atan2(u.vel.y, u.vel.x);
    let diff = target - u.facing;
    // Wrap to the shortest turn.
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = CONFIG.team.turnRate * dt;
    u.facing += clamp(diff, -maxTurn, maxTurn);
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
        this._roomCleared();
        return;
      }
    }
  }

  // A room is cleared: open the map so the player picks the next node. If this
  // was the boss, the run is won.
  _roomCleared() {
    // Surviving a room together strengthens every pair's bond.
    const alive = this.playerUnits.filter(u => u.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        this._growBond(alive[i], alive[j], CONFIG.synergy.roomClearBond);
      }
    }

    const node = this.map.nodes.find(n => n.id === this.currentNodeId);
    if (node && node.type === 'boss') {
      this.over = 'win';
      return;
    }
    const choices = this._nextChoices();
    if (choices.length === 0) {
      this.over = 'win';
      return;
    }
    this.mapOpen = true;
    this.started = false; // pause the sim while the map is shown
  }

  // The player chose a node on the map; enter it.
  chooseNode(nodeId) {
    if (!this.mapOpen) return;
    const choices = this._nextChoices();
    if (!choices.some(c => c.id === nodeId)) return;
    this.level += 1;
    this._enterNode(nodeId);
    this.started = true;
  }

  // --- Member AI (generic, driven by the member's attribute bundle) ---

  _updateMember(u, dt) {
    const enemies = this.enemyUnits.filter(e => e.alive);
    const allies = this.playerUnits.filter(a => a.alive);

    // Determine the target side and candidates.
    const side = u.targetRule.side;
    const candidates = side === 'ally' ? allies : enemies;

    // Pick a target by the configured rule, then apply synergy biases.
    let target = pickTarget(u, candidates, u.attack.range);
    if (u.attack.type === 'heal') {
      target = this._healTarget(u, allies);
    } else if (side === 'enemy') {
      target = this._focusFireTarget(u, target, enemies, allies);
    }

    // Movement decision.
    this._applyMovement(u, target, enemies, allies, dt);

    // Peel: units with the peel modifier rush to defend squishy allies.
    this._peelForAllies(u, enemies, allies, dt);

    // Evasive: units with the evasive modifier back away from their hunter.
    this._evasiveRetreat(u, enemies, dt);

    // Self-preservation: situational overrides (hide / seek heal) that take
    // priority over the normal movement decided above.
    this._selfPreservation(u, enemies, allies, dt);

    // Resolve attacks (primary + universal secondary).
    this._resolveAttacks(u, target, enemies, allies);
  }

  // Healers prefer the ally with the strongest bond, weighted against how
  // hurt they are, so a bonded ally is favored over a stranger.
  _healTarget(u, allies) {
    let best = null, bestScore = -Infinity;
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      if (a.hp >= a.maxHp) continue;
      const missing = a.maxHp - a.hp;
      const score = missing + this._getBond(u, a) * CONFIG.synergy.healBiasFactor;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  // Focus fire: prefer an enemy a bonded ally is already attacking, so the
  // team concentrates damage. Falls back to the rule-picked target.
  _focusFireTarget(u, target, enemies, allies) {
    let best = null, bestScore = 0;
    for (const e of enemies) {
      if (!e.alive) continue;
      if (dist(u.pos, e.pos) > u.attack.range) continue;
      let score = 0;
      for (const a of allies) {
        if (a === u || !a.alive) continue;
        if (a.target === e) score += this._getBond(u, a) * CONFIG.synergy.focusBias;
      }
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best || target;
  }

  // A unit with the 'peel' modifier abandons its own target to engage an
  // enemy that is menacing a squishy ally, shielding the back line. It prefers
  // the ally it is most bonded with.
  _peelForAllies(u, enemies, allies, dt) {
    if (!u.modifiers.includes('peel')) return;
    const t = CONFIG.team;

    // Find the best squishy ally to defend: highest bond, then most hurt.
    let best = null, bestScore = -Infinity;
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      const squishy = a.armor <= 0 || a.hp < a.maxHp * 0.5;
      if (!squishy) continue;
      const threat = nearestEnemy(a, enemies);
      if (!threat) continue;
      if (dist(a.pos, threat.pos) > t.protectRadius) continue;
      if (dist(u.pos, threat.pos) > t.protectEngageRange) continue;
      const score = this._getBond(u, a) * CONFIG.synergy.protectBias + (a.maxHp - a.hp);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (!best) return;

    const threat = nearestEnemy(best, enemies);
    // Peel: move toward the enemy menacing the ally.
    this._moveAlongPath(u, threat.pos, dt);
    this._separate(u, allies, dt);
    // Defending an ally strengthens the bond with them.
    this._growBond(u, best, CONFIG.synergy.peelBond);
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

  // Self-preservation instincts. These override the normal movement decided in
  // _applyMovement. Priority: seek healing (most urgent) > hide behind a
  // protector. Each only fires while its trigger holds, with hysteresis so the
  // unit doesn't flip-flop at the threshold.
  _selfPreservation(u, enemies, allies, dt) {
    const sp = u.selfPreservation;
    if (sp.length === 0) return;
    const t = CONFIG.team;

    // Seek heal: run to the healer while badly hurt.
    if (sp.includes('seekHeal')) {
      const hpFrac = u.hp / u.maxHp;
      const threshold = t.healSeekThreshold;
      const active = u.seekingHeal || hpFrac < threshold;
      if (active && hpFrac < threshold + t.healSeekHysteresis) {
        u.seekingHeal = true;
        const healer = allies.find(a => a.alive && a !== u && a.attack && a.attack.type === 'heal');
        if (healer) {
          this._moveAlongPath(u, healer.pos, dt);
          this._separate(u, allies, dt);
          return;
        }
      } else {
        u.seekingHeal = false;
      }
    }

    // Hide: retreat behind the tankiest ally when an enemy is close.
    if (sp.includes('hide')) {
      const threat = nearestEnemy(u, enemies);
      if (threat && dist(u.pos, threat.pos) < t.hideThreatRange) {
        const protector = this._pickProtector(u, allies);
        if (protector) {
          const away = norm(sub(protector.pos, threat.pos));
          const spot = add(protector.pos, scale(away, t.hideOffset));
          this._moveAlongPath(u, spot, dt);
          this._separate(u, allies, dt);
          return;
        }
      }
    }
  }

  // Pick the ally to hide behind: the tankiest (highest armor, then HP),
  // excluding the unit itself. Falls back to the leader.
  _pickProtector(u, allies) {
    let best = null, bestScore = -Infinity;
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      const score = a.armor * 10 + a.maxHp;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best) return best;
    return this.playerUnits.find(a => a.alive && a.isLeader) || null;
  }

  _applyMovement(u, target, enemies, allies, dt) {
    const mv = u.movement;

    // Hold: stay put (still attack in range), with a subtle idle drift so the
    // unit doesn't look frozen.
    if (mv === 'hold') {
      this._idleWander(u, dt);
      return;
    }

    // Follow: follow the leader (or advance if no leader alive).
    if (mv === 'follow') {
      const leader = this.playerUnits.find(a => a.alive && a.isLeader);
      const goal = leader ? leader.pos : this._exitGoal();
      if (leader) {
        const d = dist(u.pos, leader.pos);
        const t = CONFIG.team;
        // Hysteresis: stop once inside the follow distance, resume only after
        // drifting past it by the dead-zone, so the follower doesn't jitter at
        // the boundary. This lets it get close and hold a comfortable gap.
        if (d <= t.followDistance) {
          if (!u.following) u.following = true;
          if (u.following && d >= t.followDistance - t.followHysteresis) {
            this._idleWander(u, dt);
            return;
          }
        } else {
          u.following = false;
        }
        this._moveAlongPath(u, goal, dt);
        this._separate(u, allies, dt);
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
        // No enemies: trail the leader instead of racing to the exit.
        this._moveAlongPath(u, this._advanceGoal(u), dt);
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
      const goal = enemies.length === 0 ? this._advanceGoal(u) : { x: CONFIG.doors.entrance.x + 2, y: CONFIG.doors.entrance.y };
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
        this._moveAlongPath(u, this._advanceGoal(u), dt);
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

    // Flank: circle around the target to attack from the side, avoiding its
    // front arc. Moves to a point offset perpendicular to the line to the
    // target, then closes in once positioned.
    if (mv === 'flank') {
      if (!target) {
        this._moveAlongPath(u, this._advanceGoal(u), dt);
        this._separate(u, allies, dt);
        return;
      }
      const toT = sub(target.pos, u.pos);
      const dT = len(toT);
      // Perpendicular direction (rotate the unit->target vector 90 degrees).
      const perp = { x: -toT.y, y: toT.x };
      const perpN = norm(perp);
      const side = add(target.pos, scale(perpN, CONFIG.team.flankDistance));
      if (dT > u.attack.range + 0.5) {
        // Still far: head for the flanking point.
        this._moveAlongPath(u, side, dt);
        this._separate(u, allies, dt);
        return;
      }
      // In range: hold and attack.
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Charge: build up speed toward the target and ram it for bonus damage.
    if (mv === 'charge') {
      if (target && dist(u.pos, target.pos) > u.attack.range) {
        u.chargeReady = true;
        this._moveAlongPath(u, target.pos, dt);
        this._separate(u, allies, dt);
        // Override the path speed with a charge burst.
        const dir = norm(sub(target.pos, u.pos));
        this._setVel(u, scale(dir, u.effSpeed * CONFIG.team.chargeSpeedMult), dt);
        return;
      }
      if (!target) {
        u.chargeReady = false;
        this._moveAlongPath(u, this._advanceGoal(u), dt);
        this._separate(u, allies, dt);
        return;
      }
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Guard: stay near a designated ally and engage anything that threatens
    // them. Guards the leader, or the most hurt ally if no leader is alive.
    if (mv === 'guard') {
      const leader = this.playerUnits.find(a => a.alive && a.isLeader);
      const guarded = leader || lowestHpAlly(u, allies) || u;
      const threat = nearestEnemy(guarded, enemies);
      if (threat && dist(guarded.pos, threat.pos) <= CONFIG.team.guardEngageRange) {
        // An enemy is menacing the guarded ally: intercept it.
        this._moveAlongPath(u, threat.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      // No immediate threat: hold position near the guarded ally.
      if (guarded !== u && dist(u.pos, guarded.pos) > CONFIG.team.guardDistance) {
        this._moveAlongPath(u, guarded.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Hunt: relentlessly chase the nearest enemy, ignoring the exit. Only
    // advances toward the exit when no enemies remain.
    if (mv === 'hunt') {
      const prey = nearestEnemy(u, enemies);
      if (prey) {
        this._moveAlongPath(u, prey.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      this._moveAlongPath(u, this._advanceGoal(u), dt);
      this._separate(u, allies, dt);
      return;
    }

    // Advance (default): move toward target, else toward exit.
    if (target && dist(u.pos, target.pos) > u.attack.range) {
      this._moveAlongPath(u, target.pos, dt);
      this._separate(u, allies, dt);
      return;
    }
    if (!target) {
      this._moveAlongPath(u, this._advanceGoal(u), dt);
      this._separate(u, allies, dt);
      return;
    }
    u.vel = { x: 0, y: 0 };
  }

  // Where a member heads when there's nothing to fight. The leader leads
  // toward the exit; everyone else trails behind the leader so the leader
  // stays in front instead of being overtaken by the back line.
  _advanceGoal(u) {
    const leader = this.playerUnits.find(a => a.alive && a.isLeader);
    if (!leader || u.isLeader) return this._exitGoal();
    const back = norm(sub(leader.pos, this._exitGoal()));
    return add(leader.pos, scale(back, CONFIG.team.followDistance));
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
        // Healing strengthens the bond between healer and target.
        this._growBond(u, target, CONFIG.synergy.healBond);
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
        // Focus fire: grow bonds with allies also attacking this target.
        for (const a of allies) {
          if (a === u || !a.alive) continue;
          if (a.target === target) this._growBond(u, a, CONFIG.synergy.focusBond);
        }
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
    // A charge that connects deals bonus damage, then the charge is spent.
    const dmg = atk.atk + (u.chargeReady ? CONFIG.team.chargeBonus : 0);
    if (u.chargeReady) u.chargeReady = false;

    if (shape === 'rangeOneShot' || shape === 'meleeOneShot') {
      target.takeDamage(dmg);
      target.addThreat(u, dmg);
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
          e.takeDamage(dmg);
          e.addThreat(u, dmg);
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
          e.takeDamage(dmg);
          e.addThreat(u, dmg);
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
    // Recompute the path only when the goal has moved meaningfully or the
    // current path is exhausted. Re-running A* every frame (e.g. while
    // following a moving leader) causes visible stutter and constant
    // re-evaluation; throttling it keeps movement smooth.
    const needRepath =
      !u.path || u.pathIndex >= u.path.length ||
      !u.pathGoal || dist(u.pathGoal, goal) > CONFIG.team.repathDistance;
    if (needRepath) {
      u.path = this.grid.findPath(u.pos, goal);
      u.pathIndex = 0;
      u.pathGoal = { ...goal };
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
    // Distance-based speed: full speed far away, easing down through a slow
    // radius, then gliding to a stop within the arrival radius. This makes
    // approach feel natural instead of a constant-speed march.
    const finalWp = u.path[u.path.length - 1];
    const dGoal = dist(u.pos, finalWp);
    const t = CONFIG.team;
    let speed = u.effSpeed;
    if (dGoal < t.slowRadius) {
      const f = dGoal / t.slowRadius; // 0..1, 1 at the slow radius edge
      speed = u.effSpeed * (t.minSpeedFactor + (1 - t.minSpeedFactor) * f);
    }
    if (dGoal < t.arrivalRadius) {
      speed = u.effSpeed * (dGoal / t.arrivalRadius);
    }
    this._setVel(u, scale(dir, speed), dt);
  }

  // Subtle sinusoidal drift while holding still, so idle units look alive
  // rather than frozen. Keeps them near their anchor point.
  _idleWander(u, dt) {
    const t = CONFIG.team;
    u.wanderPhase += dt * (Math.PI * 2 / t.idleWanderPeriod);
    const dx = Math.cos(u.wanderPhase) * t.idleWander;
    const dy = Math.sin(u.wanderPhase * 0.7) * t.idleWander;
    this._setVel(u, { x: dx, y: dy }, dt);
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
