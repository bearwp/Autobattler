// PvP draft state machine. Pure logic, host-owned: the host runs the draft and
// broadcasts its state to the guest, who sends back picks. No shared RNG, no
// deterministic replay — the host is the single source of truth.
//
// Round-based with permadeath: each round both players draft a team from a
// shared pool, then fight. There is no currency and no pass — on your turn you
// pick any available member, then the turn alternates. The host starts the
// fight whenever both sides are ready. Members who die in a fight are removed
// from the pool for the rest of the match, so a team can be whittled down to
// nothing.
//
// Team ownership: the host owns team 'a', the guest owns team 'b'. A pick is
// only accepted for the player whose turn it is, so nobody can draft for the
// other side.

export const PVP = {
  // Rounds in a match (best-of-N, re-draft between rounds).
  rounds: 3,
};

// Build a shared draft pool from the roster.
export function buildPool(roster) {
  return roster.map(m => ({ ...m }));
}

export class Draft {
  constructor(pool, opts = {}) {
    this.pool = pool;                       // shared member pool
    this.rounds = opts.rounds ?? PVP.rounds;
    this.round = 1;
    this.picks = { a: [], b: [] };          // member ids picked this round
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

  // Is a member still available (not already picked this round, not dead)?
  available(id) {
    if (!this.member(id)) return false;
    if (this.dead.has(id)) return false;
    return !this.picks.a.includes(id) && !this.picks.b.includes(id);
  }

  // The player's drafted member bundles for this round.
  team(player) {
    return this.picks[player].map(id => this.member(id)).filter(Boolean);
  }

  // Both teams have at least one member, so the host can start the fight.
  get roundComplete() {
    return this.picks.a.length > 0 && this.picks.b.length > 0;
  }

  // Pick a member for the current player. Validates turn and availability.
  // Returns true on success, false otherwise.
  pick(player, id) {
    if (!this.isTurn(player)) return false;
    if (!this.available(id)) return false;
    this.picks[player].push(id);
    this._advanceTurn();
    return true;
  }

  // Alternate the turn between the two players.
  _advanceTurn() {
    this.turn = this.turn === 'a' ? 'b' : 'a';
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

  // Advance to the next round: reset picks, keep the pool minus dead members.
  // Returns false if the match is over.
  nextRound() {
    if (this.phase === 'done') return false;
    if (this.round >= this.rounds) {
      this.phase = 'done';
      return false;
    }
    this.round++;
    this.picks = { a: [], b: [] };
    this.turn = 'a';
    this.phase = 'drafting';
    return true;
  }

  // Record a round result (called by the host after the fight). Advances to
  // the next round or ends the match.
  recordRoundResult(winner) {
    if (this.phase === 'done') return;
    if (winner === 'a' || winner === 'b') {
      this.winner = winner;
    }
    this.nextRound();
  }

  // Plain-object snapshot for broadcasting to the guest.
  serialize() {
    return {
      pool: this.pool,
      rounds: this.rounds,
      round: this.round,
      picks: this.picks,
      turn: this.turn,
      phase: this.phase,
      winner: this.winner,
      dead: [...this.dead],
    };
  }

  // Rebuild a Draft from a serialized snapshot (guest side).
  static deserialize(data) {
    const d = new Draft(data.pool, { rounds: data.rounds });
    d.round = data.round;
    d.picks = data.picks;
    d.turn = data.turn;
    d.phase = data.phase;
    d.winner = data.winner;
    d.dead = new Set(data.dead || []);
    return d;
  }
}
