// Render layer. Reads sim state and draws it. NEVER mutates sim state.

import { CONFIG } from '../sim/config.js';

// Linearly interpolate two hex colors toward a target, returning a CSS color.
// Used to flash a unit's body white when it takes a hit.
function mixColor(hex, target, t) {
  const from = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const to = [1, 3, 5].map(i => parseInt(target.slice(i, i + 2), 16));
  const c = from.map((v, i) => Math.round(v + (to[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.showDebug = false;     // toggle intent/goal/target debug overlay with the D key
    this.highlightId = null;    // unit id to draw a highlight ring around (debug hover)
    // Renderer-owned cosmetic state: screen shake that lives only here and
    // never touches sim state.
    this.shake = 0;             // 0..1 screen-shake intensity
    this.shakeX = 0;
    this.shakeY = 0;
    this._t = 0;                // accumulated time, drives idle animation
    // Per-layer overlay toggles, driven by the pills in the debug panel.
    this.showAggro = true;      // enemy -> member threat lines
    this.showConfidence = true; // green/red confidence rings
    this.showBackup = true;     // faint backup-radius circles
    this.showSafety = true;     // yellow safety-direction arrows
    this.showTargets = true;    // dashed lines to attack targets
    this.showIntent = true;     // intent text above units
    this.showDecision = true;   // utility-AI score breakdown (player only)
    this._resize();
    window.addEventListener('resize', () => this._resize());
    // Re-fit whenever the canvas element's layout size changes (e.g. the
    // customizer grows/shrinks), not just on window resize.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fit world into canvas with padding.
    const { width, height } = CONFIG.world;
    const pad = 40;
    this.scale = Math.min((w - pad * 2) / width, (h - pad * 2) / height);
    this.offset = {
      x: (w - width * this.scale) / 2,
      y: (h - height * this.scale) / 2,
    };
  }

  _toScreen(p) {
    return {
      x: this.offset.x + p.x * this.scale,
      y: this.offset.y + p.y * this.scale,
    };
  }

  render(sim, dt = 0) {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    this._t += dt;
    this._updateShake(dt);

    // Apply screen shake as a whole-canvas translation so everything jitters
    // together on heavy impacts.
    ctx.save();
    ctx.translate(this.shakeX, this.shakeY);

    this._drawRoom(sim);
    this._drawUnits(sim);
    this._drawBubbles(sim);
    this._drawEffects(sim);
    if (this.showDebug) this._drawDebug(sim);

    ctx.restore();
  }

  // Decay screen shake over time and derive the per-frame jitter offset.
  _updateShake(dt) {
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.2);
      const mag = this.shake * this.shake * 14;
      this.shakeX = (Math.random() * 2 - 1) * mag;
      this.shakeY = (Math.random() * 2 - 1) * mag;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  // Add screen shake. amount is 0..1; big hits use ~0.5, deaths ~0.3.
  _addShake(amount) {
    this.shake = Math.min(1, this.shake + amount);
  }

  // A short straight line from a to b (world coords) in `color`. `life` is
  // the effect's remaining life (0..1 fraction), used to fade and shrink it.
  _line(a, b, color, life, width = 1) {
    const ctx = this.ctx;
    const pa = this._toScreen(a);
    const pb = this._toScreen(b);
    ctx.globalAlpha = life;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * (0.3 + life * 0.7);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // A circle at world `pos` with world `radius`, fading out as `life` falls.
  _ring(pos, radius, color, life, width = 1) {
    const ctx = this.ctx;
    const p = this._toScreen(pos);
    ctx.globalAlpha = life;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * (0.3 + life * 0.7);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * this.scale * (0.6 + life * 0.4), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // An arc of `radius` (world) swept between two angles, for cleave cones.
  _arc(pos, radius, fromAngle, toAngle, color, life, width = 1) {
    const ctx = this.ctx;
    const p = this._toScreen(pos);
    ctx.globalAlpha = life;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * (0.3 + life * 0.7);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * this.scale, fromAngle, toAngle);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Outline a unit body in `color`, fading with `life`. Reads only, never
  // mutates sim state. Used so an effect's colour reads directly on the unit.
  _outline(u, color, life, width = 2) {
    const ctx = this.ctx;
    const p = this._toScreen(u.pos);
    const s = u.size * this.scale;
    ctx.globalAlpha = life;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(p.x, p.y, s / 2 + 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Radial gradient glow helper (world coords).
  _glow(x, y, radius, color, alpha) {
    const ctx = this.ctx;
    const s = this._toScreen({ x, y });
    const r = radius * this.scale;
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Returns true only the first time a given effect is seen, so one-shot
  // particle bursts fire once per effect rather than every frame. Marks the
  // effect with a renderer-owned cosmetic flag (never read by the sim).
  _once(fx) {
    if (fx._fxDone) return false;
    fx._fxDone = true;
    return true;
  }

  // Debug overlay: shows each unit's current intent (what it's thinking), a
  // marker at its movement goal, and a line to its attack target. Toggled with
  // the D key. Reads sim state only; never mutates it.
  _drawDebug(sim) {
    const ctx = this.ctx;

    // A "member" is a player-controlled unit: the single-player team, or
    // either PvP team. These get the full utility-AI debug layers.
    const isMember = (u) => u.team === 'player' || (sim.pvp && (u.team === 'a' || u.team === 'b'));

    // Layer 1: aggro lines. Enemy -> member, red, width scaled by threat, so
    // you instantly see who is being focused or swarmed.
    if (this.showAggro) {
      for (const e of sim.enemyUnits) {
        if (!e.alive || !e.target || !e.target.alive) continue;
        const ep = this._toScreen(e.pos);
        const tp = this._toScreen(e.target.pos);
        const threat = e.threat.get(e.target.id) ?? 0;
        const alpha = Math.min(0.9, 0.25 + threat / 300);
        ctx.strokeStyle = `rgba(248,113,113,${alpha})`;
        ctx.lineWidth = 1 + Math.min(3, threat / 150);
        ctx.beginPath();
        ctx.moveTo(ep.x, ep.y);
        ctx.lineTo(tp.x, tp.y);
        ctx.stroke();
      }
    }

    for (const u of sim.units) {
      if (!u.alive) continue;
      const p = this._toScreen(u.pos);

      // Layer 2: confidence ring (member only). Green = bold, red = shaken.
      // Reads team morale at a glance.
      if (this.showConfidence && isMember(u)) {
        const c = u.confidence;
        const r = Math.round(255 * (1 - c));
        const g = Math.round(255 * c);
        ctx.strokeStyle = `rgba(${r},${g},80,0.9)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, u.size * this.scale / 2 + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Layer 3: backup radius (member only). Faint circle showing who is
      // "covered" by allies vs isolated.
      if (this.showBackup && isMember(u)) {
        const br = CONFIG.confidence.backupRadius * this.scale;
        ctx.strokeStyle = 'rgba(148,163,184,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, br, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Layer 4: safety direction arrow (member only, when retreating).
      if (this.showSafety && isMember(u) && u.safetyDir && (u.safetyDir.x !== 0 || u.safetyDir.y !== 0)) {
        const d = u.safetyDir;
        const len = 1.2 * this.scale;
        const ex = p.x + d.x * len;
        const ey = p.y + d.y * len;
        ctx.strokeStyle = 'rgba(250,204,21,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        // Arrowhead.
        const ang = Math.atan2(d.y, d.x);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang - 0.4) * 6, ey - Math.sin(ang - 0.4) * 6);
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang + 0.4) * 6, ey - Math.sin(ang + 0.4) * 6);
        ctx.stroke();
      }

      // Line to the attack target.
      if (this.showTargets && u.target && u.target.alive) {
        const tp = this._toScreen(u.target.pos);
        ctx.strokeStyle = u.team === 'player' ? 'rgba(251,191,36,0.7)' : u.team === 'a' ? 'rgba(96,165,250,0.7)' : 'rgba(248,113,113,0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(tp.x, tp.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Intent text above the unit.
      if (this.showIntent && u.intent) {
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        const tw = ctx.measureText(u.intent).width;
        ctx.fillRect(p.x - tw / 2 - 3, p.y - 22, tw + 6, 14);
        ctx.fillStyle = u.team === 'player' ? '#fbbf24' : u.team === 'a' ? '#60a5fa' : u.team === 'b' ? '#f87171' : '#f87171';
        ctx.fillText(u.intent, p.x, p.y - 11);
      }

      // Decision breakdown (member only): the utility-AI score for each
      // candidate action, so you can see WHY the member acted. The winner is
      // highlighted; the reason string explains the top contributing signal.
      if (this.showDecision && isMember(u) && u.decision) {
        const d = u.decision;
        const lines = d.candidates.map(c => {
          const mark = c.name === d.action ? '▶' : ' ';
          return `${mark}${c.name} ${c.score.toFixed(2)}`;
        });
        lines.push(`  ${d.reason}`);
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        const boxW = 120;
        const lineH = 12;
        const boxH = lines.length * lineH + 4;
        const bx = p.x + u.size * this.scale / 2 + 4;
        const by = p.y - 22;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.fillStyle = '#e2e8f0';
        lines.forEach((ln, i) => {
          const isWinner = ln.startsWith('▶');
          if (isWinner) ctx.fillStyle = '#4ade80';
          ctx.fillText(ln, bx + 4, by + 12 + i * lineH);
          if (isWinner) ctx.fillStyle = '#e2e8f0';
        });
      }
    }

    // Leader's current play, shown at the top of the room.
    if (sim.play) {
      const target = sim.units.find(x => x.id === sim.play.targetId);
      const label = sim.play.type === 'focus' ? 'Focus fire'
        : sim.play.type === 'backline' ? 'Focus backline'
        : sim.play.type === 'retreat' ? 'Retreat'
        : sim.play.type === 'hold' ? 'Hold the line'
        : sim.play.type === 'scatter' ? 'Scatter'
        : sim.play.type;
      const full = target
        ? `Play: ${label} → ${target.def.name || 'target'}`
        : `Play: ${label}`;
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const tw = ctx.measureText(full).width;
      const tl = this._toScreen({ x: 0, y: 0 });
      ctx.fillRect(tl.x + 8, tl.y + 8, tw + 10, 18);
      ctx.fillStyle = '#4ade80';
      ctx.fillText(full, tl.x + 13, tl.y + 21);
    }
  }

  _drawRoom(sim) {
    const ctx = this.ctx;
    const { width, height } = CONFIG.world;
    const tl = this._toScreen({ x: 0, y: 0 });
    const br = this._toScreen({ x: width, y: height });
    const w = br.x - tl.x, h = br.y - tl.y;

    // Floor.
    ctx.fillStyle = '#1a1a22';
    ctx.fillRect(tl.x, tl.y, w, h);

    // Walls.
    ctx.fillStyle = '#3a3a45';
    const wall = 0.5 * this.scale;
    ctx.fillRect(tl.x - wall, tl.y - wall, w + wall * 2, wall);          // top
    ctx.fillRect(tl.x - wall, br.y, w + wall * 2, wall);                 // bottom
    ctx.fillRect(tl.x - wall, tl.y, wall, h);                            // left
    ctx.fillRect(br.x, tl.y, wall, h);                                   // right

    // Doors (gaps in wall, colored outline).
    for (const door of [CONFIG.doors.entrance, CONFIG.doors.exit]) {
      const vertical = door.orientation === 'vertical';
      const d1 = this._toScreen({
        x: vertical ? door.x : door.x - door.width / 2,
        y: vertical ? door.y - door.width / 2 : door.y,
      });
      const d2 = this._toScreen({
        x: vertical ? door.x : door.x + door.width / 2,
        y: vertical ? door.y + door.width / 2 : door.y,
      });
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(d1.x, d1.y);
      ctx.lineTo(d2.x, d2.y);
      ctx.stroke();
    }

    // Obstacles.
    ctx.fillStyle = '#4a4a55';
    for (const o of CONFIG.obstacles) {
      const p = this._toScreen({ x: o.x, y: o.y });
      ctx.fillRect(p.x, p.y, o.w * this.scale, o.h * this.scale);
    }
  }

  _drawUnits(sim) {
    const ctx = this.ctx;
    for (const u of sim.units) {
      if (!u.alive) continue;
      const p = this._toScreen(u.pos);
      const s = u.size * this.scale;
      // Flash white when hit: the body colour lerps toward white, the mix
      // proportional to the damage taken relative to max health. A big hit
      // blazes bright; a small tick only tints.
      ctx.fillStyle = u.hitFlash > 0
        ? mixColor(u.def.color, '#ffffff', Math.min(1, u.hitFlash))
        : u.def.color;

      // Rotate the shape to face the unit's smoothed heading.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(u.facing ?? 0);

      switch (u.def.shape) {
        case 'square':
          ctx.fillRect(-s / 2, -s / 2, s, s);
          break;
        case 'triangle': {
          ctx.beginPath();
          ctx.moveTo(0, -s / 2);
          ctx.lineTo(-s / 2, s / 2);
          ctx.lineTo(s / 2, s / 2);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case 'circle': {
          ctx.beginPath();
          ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
          ctx.fill();
          // Cross for healers.
          if (u.def.attack && u.def.attack.type === 'heal') {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            const c = s * 0.25;
            ctx.beginPath();
            ctx.moveTo(-c, 0);
            ctx.lineTo(c, 0);
            ctx.moveTo(0, -c);
            ctx.lineTo(0, c);
            ctx.stroke();
          }
          break;
        }
      }
      ctx.restore();

      // Team ring in PvP: blue for team A, red for team B, so you can tell
      // who belongs to which side at a glance.
      if (sim.pvp && (u.team === 'a' || u.team === 'b')) {
        ctx.strokeStyle = u.team === 'a' ? 'rgba(96,165,250,0.9)' : 'rgba(248,113,113,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s / 2 + 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Taunted marker: orange ring around bats forced to target the tank.
      if (u.taunted) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s / 2 + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Shield: a cyan ring that shrinks as the barrier is worn down, with a
      // soft pulsing glow. A trailing arc sweeps around showing how much
      // charge remains.
      if (u.shield > 0 && u.shieldMax > 0) {
        const frac = Math.max(0, u.shield / u.shieldMax);
        const pulse = 1 + Math.sin(this._t * 6) * 0.05;
        const rr = (s / 2 + 4 + (1 - frac) * 3) * pulse;
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.stroke();
        // Remaining-charge arc.
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx.stroke();
        ctx.globalAlpha = 1;
        this._glow(u.pos.x, u.pos.y, u.size * 0.8, 'rgba(34,211,238,0.4)', 0.25);
      }

      // Stunned: a rotating yellow starburst over the unit. The starburst
      // slows down and pulls inward as the stun is about to wear off, so you
      // can read how much time is left.
      if (u.stunTimer > 0) {
        const STUN_MAX = 1.2;
        const left = Math.max(0, Math.min(1, u.stunTimer / STUN_MAX));
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2;
        const r = s / 2 + 5 + (1 - left) * -3;
        const rot = this._t * 3 * (0.4 + left * 0.6);
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2 + Math.PI / 4 + rot;
          ctx.beginPath();
          ctx.moveTo(p.x + Math.cos(a) * (r - 3), p.y + Math.sin(a) * (r - 3));
          ctx.lineTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
          ctx.stroke();
        }
        // Dizzy stars circling the unit.
        for (let i = 0; i < 3; i++) {
          const a = this._t * 4 + (i * Math.PI * 2) / 3;
          const sx = p.x + Math.cos(a) * (r + 4);
          const sy = p.y + Math.sin(a) * (r + 4);
          ctx.beginPath();
          ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Buffed: an orange ring that pulls inward as the damage bonus runs out.
      if (u.buffTimer > 0) {
        const left = Math.max(0, Math.min(1, u.buffTimer / 4));
        ctx.strokeStyle = '#fb923c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s / 2 + 4 + (1 - left) * 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Slowed: a pale blue ring that fades as the slow wears off.
      if (u.slowTimer > 0) {
        const left = Math.max(0, Math.min(1, u.slowTimer / 3));
        ctx.globalAlpha = 0.3 + left * 0.7;
        ctx.strokeStyle = '#93c5fd';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s / 2 + 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Burning: a flickering orange flame ring with rising embers. The ring
      // shrinks as the burn burns out, so you can see how long it has left.
      if (u.burn) {
        const BURN_MAX = 3.0;
        const left = Math.max(0, Math.min(1, u.burn.life / BURN_MAX));
        const flick = 0.8 + Math.sin(this._t * 20 + u.pos.x * 3) * 0.2;
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (s / 2 + 4) * flick * (0.4 + left * 0.6), 0, Math.PI * 2);
        ctx.stroke();
        this._glow(u.pos.x, u.pos.y, u.size * 0.9 * (0.5 + left * 0.5), 'rgba(249,115,22,0.45)', 0.3);
      }

      // Health bar.
      const bw = s * 1.2;
      const bh = 4;
      const by = p.y - s / 2 - 8;
      ctx.fillStyle = '#000';
      ctx.fillRect(p.x - bw / 2, by, bw, bh);
      const frac = u.hp / u.maxHp;
      ctx.fillStyle = frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#facc15' : '#f87171';
      ctx.fillRect(p.x - bw / 2, by, bw * frac, bh);

      // Mana bar (only for units that use mana, e.g. the healer).
      if (u.maxMana > 0) {
        const mby = by + bh + 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(p.x - bw / 2, mby, bw, bh);
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(p.x - bw / 2, mby, bw * (u.mana / u.maxMana), bh);
      }

      // Debug hover highlight: ring around the unit whose card is hovered.
      if (this.highlightId === u.id) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, s / 2 + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Speech bubbles: draw each active line above its speaker, fading out as it
  // expires. Reads sim state only; never mutates it.
  _drawBubbles(sim) {
    const ctx = this.ctx;
    for (const b of sim.bubbles) {
      const u = sim.units.find(x => x.id === b.unitId);
      if (!u || !u.alive) continue;
      const p = this._toScreen(u.pos);
      const alpha = Math.max(0, Math.min(1, b.life / 0.5));
      ctx.globalAlpha = alpha;
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      const tw = ctx.measureText(b.text).width;
      const bx = p.x;
      const by = p.y - u.size * this.scale / 2 - 20;
      // Bubble background with a small tail.
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      ctx.roundRect(bx - tw / 2 - 5, by - 12, tw + 10, 17, 3);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(bx - 3, by + 5);
      ctx.lineTo(bx + 3, by + 5);
      ctx.lineTo(bx, by + 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(b.text, bx, by - 1);
      ctx.globalAlpha = 1;
    }
  }

  // Find the living unit nearest to a world position (used to tint the unit
  // an effect is acting on). Reads sim state only; never mutates it.
  _unitAt(sim, pos) {
    let best = null, bestD = Infinity;
    for (const u of sim.units) {
      if (!u.alive) continue;
      const d = Math.hypot(u.pos.x - pos.x, u.pos.y - pos.y);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  // Map each effect type to a tiny fixed set of simple cues. Everything is a
  // line, ring, arc, or a colour change on the unit's outline/body, drawn once
  // and faded out as the effect's `life` expires. No particle systems.
  // magnitude() maps an effect's dmg/mag (absolute value) onto a 0..1 scale
  // that makes a small hit a tick and an execute a wide flare.
  _mag(fx) {
    const v = fx.dmg ?? fx.mag ?? 0;
    return Math.min(1, v / 40);
  }

  // Normalized remaining life (0..1) so primitives fade as the effect expires.
  _life(fx) {
    return Math.max(0, Math.min(1, fx.life / (fx.max || fx.life || 0.3)));
  }

  _drawEffects(sim) {
    for (const fx of sim.effects) {
      const m = this._mag(fx);
      const life = this._life(fx);
      const target = this._unitAt(sim, fx.to || fx.pos);
      switch (fx.type) {
        case 'attack':
        case 'pierce': {
          // A single line from attacker to target, in the attacker's colour,
          // scaled by magnitude. Fades with the effect.
          this._line(fx.from, fx.to, fx.color, life, 1 + m * 1.5);
          break;
        }
        case 'heal':
        case 'shield':
        case 'buff':
        case 'mana': {
          // A single line from caster to recipient + the recipient's outline
          // tints in the effect colour.
          const color = fx.type === 'heal' || fx.type === 'pierce' ? '#4ade80'
            : fx.type === 'buff' ? '#fb923c' : '#22d3ee';
          this._line(fx.from, fx.to, color, life, 1.25);
          if (target) this._outline(target, color, life, 1.5);
          break;
        }
        case 'taunt':
        case 'aoe':
        case 'push': {
          // A simple ring showing the area of influence, in the effect colour.
          const color = fx.type === 'taunt' ? '#f59e0b'
            : fx.type === 'aoe' ? '#fbbf24' : '#22d3ee';
          this._ring(fx.pos, fx.radius, color, life, 1);
          break;
        }
        case 'cleave': {
          // A single arc showing the cone's reach.
          const base = Math.atan2(fx.dir.y, fx.dir.x);
          this._arc(fx.pos, fx.range, base - fx.arc / 2, base + fx.arc / 2, '#f87171', life, 1);
          break;
        }
        case 'summon': {
          // A ring at the summoner + outline.
          this._ring(fx.pos, 1, '#c084fc', life, 1);
          if (target) this._outline(target, '#c084fc', life, 1.5);
          break;
        }
        case 'execute': {
          // A hard red ring + shake on a finisher.
          this._ring(fx.pos, 1 + m * 0.8, '#f87171', life, 1.5);
          if (this._once(fx)) this._addShake(0.2 + m * 0.2);
          break;
        }
        case 'burn': {
          // Outline tints orange on ignition; the persistent flame ring (drawn
          // on the unit body) carries the ongoing state.
          if (target) this._outline(target, '#f97316', life, 1.5);
          break;
        }
        case 'death': {
          // Expanding ring in the unit's colour, plus a hard shake.
          const u = this._unitAt(sim, fx.pos);
          if (u) {
            const prog = 1 - fx.life / 0.4;
            this._ring(fx.pos, u.size * (0.6 + prog * 1.4), fx.color, life, 1.5);
          }
          if (this._once(fx)) this._addShake(0.3);
          break;
        }
        case 'telegraph': {
          // Enemy windup: a red line that brightens as the hit is about to land.
          const prog = 1 - fx.life / CONFIG.combat.windupTime;
          this._line(fx.from, fx.to, 'rgba(248,113,113,0.8)', 0.3 + prog * 0.7, 1 + prog * 0.75);
          break;
        }
        case 'dodge': {
          // A pale line on the dodger, distinct from heal's green.
          if (target) this._outline(target, '#a7f3d0', life, 1.25);
          break;
        }
      }
    }
  }
}
