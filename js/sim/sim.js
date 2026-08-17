// The simulation. Owns ALL game state and runs on a fixed timestep.
// The render layer reads this object but never mutates it.

import { CONFIG } from './config.js';
import { Grid } from './grid.js';
import { Unit, pickTarget, nearestEnemy, threatenedEnemy, lowestHpAlly } from './unit.js';
import { dist, len, norm, sub, add, scale, dot, clampLen, clamp } from './vec.js';
import { completeRun, rollTavernRecruits, salaryOf } from '../meta.js';

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
    this.shopOpen = false;    // true while the player is at a shop screen
    this.eventOpen = false;   // true while the player is at an event screen
    this.restCandidates = []; // members offered at a rest point
    this.shopStock = [];      // members offered at a shop node
    this.eventState = null;   // { choices, resolved } for the current event
    this._hireJustMade = null; // id of the member just recruited free from an event
    this._recruitSeq = 0;     // unique id counter for recruited members
    this.bonds = new Map();   // "idA|idB" (sorted) -> bond value, persists across rooms
    this.intel = {};          // shared team knowledge: kind -> { hitsTaken, dmgTaken }, persists across rooms
    this.play = null;         // current leader-called play: { type, targetId, until }
    this.playsEnabled = false; // leader-called plays toggle (off by default)
    this.gold = 0;            // run gold earned from cleared rooms
    this.tavernRecruits = []; // hires offered at rest points this run
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

  // Team morale: the average confidence of the alive members, 0..1. Used as a
  // small shared combat bonus so the whole team fights together.
  get morale() {
    const alive = this.playerUnits.filter(u => u.alive);
    if (alive.length === 0) return 0.5;
    let sum = 0;
    for (const u of alive) sum += u.confidence;
    return sum / alive.length;
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
    // No intel on this kind yet: assume a baseline danger so members are
    // cautious against the unknown instead of charging in blind. Tanks are the
    // exception — they're built to absorb and are the ones who engage first to
    // learn, so they charge the unknown without fear. Once the team has been
    // hit, the learned value takes over for everyone.
    if (base <= 0) {
      // A durable member (high HP + armor) is built to absorb and is the one
      // who engages first to learn, so it charges the unknown without fear.
      return u.hp + u.armor * 10 >= 200 ? 0 : CONFIG.intel.unknownDanger;
    }
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
        const type = this._randomNodeType(f === 1);
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

  _randomNodeType(isFirstFloor) {
    const r = Math.random();
    if (r < 0.4) return 'combat';
    if (!isFirstFloor && r < 0.58) return 'elite';
    if (r < 0.72) return 'rest';
    if (r < 0.82) return 'treasure';
    if (r < 0.92) return 'shop';
    return 'event';
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
    if (node && (node.type === 'rest' || node.type === 'shop' || node.type === 'event')) {
      // Rest/shop/event nodes open their own screen instead of a combat room.
      this.restOpen = node.type === 'rest';
      this.shopOpen = node.type === 'shop';
      this.eventOpen = node.type === 'event';
      this.restCandidates = this._rollRecruits();
      this.shopStock = this._rollRecruits(CONFIG.map.shopStock);
      this.eventState = null;
      this.started = false;
      this.over = null;
      return;
    }
    this.restOpen = false;
    this.shopOpen = false;
    this.eventOpen = false;
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

  // Generate a small pool of random members to offer at a rest point or shop.
  _rollRecruits(count) {
    const pool = [];
    const n = count || 3;
    for (let i = 0; i < n; i++) {
      const m = this._randomMember();
      m.salary = salaryOf(m);
      pool.push(m);
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
    const atkTypes = ['damage', 'damage', 'damage', 'damage', 'heal', 'taunt', 'shield', 'buff', 'mana', 'summon', 'push'];
    const atkShapes = ['rangeOneShot', 'rangeAoe', 'meleeOneShot', 'meleeCone', 'meleeAoe'];
    const rules = ['lowestHp', 'highestHp', 'closest', 'strongest', 'weakest', 'mostAtOnce', 'threatened'];    const modPool = ['taunt', 'lifesteal', 'pierce', 'slow', 'peel', 'evasive', 'burn', 'stun', 'thorns', 'execute'];
    const spPool = ['hide', 'seekHeal'];
    const personalities = ['stoic', 'cocky', 'cautious', 'cheerful', 'grumpy', 'nervous', 'chatty'];

    const type = atkTypes[Math.floor(Math.random() * atkTypes.length)];
    const shape = atkShapes[Math.floor(Math.random() * atkShapes.length)];
    const mods = [];
    // Usually one modifier, sometimes two, occasionally a self-preservation instinct.
    if (Math.random() < 0.7) mods.push(modPool[Math.floor(Math.random() * modPool.length)]);
    if (Math.random() < 0.3) mods.push(modPool[Math.floor(Math.random() * modPool.length)]);
    const sp = Math.random() < 0.3 ? [spPool[Math.floor(Math.random() * spPool.length)]] : [];
    const support = type === 'heal' || type === 'shield' || type === 'buff' || type === 'mana' || type === 'summon';

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
        ...(support ? { mana: { max: 100 + Math.floor(Math.random() * 40), cost: 20 + Math.floor(Math.random() * 15) } } : {}),
      },
      attack: {
        type,
        shape,
        range: shape.startsWith('range') ? 4 + Math.random() * 4 : 1 + Math.random() * 2,
        atk: 10 + Math.floor(Math.random() * 25),
      },
      modifiers: mods,
      selfPreservation: sp,
      target: { side: (support && type !== 'taunt' && type !== 'summon') ? 'ally' : 'enemy', rule: rules[Math.floor(Math.random() * rules.length)] },
      leader: false,
      personality: personalities[Math.floor(Math.random() * personalities.length)],
      // Composure (base confidence) and stamina pool are per-member traits, so
      // random recruits vary: a brave skirmisher with high regen, or a nervous
      // tank with a deep but slow-refilling pool.
      confidence: Math.round((0.2 + Math.random() * 0.7) * 100) / 100,
      stamina: { max: 60 + Math.floor(Math.random() * 80), regen: 6 + Math.floor(Math.random() * 14) },
    };
  }

  // Recruit a member offered at a rest point.
  recruitMember(candidateId) {
    const c = this.restCandidates.find(x => x.id === candidateId);
    if (!c) return;
    if (c.salary > this.gold) return; // can't afford this hire
    this.gold -= c.salary;
    this.members.push(c);
    this.restCandidates = this.restCandidates.filter(x => x.id !== candidateId);
  }

  // Shop actions at a rest point. Each spends run gold in exchange for an
  // immediate boon, so rest becomes a "what do I need most right now" choice.
  get restHealCost() { return CONFIG.economy.healCost; }
  get restUpgradeCost() { return CONFIG.economy.upgradeCost; }

  _memberByUnitId(uid) {
    const u = this.units.find(x => x.id === uid);
    if (!u || !u.def.stats) return null;
    return u;
  }

  // Heal every living member to full HP for a gold cost.
  restHealAll() {
    if (this.gold < this.restHealCost) return false;
    const any = this.playerUnits.some(u => u.alive && u.hp < u.maxHp);
    if (!any) return false;
    this.gold -= this.restHealCost;
    for (const u of this.playerUnits) {
      if (!u.alive) continue;
      u.hp = u.maxHp;
      if (u.def.stats) u.def.stats.currentHp = u.maxHp;
    }
    return true;
  }

  // Upgrade a member's primary attack (and max HP) for a gold cost.
  restUpgrade(uid) {
    if (this.gold < this.restUpgradeCost) return false;
    const u = this._memberByUnitId(uid);
    if (!u) return false;
    this.gold -= this.restUpgradeCost;
    const def = u.def;
    def.attack.atk = Math.round((def.attack.atk || 0) * CONFIG.economy.upgradeAtkMult);
    def.stats.hp = Math.round((def.stats.hp || 0) * CONFIG.economy.upgradeHpMult);
    u.attack.atk = def.attack.atk;
    u.maxHp = def.stats.hp;
    u.hp = u.maxHp;
    if (def.stats) def.stats.currentHp = u.maxHp;
    return true;
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
    // Snapshot each living member's entry HP so "restart room" replays this
    // room from the same state the members walked in with.
    this._roomEntryHp = {};
    for (const m of this.members) {
      if (this.deadIds.has(m.id)) continue;
      // Ensure currentHp is a real number so the restart snapshot is valid.
      if (m.stats && typeof m.stats.currentHp !== 'number') m.stats.currentHp = m.stats.hp;
      this._roomEntryHp[m.id] = m.stats.currentHp;
    }
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

    // Rest, shop, event and treasure rooms have no enemies.
    if (type === 'rest' || type === 'shop' || type === 'event' || type === 'treasure') {
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

  // Treasure room: grant run gold (spent on the next rest / hires).
  _applyTreasure() {
    this.gold += CONFIG.economy.treasureGold;
  }

  // Shop room: recruit a member from the shop stock, exactly like a rest hire.
  shopBuy(candidateId) {
    const c = this.shopStock.find(x => x.id === candidateId);
    if (!c) return;
    if (c.salary > this.gold) return; // can't afford this hire
    this.gold -= c.salary;
    this.members.push(c);
    this.shopStock = this.shopStock.filter(x => x.id !== candidateId);
  }

  // Event room: one of a few small narrative boons. Each outcome is a simple,
  // immediate tradeoff the player picks. Only one choice can be taken; after
  // choosing, the event is resolved and the map reopens.
  eventChoices() {
    if (this.eventState) return this.eventState.choices;
    const alive = this.playerUnits.filter(u => u.alive);
    const choices = [];
    // Option 1: heal the team (costs gold).
    if (alive.some(u => u.hp < u.maxHp)) {
      choices.push({ id: 'heal', label: 'Pray to an old shrine', effect: 'Heal the whole team to full' });
    }
    // Option 2: gamble max HP for gold.
    if (alive.length > 0) {
      choices.push({ id: 'gamble', label: 'Offer your vitality', effect: 'Lose some max HP for 🪙 gold' });
    }
    // Option 3: free recruit.
    choices.push({ id: 'hire', label: 'Invite a wandering adventurer', effect: 'A new ally joins for free' });
    this.eventState = { choices, resolved: null };
    return choices;
  }

  // Resolve a chosen event outcome.
  resolveEvent(choiceId) {
    const choices = this.eventChoices();
    const choice = choices.find(c => c.id === choiceId);
    if (!choice || this.eventState.resolved) return;
    this.eventState.resolved = choiceId;
    const m = CONFIG.map;
    if (choiceId === 'heal') {
      for (const u of this.playerUnits) {
        if (!u.alive) continue;
        u.hp = u.maxHp;
        if (u.def.stats) u.def.stats.currentHp = u.maxHp;
      }
    } else if (choiceId === 'gamble') {
      const gold = m.eventGoldRisk;
      this.gold += gold;
      // Sacrifice a fraction of each living member's max HP (and current HP).
      for (const u of this.playerUnits) {
        if (!u.alive) continue;
        const cut = Math.max(1, Math.round(u.maxHp * m.eventGoldRiskHp));
        u.maxHp = Math.max(1, u.maxHp - cut);
        u.hp = Math.max(1, Math.min(u.hp, u.maxHp));
        if (u.def.stats) {
          u.def.stats.hp = u.maxHp;
          u.def.stats.currentHp = u.hp;
        }
      }
    } else if (choiceId === 'hire') {
      const recruits = this._rollRecruits(1);
      const r = recruits[0];
      r.salary = 0;
      this.members.push(r);
      this._hireJustMade = r.id;
    }
  }

  // Leave the event screen and open the map to choose the next node.
  finishEvent() {
    this.eventOpen = false;
    this.mapOpen = true;
    this.started = false;
  }

  // Leave the shop screen and open the map to choose the next node.
  finishShop() {
    this.shopOpen = false;
    this.mapOpen = true;
    this.started = false;
  }

  start() {
    if (this.over) this._reset();
    if (this.mapOpen) return; // wait for the player to pick a node
    this.started = true;
  }

  reset() {
    this._reset();
  }

  // Replay the current combat room: spawn fresh units for the members at their
  // HP from the start of this room. Only meaningful mid-fight (not on the map
  // or at rest, and not after the run ends).
  restartRoom() {
    if (this.over || this.mapOpen || this.restOpen || this.shopOpen || this.eventOpen) return;
    if (!this.currentNodeId) return;
    const node = this.map.nodes.find(n => n.id === this.currentNodeId);
    if (!node || node.type === 'rest' || node.type === 'shop' || node.type === 'event' || node.type === 'start') return;
    // Restore the members' HP to where they were when this room started, so
    // the replay begins from the same situation (attrition from earlier rooms
    // is preserved, but this room's damage is undone).
    for (const m of this.members) {
      if (!m.stats) continue;
      const entry = this._roomEntryHp ? this._roomEntryHp[m.id] : null;
      if (typeof entry === 'number') m.stats.currentHp = entry;
    }
    this._startLevel(node);
    this.started = true;
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
      u.tauntCooldown = Math.max(0, u.tauntCooldown - dt);
      u.kiteTimer = Math.max(0, u.kiteTimer - dt);
      u.slowTimer = Math.max(0, u.slowTimer - dt);
      u.stunTimer = Math.max(0, u.stunTimer - dt);
      u.dodgeTimer = Math.max(0, u.dodgeTimer - dt);
      u.summonTimer = Math.max(0, u.summonTimer - dt);
      // Buff (Warhorn): the damage boost fades over time.
      if (u.buffTimer > 0) {
        u.buffTimer = Math.max(0, u.buffTimer - dt);
        if (u.buffTimer <= 0) u.buffMult = 0;
      }
      // Summoned minions crumble after their lifetime expires.
      if (u.def.kind === 'minion') {
        u.minionLife -= dt;
        if (u.minionLife <= 0) u.alive = false;
      }
      // Burn: damage over time. Ticks each step while the fire lasts.
      if (u.burn) {
        u.burn.life -= dt;
        const tick = u.burn.dps * dt;
        u.takeDamage(tick);
        if (u.burn.life <= 0) u.burn = null;
      }
      // Shield decays over time so it's a temporary buffer, not permanent.
      if (u.shield > 0) {
        u.shield = Math.max(0, u.shield - dt * CONFIG.combat.shieldDecay);
        if (u.shield <= 0) u.shieldMax = 0;
      }
      // Sprinting is a per-frame state: clear it now; _sprint re-sets it only
      // while a sprint is actually happening this frame.
      u.sprinting = false;
      // Enemy attack telegraph: count down the windup; when it lands, resolve
      // the hit (the target may dodge it).
      if (u.windup > 0) {
        u.windup -= dt;
        if (u.windup <= 0) {
          u.windup = 0;
          this._resolveEnemyHit(u, u.windupTarget);
          u.windupTarget = null;
        }
      }
      // Stamina regenerates over time.
      if (u.team === 'player') u.stamina = Math.min(u.staminaMax, u.stamina + dt * u.staminaRegen);
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
          max: 0.4,
        });
        // Record perma-death for team members.
        if (u.team === 'player') {
          this.deadIds.add(u.def.id);
          if (u.def.stats) u.def.stats.currentHp = 0;
        }
      }
    }

    // Banter reactions to deaths that happened this step.
    for (const u of this.units) {
      if (!u.alive || !u._deathFx) continue;
      if (u.team === 'enemy') {
        // A member whose target just died celebrates the kill.
        const killer = this.playerUnits.find(a => a.alive && a.target === u);
        if (killer) {
          this._say(killer, 'killing', u);
          this._gainConfidence(killer, CONFIG.confidence.killGain);
        }
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
    // Lose: all team members dead and none left to enter. Summoned minions
    // don't count as team members, so a lone minion can't prevent defeat.
    const realMembers = this.playerUnits.filter(u => u.def.kind !== 'minion');
    if (this._spawnQueue.length === 0 && realMembers.every(u => !u.alive)) {
      this._endRun('lose');
      return;
    }

    // Advance: all mobs cleared AND a team member reaches the exit door.
    const mobsCleared = this.enemyUnits.every(e => !e.alive);
    if (!mobsCleared) return;
    const { exit } = CONFIG.doors;
    for (const u of this.playerUnits) {
      if (!u.alive) continue;
      if (u.def.kind === 'minion') continue; // minions can't clear the room
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

    // Persist HP so damage carries into the next room (attrition).
    for (const u of this.playerUnits) {
      if (u.def.stats) u.def.stats.currentHp = Math.max(0, u.hp);
    }

    // Reward the run for clearing the room.
    this.gold += CONFIG.economy.goldPerClear;

    const node = this.map.nodes.find(n => n.id === this.currentNodeId);
    if (node && node.type === 'boss') {
      this._endRun('win');
      return;
    }
    const choices = this._nextChoices();
    if (choices.length === 0) {
      this._endRun('win');
      return;
    }
    this.mapOpen = true;
    this.started = false; // pause the sim while the map is shown
  }

  // The run is over: bank gold, promote survivors into the tavern pool, and
  // return to the tavern to begin the next cycle.
  _endRun(result) {
    this.over = result;
    const floor = this.currentNodeId
      ? (this.map.nodes.find(n => n.id === this.currentNodeId)?.floor ?? this.level)
      : this.level;
    completeRun(this.members, this.deadIds, this.gold, floor, result);
  }

  // The player chose a node on the map; enter it.
  chooseNode(nodeId) {
    if (!this.mapOpen) return;
    const choices = this._nextChoices();
    if (!choices.some(c => c.id === nodeId)) return;
    this.level += 1;
    this._enterNode(nodeId);
    // Rest/shop/event nodes pause the sim (their screen is shown instead);
    // only combat rooms start running. Setting started=true here would let
    // _checkEnd run during rest and re-trigger the room-clear with the stale
    // empty enemy list, opening the map behind the rest overlay.
    const node = this.map.nodes.find(n => n.id === nodeId);
    if (!node || (node.type !== 'rest' && node.type !== 'shop' && node.type !== 'event')) this.started = true;
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

    // Stunned: can't move or act until the stun wears off.
    if (u.stunTimer > 0) {
      this._intent(u, 'stunned');
      u.vel = { x: 0, y: 0 };
      return;
    }

    // Clear the safety direction each frame; it is only re-set when a retreat
    // path actually runs, so the debug arrow doesn't linger while advancing.
    u.safetyDir = null;

    // Determine the target side and candidates.
    const side = u.targetRule.side;
    const candidates = side === 'ally' ? allies : enemies;

    // Pick a target by the configured rule, then apply synergy biases.
    let target = pickTarget(u, candidates, u.attack.range);
    if (u.attack.type === 'heal') {
      target = this._healTarget(u, allies);
    } else if (u.attack.type === 'shield') {
      target = this._shieldTarget(u, allies);
    } else if (u.attack.type === 'mana' || u.attack.type === 'buff') {
      // Support units never buff themselves; pick a real ally to boost.
      target = this._supportTarget(u, allies);
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
      this._moveTo(u, this._exitGoal(), {}, dt);
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

    // Self-preservation: situational overrides (hide / seek heal) that take
    // priority over the normal movement decided above.
    this._selfPreservation(u, enemies, allies, dt);

    // Confidence-driven safety: a shaken member retreats toward the healer,
    // tank, and away from threats instead of fighting.
    this._seekSafety(u, target, enemies, allies, dt);

    // Resolve attacks (primary + universal secondary).
    this._resolveAttacks(u, target, enemies, allies);

    // Confidence recovers over time while the member is safe (not being hit
    // and not backing off). It climbs fastest with no enemies around, but also
    // recovers slowly during a fight the member is winning (landing hits and
    // scoring kills add to it directly via recordDeal / killGain).
    const cf = CONFIG.confidence;
    // Confidence drifts back toward a shared neutral fighting morale (cf.base),
    // not this member's baseConfidence. baseConfidence is not a ceiling here —
    // it shapes *how fast* confidence recovers (and, via a factor below, how
    // hard it is shaken). A steady member regains its nerve quickly; a fragile
    // one recovers slowly but is never trapped: everyone can climb back to the
    // same fighting morale, so even a nervous unit can rejoin the fight. The
    // only cap is the global max, so a member can never be permanently stuck
    // below the safety threshold.
    const rateScale = cf.recoverScale * (0.5 + u.baseConfidence); // 0.5..1.5
    if (enemies.length === 0) {
      u.confidence = clamp(u.confidence + cf.recoverRate * rateScale * dt, cf.min, cf.max);
    } else if (u.hp / u.maxHp > 0.5) {
      // In a fight but healthy: steady morale, slower than full safety.
      u.confidence = clamp(u.confidence + cf.recoverRate * 0.5 * rateScale * dt, cf.min, cf.max);
    }

    // Pressure: nearby enemies, and especially ones actively targeting this
    // member, sap confidence over time. Being swarmed or singled out is
    // demoralizing even before any hit lands.
    let pressure = 0;
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = dist(u.pos, e.pos);
      if (d <= cf.pressureRadius) {
        pressure += cf.pressurePerSec;
        if (e.target === u) pressure += cf.pressurePerSec * cf.pressureTargetMult;
      }
    }
    // Backup damps the fear: a nearby tank, healer, or ally steadies the
    // member, so it is braver when the team is around and rattled when alone.
    // This is the "rely on each other" mechanic.
    let backup = 0;
    const backupParts = [];
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      if (dist(u.pos, a.pos) > cf.backupRadius) continue;
      // A durable ally (high HP + armor) steadies the member like a front
      // line; a healer steadies it too. This replaces the old `tankArmor`
      // role threshold with a real durability quantity.
      if (a.hp + a.armor * 10 >= 200) { backup += cf.backupTank; backupParts.push(`${a.displayName}(front)`); }
      else if (a.attack && a.attack.type === 'heal') { backup += cf.backupHealer; backupParts.push(`${a.displayName}(healer)`); }
      else { backup += cf.backupAlly; backupParts.push(`${a.displayName}(ally)`); }
    }
    // Store for the debug panel: how much backup is steadying this member and
    // which allies are providing it.
    u.backup = { total: backup, parts: backupParts };
    pressure = Math.max(0, pressure - backup);
    if (pressure > 0) {
      // Fragile members are more rattled by nearby pressure.
      const frag = (1.5 - u.baseConfidence);
      u.confidence = clamp(u.confidence - pressure * frag * dt, cf.min, cf.max);
    }

    // Occasional "thinking" line reflecting what the unit is currently doing.
    this._think(u);
  }

  // Healers prefer the ally with the strongest bond, weighted against how
  // hurt they are, so a bonded ally is favored over a stranger. Never targets
  // self. If no ally needs healing, it still picks the nearest ally (rather
  // than leaving the target as a fallback that could be itself), so a healer
  // never tries to heal itself.
  _healTarget(u, allies) {
    let best = null, bestScore = -Infinity;
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      if (a.hp >= a.maxHp) continue;
      const missing = a.maxHp - a.hp;
      const score = missing + this._getBond(u, a) * CONFIG.synergy.healBiasFactor;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    // No one hurt: return null so the healer engages enemies instead of
    // trailing another support unit in a mutual-support loop.
    return best;
  }

  // Shielders protect the ally currently under the most threat, so the
  // barrier lands where it's needed most. Falls back to the most hurt ally.
  _shieldTarget(u, allies) {
    let best = null, bestScore = -Infinity;
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      // Skip allies already carrying a fresh shield.
      if (a.shield > 0 && a.shield >= a.shieldMax * 0.5) continue;
      let threat = 0;
      for (const e of this.enemyUnits) {
        if (!e.alive) continue;
        const t = e.threat.get(a.id) ?? 0;
        threat += t;
      }
      const missing = a.maxHp - a.hp;
      const score = threat + missing * 0.5 + this._getBond(u, a) * CONFIG.synergy.healBiasFactor;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    // No one needs a shield: return null so the shielder engages enemies
    // instead of trailing another support unit in a mutual-support loop.
    return best;
  }

  // Buff/mana support: pick an ally to boost. Never self — a support unit
  // empowers its teammates, not itself. Buffs go to the strongest attacker;
  // mana goes to the ally with the most mana to refill. Falls back to the
  // nearest healthy ally.
  _supportTarget(u, allies) {
    const type = u.attack.type;
    let best = null, bestScore = -Infinity;
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      let score;
      if (type === 'buff') {
        // Buff the highest-damage attacker (excluding minions/summons).
        if (a.def.kind === 'minion') continue;
        score = (a.def.attack ? a.def.attack.atk : 0) + this._getBond(u, a) * CONFIG.synergy.healBiasFactor;
      } else {
        // Mana: refill the ally that needs it most (has a pool and is low).
        // Skip allies that don't use mana or are already full, so the
        // channeler never wastes a cast on someone who can't benefit.
        if (a.maxMana <= 0) continue;
        const need = a.maxMana - a.mana;
        if (need <= 0) continue;
        score = need + this._getBond(u, a) * CONFIG.synergy.healBiasFactor;
      }
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best) return best;
    // No one needs a buff or mana: return null so the support unit engages
    // enemies instead of trailing another support unit in a mutual-support
    // loop. A channeler with nothing to refill should fight, not orbit.
    return null;
  }

  // Raise a disposable minion near the summoner. It rushes the nearest enemy
  // and splits aggro so the real team stays safe. Tracks its owner so it can
  // be cleaned up when the room ends.
  _summonMinion(u, target) {
    const m = CONFIG.minion;
    const def = { ...m, name: 'Minion' };
    const pos = {
      x: u.pos.x + (target ? (target.pos.x - u.pos.x) * 0.3 : 1),
      y: u.pos.y + (target ? (target.pos.y - u.pos.y) * 0.3 : 0),
    };
    const minion = new Unit(def, { team: 'player', pos });
    minion.minionOwner = u;
    minion.minionLife = m.life;
    this.units.push(minion);
    this.playerUnits.push(minion);
  }

  // Focus fire: prefer an enemy a bonded ally is already attacking, so the
  // team concentrates damage. Falls back to the rule-picked target. Also
  // blends in per-member intel: a member pounces on an enemy it has personally
  // softened (high killability) and shies away from one it knows hits hard
  // (high danger) unless that enemy is already vulnerable.
  _focusFireTarget(u, target, enemies, allies) {
    const it = CONFIG.intel;
    const ec = CONFIG.intel; // emergent coordination weights live under intel
    // Durability: effective hit points (HP + armor scaled). A durable member
    // is a front-liner that can absorb hits, so it steps up to engage; a
    // fragile one hangs back. This replaces the old hard-coded `tankArmor`
    // role threshold with a real quantity.
    const durable = (a) => a.hp + a.armor * 10 >= 200;
    const isDurable = durable(u);
    // Is any durable ally (other than me) currently engaging a given enemy?
    // "Engaging" means it has that enemy as its target. Used to make fragile
    // members commit when a front-liner is in front, and to let a durable
    // member step up (off-tank) when no front-liner is engaging.
    const tankEngaging = (e) => allies.some(a => a !== u && a.alive && durable(a) &&
      a.target && a.target.alive && a.target === e);
    const anyTankEngaging = enemies.some(tankEngaging);

    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      if (!e.alive) continue;
      if (dist(u.pos, e.pos) > u.attack.range) continue;
      let score = 0;

      // Emergent focus fire: pull toward what allies are already attacking.
      // Bonded allies pull harder, so trusted teammates converge first.
      let alliesOn = 0;
      let bond = 0;
      for (const a of allies) {
        if (a === u || !a.alive) continue;
        if (a.target === e) {
          alliesOn++;
          const b = this._getBond(u, a) * CONFIG.synergy.focusBias;
          bond += b;
          score += b;
        }
      }
      score += alliesOn * ec.allyFocusWeight;

      // Commit when a durable front-liner is engaging: fragile members are
      // braver behind a front line.
      if (tankEngaging(e)) score += ec.tankEngageWeight;

      // Off-tank: if I'm durable and no front-liner is engaging anything,
      // step up and take the strongest threat so the team always has a front.
      if (isDurable && !anyTankEngaging) score += ec.offTankWeight;

      // Intel: pounce on what I've personally softened, avoid what the team
      // knows hits hard (ramped by my own familiarity) unless it is already
      // vulnerable (low HP). The danger penalty scales with how hurt I am: a
      // healthy member shrugs off a hard-hitting enemy, but a low-HP member
      // fears it — so a dying member won't dive onto a threat that will kill
      // it while a healthy one still commits.
      const kill = u.killabilityOf(e);
      const danger = this.memberDanger(u, e.def.kind);
      const vulnerable = e.hp / e.maxHp < it.avoidHpFrac;
      const pounce = kill * it.pounceWeight;
      const hurtScale = 1 - u.hp / u.maxHp; // 0 healthy .. 1 near-dead
      const dangerPenalty = (danger > it.avoidDanger && !vulnerable)
        ? -(danger * it.dangerWeight * (0.4 + hurtScale * 0.6))
        : 0;
      score += pounce;
      score += dangerPenalty;

      // Kill the weak first: prefer cheap kills (low maxHp) to thin the horde,
      // and near-dead enemies to finish them off. This makes the team mow down
      // the swarm before turning on the strong ones.
      const finish = (1 - e.hp / e.maxHp) * ec.finishWeight;
      const weakest = (1 - e.maxHp / 200) * ec.weakestWeight;
      score += finish;
      score += weakest;

      if (score > bestScore) { bestScore = score; best = e; }
    }

    // Record the score breakdown for the chosen target so the debug panel can
    // show WHY it was picked, without duplicating the scoring logic.
    if (best) {
      const e = best;
      const kill = u.killabilityOf(e);
      const danger = this.memberDanger(u, e.def.kind);
      const vulnerable = e.hp / e.maxHp < it.avoidHpFrac;
      let alliesOn = 0, bond = 0;
      for (const a of allies) {
        if (a === u || !a.alive) continue;
        if (a.target === e) { alliesOn++; bond += this._getBond(u, a) * CONFIG.synergy.focusBias; }
      }
      u.targetScore = {
        total: bestScore,
        alliesOn,
        allyFocus: alliesOn * ec.allyFocusWeight,
        bond,
        tankEngaging: tankEngaging(e) ? ec.tankEngageWeight : 0,
        offTank: (isDurable && !anyTankEngaging) ? ec.offTankWeight : 0,
        pounce: kill * it.pounceWeight,
        danger: (danger > it.avoidDanger && !vulnerable) ? -(danger * it.dangerWeight) : 0,
        finish: (1 - e.hp / e.maxHp) * ec.finishWeight,
        weakest: (1 - e.maxHp / 200) * ec.weakestWeight,
      };
    } else {
      u.targetScore = null;
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
    this._moveTo(u, threat.pos, { chase: true }, dt);
    this._separate(u, allies, dt);
    // Defending an ally strengthens the bond with them.
    this._growBond(u, best, CONFIG.synergy.peelBond);
  }

  // Self-preservation instincts. These override the normal movement decided in
  // _applyMovement. Priority: seek healing (most urgent) > hide behind a
  // protector. Each only fires while its trigger holds, with hysteresis so the
  // unit doesn't flip-flop at the threshold.
  _selfPreservation(u, enemies, allies, dt) {
    const sp = u.selfPreservation;
    if (sp.length === 0) return;
    const t = CONFIG.team;
    // While fleeing/hiding the member still fights anything in reach, so pick
    // a target by its own rule (enemy for attackers, ally for healers). Ally
    // support types never pick themselves.
    const side = u.targetRule && u.targetRule.side;
    const type = u.attack.type;
    let target;
    if (type === 'heal') target = this._healTarget(u, allies);
    else if (type === 'shield') target = this._shieldTarget(u, allies);
    else if (type === 'mana' || type === 'buff') target = this._supportTarget(u, allies);
    else {
      const candidates = side === 'ally' ? allies : enemies;
      target = pickTarget(u, candidates, u.attack.range);
    }

    // Universal: critically low HP retreats toward the team, regardless of
    // confidence or modifiers. Only fights enemies already in reach.
    const hpFrac = u.hp / u.maxHp;
    if (hpFrac < 0.25) {
      const cluster = this._teamCluster(u, allies);
      if (cluster) {
        this._intent(u, 'retreating (critically hurt)');
        this._moveTo(u, cluster, { chase: true }, dt);
        this._separate(u, allies, dt);
        this._resolveAttacks(u, target, enemies, allies);
        return;
      }
    }

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
          this._moveTo(u, healer.pos, { chase: true }, dt);
          this._separate(u, allies, dt);
          this._resolveAttacks(u, target, enemies, allies);
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
          this._moveTo(u, spot, {}, dt);
          this._separate(u, allies, dt);
          this._resolveAttacks(u, target, enemies, allies);
          return;
        }
      }
    }
  }

  // A shaken member (low confidence) seeks safety instead of fighting. It
  // blends several instincts into one weighted direction: pull away from the
  // nearest threat, toward the healer, toward the tankiest ally, and away
  // from nearby enemies (spacing). This is driven by the same confidence
  // attribute as the avoid decision, so a beaten-down member naturally
  // retreats to safety while a confident one keeps fighting. Runs after the
  // urgent self-preservation instincts (seek heal / hide) so those win.
  _seekSafety(u, target, enemies, allies, dt) {
    const cf = CONFIG.confidence;
    // A shaken member gives up sooner, a confident one keeps fighting. The
    // per-member difference comes purely from the dynamic confidence value
    // (each member has its own composure base), so the seek-safety trigger is
    // simply "confidence below the safety threshold."
    const effThreshold = cf.safetyThreshold;
    const active = u.seekingSafety || u.confidence < effThreshold;
    if (!active || u.confidence >= effThreshold + cf.safetyHysteresis) {
      u.seekingSafety = false;
      return;
    }
    u.seekingSafety = true;

    // Confidence steadies over time while fleeing, so a shaken unit
    // gradually regains its nerve instead of cowering forever. There is no
    // cap at baseConfidence here: everyone can climb back out of the shaken
    // band (a nervous unit just recovers slower via its baseConfidence-scaled
    // rate), so no member is ever permanently stuck in seek-safety.
    const rateScale = cf.recoverScale * (0.5 + u.baseConfidence);
    u.confidence = clamp(u.confidence + cf.safetyRecover * rateScale * dt, cf.min, cf.max);

    // If an enemy is in attack range, attack it — but keep fleeing, don't
    // move toward it. _resolveAttacks fires the attack; the retreat below
    // keeps the unit backing off.
    const threat = nearestEnemy(u, enemies);
    const inRange = threat && dist(u.pos, threat.pos) <= u.attack.range;

    // Reached safety: near the team cluster and no enemy close. Reward the
    // successful retreat with a confidence boost so the member steadies and
    // rejoins the fight instead of cowering forever.
    const cluster = this._teamCluster(u, allies);
    const nearTeam = cluster && dist(u.pos, cluster) <= cf.safetyGainRadius;
    const noThreat = !threat || dist(u.pos, threat.pos) > cf.pressureRadius;
    if (nearTeam && noThreat) {
      u.confidence = clamp(u.confidence + cf.safetyGain, cf.min, cf.max);
      this._intent(u, 'regaining composure');
      return;
    }

    const dir = this._safetyDirection(u, enemies, allies);
    if (dir.x === 0 && dir.y === 0) return;
    this._intent(u, 'seeking safety (shaken)');
    // Sprint toward safety while stamina lasts.
    this._sprint(u, norm(dir), dt);
    this._separate(u, allies, dt);
    // Attack any enemy in reach while backing off.
    if (inRange) this._resolveAttacks(u, target, enemies, allies);
  }

  // The single, reusable "where is safe?" direction. Blends several instincts
  // into one weighted vector: away from the nearest threat, toward the healer,
  // toward the tankiest ally, toward high-confidence allies (strength in
  // numbers), away from nearby enemies (spacing), and away from walls so a
  // retreat slides along a wall instead of pinning into a corner. Every
  // retreat path (avoid, kite, evade, seek-safety) routes through this, so
  // the whole team funnels toward safety instead of the exit.
  _safetyDirection(u, enemies, allies) {
    const s = CONFIG.confidence.safety;
    let dir = { x: 0, y: 0 };

    // Away from the nearest threat.
    const threat = nearestEnemy(u, enemies);
    if (threat) {
      dir = add(dir, scale(norm(sub(u.pos, threat.pos)), s.threatWeight));
    }
    // A unit only retreats toward a team member if that direction also moves
    // it away from the nearest threat. Otherwise the "toward the team" pull
    // can point straight through an enemy (team on the far side), sending a
    // shaken unit running into danger.
    const awayFromThreat = threat ? norm(sub(u.pos, threat.pos)) : null;
    const towardSafe = (p) => {
      if (!awayFromThreat) return true;
      const to = norm(sub(p, u.pos));
      return dot(to, awayFromThreat) > 0;
    };

    // Toward the healer.
    const healer = allies.find(a => a.alive && a !== u && a.attack && a.attack.type === 'heal');
    if (healer && towardSafe(healer.pos)) {
      dir = add(dir, scale(norm(sub(healer.pos, u.pos)), s.healerWeight));
    }

    // Toward the tankiest ally.
    const tank = this._pickProtector(u, allies);
    if (tank && towardSafe(tank.pos)) {
      dir = add(dir, scale(norm(sub(tank.pos, u.pos)), s.tankWeight));
    }

    // Toward high-confidence allies: strength in numbers. A confident ally is
    // a safe ally, so the team clusters around whoever is holding their nerve.
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      if (a.confidence < CONFIG.confidence.safetyThreshold) continue;
      const d = dist(u.pos, a.pos);
      if (d > 0 && d < CONFIG.team.protectRadius && towardSafe(a.pos)) {
        dir = add(dir, scale(norm(sub(a.pos, u.pos)), s.allyWeight * (1 - d / CONFIG.team.protectRadius)));
      }
    }

    // Away from nearby enemies (spacing out).
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = dist(u.pos, e.pos);
      if (d > 0 && d < CONFIG.team.protectRadius) {
        dir = add(dir, scale(norm(sub(u.pos, e.pos)), s.spaceWeight * (1 - d / CONFIG.team.protectRadius)));
      }
    }

    // Away from walls so a retreat slides along them instead of pinning into
    // a corner. Reuses the same margin logic as the bats' wall avoidance.
    dir = add(dir, scale(this._boidWallAvoidance(u), s.wallWeight));

    // Hard wall projection: if the unit is inside the wall margin, zero out
    // any component of the retreat that points into a wall. This guarantees
    // the retreat slides along the wall instead of pinning into a corner.
    const { width, height } = CONFIG.world;
    const margin = 1.5;
    if (u.pos.x < margin && dir.x < 0) dir.x = 0;
    if (u.pos.x > width - margin && dir.x > 0) dir.x = 0;
    if (u.pos.y < margin && dir.y < 0) dir.y = 0;
    if (u.pos.y > height - margin && dir.y > 0) dir.y = 0;

    // Corner escape: if projection left no direction to flee (threat straight
    // in line with the corner), drift along the wall so the unit slides out
    // instead of cowering in place. Pick the wall tangent that heads toward
    // the team cluster.
    if (dir.x === 0 && dir.y === 0) {
      const cluster = this._teamCluster(u, allies);
      if (cluster) {
        const to = sub(cluster, u.pos);
        // Keep only the component parallel to the wall the unit is against.
        if (u.pos.x < margin || u.pos.x > width - margin) dir.y = to.y;
        if (u.pos.y < margin || u.pos.y > height - margin) dir.x = to.x;
      }
    }

    // Store the blended direction for the debug overlay.
    u.safetyDir = dir;
    return dir;
  }

  // The center of the team's alive members (excluding the unit itself), used
  // as a fallback escape target so a shaken unit slides back toward its
  // teammates instead of cowering alone in a corner.
  _teamCluster(u, allies) {
    let cx = 0, cy = 0, count = 0;
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      cx += a.pos.x; cy += a.pos.y; count++;
    }
    if (count === 0) return null;
    return { x: cx / count, y: cy / count };
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
    const mv = CONFIG.movement;

    // --- Layer 1: Universal survival ---
    // Everyone, regardless of role, backs off the enemy currently hunting
    // them (highest threat) when it gets too close. This is the "evade to
    // survive" instinct that applies to every member. It does NOT decide
    // engagement — that's the goal layer. A healer backs off its attacker
    // while still moving toward the hurt ally.
    const hunter = threatenedEnemy(u, enemies);
    // Only back off if the hunter is close but NOT already in attack range.
    // If the member can hit it, it stands and fights — otherwise a ranged
    // unit would flee from a target it's already in range of, bouncing
    // between evading and attacking every frame.
    const hunterInRange = hunter && dist(u.pos, hunter.pos) <= u.attack.range;
    if (hunter && !hunterInRange && dist(u.pos, hunter.pos) < mv.survivalDistance - mv.survivalHysteresis) {
      this._intent(u, 'evading hunter');
      this._say(u, 'avoiding', hunter);
      this._dropConfidence(u, CONFIG.confidence.avoidDrop);
      const dir = this._safetyDirection(u, enemies, allies);
      this._sprint(u, norm(dir), dt);
      this._separate(u, allies, dt);
      // Keep fighting while backing off: if a target is in reach, attack it.
      this._resolveAttacks(u, target, enemies, allies);
      return;
    }

    // --- Layer 2: Kit-derived goal ---
    // What does this member's kit want it to do right now? The attack type
    // drives the goal, so it can never drift out of sync with the build.
    const goal = this._kitGoal(u, target, enemies, allies);

    // --- Layer 3: Emergent commitment ---
    // How hard does this member push toward its goal? Confidence and
    // durability, not class labels, decide. A fragile, shaken member hangs
    // back; a durable, confident one commits.
    const commit = this._commitment(u, enemies, allies);

    if (!goal) {
      // No goal (e.g. no enemies and no hurt ally): advance or idle.
      this._intent(u, 'advancing into combat');
      this._moveTo(u, this._advanceGoal(u), {}, dt);
      this._separate(u, allies, dt);
      return;
    }

    // Low commitment: hold at range from the goal instead of pushing in.
    if (commit < mv.commitFloor) {
      const d = dist(u.pos, goal.pos);
      if (d < mv.holdRange) {
        this._intent(u, 'holding at range (cautious)');
        this._idleWander(u, dt);
        this._separate(u, allies, dt);
        return;
      }
      this._intent(u, 'approaching cautiously');
      this._moveTo(u, goal.pos, {}, dt);
      this._separate(u, allies, dt);
      return;
    }

    // In range of the goal: hold and act.
    if (dist(u.pos, goal.pos) <= mv.goalRange) {
      this._intent(u, goal.intent);
      u.vel = { x: 0, y: 0 };
      return;
    }

    // High commitment: close on the goal. The speed is a walk/sprint blend
    // driven by urgency (how much the goal needs the member right now) and
    // commitment (how hard the member pushes). A support unit sprints to
    // close on its ally, then matches the ally's speed so it stays in range
    // without overshooting or trailing behind.
    this._intent(u, goal.intent);
    const urgency = goal.urgency ?? 1;
    const blend = clamp(commit * 0.5 + urgency * 0.5, 0, 1);
    if (goal.ally && goal.ally.alive) {
      // Sprint to close the gap, then match the ally's velocity so the
      // support unit keeps pace with a moving ally. Closing speed eases off
      // continuously as the unit nears the standoff distance (arrival
      // easing), so it decelerates smoothly into position instead of coming
      // to a hard stop, jittering, and re-sprinting. Stamina is drained only
      // in proportion to how much faster than normal the unit is moving.
      // Movement routes through _moveTo so it pathfinds around obstacles like
      // every other movement, sprints to close, then matches the ally's speed.
      this._moveTo(u, goal.ally.pos, {
        follow: goal.ally,
        standoff: u.attack.range * 0.5,
        chase: true,
      }, dt);
    } else if (blend >= mv.sprintCommit) {
      // High commitment: sprint to close on the goal. Unified through _moveTo
      // so it gains speed when far, eases off when close, and drains stamina
      // only for the portion above baseline.
      this._moveTo(u, goal.pos, { chase: true }, dt);
    } else {
      this._moveTo(u, goal.pos, { chase: true }, dt);
    }
    this._separate(u, allies, dt);
  }

  // The kit-derived goal: what this member wants to do right now, based on
  // its attack type. Returns { pos, intent } or null. This replaces the old
  // hard-coded `movement` role ladder — the build drives the behavior.
  _kitGoal(u, target, enemies, allies) {
    const type = u.attack.type;
    const range = u.attack.range;

    // Support goals: position near the ally to heal/shield/buff.
    if (type === 'heal' || type === 'shield' || type === 'buff' || type === 'mana') {
      // Never target self: a support unit empowers a teammate, not itself.
      const ally = (target && target.alive && target !== u)
        ? target
        : (type === 'heal' ? this._healTarget(u, allies)
          : type === 'shield' ? this._shieldTarget(u, allies)
          : this._supportTarget(u, allies));
      if (ally) {
        // Stand just inside attack range of the ally so the cast lands.
        const to = sub(ally.pos, u.pos);
        const d = len(to);
        const desired = Math.max(0, d - range * 0.5);
        const dir = d > 0 ? scale(to, 1 / d) : { x: 0, y: 0 };
        const label = type === 'heal' ? 'moving to heal' : type === 'shield' ? 'moving to shield' : 'moving to support';
        // Urgency: how much the ally needs the cast right now. A healer
        // rushes a bleeding ally, a channeler hurries to a dry mana pool, a
        // buffer moves at a steady pace. This drives the walk/sprint blend.
        let urgency = 0.5;
        if (type === 'heal' || type === 'shield') {
          urgency = clamp(1 - ally.hp / ally.maxHp, 0, 1);
        } else if (type === 'mana') {
          urgency = ally.maxMana > 0 ? clamp((ally.maxMana - ally.mana) / ally.maxMana, 0, 1) : 0;
        }
        return { pos: add(u.pos, scale(dir, desired)), intent: label, urgency, ally };
      }
      return null;
    }

    // Taunt goal: be near the most enemies so the taunt lands on a crowd.
    if (type === 'taunt') {
      if (enemies.length === 0) return null;
      let cx = 0, cy = 0;
      for (const e of enemies) { cx += e.pos.x; cy += e.pos.y; }
      const centroid = { x: cx / enemies.length, y: cy / enemies.length };
      return { pos: centroid, intent: 'moving to taunt' };
    }

    // Damage goal: engage the focus target.
    if (target && target.alive) {
      // A hurt member facing a dangerous target holds at range instead of
      // diving in: stand just outside the enemy's reach and let it come.
      const hpFrac = u.hp / u.maxHp;
      const danger = this.memberDanger(u, target.def.kind);
      if (hpFrac < 0.3 && danger > CONFIG.intel.avoidDanger) {
        const to = sub(target.pos, u.pos);
        const d = len(to);
        const desired = Math.max(0, d - target.def.range - 0.5);
        const dir = d > 0 ? scale(to, 1 / d) : { x: 0, y: 0 };
        return { pos: add(u.pos, scale(dir, desired)), intent: 'holding at range (hurt)' };
      }
      return { pos: target.pos, intent: 'advancing on target' };
    }

    return null;
  }

  // Emergent commitment: how hard this member pushes toward its goal, 0..1.
  // Confidence and durability, not class labels, decide. A durable member
  // (high HP + armor) commits harder; a shaken one hangs back. Nearby backup
  // steadies the member, so it commits when the team is around.
  _commitment(u, enemies, allies) {
    const mv = CONFIG.movement;
    const cf = CONFIG.confidence;

    // Durability: effective hit points (HP + armor scaled) relative to a
    // baseline. A tanky member is built to absorb, so it commits harder.
    const dur = u.hp + u.armor * 10;
    const durFrac = clamp(dur / 200, 0, 1);

    // Backup: nearby allies steady the member (reuse the confidence backup).
    let backup = 0;
    for (const a of allies) {
      if (a === u || !a.alive) continue;
      if (dist(u.pos, a.pos) > cf.backupRadius) continue;
      backup += cf.backupAlly;
    }
    const backupFrac = clamp(backup / 2, 0, 1);

    let commit = clamp(
      u.confidence * mv.confWeight +
      durFrac * mv.durWeight +
      backupFrac * mv.backupWeight,
      0, 1
    );
    // A critically hurt member can't push hard into a fight, no matter how
    // confident or backed up it feels. Cap commitment so it won't sprint in.
    const hpFrac = u.hp / u.maxHp;
    if (hpFrac < 0.3) commit = Math.min(commit, 0.3);
    // Store for the debug panel.
    u.commitment = commit;
    return commit;
  }

  // Lower a member's confidence (clamped to the floor). Called when the
  // member is forced to back off, so retreating compounds into a shaken,
  // more cautious state.
  _dropConfidence(u, amount) {
    const cf = CONFIG.confidence;
    u.confidence = clamp(u.confidence - amount, cf.min, cf.max);
  }

  // Raise a member's confidence (clamped to the ceiling). Called when the
  // member lands a hit or scores a kill, so successful combat builds morale.
  _gainConfidence(u, amount) {
    const cf = CONFIG.confidence;
    u.confidence = clamp(u.confidence + amount, cf.min, cf.max);
  }

  // Where a member heads when there's nothing to fight. The leader leads
  // toward the exit; everyone else trails behind the leader so the leader
  // stays in front instead of being overtaken by the back line. Followers
  // fan out into a compact wedge behind the leader (by formation slot) so
  // they don't all stack on the same point, clump together, or stretch into
  // an unwieldy single-file line when the party is large.
  _advanceGoal(u) {
    // If enemies are still alive, advance into the fight: move to a tactical
    // position just outside attack range of the nearest enemy, so the member
    // closes distance and engages instead of running to the door. Only head
    // for the exit / formation when the room is actually clear.
    const enemies = this.enemyUnits.filter(e => e.alive);
    if (enemies.length > 0) {
      const near = nearestEnemy(u, enemies);
      if (near) {
        const to = sub(near.pos, u.pos);
        const d = len(to);
        // Stand just outside attack range so the member can engage immediately
        // on arrival, without walking into the enemy's face.
        const desired = Math.max(0, d - u.attack.range * 0.5);
        const dir = d > 0 ? scale(to, 1 / d) : { x: 0, y: 0 };
        return add(u.pos, scale(dir, desired));
      }
    }
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
    // With no enemies left, the fight is decided: units stop spending mana or
    // committing abilities so they don't waste casts on an already-won room.
    const aliveEnemies = enemies.filter(e => e.alive);
    if (aliveEnemies.length === 0) return;

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
          mag: atk.atk, max: 0.4,
        });
        // Healing generates threat.
        for (const e of enemies) e.addThreat(u, CONFIG.threat.healThreat);
        // Healing strengthens the bond between healer and target.
        this._growBond(u, target, CONFIG.synergy.healBond);
        break;
      }
      case 'taunt': {
        // Raid-style taunt: spend it deliberately, not on every attack. It
        // only fires when (a) the cooldown is ready and (b) some enemy in
        // range is leaking aggro (its top threat isn't this tank) or its
        // taunt is about to expire and needs refreshing. Otherwise the tank
        // holds its taunt instead of wasting it.
        if (u.tauntCooldown > 0) break;
        const radius = atk.range;
        const refresh = CONFIG.threat.tauntRefresh;
        // A taunt is a threatening slam: it yanks aggro AND deals damage to
        // everyone in reach, so a pure taunt-tank can still whittle down the
        // swarm instead of stalling forever against ranged enemies that kite
        // out of melee reach. It always slams when it swings, even if no aggro
        // needs refreshing, so a taunt primary stays a real weapon.
        let shouldTaunt = false;
        for (const e of enemies) {
          if (dist(u.pos, e.pos) > radius) continue;
          // Leak: this enemy's highest threat is not the tank.
          const top = e.highestThreatEnemy(this.units);
          const leaking = !top || top.id !== u.id;
          // Refresh: already taunted but the forced-target window is ending.
          const expiring = e.taunted && e.tauntTimer <= refresh;
          if (leaking || expiring) { shouldTaunt = true; break; }
        }
        if (shouldTaunt) u.tauntCooldown = CONFIG.threat.tauntCooldown;
        let hit = false;
        const dmg = atk.atk;
        for (const e of enemies) {
          if (dist(u.pos, e.pos) <= radius) {
            const dealt = e.takeDamage(dmg);
            u.recordDeal(e.def.kind, dealt);
            e.addThreat(u, CONFIG.threat.tauntThreat);
            e.taunted = true;
            e.tauntTimer = CONFIG.threat.tauntDuration;
            this._knockback(e, u.pos, CONFIG.combat.knockback);
            this.effects.push({
              type: 'attack', from: { ...u.pos }, to: { ...e.pos },
              color: u.team === 'player' ? '#fbbf24' : '#f87171', life: 0.15,
              dmg: dealt, max: 0.15,
            });
            hit = true;
          }
        }
        if (hit) {
          this.effects.push({
            type: 'taunt', pos: { ...u.pos }, radius, life: 0.5,
            mag: CONFIG.threat.tauntDuration, max: 0.5,
          });
          this._say(u, 'taunting');
        }
        break;
      }
      case 'shield': {
        // Barrier: grant the target (an ally) a temporary shield that absorbs
        // incoming damage. The shield is a flat pool that decays over time, so
        // it's a proactive buffer rather than a heal. Costs mana like a heal.
        if (u.maxMana > 0 && u.mana < u.manaCost) {
          this._intent(u, 'out of mana');
          break;
        }
        if (u.maxMana > 0) u.mana -= u.manaCost;
        const shield = atk.atk;
        target.shield = Math.max(target.shield || 0, shield);
        target.shieldMax = Math.max(target.shieldMax || 0, shield);
        this._say(u, 'shielding', target);
        this.effects.push({
          type: 'shield', from: { ...u.pos }, to: { ...target.pos }, life: 0.4,
          mag: shield, max: 0.4,
        });
        // Shielding generates threat like healing.
        for (const e of enemies) e.addThreat(u, CONFIG.threat.healThreat);
        // Shielding strengthens the bond between shielder and target.
        this._growBond(u, target, CONFIG.synergy.healBond);
        break;
      }
      case 'buff': {
        // Empower an ally to deal bonus damage for a while. The buff stacks
        // with the target's own attack, so it shines on a high-damage duelist.
        if (u.maxMana > 0 && u.mana < u.manaCost) {
          this._intent(u, 'out of mana');
          break;
        }
        if (u.maxMana > 0) u.mana -= u.manaCost;
        const b = CONFIG.buff;
        target.buffTimer = b.duration;
        target.buffMult = Math.max(target.buffMult || 0, atk.atk);
        this._say(u, 'buffing', target);
        this.effects.push({
          type: 'buff', from: { ...u.pos }, to: { ...target.pos }, life: 0.4,
          mag: atk.atk, max: 0.4,
        });
        // Buffing generates threat like healing (enemies resent the boost).
        for (const e of enemies) e.addThreat(u, CONFIG.threat.healThreat);
        this._growBond(u, target, CONFIG.synergy.healBond);
        break;
      }
      case 'mana': {
        // Restore an ally's mana pool so healers and shielders can keep
        // casting. Costs the channeler's own mana to transfer. Skip the cast
        // if the target is already full — no point spending mana on someone
        // who can't take any more.
        if (u.maxMana > 0 && u.mana < u.manaCost) {
          this._intent(u, 'out of mana');
          break;
        }
        if (target.maxMana <= 0 || target.mana >= target.maxMana) break;
        if (u.maxMana > 0) u.mana -= u.manaCost;
        target.mana = Math.min(target.maxMana, target.mana + CONFIG.mana.transfer);
        this._say(u, 'channeling', target);
        this.effects.push({
          type: 'mana', from: { ...u.pos }, to: { ...target.pos }, life: 0.4,
          mag: CONFIG.mana.transfer, max: 0.4,
        });
        for (const e of enemies) e.addThreat(u, CONFIG.threat.healThreat);
        this._growBond(u, target, CONFIG.synergy.healBond);
        break;
      }
      case 'summon': {
        // Raise a disposable minion that rushes the nearest enemy. Capped by
        // a cooldown and a max-alive limit so it can't flood the field.
        if (u.summonTimer > 0) break;
        const aliveMinions = this.playerUnits.filter(x => x.def.kind === 'minion' && x.alive).length;
        if (aliveMinions >= CONFIG.summon.maxAlive) break;
        u.summonTimer = CONFIG.summon.cooldown;
        this._summonMinion(u, target);
        this._say(u, 'summoning');
        this.effects.push({
          type: 'summon', pos: { ...u.pos }, life: 0.4,
          mag: CONFIG.summon.cooldown, max: 0.4,
        });
        break;
      }
      case 'push': {
        // Knock the target and any nearby enemies far away from the caster.
        // A strong, short-lived impulse that scatters the swarm. This is a
        // standalone primary attack: it displaces enemies but deals no damage.
        const radius = atk.range;
        const strength = CONFIG.combat.knockback * 2.2;
        let hit = false;
        for (const e of enemies) {
          if (!e.alive) continue;
          if (dist(u.pos, e.pos) <= radius) {
            this._knockback(e, u.pos, strength);
            hit = true;
          }
        }
        if (hit) {
          this.effects.push({
            type: 'push', pos: { ...u.pos }, radius, life: 0.3,
            mag: strength, max: 0.3,
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
            this.effects.push({ type: 'taunt', pos: { ...u.pos }, radius, life: 0.5, mag: CONFIG.threat.tauntDuration, max: 0.5 });
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
              dmg: dealt, max: 0.2,
            });
          }
          break;
        }
        case 'slow': {
          // Halve the target's speed briefly.
          target.slowTimer = 1.5;
          break;
        }
        case 'burn': {
          // Ignite the target: deal damage over time. The burn is stored on
          // the target and ticks each step in the status phase.
          target.burn = { dps: atk.atk * 0.25, life: 3.0 };
          this.effects.push({
            type: 'burn', pos: { ...target.pos }, life: 0.3,
            mag: 3.0, max: 0.3,
          });
          break;
        }
        case 'stun': {
          // Immobilize the target briefly so it can't move or attack.
          target.stunTimer = 1.2;
          break;
        }
        case 'thorns': {
          // Reflect a portion of melee damage back at attackers. The thorns
          // value is a fraction (e.g. 0.5 = reflect half). Stored on the unit
          // so takeDamage can reflect when it is hit.
          u.thorns = Math.max(u.thorns || 0, 0.5);
          break;
        }
        case 'execute': {
          // Deal bonus damage to enemies below half health, so the finisher
          // mows down wounded targets.
          if (target && target.alive && target.hp / target.maxHp < 0.5) {
            const bonus = atk.atk * 0.5;
            const dealt = target.takeDamage(bonus);
            u.recordDeal(target.def.kind, dealt);
            target.addThreat(u, bonus);
            this.effects.push({
              type: 'execute', pos: { ...target.pos }, life: 0.25,
              dmg: bonus, max: 0.25,
            });
          }
          break;
        }
      }
    }
  }

  _applyDamageShape(u, target, enemies, atk) {
    const shape = atk.shape;
    const range = atk.range;
    // A charge that connects deals bonus damage, then the charge is spent.
    let dmg = atk.atk + (u.chargeReady ? CONFIG.team.chargeBonus : 0);
    if (u.chargeReady) u.chargeReady = false;
    // A buff (Warhorn) empowers the target's damage while it lasts.
    if (u.buffTimer > 0 && u.buffMult > 0) dmg *= 1 + u.buffMult;
    // Team morale: a confident team hits a touch harder, a shaken one softer.
    if (u.team === 'player') {
      dmg *= 1 + CONFIG.morale.dmgMult * (this.morale - 0.5);
    }

    if (shape === 'rangeOneShot' || shape === 'meleeOneShot') {
      const dealt = target.takeDamage(dmg);
      u.recordDeal(target.def.kind, dealt);
      target.addThreat(u, dmg);
      this._knockback(target, u.pos, CONFIG.combat.knockback);
      this.effects.push({
        type: 'attack', from: { ...u.pos }, to: { ...target.pos },
        color: u.team === 'player' ? '#fbbf24' : '#f87171', life: 0.15,
        dmg: dealt, max: 0.15,
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
          dmg, max: 0.25,
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
          dmg, max: 0.25,
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
      dmg: dealt, max: 0.15,
    });
  }

  // --- Enemy AI ---
  // Dispatches to a per-kind behavior. All kinds share the same target
  // picker (_pickBatTarget) but move and attack differently.

  _updateEnemy(u, dt) {
    // Stunned: can't move or act until the stun wears off.
    if (u.stunTimer > 0) {
      u.vel = { x: 0, y: 0 };
      return;
    }
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

    // Direct pursuit: steer straight at the target. Only wall avoidance and a
    // light separation from other bats are kept, so the swarm commits to the
    // fight instead of orbiting members on cohesion/alignment forces.
    const others = this.enemyUnits.filter(e => e.alive && e !== u);
    const sep = this._boidSeparation(u, others);
    const seek = this._boidSeek(u, target.pos);
    const wall = this._boidWallAvoidance(u);

    const b = CONFIG.boids;
    // When already in attack range, hold position and attack instead of being
    // pushed around by separation (which otherwise orbits the bat just out of
    // reach). Separation is damped near the target so the swarm packs in and
    // lands hits rather than circling.
    const inRange = target && dist(u.pos, target.pos) <= u.def.range;
    const sepScale = inRange ? 0.15 : 1;
    const fx = seek.x * b.seekWeight + sep.x * b.separationWeight * sepScale + wall.x * b.wallWeight;
    const fy = seek.y * b.seekWeight + sep.y * b.separationWeight * sepScale + wall.y * b.wallWeight;

    const force = clampLen({ x: fx, y: fy }, b.maxForce);
    u.vel = clampLen(add(u.vel, scale(force, dt)), u.effSpeed);

    // Attack if in range.
    if (target && dist(u.pos, target.pos) <= u.def.range) {
      if (u.attackTimer <= 0) {
        u.attackTimer = CONFIG.combat.attackCooldown;
        u.target = target;
        this._startEnemyWindup(u, target);
      }
    }
  }

  // Begin an enemy attack: telegraph it with a windup so the target has a
  // window to dodge. The hit itself resolves when the windup elapses (in the
  // step loop), at which point the target may dodge it.
  _startEnemyWindup(u, target) {
    u.windup = CONFIG.combat.windupTime;
    u.windupTarget = target;
    this.effects.push({
      type: 'telegraph', from: { ...u.pos }, to: { ...target.pos },
      color: '#f87171', life: CONFIG.combat.windupTime,
    });
  }

  // Resolve an enemy's telegraphed hit. The target may dodge it if it has
  // stamina and is within the dodge window; otherwise it takes the damage.
  _resolveEnemyHit(u, target) {
    if (!target || !target.alive) return;
    // Dodge: the target spends stamina to avoid the hit entirely.
    if (this._tryDodge(target, u.def.atk)) {
      this.effects.push({
        type: 'dodge', from: { ...u.pos }, to: { ...target.pos },
        color: '#a7f3d0', life: 0.2, max: 0.2,
      });
      return;
    }
    const dealt = target.takeDamage(u.def.atk);
    target.recordHit(u.def.kind);
    this.recordSharedHit(u.def.kind, dealt);
    target.addThreat(u, u.def.atk);
    this._knockback(target, u.pos, CONFIG.combat.knockback);
    this.effects.push({
      type: 'attack', from: { ...u.pos }, to: { ...target.pos },
      color: '#f87171', life: 0.15, dmg: dealt, max: 0.15,
    });
  }

  // A member tries to dodge an incoming hit. Succeeds if it has enough stamina
  // and isn't already dodging; spends stamina and grants a brief invulnerable
  // window. Returns true if the hit was avoided.
  //
  // Stamina preservation: a member only dodges a hit that is actually worth
  // dodging (deals meaningful damage) and never spends below a reserve floor,
  // so it always keeps enough stamina to sprint away if it needs to escape.
  _tryDodge(u, incomingDmg) {
    if (u.team !== 'player') return false;
    const st = CONFIG.stamina;
    // Only dodge hits that would hurt enough to justify the stamina cost.
    if (incomingDmg < st.dodgeMinDmg) return false;
    // Never spend below the reserve floor: keep enough to sprint to safety.
    if (u.stamina - st.dodgeCost < u.staminaMax * st.reserveFrac) return false;
    if (u.dodgeTimer > 0) return false;
    u.stamina -= st.dodgeCost;
    u.dodgeTimer = st.dodgeWindow;
    return true;
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
        this._startEnemyWindup(u, target);
      }
    }
  }

  // Spitter: ranged. Keeps distance from its target and fires from afar.
  // A taunted spitter breaks that rule: it is forced onto its taunter and
  // charges in so the tank can actually reach it, otherwise a slow melee
  // taunt-tank would endlessly chase a kiting ranged enemy it can't catch.
  _updateSpitter(u, dt) {
    const enemies = this.playerUnits.filter(e => e.alive);
    if (enemies.length === 0) { u.vel = { x: 0, y: 0 }; return; }
    const target = this._pickBatTarget(u, enemies);

    const d = dist(u.pos, target.pos);
    const desired = u.def.range * 0.7; // preferred standoff distance
    let steer;
    if (u.taunted) {
      steer = norm(sub(target.pos, u.pos)); // charge the taunter
    } else if (d > desired + 0.5) {
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
        u.attackTimer = u.def.attackCooldown || CONFIG.combat.attackCooldown;
        u.target = target;
        this._startEnemyWindup(u, target);
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

  // Unified movement. Every path-based movement routes through here so the
  // speed profile is consistent: speed up when far, ease off when close,
  // match a followed target's velocity, and gain speed when chasing. Stamina
  // is drained only in proportion to how much faster than baseline the unit
  // moves. `opts`:
  //   follow   - a Unit to keep pace with (its velocity is blended in)
  //   chase    - push harder the farther behind the goal we are (catch up)
  //   standoff - stop approaching once within this distance of `follow`
  _moveTo(u, goal, opts = {}, dt) {
    const { follow = null, chase = false, standoff = 0 } = opts;
    const t = CONFIG.team;
    const st = CONFIG.stamina;

    // Following a target we're already close enough to: just match its speed
    // instead of pathing into it.
    if (follow && follow.alive && dist(u.pos, follow.pos) <= standoff) {
      this._setVel(u, { ...follow.vel }, dt);
      u.sprinting = false;
      return;
    }

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
      !u.pathGoal || dist(u.pathGoal, goal) > t.repathDistance;
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

    // Speed profile: full speed far away, easing down through the slow radius,
    // then gliding to a stop within the arrival radius. This makes approach
    // feel natural instead of a constant-speed march.
    const finalWp = u.path[u.path.length - 1];
    const dGoal = dist(u.pos, finalWp);
    let speed = u.effSpeed;
    if (dGoal < t.slowRadius) {
      const f = dGoal / t.slowRadius; // 0..1, 1 at the slow radius edge
      speed = u.effSpeed * (t.minSpeedFactor + (1 - t.minSpeedFactor) * f);
    }
    if (dGoal < t.arrivalRadius) {
      speed = u.effSpeed * (dGoal / t.arrivalRadius);
    }

    // Chasing: gain speed to catch a moving goal. The farther behind we are,
    // the harder we push, up to the sprint multiplier.
    if (chase) {
      const gap = dist(u.pos, goal);
      speed = Math.max(speed, u.effSpeed * st.sprintMult * clamp(gap / t.slowRadius, 0, 1));
    }

    // Desired velocity: move along the path at `speed`, plus the followed
    // target's own velocity so we keep pace once close (matching speed).
    let desired = scale(dir, speed);
    if (follow && follow.alive) desired = add(desired, follow.vel);

    // Stamina: drain only for the portion of speed above baseline, so a unit
    // doesn't burn stamina while merely keeping pace.
    const over = Math.max(0, len(desired) - u.effSpeed);
    if (over > 0) {
      const floor = u.staminaMax * st.reserveFrac;
      if (u.stamina > floor) {
        u.sprinting = true;
        u.stamina = Math.max(floor, u.stamina - st.sprintCost * dt * (over / (u.effSpeed * (st.sprintMult - 1))));
      } else {
        u.sprinting = false;
      }
    } else {
      u.sprinting = false;
    }

    this._setVel(u, desired, dt);
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
    // Team morale: a confident team moves a touch faster, a shaken one slower.
    if (u.team === 'player') {
      const m = 1 + CONFIG.morale.speedMult * (this.morale - 0.5);
      desired = scale(desired, m);
    }
    const accel = CONFIG.team.accel * dt;
    const dv = sub(desired, u.vel);
    const dl = len(dv);
    if (dl <= accel) {
      u.vel = desired;
    } else {
      u.vel = add(u.vel, scale(dv, accel / dl));
    }
  }

  // Sprint: move at a boosted speed while stamina lasts. Drains stamina per
  // second; stops when exhausted. Returns the effective speed used.
  _sprint(u, dir, dt) {
    const st = CONFIG.stamina;
    // Stop at the reserve floor, not at zero, so a member always keeps a
    // little stamina in the tank.
    const floor = u.staminaMax * st.reserveFrac;
    if (u.stamina <= floor) {
      u.sprinting = false;
      // Out of sprint stamina: still move at normal speed in the given
      // direction. Without this, a retreating unit keeps its previous
      // velocity (e.g. toward an enemy) and drifts into danger.
      this._setVel(u, scale(dir, u.effSpeed), dt);
      return u.effSpeed;
    }
    u.sprinting = true;
    u.stamina = Math.max(floor, u.stamina - st.sprintCost * dt);
    this._setVel(u, scale(dir, u.effSpeed * st.sprintMult), dt);
    return u.effSpeed * st.sprintMult;
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