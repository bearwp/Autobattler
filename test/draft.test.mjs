// Draft state machine tests: pass-based drafting, escalating gold,
// availability, permadeath, and between-round reset.
//
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Draft, PVP, buildPool, goldForRound } from '../js/pvp/draft.js';

// A minimal member bundle (same shape as CONFIG.roster entries).
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

// A pool of 8 members with distinct, affordable salaries.
function pool() {
  return buildPool([
    member('m1', { stats: { hp: 100, armor: 0, speed: 1, size: 0.5 }, attack: { type: 'damage', shape: 'meleeOneShot', range: 1, atk: 5 } }),
    member('m2', { stats: { hp: 100, armor: 0, speed: 1, size: 0.5 }, attack: { type: 'damage', shape: 'meleeOneShot', range: 1, atk: 5 } }),
    member('m3', { stats: { hp: 100, armor: 0, speed: 1, size: 0.5 }, attack: { type: 'damage', shape: 'meleeOneShot', range: 1, atk: 5 } }),
    member('m4', { stats: { hp: 100, armor: 0, speed: 1, size: 0.5 }, attack: { type: 'damage', shape: 'meleeOneShot', range: 1, atk: 5 } }),
    member('m5', { stats: { hp: 100, armor: 0, speed: 1, size: 0.5 }, attack: { type: 'damage', shape: 'meleeOneShot', range: 1, atk: 5 } }),
    member('m6', { stats: { hp: 100, armor: 0, speed: 1, size: 0.5 }, attack: { type: 'damage', shape: 'meleeOneShot', range: 1, atk: 5 } }),
    member('m7', { stats: { hp: 100, armor: 0, speed: 1, size: 0.5 }, attack: { type: 'damage', shape: 'meleeOneShot', range: 1, atk: 5 } }),
    member('m8', { stats: { hp: 100, armor: 0, speed: 1, size: 0.5 }, attack: { type: 'damage', shape: 'meleeOneShot', range: 1, atk: 5 } }),
  ]);
}

test('goldForRound escalates by 100 each round', () => {
  assert.equal(goldForRound(1), 100);
  assert.equal(goldForRound(2), 200);
  assert.equal(goldForRound(3), 300);
});

test('buildPool attaches a salary to each member', () => {
  const p = pool();
  assert.ok(p.every(m => typeof m.salary === 'number' && m.salary > 0));
});

test('draft alternates turns and lets a player pick multiple members', () => {
  const d = new Draft(pool(), { baseGold: 100 });
  // A picks m1, then it's B's turn.
  assert.equal(d.turn, 'a');
  assert.equal(d.pick('a', 'm1'), true);
  assert.equal(d.turn, 'b');
  // B picks m2, then back to A.
  assert.equal(d.pick('b', 'm2'), true);
  assert.equal(d.turn, 'a');
  // A picks m3 too (multiple picks per player).
  assert.equal(d.pick('a', 'm3'), true);
  assert.equal(d.turn, 'b');
  assert.deepEqual(d.picks.a, ['m1', 'm3']);
  assert.deepEqual(d.picks.b, ['m2']);
});

test('pick validates turn, availability, and gold', () => {
  const d = new Draft(pool(), { baseGold: 100 });
  // Wrong player cannot pick.
  assert.equal(d.pick('b', 'm1'), false);
  // Correct player picks.
  assert.equal(d.pick('a', 'm1'), true);
  // Already-picked member is unavailable.
  assert.equal(d.pick('b', 'm1'), false);
  // A member not in the pool is unavailable.
  assert.equal(d.pick('b', 'nope'), false);
});

test('a player cannot pick a member they cannot afford', () => {
  const p = pool();
  // Make m1 very expensive.
  p[0].salary = 1000;
  const d = new Draft(p, { baseGold: 100 });
  assert.equal(d.canAfford('a', 'm1'), false);
  assert.equal(d.pick('a', 'm1'), false);
  // A cheap member is fine.
  assert.equal(d.pick('a', 'm2'), true);
});

test('gold is deducted on pick and cannot go negative', () => {
  const p = pool();
  p[0].salary = 60;
  p[1].salary = 60;
  const d = new Draft(p, { baseGold: 100 });
  assert.equal(d.pick('a', 'm1'), true);
  assert.equal(d.gold.a, 40);
  // m2 costs 60 > 40 remaining, so it must be rejected for A.
  assert.equal(d.pick('a', 'm2'), false);
  // B has a full budget and can afford it.
  assert.equal(d.pick('b', 'm2'), true);
  assert.equal(d.gold.b, 40);
});

test('pass ends a players drafting and hands the turn over', () => {
  const d = new Draft(pool(), { baseGold: 100 });
  // A passes first.
  assert.equal(d.pass('a'), true);
  assert.equal(d.passed.a, true);
  assert.equal(d.turn, 'b');
  // B can still pick.
  assert.equal(d.pick('b', 'm1'), true);
  // B passes, ending the round.
  assert.equal(d.pass('b'), true);
  assert.equal(d.roundComplete, true);
  assert.equal(d.phase, 'betweenRounds');
  assert.equal(d.turn, null);
});

test('a passed player cannot pick again', () => {
  const d = new Draft(pool(), { baseGold: 100 });
  d.pass('a');
  // A passed, so it can no longer pick.
  assert.equal(d.pick('a', 'm1'), false);
  // B is on turn and can pick.
  assert.equal(d.pick('b', 'm1'), true);
});

test('nextRound resets picks, gold, and pass state but keeps the pool', () => {
  const d = new Draft(pool(), { rounds: 3, baseGold: 100 });
  d.pick('a', 'm1');
  d.pick('b', 'm2');
  d.pass('a');
  d.pass('b');
  assert.equal(d.phase, 'betweenRounds');

  d.recordRoundResult('a');
  assert.equal(d.round, 2);
  assert.equal(d.phase, 'drafting');
  assert.deepEqual(d.picks, { a: [], b: [] });
  assert.deepEqual(d.passed, { a: false, b: false });
  assert.equal(d.gold.a, goldForRound(2));
  assert.equal(d.gold.b, goldForRound(2));
  assert.equal(d.turn, 'a');
  assert.equal(d.pool.length, 8, 'pool is shared and persists across rounds');
});

test('recordRoundResult advances through rounds and ends the match', () => {
  const d = new Draft(pool(), { rounds: 3, baseGold: 100 });
  for (let r = 0; r < 3; r++) {
    d.pick('a', 'm1');
    d.pick('b', 'm2');
    d.pass('a');
    d.pass('b');
    assert.equal(d.phase, 'betweenRounds');
    d.recordRoundResult(r % 2 === 0 ? 'a' : 'b');
  }
  assert.equal(d.phase, 'done');
  assert.equal(d.round, 3);
});

test('dead members are removed from the pool (permadeath)', () => {
  const d = new Draft(pool(), { baseGold: 100 });
  // Mark m1 and m2 dead.
  d.markDead(['m1', 'm2']);
  assert.equal(d.available('m1'), false);
  assert.equal(d.available('m2'), false);
  assert.equal(d.available('m3'), true);
  // Cannot pick a dead member.
  assert.equal(d.pick('a', 'm1'), false);
  // markDead is idempotent.
  assert.deepEqual(d.markDead(['m1']), []);
});

test('serialize/deserialize round-trips the draft state', () => {
  const d = new Draft(pool(), { baseGold: 100 });
  d.pick('a', 'm1');
  d.pick('b', 'm2');
  d.pass('a');
  d.markDead(['m3']);
  const snap = d.serialize();
  const d2 = Draft.deserialize(snap);
  assert.equal(d2.turn, d.turn);
  assert.equal(d2.phase, d.phase);
  assert.deepEqual(d2.picks, d.picks);
  assert.deepEqual(d2.gold, d.gold);
  assert.deepEqual(d2.passed, d.passed);
  assert.equal(d2.round, d.round);
  assert.deepEqual([...d2.dead], ['m3']);
  // The guest can continue picking from the restored state (B is on turn).
  assert.equal(d2.pick('b', 'm4'), true);
});
