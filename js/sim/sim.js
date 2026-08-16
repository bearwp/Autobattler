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
    this.paused = false;      // debug: freeze the sim so the player can inspect
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
    this.intel = {};          // shared team knowledge: kind -> { hitsTaken, dmgTaken }, persists across rooms
    this.play = null;         // current leader-called play: { type, targetId, until }
    this.playsEnabled = false; // leader-called plays toggle (off by default)
    this.bubbles = [];        // active speech bubbles: { unitId, text, life }
    this._nextBubbleAt = 0;   // sim time when the next line may be spoken
    this._saidFirstBlood = false;
    this._saidOutnumbered = false;
    this._saidWinning = false;
    this._reset();
  }

  _reset() {
    this.level = 1;
    this.deadIds = new Set();
    this.intel = {};          // fresh run: the team forgets what it knew
    this._generateMap();
    this._enterNode(this.map.nodes[0].id);
  }

  // --- Synergy (pair bonds) ---

  // Canonical key for a pair of members, sorted so order doesn't matter.
  // Keyed by the stable member id (def.id), not the per-room unit instance id,
  // so bonds persist across rooms as intended.
  _bondKey(a, b) {
    const ai = a.def.id, bi = b.def.id;
    return ai < bi ? `${ai}|${bi}` : `${bi}|${ai}`;
  }

  _getBond(a, b) {
    return this.bonds.get(this._bondKey(a, b)) ?? 0;
  }

  _growBond(a, b, amount) {
    if (a === b) return;
    const key = this._bondKey(a, b);
    this.bonds.set(key, (this.bonds.get(key) ?? 0) + amount);
  }

  // --- Shared intel (team knowledge) ---
  // Danger is shared: when any member gets hit by a kind, the whole team learns
  // how hard that kind hits. Lives on the Sim so it persists across rooms (the
  // team remembers brutes from the last room) and resets on a fresh run.

  // Record that a member was hit by an enemy of `kind` for `dmg`.
  recordSharedHit(kind, dmg) {
    const r = this.intel[kind] || (this.intel[kind] = { hitsTaken: 0, dmgTaken: 0 });
    r.hitsTaken++;
    r.dmgTaken += dmg;
  }

  // Average damage this kind has dealt to the team per hit (0 if never seen).
  sharedDanger(kind) {
    const r = this.intel[kind];
    if (!r || r.hitsTaken === 0) return 0;
    return r.dmgTaken / r.hitsTaken;
  }

  // Effective danger of `kind` for a specific member: the shared team danger
  // ramped by how personally familiar that member is with the kind. A veteran
  // (many hits) is fully scared; a fresh recruit (zero hits) is only mildly
  // cautious even though it has heard the tank grunt.
  memberDanger(u, kind) {
    const base = this.sharedDanger(kind);
    if (base <= 0) return 0;
    const fam = u.familiarityOf(kind);
    const ramp = CONFIG.intel.familiarityRamp;
    return base * (1 - ramp * Math.exp(-fam));
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
      // Resting refills mana for units that use it (e.g. the healer).
      this._refillMana();
      return;
    }
    this._startLevel(node);
  }

  // Refill mana for all living members that use it. Mana only regenerates at
  // rest points, so a healer must rest to keep healing.
  _refillMana() {
    for (const m of this.members) {
      if (this.deadIds.has(m.id)) continue;
      if (m.stats.mana) m.stats.mana.current = m.stats.mana.max;
    }
  }

  // Generate a small pool of random members to offer at a rest point.
  _rollRecruits() {    const pool = [];
    for (let i = 0; i < 3; i++) {
      pool.push(this._randomMember());
    }
    return pool;
  }

  // A random member drawn from the attribute vocabulary.
  _randomMember() {
    const id = 'r' + (++this._recruitSeq);
    const names = ['Rogue', 'Knight', 'Mage', 'Ranger', 'Cleric', 'Berserker', 'Scout', 'Warden',
      'Aria', 'Bram', 'Cora', 'Dax', 'Elara', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jax',
      'Kira', 'Liam', 'Mara', 'Niko', 'Owen', 'Pia', 'Quinn', 'Rhea', 'Soren', 'Tessa',
      'Ulf', 'Vera', 'Wren', 'Xander', 'Yara', 'Zane', 'Bryn', 'Cade', 'Della', 'Emmett',
      'Freya', 'Galen', 'Hazel', 'Ivo', 'Juno', 'Kade', 'Liora', 'Milo', 'Nadia', 'Orin',
      'Petra', 'Ronan', 'Sable', 'Talon', 'Una', 'Vance', 'Willa', 'Yuri', 'Zelda'];
    const colors = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#22d3ee', '#a78bfa', '#f472b6', '#94a3b8'];
    const shapes = ['square', 'triangle', 'circle'];
    const atkTypes = ['damage', 'damage', 'damage', 'heal', 'taunt'];
    const atkShapes = ['rangeOneShot', 'rangeAoe', 'meleeOneShot', 'meleeCone', 'meleeAoe'];
    const moves = ['keepDistance', 'kite', 'evade', 'follow', 'advance'];
    const rules = ['lowestHp', 'highestHp', 'closest', 'strongest', 'weakest', 'mostAtOnce', 'threatened'];
    const modPool = ['taunt', 'lifesteal', 'pierce', 'slow', 'peel', 'evasive'];
    const personalities = ['stoic', 'cocky', 'cautious', 'cheerful', 'grumpy', 'nervous', 'chatty'];

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
      personality: personalities[Math.floor(Math.random() * personalities.length)],
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
    // Reset dialogue state so a fresh room starts talking cleanly. The global
    // bubble cooldown is sim-time based, so it must reset with the clock.
    this.bubbles = [];
    this._nextBubbleAt = 0;
    this._saidFirstBlood = false;
    this._saidOutnumbered = false;
    this._saidWinning = false;
    this._saidBossFight = false;
    this._saidEliteFight = false;
    this._queueTeam();
    this._spawnBats(node);
    // Mana refreshes at the start of every round so casters can use their
    // abilities each fight rather than only after resting.
    this._refillMana();
  }

  // Team enters through the left door one by one.
  _queueTeam() {
    const { entrance } = CONFIG.doors;
    const gap = 0.8; // seconds between each member entering
    // Skip members that died in a previous level (perma-death).
    const alive = this.members.filter(m => !this.deadIds.has(m.id));
    // Stagger spawn positions vertically across the door gap so members enter
    // side by side instead of all piling onto the same point and jamming the
    // narrow doorway.
    const doorHalf = entrance.width / 2;
    const spread = Math.max(0.4, doorHalf - 0.4); // keep clear of the door edges
    this._spawnQueue = alive.map((m, i) => {
      // Evenly distribute across the door gap; alternate sides for odd counts.
      const t = alive.length > 1 ? i / (alive.length - 1) : 0.5;
      const y = entrance.y - spread + 2 * spread * t;
      return {
        member: m,
        pos: { x: entrance.x + 0.5, y },
        at: i * gap,
        slot: i,
      };
    });
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
      const lvlMult = Math.pow(1 + m.levelHpMult, this.level - 1);
      const lvlAtk = Math.pow(1 + m.levelAtkMult, this.level - 1);
      const bossDef = {        ...CONFIG.enemies.bat,
        hp: m.bossHp * lvlMult, atk: m.bossAtk * lvlAtk, size: 1.2, color: '#f43f5e',
      };
      const u = new Unit(bossDef, { team: 'enemy', pos });
      this.units.push(u);
      this.enemyUnits.push(u);

      // Boss adds: a small escort of mixed enemy types around the boss.
      const escortCount = m.bossEscortCount;
      for (let i = 0; i < escortCount; i++) {
        const escortDef = { ...this._pickEnemyType() };
        escortDef.hp = escortDef.hp * lvlMult;
        escortDef.atk = escortDef.atk * lvlAtk;
        const angle = (i / escortCount) * Math.PI * 2;
        const epos = {
          x: pos.x + Math.cos(angle) * 3,
          y: pos.y + Math.sin(angle) * 3,
        };
        const e = new Unit(escortDef, { team: 'enemy', pos: epos });
        this.units.push(e);
        this.enemyUnits.push(e);
      }
      // The team reacts to facing the boss.
      if (!this._saidBossFight) {
        this._saidBossFight = true;
        const speaker = this.playerUnits.find(a => a.alive);
        if (speaker) this._say(speaker, 'bossFight');
      }
      return;
    }

    // Combat / elite: a swarm of a randomly-chosen enemy type (elite is tougher).
    const enemyDef = this._pickEnemyType();
    const n = enemyDef.count + (this.level - 1) * enemyDef.countPerLevel;
    const elite = type === 'elite';
    // Enemies scale up each level so the run keeps getting harder even though
    // the swarm size grows slowly. Applied after the elite multiplier.
    const lvlMult = Math.pow(1 + m.levelHpMult, this.level - 1);
    const lvlAtk = Math.pow(1 + m.levelAtkMult, this.level - 1);
    for (let i = 0; i < n; i++) {
      const pos = {
        x: 3 + Math.random() * (width - 6),
        y: 2 + Math.random() * (height - 4),
      };
      const base = elite
        ? { ...enemyDef, hp: enemyDef.hp * m.eliteHpMult, atk: enemyDef.atk * m.eliteAtkMult, color: '#fb923c' }
        : enemyDef;
      const def = { ...base, hp: base.hp * lvlMult, atk: base.atk * lvlAtk };
      const u = new Unit(def, { team: 'enemy', pos });
      this.units.push(u);
      this.enemyUnits.push(u);
    }
    // The team reacts to an elite room.
    if (elite && !this._saidEliteFight) {
      this._saidEliteFight = true;
      const speaker = this.playerUnits.find(a => a.alive);
      if (speaker) this._say(speaker, 'eliteFight');
    }
  }

  // Pick an enemy type for a combat room, weighted by CONFIG.enemyWeights.
  _pickEnemyType() {
    const weights = CONFIG.enemyWeights;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const [id, w] of Object.entries(weights)) {
      r -= w;
      if (r <= 0) return CONFIG.enemies[id];
    }
    return CONFIG.enemies.bat;
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
    if (!this.started || this.over || this.paused) return;
    this.time += dt;

    // Release queued team members as their entry time arrives.
    while (this._spawnQueue.length > 0 && this._spawnQueue[0].at <= this.time) {
      const s = this._spawnQueue.shift();
      const u = new Unit(s.member, { team: 'player', pos: s.pos });
      u.slot = s.slot;
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
      // Passive mana regen during combat so mana users (e.g. the healer)
      // can keep casting without needing to rest constantly.
      if (u.maxMana > 0) u.mana = Math.min(u.maxMana, u.mana + dt * CONFIG.combat.manaRegen);
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
    if (this.playsEnabled) this._callPlays(dt);
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.isBat) this._updateEnemy(u, dt);
      else this._updateMember(u, dt);
    }

    // Persist mana back to the member def so it carries across rooms.
    for (const u of this.playerUnits) {
      if (u.def.stats && u.def.stats.mana) u.def.stats.mana.current = u.mana;
    }

    // Integrate positions.
    for (const u of this.units) {
      if (!u.alive) continue;
      u.pos.x += (u.vel.x + u.knockback.x) * dt;
      u.pos.y += (u.vel.y + u.knockback.y) * dt;
      // Knockback decays quickly so it's a short shove, not a permanent drift.
      u.knockback = scale(u.knockback, Math.max(0, 1 - dt * CONFIG.combat.knockbackDecay));
      // The white damage flash fades out each step.
      u.hitFlash = Math.max(0, u.hitFlash - dt * CONFIG.combat.hitFlashDecay);
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

    // Banter reactions to deaths that happened this step.
    for (const u of this.units) {
      if (!u.alive || !u._deathFx) continue;
      if (u.team === 'enemy') {
        // A member whose target just died celebrates the kill.
        const killer = this.playerUnits.find(a => a.alive && a.target === u);
        if (killer) this._say(killer, 'killing', u);
      } else {
        // A member just fell: surviving allies react.
        for (const a of this.playerUnits) {
          if (a.alive && a !== u) this._say(a, 'allyDown', u);
        }
      }
    }

    // A member that just dropped to low HP speaks up (once per drop).
    for (const u of this.playerUnits) {
      if (!u.alive) continue;
      if (u.hp / u.maxHp < 0.35 && !u._saidLowHp) {
        u._saidLowHp = true;
        this._say(u, 'lowHp');
      } else if (u.hp / u.maxHp >= 0.5) {
        u._saidLowHp = false;
      }
    }

    // A member that just took a hit reacts (occasionally, not every hit).
    for (const u of this.playerUnits) {
      if (!u.alive || !u._tookDamage) continue;
      u._tookDamage = false;
      if (Math.random() < 0.25) this._say(u, 'takingDamage');
    }

    // First kill of the room: the team celebrates.
    if (!this._saidFirstBlood && this.enemyUnits.some(e => !e.alive)) {
      this._saidFirstBlood = true;
      const speaker = this.playerUnits.find(a => a.alive);
      if (speaker) this._say(speaker, 'firstBlood');
    }

    // Outnumbered: the team reacts when heavily outnumbered.
    const aliveEnemies = this.enemyUnits.filter(e => e.alive).length;
    const aliveAllies = this.playerUnits.filter(a => a.alive).length;
    if (aliveEnemies > aliveAllies * CONFIG.team.holdOutnumberMult && !this._saidOutnumbered) {
      this._saidOutnumbered = true;
      const speaker = this.playerUnits.find(a => a.alive);
      if (speaker) this._say(speaker, 'outnumbered');
    } else if (aliveEnemies <= aliveAllies) {
      this._saidOutnumbered = false;
    }

    // Winning: the team cheers when the last enemies are nearly gone.
    if (aliveEnemies > 0 && aliveEnemies <= 2 && !this._saidWinning) {
      this._saidWinning = true;
      const speaker = this.playerUnits.find(a => a.alive);
      if (speaker) this._say(speaker, 'winning');
    } else if (aliveEnemies > 2) {
      this._saidWinning = false;
    }

    // Team banter: age out bubbles and tick per-unit speak cooldowns. Lines
    // themselves are emitted at the moment their situation happens (see _say).
    this._updateBubbles(dt);

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
      if (Math.abs(u.pos.y - exit.y) <= exit.width / 2 && u.pos.x >= exit.x - 1.0) {
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
    // Rest nodes pause the sim (their screen is shown instead); only combat
    // rooms start running. Setting started=true here would let _checkEnd run
    // during rest and re-trigger the room-clear with the stale empty enemy
    // list, opening the map behind the rest overlay.
    const node = this.map.nodes.find(n => n.id === nodeId);
    if (!node || node.type !== 'rest') this.started = true;
  }

  // --- Member AI (generic, driven by the member's attribute bundle) ---

  // The leader calls plays: a lightweight coordination layer that nudges the
  // whole team toward a shared goal. It only runs while a leader is alive and
  // there are enemies. Each play is a short-lived directive (a few seconds)
  // that biases every member's behavior, so the team acts as one unit instead
  // of each member doing its own thing. The leader picks a play based on the
  // situation: retreat when hurt, hold when outnumbered, focus the backline
  // when a squishy is exposed, otherwise focus fire.
  _callPlays(dt) {
    const leader = this.playerUnits.find(a => a.alive && a.isLeader);
    const enemies = this.enemyUnits.filter(e => e.alive);
    if (!leader || enemies.length === 0) { this.play = null; return; }

    // Expire the current play once its duration elapses.
    if (this.play && this.time >= this.play.until) {
      this.play = null;
      for (const a of this.playerUnits) a._saidRetreat = false;
    }

    // Only call a new play when there isn't one active.
    if (this.play) return;

    const t = CONFIG.team;
    const allies = this.playerUnits.filter(a => a.alive);
    const avgHp = allies.reduce((s, a) => s + a.hp / a.maxHp, 0) / allies.length;
    const play = { type: 'focus', targetId: null, until: this.time + t.playDuration };

    // Retreat: the team is badly hurt, fall back toward the exit to regroup.
    if (avgHp < t.retreatHpThreshold) {
      play.type = 'retreat';
      this.play = play;
      return;
    }

    // Hold the line: heavily outnumbered, dig in and defend instead of pushing.
    if (enemies.length > allies.length * t.holdOutnumberMult) {
      play.type = 'hold';
      this.play = play;
      return;
    }

    // Scatter: enemies are clustered together (AOE threat), so spread out to
    // avoid taking splash damage as a group.
    if (this._enemiesClustered(enemies)) {
      play.type = 'scatter';
      this.play = play;
      return;
    }

    // Backline: a squishy enemy is exposed, focus it down.
    const squishy = enemies.find(e => e.armor <= 0 && e.hp < e.maxHp * 0.8);
    if (squishy) {
      play.type = 'backline';
      play.targetId = squishy.id;
      this.play = play;
      return;
    }

    // Focus fire: pick the enemy most of the team is already attacking, or
    // the lowest-HP one, so the team concentrates damage and kills fast.
    const counts = new Map();
    for (const u of this.playerUnits) {
      if (!u.alive || !u.target || !u.target.alive) continue;
      counts.set(u.target.id, (counts.get(u.target.id) ?? 0) + 1);
    }
    let best = null, bestCount = 0;
    for (const [id, c] of counts) {
      if (c > bestCount) { bestCount = c; best = id; }
    }
    if (best) {
      play.type = 'focus';
      play.targetId = best;
    } else {
      // No one is attacking yet: focus the lowest-HP enemy.
      let low = null, lowHp = Infinity;
      for (const e of enemies) {
        if (e.hp < lowHp) { lowHp = e.hp; low = e; }
      }
      if (low) { play.type = 'focus'; play.targetId = low.id; }
    }

    this.play = play;
  }

  // True when a group of enemies is bunched together tightly enough that an
  // AOE would hit several of them at once. Used to call a scatter play.
  _enemiesClustered(enemies) {
    const t = CONFIG.team;
    for (let i = 0; i < enemies.length; i++) {
      let count = 0;
      for (let j = 0; j < enemies.length; j++) {
        if (i === j) continue;
        if (dist(enemies[i].pos, enemies[j].pos) <= t.scatterClusterRadius) count++;
      }
      if (count >= t.scatterClusterCount) return true;
    }
    return false;
  }

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
      // Leader's play: if the leader called a focus/backline target, prefer it
      // so the team concentrates fire instead of scattering.
      if (this.play && (this.play.type === 'focus' || this.play.type === 'backline') && this.play.targetId) {
        const called = enemies.find(e => e.id === this.play.targetId);
        if (called && dist(u.pos, called.pos) <= u.attack.range) target = called;
      }
    }

    // Leader's play overrides movement for the whole team.
    if (this.play && this.play.type === 'retreat') {
      if (!u._saidRetreat) {
        u._saidRetreat = true;
        this._say(u, 'retreating');
      }
      this._intent(u, 'retreating (leader call)');
      this._moveAlongPath(u, this._exitGoal(), dt);
      this._separate(u, allies, dt);
      this._resolveAttacks(u, target, enemies, allies);
      return;
    }
    if (this.play && this.play.type === 'hold') {
      this._intent(u, 'holding the line (leader call)');
      this._idleWander(u, dt);
      this._resolveAttacks(u, target, enemies, allies);
      return;
    }
    if (this.play && this.play.type === 'scatter') {
      this._intent(u, 'scattering (leader call)');
      this._scatter(u, allies, enemies, dt);
      this._resolveAttacks(u, target, enemies, allies);
      return;
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

    // Occasional "thinking" line reflecting what the unit is currently doing.
    this._think(u);
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
  // team concentrates damage. Falls back to the rule-picked target. Also
  // blends in per-member intel: a member pounces on an enemy it has personally
  // softened (high killability) and shies away from one it knows hits hard
  // (high danger) unless that enemy is already vulnerable.
  _focusFireTarget(u, target, enemies, allies) {
    const it = CONFIG.intel;
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      if (!e.alive) continue;
      if (dist(u.pos, e.pos) > u.attack.range) continue;
      let score = 0;
      for (const a of allies) {
        if (a === u || !a.alive) continue;
        if (a.target === e) score += this._getBond(u, a) * CONFIG.synergy.focusBias;
      }
      // Intel: pounce on what I've personally softened, avoid what the team
      // knows hits hard (ramped by my own familiarity) unless it is already
      // vulnerable (low HP).
      const kill = u.killabilityOf(e);
      const danger = this.memberDanger(u, e.def.kind);
      const vulnerable = e.hp / e.maxHp < it.avoidHpFrac;
      score += kill * it.pounceWeight;
      if (danger > it.avoidDanger && !vulnerable) score -= danger * it.dangerWeight;
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
    this._intent(u, 'peeling for ally');
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
    this._intent(u, 'evading hunter');
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
        if (!u.seekingHeal) {
          // Just started seeking healing: speak up.
          this._say(u, 'seekingHeal');
        }
        u.seekingHeal = true;
        const healer = allies.find(a => a.alive && a !== u && a.attack && a.attack.type === 'heal');
        if (healer) {
          this._intent(u, 'seeking healer');
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
          this._intent(u, 'hiding behind ally');
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

    // Intel-driven caution: a squishy member that has learned an enemy hits
    // hard avoids diving in. It retreats when it can actually escape (or is
    // being actively engaged / swarmed), and holds ground when fleeing is
    // futile (slower than the target, or the target outranges it). Either way
    // it doesn't charge into a fight it can't win. The decision (with its
    // reasoning) is stored on the unit for the debug overlay.
    const avoid = this._avoidDecision(u, target, enemies, allies);
    u.avoid = avoid;
    if (avoid && avoid.action === 'retreat') {
      this._intent(u, 'backing off (dangerous enemy)');
      this._say(u, 'avoiding', target);
      const away = norm(sub(u.pos, target.pos));
      const toExit = norm(sub(this._exitGoal(), u.pos));
      const dir = norm(add(away, scale(toExit, 0.8)));
      this._setVel(u, scale(dir, u.effSpeed), dt);
      this._separate(u, allies, dt);
      return;
    }
    if (avoid && avoid.action === 'hold') {
      this._intent(u, 'holding ground (can\'t escape)');
      this._say(u, 'holding', target);
      this._idleWander(u, dt);
      this._separate(u, allies, dt);
      return;
    }

    // Follow: follow the leader (or advance if no leader alive).
    if (mv === 'follow') {
      const leader = this.playerUnits.find(a => a.alive && a.isLeader);
      const goal = leader ? this._advanceGoal(u) : this._exitGoal();
      if (leader) {
        const d = dist(u.pos, goal);
        const t = CONFIG.team;
        // Hysteresis: stop once inside the follow distance, resume only after
        // drifting past it by the dead-zone, so the follower doesn't jitter at
        // the boundary. This lets it get close and hold a comfortable gap.
        if (d <= t.followDistance) {
          if (!u.following) u.following = true;
          if (u.following && d >= t.followDistance - t.followHysteresis) {
            this._intent(u, 'following leader');
            this._idleWander(u, dt);
            return;
          }
        } else {
          u.following = false;
        }
        this._intent(u, 'following leader');
        this._moveAlongPath(u, goal, dt);
        this._separate(u, allies, dt);
        return;
      }
      this._intent(u, 'advancing to exit');
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
        this._intent(u, 'advancing (no enemies)');
        this._moveAlongPath(u, this._advanceGoal(u), dt);
        this._separate(u, allies, dt);
        return;
      }
      const dNear = dist(u.pos, near.pos);
      if (dNear < CONFIG.team.kiteDistance - CONFIG.team.kiteHysteresis) {
        // Back away from the enemy, but bias the retreat toward the exit so
        // the unit doesn't get pinned against the entrance wall.
        this._intent(u, 'kiting away');
        const away = norm(sub(u.pos, near.pos));
        const toExit = norm(sub(this._exitGoal(), u.pos));
        const dir = norm(add(away, scale(toExit, 0.8)));
        this._setVel(u, scale(dir, u.effSpeed), dt);
        u.kiteTimer = 0.3;
        return;
      }
      if (dNear > u.attack.range) {
        // Too far to shoot: close in on the nearest enemy.
        this._intent(u, 'closing to range');
        this._moveAlongPath(u, near.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      // In range: hold and shoot.
      this._intent(u, 'shooting');
      u.vel = { x: 0, y: 0 };
      return;
    }

    // KeepDistance: hold a comfortable distance from enemies.
    if (mv === 'keepDistance') {
      const near = nearestEnemy(u, enemies);
      if (near && dist(u.pos, near.pos) < CONFIG.team.keepDistance - CONFIG.team.keepHysteresis) {
        this._intent(u, 'backing off');
        const away = norm(sub(u.pos, near.pos));
        this._setVel(u, scale(away, u.effSpeed), dt);
        return;
      }
      this._intent(u, 'holding distance');
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
        this._intent(u, 'advancing (no hunter)');
        this._moveAlongPath(u, this._advanceGoal(u), dt);
        this._separate(u, allies, dt);
        return;
      }
      const dH = dist(u.pos, hunter.pos);
      if (dH < CONFIG.team.evadeDistance - CONFIG.team.evadeHysteresis) {
        this._intent(u, 'evading hunter');
        const away = norm(sub(u.pos, hunter.pos));
        const toExit = norm(sub(this._exitGoal(), u.pos));
        const dir = norm(add(away, scale(toExit, 0.8)));
        this._setVel(u, scale(dir, u.effSpeed), dt);
        return;
      }
      if (dH > u.attack.range) {
        this._intent(u, 'closing on hunter');
        this._moveAlongPath(u, hunter.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      this._intent(u, 'shooting hunter');
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Flank: circle around the target to attack from the side, avoiding its
    // front arc. Moves to a point offset perpendicular to the line to the
    // target, then closes in once positioned.
    if (mv === 'flank') {
      if (!target) {
        this._intent(u, 'advancing (no target)');
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
        this._intent(u, 'flanking target');
        this._moveAlongPath(u, side, dt);
        this._separate(u, allies, dt);
        return;
      }
      // In range: hold and attack.
      this._intent(u, 'attacking from flank');
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Charge: build up speed toward the target and ram it for bonus damage.
    if (mv === 'charge') {
      if (target && dist(u.pos, target.pos) > u.attack.range) {
        if (!u.chargeReady) this._say(u, 'charging', target);
        u.chargeReady = true;
        this._intent(u, 'charging target');
        this._moveAlongPath(u, target.pos, dt);
        this._separate(u, allies, dt);
        // Override the path speed with a charge burst.
        const dir = norm(sub(target.pos, u.pos));
        this._setVel(u, scale(dir, u.effSpeed * CONFIG.team.chargeSpeedMult), dt);
        return;
      }
      if (!target) {
        u.chargeReady = false;
        this._intent(u, 'advancing (no target)');
        this._moveAlongPath(u, this._advanceGoal(u), dt);
        this._separate(u, allies, dt);
        return;
      }
      this._intent(u, 'attacking');
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
        this._intent(u, 'intercepting threat to ally');
        this._moveAlongPath(u, threat.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      // No immediate threat: hold position near the guarded ally.
      if (guarded !== u && dist(u.pos, guarded.pos) > CONFIG.team.guardDistance) {
        this._intent(u, 'guarding ally');
        this._moveAlongPath(u, guarded.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      this._intent(u, 'guarding');
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Hunt: relentlessly chase the nearest enemy, ignoring the exit. Only
    // advances toward the exit when no enemies remain.
    if (mv === 'hunt') {
      const prey = nearestEnemy(u, enemies);
      if (prey) {
        this._intent(u, 'hunting prey');
        this._moveAlongPath(u, prey.pos, dt);
        this._separate(u, allies, dt);
        return;
      }
      this._intent(u, 'advancing (no prey)');
      this._moveAlongPath(u, this._advanceGoal(u), dt);
      this._separate(u, allies, dt);
      return;
    }

    // Advance (default): move toward target, else toward exit.
    if (target && dist(u.pos, target.pos) > u.attack.range) {
      this._intent(u, 'advancing on target');
      this._moveAlongPath(u, target.pos, dt);
      this._separate(u, allies, dt);
      return;
    }
    if (!target) {
      this._intent(u, 'advancing to exit');
      this._moveAlongPath(u, this._advanceGoal(u), dt);
      this._separate(u, allies, dt);
      return;
    }
    this._intent(u, 'attacking');
    u.vel = { x: 0, y: 0 };
  }

  // Intel-driven caution: decide how a squishy member reacts to a dangerous
  // target. Returns null (fight normally) or { action, danger, outnumbered,
  // engaged, canEscape, reason }. Considers the target's learned danger, its
  // HP, the member's own killability, whether a tank is absorbing, how
  // outnumbered the member is, whether it is being actively engaged, and
  // whether it can actually outrun or outrange the target. Healers never
  // avoid (it's their job to stay back). Tanks tolerate far more danger
  // before avoiding, but will still retreat if truly threatened.
  _avoidDecision(u, target, enemies, allies) {
    if (!target || !target.alive) return null;
    const it = CONFIG.intel;
    // Healers don't avoid.
    if (u.attack.type === 'heal') return null;
    // Only cautious when hurt.
    if (u.hp / u.maxHp < it.avoidHpFrac) return null;
    // Must have learned this kind hits hard (shared knowledge, ramped by
    // personal familiarity). A ranged enemy's reach inflates its danger since
    // it can hit from beyond the member's own range.
    let danger = this.memberDanger(u, target.def.kind);
    const outranged = target.def.range > u.attack.range;
    if (outranged) danger *= it.rangeThreat;
    // Tanks are built to absorb hits, so they need a much higher danger bar
    // before they'll back off.
    const isTank = u.armor >= it.tankArmor;
    if (isTank) danger *= it.tankDangerMult;
    if (danger <= it.avoidDanger) return null;
    // Don't avoid if the target is already vulnerable (pounce instead).
    if (target.hp / target.maxHp < it.avoidHpFrac) return null;
    // If the member can actually finish the enemy, commit instead of fleeing.
    if (u.killabilityOf(target) >= it.pounceKillFrac) return null;
    // A tank absorbing the hits means it's safe to stay and fight.
    const tankEngaging = allies.some(a => a.alive && a !== u && a.armor >= it.tankArmor &&
      a.target && a.target.alive && a.target === target);
    if (tankEngaging) return null;

    // Outnumbered: too many enemies nearby to safely engage.
    let nearby = 0;
    for (const e of enemies) {
      if (e === target) continue;
      if (dist(u.pos, e.pos) <= it.swarmRadius) nearby++;
    }
    const outnumbered = nearby >= it.swarmCount;

    // Actively engaged: an enemy is currently targeting this member.
    const engaged = enemies.some(e => e.target === u);

    // Can the member actually escape? It must be faster than the target, and
    // the target must not outrange it (a ranged enemy can hit it while it
    // flees, so running is pointless).
    const canEscape = u.effSpeed > target.effSpeed * it.speedEscape && !outranged;

    // Retreat when it can escape and is in real danger (engaged or swarmed).
    // Otherwise hold ground rather than die running.
    if (canEscape && (engaged || outnumbered)) {
      return { action: 'retreat', danger, outnumbered, engaged, canEscape, reason: 'engaged/swarmed, can escape' };
    }
    return { action: 'hold', danger, outnumbered, engaged, canEscape, reason: 'can\'t escape' };
  }

  // Where a member heads when there's nothing to fight. The leader leads
  // toward the exit; everyone else trails behind the leader so the leader
  // stays in front instead of being overtaken by the back line. Followers
  // fan out into a compact wedge behind the leader (by formation slot) so
  // they don't all stack on the same point, clump together, or stretch into
  // an unwieldy single-file line when the party is large.
  _advanceGoal(u) {
    const leader = this.playerUnits.find(a => a.alive && a.isLeader);
    if (!leader || u.isLeader) return this._exitGoal();
    const back = norm(sub(leader.pos, this._exitGoal()));
    const t = CONFIG.team;
    // Fan followers out behind the leader: the first sits directly behind,
    // and each later slot swings further out to the side, forming a wedge
    // that stays tight around the leader no matter how many members there are.
    const i = u.slot - 1; // 0 for the first follower
    const angle = i * t.formationWedge;
    const side = { x: -back.y, y: back.x };
    const dir = norm(add(scale(back, Math.cos(angle)), scale(side, Math.sin(angle))));
    return add(leader.pos, scale(dir, t.followDistance));
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
        // Heal the target (an ally). Costs mana if the healer uses it; a
        // healer with no mana left can't heal until the team rests.
        if (u.maxMana > 0 && u.mana < u.manaCost) {
          this._intent(u, 'out of mana');
          break;
        }
        if (u.maxMana > 0) u.mana -= u.manaCost;
        target.heal(atk.atk);
        this._say(u, 'healing', target);
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
          this._say(u, 'taunting');
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
            const dealt = behind.takeDamage(atk.atk * 0.7);
            u.recordDeal(behind.def.kind, dealt);
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
      const dealt = target.takeDamage(dmg);
      u.recordDeal(target.def.kind, dealt);
      target.addThreat(u, dmg);
      this._knockback(target, u.pos, CONFIG.combat.knockback);
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
          const dealt = e.takeDamage(dmg);
          u.recordDeal(e.def.kind, dealt);
          e.addThreat(u, dmg);
          this._knockback(e, center, CONFIG.combat.knockback);
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
          const dealt = e.takeDamage(dmg);
          u.recordDeal(e.def.kind, dealt);
          e.addThreat(u, dmg);
          this._knockback(e, u.pos, CONFIG.combat.knockback);
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
    const dealt = target.takeDamage(CONFIG.secondary.atk);
    u.recordDeal(target.def.kind, dealt);
    target.addThreat(u, CONFIG.secondary.atk);
    this._knockback(target, u.pos, CONFIG.combat.knockback);
    this.effects.push({
      type: 'attack', from: { ...u.pos }, to: { ...target.pos },
      color: u.team === 'player' ? '#fbbf24' : '#f87171', life: 0.15,
    });
  }

  // --- Enemy AI ---
  // Dispatches to a per-kind behavior. All kinds share the same target
  // picker (_pickBatTarget) but move and attack differently.

  _updateEnemy(u, dt) {
    switch (u.def.kind) {
      case 'brute': return this._updateBrute(u, dt);
      case 'spitter': return this._updateSpitter(u, dt);
      case 'wisp': return this._updateWisp(u, dt);
      default: return this._updateBat(u, dt);
    }
  }

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
        const dealt = target.takeDamage(u.def.atk);
        target.recordHit(u.def.kind);
        this.recordSharedHit(u.def.kind, dealt);
        target.addThreat(u, u.def.atk);
        this._knockback(target, u.pos, CONFIG.combat.knockback);
        this.effects.push({
          type: 'attack', from: { ...u.pos }, to: { ...target.pos },
          color: '#f87171', life: 0.15,
        });
      }
    }
  }

  // Brute: slow, tanky melee. Ignores boids cohesion, charges straight at the
  // target and hits hard up close.
  _updateBrute(u, dt) {
    const enemies = this.playerUnits.filter(e => e.alive);
    if (enemies.length === 0) { u.vel = { x: 0, y: 0 }; return; }
    const target = this._pickBatTarget(u, enemies);

    const toTarget = norm(sub(target.pos, u.pos));
    const wall = this._boidWallAvoidance(u);
    const steer = add(scale(toTarget, 1.0), scale(wall, 2.0));
    const force = clampLen(steer, CONFIG.boids.maxForce);
    u.vel = clampLen(add(u.vel, scale(force, dt)), u.effSpeed);

    if (target && dist(u.pos, target.pos) <= u.def.range) {
      if (u.attackTimer <= 0) {
        u.attackTimer = CONFIG.combat.attackCooldown;
        u.target = target;
        const dealt = target.takeDamage(u.def.atk);
        target.recordHit(u.def.kind);
        this.recordSharedHit(u.def.kind, dealt);
        target.addThreat(u, u.def.atk);
        this._knockback(target, u.pos, CONFIG.combat.knockback);
        this.effects.push({
          type: 'attack', from: { ...u.pos }, to: { ...target.pos },
          color: '#f87171', life: 0.15,
        });
      }
    }
  }

  // Spitter: ranged. Keeps distance from its target and fires from afar.
  _updateSpitter(u, dt) {
    const enemies = this.playerUnits.filter(e => e.alive);
    if (enemies.length === 0) { u.vel = { x: 0, y: 0 }; return; }
    const target = this._pickBatTarget(u, enemies);

    const d = dist(u.pos, target.pos);
    const desired = u.def.range * 0.7; // preferred standoff distance
    let steer;
    if (d > desired + 0.5) {
      steer = norm(sub(target.pos, u.pos));          // close in
    } else if (d < desired - 0.5) {
      steer = norm(sub(u.pos, target.pos));          // back off
    } else {
      steer = { x: 0, y: 0 };
    }
    const wall = this._boidWallAvoidance(u);
    const force = clampLen(add(scale(steer, 1.0), scale(wall, 2.0)), CONFIG.boids.maxForce);
    u.vel = clampLen(add(u.vel, scale(force, dt)), u.effSpeed);

    if (target && d <= u.def.range) {
      if (u.attackTimer <= 0) {
        u.attackTimer = CONFIG.combat.attackCooldown;
        u.target = target;
        const dealt = target.takeDamage(u.def.atk);
        target.recordHit(u.def.kind);
        this.recordSharedHit(u.def.kind, dealt);
        target.addThreat(u, u.def.atk);
        this._knockback(target, u.pos, CONFIG.combat.knockback);
        this.effects.push({
          type: 'attack', from: { ...u.pos }, to: { ...target.pos },
          color: '#22d3ee', life: 0.15,
        });
      }
    }
  }

  // Wisp: fast, fragile swarm. Same boids behavior as bats but faster and
  // lighter, so it zips around and harasses the back line.
  _updateWisp(u, dt) {
    this._updateBat(u, dt);
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
    // Per-unit desync: bats remember which enemy they last chose and hold onto
    // it unless another target beats it by a small margin. Without this every
    // bat scores the same squishy target each frame, so the whole swarm
    // converges on one point instead of spreading out.
    const lastTargetId = u.target && u.target.alive ? u.target.id : null;
    const stickiness = CONFIG.boids.targetStickiness;
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      const d = dist(u.pos, e.pos);
      const hpFrac = e.hp / e.maxHp;
      const squishy = e.armor <= 0 ? bias : 0;
      const threat = u.threat.get(e.id) ?? 0;
      let score = -d + squishy + (1 - hpFrac) * 5 + threat;
      // Bias toward the current target so it keeps committing to one enemy.
      if (e.id === lastTargetId) score += stickiness;
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
    // Build a set of cells occupied by other units so pathfinding routes
    // around teammates instead of walking through them. Only units that are
    // actually standing in a cell count; the moving unit itself is excluded.
    const occupied = new Set();
    for (const o of this.units) {
      if (o === u || !o.alive) continue;
      const cell = this.grid.worldToCell(o.pos);
      occupied.add(this.grid.idx(cell.c, cell.r));
    }

    // Recompute the path only when the goal has moved meaningfully or the
    // current path is exhausted. Re-running A* every frame (e.g. while
    // following a moving leader) causes visible stutter and constant
    // re-evaluation; throttling it keeps movement smooth.
    const needRepath =
      !u.path || u.pathIndex >= u.path.length ||
      !u.pathGoal || dist(u.pathGoal, goal) > CONFIG.team.repathDistance;
    // If a straight line to the goal is clear, snap back to LOS and drop the
    // A* waypoints. This lets units cut corners the moment an obstacle stops
    // blocking them instead of walking the full grid path.
    if (!needRepath && this.grid._lineClear(
      this.grid.worldToCell(u.pos).c, this.grid.worldToCell(u.pos).r,
      this.grid.worldToCell(goal).c, this.grid.worldToCell(goal).r, occupied)) {
      u.path = [goal];
      u.pathIndex = 0;
      u.pathGoal = { ...goal };
    }
    if (needRepath) {
      u.path = this.grid.findPath(u.pos, goal, occupied);
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

  // Record a human-readable intent for the debug overlay.
  _intent(u, msg) { u.intent = msg; }

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

  // Apply a knockback impulse to a unit, pushing it away from `from`.
  _knockback(u, from, strength) {
    if (!u.alive) return;
    const dir = norm(sub(u.pos, from));
    u.knockback = add(u.knockback, scale(dir, strength));
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

  // Scatter: spread the team out so a clustered enemy AOE can't hit everyone
  // at once. Each member pushes away from nearby allies and from the enemy
  // cluster, while still keeping the enemy in attack range.
  _scatter(u, allies, enemies, dt) {
    const t = CONFIG.team;
    let steer = { x: 0, y: 0 };

    // Push away from nearby allies.
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      const d = dist(u.pos, a.pos);
      if (d > 0 && d < t.scatterRadius) {
        const diff = norm(sub(u.pos, a.pos));
        const strength = 1 - d / t.scatterRadius;
        steer = add(steer, scale(diff, strength));
      }
    }

    // Push away from the enemy cluster center.
    if (enemies.length > 0) {
      let cx = 0, cy = 0;
      for (const e of enemies) { cx += e.pos.x; cy += e.pos.y; }
      cx /= enemies.length; cy /= enemies.length;
      const toCluster = sub(u.pos, { x: cx, y: cy });
      const dC = len(toCluster);
      if (dC > 0 && dC < t.scatterClusterRadius) {
        steer = add(steer, scale(norm(toCluster), 1 - dC / t.scatterClusterRadius));
      }
    }

    if (steer.x !== 0 || steer.y !== 0) {
      this._setVel(u, clampLen(add(u.vel, scale(steer, t.scatterWeight)), u.effSpeed), dt);
    } else {
      // Already spread out: hold position.
      u.vel = { x: 0, y: 0 };
    }
  }

  // --- Team banter ---
  // Members occasionally speak based on what they're thinking and doing. A
  // line is chosen from the situation pool, the speaker's name (and target's)
  // are substituted, and it's shown as a speech bubble. Lines are throttled by
  // a global cooldown so the team doesn't chatter constantly.

  // Age out expired speech bubbles.
  _updateBubbles(dt) {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      this.bubbles[i].life -= dt;
      if (this.bubbles[i].life <= 0) this.bubbles.splice(i, 1);
    }
    // Tick each unit's per-unit speak cooldown and think timer.
    for (const u of this.playerUnits) {
      if (u.speakCooldown > 0) u.speakCooldown = Math.max(0, u.speakCooldown - dt);
      if (u.thinkTimer > 0) u.thinkTimer = Math.max(0, u.thinkTimer - dt);
    }
  }

  // Emit a dialogue line for a unit. Called at the moment the situation is
  // actually happening (a heal, a kill, an ally falling, etc.), so lines are
  // always relevant. Throttled per-unit and globally so the team doesn't
  // chatter constantly.
  _say(u, key, target) {
    if (!u || !u.alive) return;
    if (u.speakCooldown > 0) return;
    if (this.time < this._nextBubbleAt) return;
    const d = CONFIG.dialogue;
    // Chatty members speak more readily; quiet personalities hold back.
    const talk = u.personality === 'chatty' ? 1.6 : (u.personality === 'stoic' || u.personality === 'grumpy' ? 0.5 : 1);
    if (Math.random() > d.chance * talk) return;
    // Prefer the speaker's personality take on this situation; fall back to
    // the generic pool so every situation still has a line.
    const persona = d.lines.personality && d.lines.personality[u.personality];
    const pool = (persona && persona[key]) || d.lines[key] || d.lines.idle;
    if (pool.length === 0) return;
    const line = pool[Math.floor(Math.random() * pool.length)]
      .replace(/\{name\}/g, u.displayName)
      .replace(/\{target\}/g, (target && target.alive ? target.displayName : 'them'));

    this.bubbles.push({ unitId: u.id, text: line, life: d.bubbleLife });
    // Keep only the most recent bubbles on screen.
    if (this.bubbles.length > d.maxLines) this.bubbles.shift();
    u.speakCooldown = d.cooldown;
    this._nextBubbleAt = this.time + d.cooldown;
  }

  // Occasional "thinking" line based on what the unit is currently doing.
  // Fires on a slow per-unit timer so the team talks regularly without
  // spamming, and always reflects the unit's actual current action.
  _think(u) {
    if (u.thinkTimer > 0) return;
    if (u.speakCooldown > 0) return;
    if (this.time < this._nextBubbleAt) return;
    // Out of mana: the healer can't heal, so it says so.
    if (u.maxMana > 0 && u.mana < u.manaCost) {
      this._say(u, 'outOfMana');
      return;
    }
    // Low mana: the healer is running dry but can still cast.
    if (u.maxMana > 0 && u.mana < u.maxMana * 0.5) {
      this._say(u, 'lowMana');
      u.thinkTimer = CONFIG.dialogue.thinkInterval;
      return;
    }
    // No enemies left: the team notices the room is clear.
    if (this.enemyUnits.every(e => !e.alive)) {
      // If the unit is just standing around (not advancing), trade relaxed
      // quiet banter; otherwise note the room is clear and move on.
      const intent = u.intent || '';
      this._say(u, intent.includes('advanc') ? 'noEnemies' : 'quiet');
      u.thinkTimer = CONFIG.dialogue.thinkInterval;
      return;
    }
    const intent = u.intent || '';
    let key = 'idle';
    if (intent.includes('advanc')) key = 'advancing';
    else if (intent.includes('attack') || intent.includes('shoot') || intent.includes('charge')) key = 'attacking';
    else if (intent.includes('kite') || intent.includes('backing off')) key = 'kiting';
    else if (intent.includes('guard')) key = 'guarding';
    else if (intent.includes('hunt')) key = 'hunting';
    this._say(u, key);
    // Reset the think timer so this unit doesn't chatter again soon.
    u.thinkTimer = CONFIG.dialogue.thinkInterval;
  }
}