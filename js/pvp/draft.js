// PvP draft state machine. Pure logic, host-owned: the host runs the draft and
// broadcasts its state to the guest, who sends back picks. No shared RNG, no
// deterministic replay — the host is the single source of truth.
//
// Round-based with permadeath: each round both players draft a team from a
// shared pool, then fight. Gold starts at 100 and rises by 100 each round.
// There is no fixed pick count — on your turn you pick any member you can
// afford, or pass to end your drafting for the round. Members who die in a
// fight are removed from the pool for the rest of the match, so a team can be
// whittled down to nothing.
//
// Team ownership: the host owns team 'a', the guest owns team 'b'. A pick is
// only accepted for the player whose turn it is, so nobody can draft for the
// other side.

import { salaryOf } from '../meta.js';

export const PVP = {
  // Gold each player starts round 1 with.
  baseGold: 100,
  // Gold added to the budget each subsequent round.
  goldPerRound: 100,
  // Rounds in a match (best-of-N, re-draft between rounds).
  rounds: 3,
};

// The gold budget for a given round: 100, 200, 300, ...
export function goldForRound(round) {
  return PVP.baseGold + (round - 1) * PVP.goldPerRound;
}

// Build a shared draft pool from the roster. Each entry is a member bundle
// with a `salary` attached (used for gold cost).
export function buildPool(roster) {
  return roster.map(m => ({ ...m, salary: salaryOf(m) }));
}

export class Draft {
  constructor(pool, opts = {}) {
    this.pool = pool;                       // shared member pool (with salary)
    this.baseGold = opts.baseGold ?? PVP.baseGold;
    this.goldPerRound = opts.goldPerRound ?? PVP.goldPerRound;
    this.rounds = opts.rounds ?? PVP.rounds;
    this.round = 1;
    this.picks = { a: [], b: [] };          // member ids picked this round
    this.gold = { a: this.baseGold, b: this.baseGold };
    this.passed = { a: false, b: false };   // has each player finished drafting?
    this.turn = 'a';                        // whose turn to pick
    this.phase = 'drafting';                 // 'drafting' | 'betweenRounds' | 'done'
    this.winner = null;                     // 'a' | 'b' | 'draw' | null
    this.dead = new Set();                  // member ids dead (permadeath)
  }

  // The member bundle for a pool id.
  member(id) {
    return this.pool.find(m => m.id === id) || null;
  }

  // Is it this player's turn to pick?
  isTurn(player) {
    return this.phase === 'drafting' && this.turn === player;
  }

  // Can this player afford a given member right now?
  canAfford(player, id) {
    const m = this.member(id);
    if (!m) return false;
    return this.gold[player] >= m.salary;
  }

  // Is a member still available (not already picked this round, not dead)?
  available(id) {
    if (this.dead.has(id)) return false;
    return !this.picks.a.includes(id) && !this.picks.b.includes(id);
  }

  // The player's drafted member bundles for this round.
  team(player) {
    return this.picks[player].map(id => this.member(id)).filter(Boolean);
  }

  // Both players have finished drafting this round.
  get roundComplete() {
    return this.passed.a && this.passed.b;
  }

  // Pick a member for the current player. Validates turn, availability, and
  // gold. Returns true on success, false otherwise.
  pick(player, id) {
    if (!this.isTurn(player)) return false;
    if (!this.available(id)) return false;
    if (!this.canAfford(player, id)) return false;
    const m = this.member(id);
    this.picks[player].push(id);
    this.gold[player] -= m.salary;
    this._advanceTurn();
    return true;
  }

  // End the current player's drafting for this round. Returns true on success.
  pass(player) {
    if (!this.isTurn(player)) return false;
    this.passed[player] = true;
    this._advanceTurn();
    return true;
  }

  // After a pick or pass, hand the turn to the other player if they can still
  // act; otherwise the current player keeps it. Ends the round when both pass.
  _advanceTurn() {
    if (this.passed.a && this.passed.b) {
      this.phase = 'betweenRounds';
      this.turn = null;
      return;
    }
    const other = this.turn === 'a' ? 'b' : 'a';
    this.turn = this.passed[other] ? this.turn : other;
  }

  // Mark members as dead (permadeath). They are removed from the pool for the
  // rest of the match. Returns the ids that were newly marked dead.
  markDead(ids) {
    const newly = [];
    for (const id of ids) {
      if (!this.dead.has(id)) { this.dead.add(id); newly.push(id); }
    }
    return newly;
  }

  // Advance to the next round: reset picks, gold (escalating), and pass state,
  // keep the pool minus dead members. Returns false if the match is over.
  nextRound() {
    if (this.phase !== 'betweenRounds') return false;
    if (this.round >= this.rounds) {
      this.phase = 'done';
      return false;
    }
    this.round++;
    this.picks = { a: [], b: [] };
    this.gold = { a: goldForRound(this.round), b: goldForRound(this.round) };
    this.passed = { a: false, b: false };
    this.turn = 'a';
    this.phase = 'drafting';
    return true;
  }

  // Record a round result (called by the host after the fight). Advances to
  // the next round or ends the match.
  recordRoundResult(winner) {
    if (this.phase !== 'betweenRounds') return;
    if (winner === 'a' || winner === 'b') {
      this.winner = winner;
    }
    this.nextRound();
  }

  // Plain-object snapshot for broadcasting to the guest.
  serialize() {
    return {
      pool: this.pool,
      baseGold: this.baseGold,
      goldPerRound: this.goldPerRound,
      rounds: this.rounds,
      round: this.round,
      picks: this.picks,
      gold: this.gold,
      passed: this.passed,
      turn: this.turn,
      phase: this.phase,
      winner: this.winner,
      dead: [...this.dead],
    };
  }

  // Rebuild a Draft from a serialized snapshot (guest side).
  static deserialize(data) {
    const d = new Draft(data.pool, {
      baseGold: data.baseGold,
      goldPerRound: data.goldPerRound,
      rounds: data.rounds,
    });
    d.round = data.round;
    d.picks = data.picks;
    d.gold = data.gold;
    d.passed = data.passed;
    d.turn = data.turn;
    d.phase = data.phase;
    d.winner = data.winner;
    d.dead = new Set(data.dead || []);
    return d;
  }
}
