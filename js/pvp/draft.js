// PvP draft state machine. Pure logic, host-owned: the host runs the draft and
// broadcasts its state to the guest, who sends back picks. No shared RNG, no
// deterministic replay — the host is the single source of truth.
//
// Round-based with permadeath: each round both players draft a team from a
// shared pool (snake order), then fight. Gold starts at 50 and rises by 50
// each round. Members who die in a fight are removed from the pool for the
// rest of the match, so a team can be whittled down to nothing.
//
// Team ownership: the host owns team 'a', the guest owns team 'b'. A pick is
// only accepted for the player whose turn it is, so nobody can draft for the
// other side.

import { salaryOf } from '../meta.js';

export const PVP = {
  // Gold each player starts round 1 with.
  baseGold: 50,
  // Gold added to the budget each subsequent round.
  goldPerRound: 50,
  // Members each player drafts per round.
  picksPerPlayer: 1,
  // Rounds in a match (best-of-N, re-draft between rounds).
  rounds: 3,
};

// The gold budget for a given round: 50, 100, 150, ...
export function goldForRound(round) {
  return PVP.baseGold + (round - 1) * PVP.goldPerRound;
}

// Build a shared draft pool from the roster. Each entry is a member bundle
// with a `salary` attached (used for gold cost).
export function buildPool(roster) {
  return roster.map(m => ({ ...m, salary: salaryOf(m) }));
}

// The snake-draft pick order for a round. Player 'a' picks first, then 'b',
// alternating. For 1 pick each: A, B. For 2: A, B, B, A (second player gets
// two in a row to compensate for going second).
export function pickOrder(picksPerPlayer) {
  const order = [];
  for (let i = 0; i < picksPerPlayer; i++) {
    if (i % 2 === 0) order.push('a', 'b');
    else order.push('b', 'a');
  }
  return order;
}

export class Draft {
  constructor(pool, opts = {}) {
    this.pool = pool;                       // shared member pool (with salary)
    this.baseGold = opts.baseGold ?? PVP.baseGold;
    this.goldPerRound = opts.goldPerRound ?? PVP.goldPerRound;
    this.picksPerPlayer = opts.picksPerPlayer ?? PVP.picksPerPlayer;
    this.rounds = opts.rounds ?? PVP.rounds;
    this.round = 1;
    this.picks = { a: [], b: [] };          // member ids picked this round
    this.gold = { a: this.baseGold, b: this.baseGold };
    this.turn = 'a';                        // whose turn to pick
    this.phase = 'drafting';                // 'drafting' | 'betweenRounds' | 'done'
    this.winner = null;                     // 'a' | 'b' | 'draw' | null
    this.dead = new Set();                  // member ids dead (permadeath)
    this._order = pickOrder(this.picksPerPlayer);
    this._orderIndex = 0;
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
    return this.picks.a.length >= this.picksPerPlayer &&
      this.picks.b.length >= this.picksPerPlayer;
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

  _advanceTurn() {
    this._orderIndex++;
    if (this.roundComplete) {
      this.phase = 'betweenRounds';
      this.turn = null;
      return;
    }
    this.turn = this._order[this._orderIndex];
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

  // Advance to the next round: reset picks and gold (escalating), keep the
  // pool minus dead members. Returns false if the match is over.
  nextRound() {
    if (this.phase !== 'betweenRounds') return false;
    if (this.round >= this.rounds) {
      this.phase = 'done';
      return false;
    }
    this.round++;
    this.picks = { a: [], b: [] };
    this.gold = { a: goldForRound(this.round), b: goldForRound(this.round) };
    this._orderIndex = 0;
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
      picksPerPlayer: this.picksPerPlayer,
      rounds: this.rounds,
      round: this.round,
      picks: this.picks,
      gold: this.gold,
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
      picksPerPlayer: data.picksPerPlayer,
      rounds: data.rounds,
    });
    d.round = data.round;
    d.picks = data.picks;
    d.gold = data.gold;
    d.turn = data.turn;
    d.phase = data.phase;
    d.winner = data.winner;
    d.dead = new Set(data.dead || []);
    d._orderIndex = data.picks.a.length + data.picks.b.length;
    return d;
  }
}
