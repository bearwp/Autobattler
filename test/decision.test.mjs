// Decision unit tests for the utility-AI refactor.
//
// These exercise the per-frame `_decide` scoring directly by constructing a
// Sim, spawning a controlled player unit and enemy, and asserting which action
// wins given crafted state (hurt / shaken / healthy / outnumbered).
//
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Sim } from '../js/sim/sim.js';
import { Unit } from '../js/sim/unit.js';
import { CONFIG } from '../js/sim/config.js';

// A minimal damage member: healthy, confident, no self-preservation instincts.
function damageMember(overrides = {}) {
  return {
    id: 'test-dmg',
    name: 'Test Dmg',
    color: '#fff', shape: 'square',
    stats: { hp: 200, armor: 5, speed: 3.0, size: 0.7 },
    attack: { type: 'damage', shape: 'meleeOneShot', range: 2.0, atk: 20 },
    modifiers: [],
    selfPreservation: [],
    target: { side: 'enemy', rule: 'closest' },
    movement: 'advance', leader: false, personality: 'stoic',
    confidence: 0.8,
    ...overrides,
  };
}

// A squishy ally for peel tests.
function squishyMember(overrides = {}) {
  return {
    id: 'test-squishy',
    name: 'Test Squishy',
    color: '#fff', shape: 'circle',
    stats: { hp: 60, armor: 0, speed: 3.0, size: 0.7 },
    attack: { type: 'damage', shape: 'rangeOneShot', range: 6.0, atk: 10 },
    modifiers: [],
    selfPreservation: [],
    target: { side: 'enemy', rule: 'closest' },
    movement: 'kite', leader: false, personality: 'cautious',
    confidence: 0.5,
    ...overrides,
  };
}

// A basic enemy bat.
function enemyDef(overrides = {}) {
  return {
    ...CONFIG.enemies.bat,
    ...overrides,
  };
}

// Build a Sim with a single player unit and a single enemy, both alive and
// positioned, and return the sim plus the unit references.
function setup({ member, enemy, uPos, ePos }) {
  const sim = new Sim();
  // Clear the auto-spawned units so we control the exact state.
  sim.units = [];
  sim.playerUnits = [];
  sim.enemyUnits = [];

  const u = new Unit(member, { team: 'player', pos: uPos });
  const e = new Unit(enemy, { team: 'enemy', pos: ePos });
  sim.units.push(u, e);
  sim.playerUnits.push(u);
  sim.enemyUnits.push(e);
  return { sim, u, e };
}

// Run _decide and return the winning action name.
function decide(sim, u, e) {
  const enemies = sim.enemyUnits.filter(x => x.alive);
  const allies = sim.playerUnits.filter(x => x.alive);
  sim._decide(u, e, enemies, allies, 0.016);
  return u.decision.action;
}

test('healthy confident damage unit engages (goal wins)', () => {
  const { sim, u, e } = setup({
    member: damageMember(),
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 6, y: 5 }, // in range
  });
  const action = decide(sim, u, e);
  assert.equal(action, 'goal');
});

test('hurt unit retreats (retreat wins)', () => {
  const { sim, u, e } = setup({
    member: damageMember({ stats: { hp: 200, armor: 5, speed: 3.0, size: 0.7 } }),
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 6, y: 5 },
  });
  // Hurt it below the retreat threshold.
  u.hp = 20; // 10% of 200
  const action = decide(sim, u, e);
  assert.equal(action, 'retreat');
});

test('shaken unit retreats (retreat wins)', () => {
  const { sim, u, e } = setup({
    member: damageMember(),
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 6, y: 5 },
  });
  u.confidence = 0.1; // below safetyThreshold (0.3)
  const action = decide(sim, u, e);
  assert.equal(action, 'retreat');
});

test('outnumbering raises the retreat score', () => {
  const { sim, u, e } = setup({
    member: damageMember(),
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 5.5, y: 5 },
  });
  const enemies = sim.enemyUnits.filter(x => x.alive);
  const allies = sim.playerUnits.filter(x => x.alive);
  const before = sim._retreatScore(u, enemies, allies);

  // Add two more enemies within swarmRadius (3.0) so swarmCount (3) is met.
  for (let i = 0; i < 2; i++) {
    const e2 = new Unit(enemyDef(), { team: 'enemy', pos: { x: 5.5 + i * 0.5, y: 5 } });
    sim.units.push(e2);
    sim.enemyUnits.push(e2);
  }
  const after = sim._retreatScore(u, sim.enemyUnits.filter(x => x.alive), allies);
  assert.ok(after.score > before.score, 'outnumbering should raise the retreat score');
  assert.ok(after.reason.includes('outnumbered'), 'reason should mention outnumbered');
});

test('peel unit defends a squishy ally under threat (peel wins)', () => {
  const { sim, u, e } = setup({
    member: damageMember({ modifiers: ['peel'] }),
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 5.5, y: 5 },
  });
  // A squishy ally right next to the enemy, low HP.
  const ally = new Unit(squishyMember(), { team: 'player', pos: { x: 5.4, y: 5 } });
  ally.hp = 20; // low HP -> squishy
  sim.units.push(ally);
  sim.playerUnits.push(ally);

  const enemies = sim.enemyUnits.filter(x => x.alive);
  const allies = sim.playerUnits.filter(x => x.alive);
  sim._decide(u, e, enemies, allies, 0.016);
  assert.equal(u.decision.action, 'peel');
});

test('room clear: unit advances to the door (advance wins)', () => {
  const { sim, u, e } = setup({
    member: damageMember(),
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 6, y: 5 },
  });
  // Kill the enemy so the room is clear.
  e.alive = false;
  const enemies = sim.enemyUnits.filter(x => x.alive);
  const allies = sim.playerUnits.filter(x => x.alive);
  sim._decide(u, null, enemies, allies, 0.016);
  assert.equal(u.decision.action, 'advance');
});

test('hurt+shaken unit stops retreating once the room clears', () => {
  const { sim, u, e } = setup({
    member: damageMember(),
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 5.5, y: 5 },
  });
  // Hurt + shaken: retreats while the enemy is alive.
  u.hp = 20;
  u.confidence = 0.1;
  assert.equal(decide(sim, u, e), 'retreat');
  // Enemy dies: room clear, no danger, so it advances instead of retreating.
  e.alive = false;
  const enemies = sim.enemyUnits.filter(x => x.alive);
  const allies = sim.playerUnits.filter(x => x.alive);
  sim._decide(u, null, enemies, allies, 0.016);
  assert.equal(u.decision.action, 'advance');
});

test('decision stores a score breakdown for the debug overlay', () => {
  const { sim, u, e } = setup({
    member: damageMember(),
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 6, y: 5 },
  });
  decide(sim, u, e);
  assert.ok(u.decision, 'decision should be set');
  assert.equal(typeof u.decision.score, 'number');
  assert.ok(Array.isArray(u.decision.candidates));
  assert.ok(u.decision.candidates.length >= 4, 'should have retreat/goal/hold/advance');
  // The winning candidate should be the one with the highest score.
  const winner = u.decision.candidates.find(c => c.name === u.decision.action);
  assert.ok(winner, 'winning action should be among candidates');
  for (const c of u.decision.candidates) {
    assert.ok(c.score <= u.decision.score + 1e-9, `${c.name} score should not exceed winner`);
  }
});

test('support unit with no ally in need engages the enemy instead of idling', () => {
  const { sim, u, e } = setup({
    member: {
      id: 'test-healer',
      name: 'Test Healer',
      color: '#fff', shape: 'circle',
      stats: { hp: 150, armor: 2, speed: 3.0, size: 0.7 },
      attack: { type: 'heal', shape: 'rangeOneShot', range: 5.0, atk: 15 },
      modifiers: [],
      selfPreservation: [],
      target: { side: 'ally', rule: 'lowestHp' },
      leader: false, confidence: 0.8,
    },
    enemy: enemyDef(),
    uPos: { x: 5, y: 5 },
    ePos: { x: 6, y: 5 }, // in heal range
  });
  // A full-health ally so no one needs a heal.
  const ally = new Unit(squishyMember(), { team: 'player', pos: { x: 4, y: 5 } });
  ally.hp = ally.maxHp;
  sim.units.push(ally);
  sim.playerUnits.push(ally);

  const enemies = sim.enemyUnits.filter(x => x.alive);
  const allies = sim.playerUnits.filter(x => x.alive);
  // Pass null as the target: in the real flow _updateMember sets the heal
  // target to null when no ally is hurt, then calls _decide with it.
  sim._decide(u, null, enemies, allies, 0.016);
  assert.equal(u.decision.action, 'goal', 'support with nothing to cast should engage');
  assert.equal(u.decision.reason, 'advancing on target');
});
