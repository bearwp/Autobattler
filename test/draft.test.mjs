// Draft state machine tests: free alternating picks, availability,
// permadeath, and between-round reset.
//
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Draft, PVP, buildPool } from '../js/pvp/draft.js';

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

// A pool of 8 members.
function pool() {
  return buildPool([
    member('m1'), member('m2'), member('m3'), member('m4'),
    member('m5'), member('m6'), member('m7'), member('m8'),
  ]);
}

test('draft alternates turns and lets a player pick multiple members', () => {
  const d = new Draft(pool());
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

test('pick validates turn and availability', () => {
  const d = new Draft(pool());
  // Wrong player cannot pick.
  assert.equal(d.pick('b', 'm1'), false);
  // Correct player picks.
  assert.equal(d.pick('a', 'm1'), true);
  // Already-picked member is unavailable.
  assert.equal(d.pick('b', 'm1'), false);
  // A member not in the pool is unavailable.
  assert.equal(d.pick('b', 'nope'), false);
});

test('roundComplete requires both teams to have at least one member', () => {
  const d = new Draft(pool());
  assert.equal(d.roundComplete, false);
  d.pick('a', 'm1');
  assert.equal(d.roundComplete, false, 'team B has no members yet');
  d.pick('b', 'm2');
  assert.equal(d.roundComplete, true);
});

test('nextRound resets picks but keeps the pool', () => {
  const d = new Draft(pool(), { rounds: 3 });
  d.pick('a', 'm1');
  d.pick('b', 'm2');
  d.pick('a', 'm3');
  d.pick('b', 'm4');

  d.recordRoundResult('a');
  assert.equal(d.round, 2);
  assert.equal(d.phase, 'drafting');
  assert.deepEqual(d.picks, { a: [], b: [] });
  assert.equal(d.turn, 'a');
  assert.equal(d.pool.length, 8, 'pool is shared and persists across rounds');
});

test('recordRoundResult advances through rounds and ends the match', () => {
  const d = new Draft(pool(), { rounds: 3 });
  for (let r = 0; r < 3; r++) {
    d.pick('a', 'm1');
    d.pick('b', 'm2');
    d.recordRoundResult(r % 2 === 0 ? 'a' : 'b');
  }
  assert.equal(d.phase, 'done');
  assert.equal(d.round, 3);
});

test('dead members are removed from the pool (permadeath)', () => {
  const d = new Draft(pool());
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
  const d = new Draft(pool());
  d.pick('a', 'm1');
  d.pick('b', 'm2');
  d.markDead(['m3']);
  const snap = d.serialize();
  const d2 = Draft.deserialize(snap);
  assert.equal(d2.turn, d.turn);
  assert.equal(d2.phase, d.phase);
  assert.deepEqual(d2.picks, d.picks);
  assert.equal(d2.round, d.round);
  assert.deepEqual([...d2.dead], ['m3']);
  // The guest can continue picking from the restored state (A is on turn).
  assert.equal(d2.pick('a', 'm4'), true);
});
