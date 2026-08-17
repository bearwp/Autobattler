// PeerJS transport for online PvP. One player hosts and runs the sim; the
// guest just renders what the host broadcasts. No shared RNG, no deterministic
// replay — the host is the single source of truth.
//
// Message protocol (JSON over a PeerJS data connection):
//   { type: 'draft', draft: <serialized Draft> }   host -> guest
//   { type: 'pick',  id }                           guest -> host
//   { type: 'snap',  units: [...], over }           host -> guest (each frame)
//   { type: 'fight', teamA, teamB }                 host -> guest (start fight)
//   { type: 'result', winner }                      host -> guest (fight over)
//
// The host owns the Draft and the Sim. The guest sends picks and renders the
// host's snapshots.

// Serialize a unit into a compact plain object for the wire.
export function unitSnap(u) {
  return {
    id: u.id,
    team: u.team,
    alive: u.alive,
    x: u.pos.x, y: u.pos.y,
    facing: u.facing ?? 0,
    hp: u.hp, maxHp: u.maxHp,
    mana: u.mana, maxMana: u.maxMana,
    shield: u.shield, shieldMax: u.shieldMax,
    stunTimer: u.stunTimer,
    taunted: u.taunted,
    hitFlash: u.hitFlash,
    size: u.size,
    stamina: u.stamina, staminaMax: u.staminaMax,
    sprinting: u.sprinting,
    confidence: u.confidence,
    intent: u.intent,
    targetId: u.target && u.target.alive ? u.target.id : null,
    def: {
      color: u.def.color,
      shape: u.def.shape,
      name: u.def.name,
      kind: u.def.kind,
      attack: u.def.attack ? { type: u.def.attack.type, shape: u.def.attack.shape } : null,
    },
  };
}

// Build a lightweight remote sim object the guest can hand to the renderer.
// It only carries what the renderer reads; it is never stepped.
export function remoteSim(units, over = null) {
  return {
    units,
    effects: [],
    bubbles: [],
    over,
    pvp: true,
    started: true,
    mapOpen: false,
    restOpen: false,
    level: 1,
    gold: 0,
    members: [],
    playerUnits: [],
    enemyUnits: [],
    teamAUnits: units.filter(u => u.team === 'a'),
    teamBUnits: units.filter(u => u.team === 'b'),
    enemyUnits: units.filter(u => u.team === 'enemy'),
    deadIds: new Set(),
  };
}

// A thin wrapper around a PeerJS connection. `onMessage` is called with each
// parsed message. `onOpen` fires when the connection is ready.
export class PvpNet {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.role = null; // 'host' | 'guest'
    this.onMessage = null;
    this.onOpen = null;
    this.onClose = null;
  }

  // Host a room. `id` is the room code the guest joins with.
  host(id) {
    this.role = 'host';
    this.peer = new Peer(id);
    this.peer.on('open', () => {
      this.peer.on('connection', (conn) => {
        this.conn = conn;
        this._wire(conn);
      });
    });
    this.peer.on('error', (err) => console.error('PeerJS host error', err));
  }

  // Join a room hosted at `id`.
  join(id) {
    this.role = 'guest';
    this.peer = new Peer();
    this.peer.on('open', () => {
      this.conn = this.peer.connect(id, { reliable: true });
      this._wire(this.conn);
    });
    this.peer.on('error', (err) => console.error('PeerJS join error', err));
  }

  _wire(conn) {
    conn.on('open', () => this.onOpen && this.onOpen());
    conn.on('data', (data) => {
      let msg;
      try { msg = typeof data === 'string' ? JSON.parse(data) : data; }
      catch { return; }
      this.onMessage && this.onMessage(msg);
    });
    conn.on('close', () => this.onClose && this.onClose());
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(JSON.stringify(msg));
  }

  close() {
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
    this.conn = null;
    this.peer = null;
  }
}
