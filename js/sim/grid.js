// Grid overlay + A* pathfinding for ground units.
// The grid is a uniform square lattice over the room. Cells are blocked by
// walls and obstacles. Doors are gaps in the wall (walkable).

import { CONFIG } from './config.js';

export class Grid {
  constructor() {
    const { width, height, cellSize } = CONFIG.world;
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.blocked = new Uint8Array(this.cols * this.rows);
    this._buildBlocked();
  }

  _buildBlocked() {
    const { width, height } = CONFIG.world;
    const cs = this.cellSize;
    const wall = 0.5; // wall thickness in meters

    // Mark cells blocked by walls (border) and obstacles.
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cx = (c + 0.5) * cs;
        const cy = (r + 0.5) * cs;
        let blocked = false;

        // Border walls, except door gaps.
        const inEntrance = this._inDoor(cx, cy, CONFIG.doors.entrance);
        const inExit = this._inDoor(cx, cy, CONFIG.doors.exit);

        if (cx < wall || cx > width - wall || cy < wall || cy > height - wall) {
          blocked = !(inEntrance || inExit);
        }

        // Obstacles.
        if (!blocked) {
          for (const o of CONFIG.obstacles) {
            if (cx >= o.x && cx <= o.x + o.w && cy >= o.y && cy <= o.y + o.h) {
              blocked = true;
              break;
            }
          }
        }

        this.blocked[r * this.cols + c] = blocked ? 1 : 0;
      }
    }
  }

  _inDoor(cx, cy, door) {
    // Door is a gap in a wall. Vertical doors are on the left/right wall;
    // horizontal doors are on the top/bottom wall.
    if (door.orientation === 'vertical') {
      return Math.abs(cy - door.y) <= door.width / 2 &&
             Math.abs(cx - door.x) <= 0.6;
    }
    return Math.abs(cx - door.x) <= door.width / 2 &&
           Math.abs(cy - door.y) <= 0.6;
  }

  idx(c, r) { return r * this.cols + c; }

  worldToCell(p) {
    const c = Math.floor(p.x / this.cellSize);
    const r = Math.floor(p.y / this.cellSize);
    return { c, r };
  }

  cellToWorld(c, r) {
    return { x: (c + 0.5) * this.cellSize, y: (r + 0.5) * this.cellSize };
  }

  isBlocked(c, r) {
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return true;
    return this.blocked[this.idx(c, r)] === 1;
  }

  // Dynamic blocking: a cell is blocked if it is statically blocked OR occupied
  // by another unit (passed as a Set of cell indices). Used so pathfinding
  // routes around teammates instead of walking through them.
  isBlockedDynamic(c, r, occupied) {
    if (this.isBlocked(c, r)) return true;
    if (occupied && occupied.has(this.idx(c, r))) return true;
    return false;
  }

  // A* from world start to world goal. Returns array of world-space waypoints
  // (cell centers), or null if no path. `occupied` is an optional Set of cell
  // indices (from other units) treated as blocked so units route around each
  // other.
  findPath(start, goal, occupied) {
    const s = this.worldToCell(start);
    const g = this.worldToCell(goal);
    if (this.isBlockedDynamic(g.c, g.r, occupied)) {
      // Try to find nearest walkable cell to goal.
      const near = this._nearestWalkable(g.c, g.r, occupied);
      if (!near) return null;
      g.c = near.c; g.r = near.r;
    }
    if (this.isBlockedDynamic(s.c, s.r, occupied)) {
      const near = this._nearestWalkable(s.c, s.r, occupied);
      if (!near) return null;
      s.c = near.c; s.r = near.r;
    }

    const startIdx = this.idx(s.c, s.r);
    const goalIdx = this.idx(g.c, g.r);
    if (startIdx === goalIdx) return [this.cellToWorld(g.c, g.r)];

    // Fast path: if the straight line between the (resolved) cells is clear,
    // skip A* entirely and return a single straight segment. Most movement in
    // an open room is unobstructed, so this avoids the grid search almost
    // always and also yields natural straight-line motion instead of a
    // stair-stepped A* path.
    if (this._lineClear(s.c, s.r, g.c, g.r, occupied)) {
      return [this.cellToWorld(g.c, g.r)];
    }

    const open = new Map(); // idx -> {f, g, parent}
    const closed = new Set();
    const gScore = new Map();
    const fScore = new Map();

    const h = (c, r) => Math.abs(c - g.c) + Math.abs(r - g.r);

    gScore.set(startIdx, 0);
    fScore.set(startIdx, h(s.c, s.r));
    open.set(startIdx, { c: s.c, r: s.r, parent: null });

    const neighbors = [[1,0],[-1,0],[0,1],[0,-1]];

    while (open.size > 0) {
      // Pop lowest fScore.
      let curIdx = null, curF = Infinity;
      for (const [idx, node] of open) {
        const f = fScore.get(idx) ?? Infinity;
        if (f < curF) { curF = f; curIdx = idx; }
      }
      if (curIdx === null) break;
      const cur = open.get(curIdx);
      open.delete(curIdx);

      if (curIdx === goalIdx) {
        // Reconstruct.
        const path = [];
        let node = cur;
        while (node) {
          path.push(this.cellToWorld(node.c, node.r));
          node = node.parent;
        }
        path.reverse();
        return path;
      }

      closed.add(curIdx);
      const curG = gScore.get(curIdx);

      for (const [dc, dr] of neighbors) {
        const nc = cur.c + dc, nr = cur.r + dr;
        if (this.isBlockedDynamic(nc, nr, occupied)) continue;
        const nIdx = this.idx(nc, nr);
        if (closed.has(nIdx)) continue;
        const tentG = curG + 1;
        if (tentG < (gScore.get(nIdx) ?? Infinity)) {
          gScore.set(nIdx, tentG);
          fScore.set(nIdx, tentG + h(nc, nr));
          open.set(nIdx, { c: nc, r: nr, parent: cur });
        }
      }
    }
    return null;
  }

  // Line-of-sight check: walk the straight line from (c0,r0) to (c1,r1) in
  // cell space and return true if no blocked cell is crossed. Uses a
  // supercover-style DDA so the line is conservative (any cell the segment
  // touches counts), matching the grid's blocking rules.
  _lineClear(c0, r0, c1, r1, occupied) {
    let x = c0, y = r0;
    const dx = Math.abs(c1 - c0), dy = Math.abs(r1 - r0);
    const sx = c0 < c1 ? 1 : -1, sy = r0 < r1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      if (this.isBlockedDynamic(x, y, occupied)) return false;
      if (x === c1 && y === r1) return true;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  _nearestWalkable(c, r, occupied) {
    // BFS outward for nearest walkable cell.
    const queue = [[c, r]];
    const seen = new Set([this.idx(c, r)]);
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    while (queue.length) {
      const [cc, rr] = queue.shift();
      if (!this.isBlockedDynamic(cc, rr, occupied)) return { c: cc, r: rr };
      for (const [dc, dr] of dirs) {
        const nc = cc + dc, nr = rr + dr;
        const idx = this.idx(nc, nr);
        if (seen.has(idx)) continue;
        if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
        seen.add(idx);
        queue.push([nc, nr]);
      }
    }
    return null;
  }
}
