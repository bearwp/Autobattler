// PvP sim tests: two human-built teams fight to a wipe.
//
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Sim } from '../js/sim/sim.js';
import { CONFIG } from '../js/sim/config.js';

// A minimal damage member bundle (same shape as CONFIG.members entries).
function member(id, overrides = {}) {
  return {
    id,
    name: id,
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

test('startPvp spawns both teams and they fight to a wipe', () => {
  const sim = new Sim();
  const teamA = [member('a1', { leader: true }), member('a2')];
  const teamB = [member('b1', { leader: true }), member('b2')];
  sim.startPvp(teamA, teamB);

  assert.equal(sim.pvp, true);
  assert.equal(sim.teamAUnits.length, 2);
  assert.equal(sim.teamBUnits.length, 2);
  assert.equal(sim.units.length, 4);
  assert.equal(sim.started, true);
  assert.equal(sim.over, null);

  // Team A enters from the left door, team B from the right.
  const a = sim.teamAUnits[0];
  const b = sim.teamBUnits[0];
  assert.ok(a.pos.x < b.pos.x, 'team A should start left of team B');

  // Run the sim until one team is wiped (bounded to avoid infinite loop).
  let steps = 0;
  while (sim.over === null && steps < 6000) {
    sim.step(1 / 30);
    steps++;
  }
  assert.ok(sim.over === 'a' || sim.over === 'b', `fight should end with a winner, got ${sim.over}`);
  const winner = sim.over === 'a' ? sim.teamAUnits : sim.teamBUnits;
  const loser = sim.over === 'a' ? sim.teamBUnits : sim.teamAUnits;
  assert.ok(winner.some(u => u.alive), 'winner should have at least one alive member');
  assert.ok(loser.every(u => !u.alive), 'loser should be fully wiped');
});

test('pvp end-check does not call completeRun (no roguelike meta)', () => {
  const sim = new Sim();
  const teamA = [member('a1', { leader: true })];
  const teamB = [member('b1', { leader: true })];
  sim.startPvp(teamA, teamB);
  // Kill team B outright.
  for (const u of sim.teamBUnits) u.alive = false;
  sim._checkEnd();
  assert.equal(sim.over, 'a');
  // The sim should not have opened the map or touched run state.
  assert.equal(sim.mapOpen, false);
});

test('PvE enemies spawn in PvP and are hostile to both teams', () => {
  const sim = new Sim();
  const teamA = [member('a1', { leader: true })];
  const teamB = [member('b1', { leader: true })];
  sim.startPvp(teamA, teamB, { enemies: { count: 3 } });

  // Enemies spawn in the middle of the arena, team 'enemy'.
  assert.equal(sim.enemyUnits.length, 3);
  for (const e of sim.enemyUnits) {
    assert.equal(e.team, 'enemy');
    assert.ok(e.pos.x > 0 && e.pos.x < CONFIG.world.width, 'enemy should be inside the arena');
  }

  // Both human teams see the PvE enemies as enemies.
  const a = sim.teamAUnits[0];
  const b = sim.teamBUnits[0];
  const aEnemies = sim._enemiesOf(a);
  const bEnemies = sim._enemiesOf(b);
  assert.ok(aEnemies.includes(b), 'team A should see team B as an enemy');
  assert.ok(aEnemies.some(e => e.team === 'enemy'), 'team A should see PvE enemies');
  assert.ok(bEnemies.includes(a), 'team B should see team A as an enemy');
  assert.ok(bEnemies.some(e => e.team === 'enemy'), 'team B should see PvE enemies');

  // PvE enemies target both teams combined.
  const targets = sim._enemyTargets();
  assert.equal(targets.length, 2, 'enemies should target both teams alive members');
  assert.ok(targets.some(u => u.team === 'a') && targets.some(u => u.team === 'b'));

  // The fight resolves to a winner (PvE enemies don't block the end-check).
  let steps = 0;
  while (sim.over === null && steps < 6000) {
    sim.step(1 / 30);
    steps++;
  }
  assert.ok(sim.over === 'a' || sim.over === 'b', `fight should end with a winner, got ${sim.over}`);
});
