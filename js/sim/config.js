// Central tunable configuration. Everything balance-related lives here so the
// prototype can be tuned without touching logic.

export const CONFIG = {
  // Simulation
  sim: {
    hz: 30,                 // fixed timestep (updates per second)
    maxSubSteps: 4,         // clamp catch-up steps per frame
  },

  // World geometry (in meters; 1 unit = 1 meter)
  world: {
    width: 24,
    height: 16,
    cellSize: 0.5,          // grid overlay cell size for A*
  },

  // Doors
  doors: {
    entrance: { x: 12, y: 16, width: 2 },  // bottom (team enters here)
    exit:     { x: 12, y: 0, width: 2 },   // top (advance to next level)
  },

  // Obstacles (pillars/rocks): axis-aligned rects {x, y, w, h}
  obstacles: [
    { x: 5,  y: 4,  w: 1.5, h: 1.5 },
    { x: 17, y: 4,  w: 1.5, h: 1.5 },
    { x: 5,  y: 10, w: 1.5, h: 1.5 },
    { x: 17, y: 10, w: 1.5, h: 1.5 },
    { x: 11, y: 7,  w: 2,   h: 2 },
  ],

  // Team unit definitions
  units: {
    tank:    { hp: 300, atk: 15, range: 1.2, speed: 2.2, armor: 8,  color: '#3b82f6', shape: 'square',   size: 0.9, name: 'Tank',    ability: 'Taunt' },
    soldier: { hp: 180, atk: 30, range: 1.2, speed: 3.0, armor: 4,  color: '#ef4444', shape: 'square',   size: 0.7, name: 'Soldier', ability: 'Cleave' },
    archer:  { hp: 100, atk: 20, range: 7.0, speed: 3.0, armor: 0,  color: '#22c55e', shape: 'triangle', size: 0.7, name: 'Archer',  ability: 'Piercing Shot' },
    healer:  { hp: 80,  atk: 0,  range: 5.0, speed: 3.0, armor: 0,  color: '#f8fafc', shape: 'circle',   size: 0.7, name: 'Healer',  ability: 'Heal' },
  },

  // Bat definition
  bat: {
    hp: 30, atk: 18, range: 0.8, speed: 4.5, armor: 0,
    color: '#a855f7', shape: 'triangle', size: 0.4,
    count: 8,               // base count for level 1
    countPerLevel: 4,       // extra bats added per level
  },

  // Boids parameters (bats)
  boids: {
    separationRadius: 0.8,
    separationWeight: 1.6,
    cohesionRadius: 2.5,
    cohesionWeight: 0.6,
    alignmentWeight: 0.3,
    seekWeight: 1.0,
    wallWeight: 2.0,
    maxForce: 12,
  },

  // Combat
  combat: {
    attackCooldown: 0.8,    // seconds between attacks
    minDamage: 1,
  },

  // Threat / aggro
  threat: {
    tauntDuration: 2.5,
    healThreat: 20,         // threat added to healer per heal
    backlineBias: 1.5,      // bats prefer squishy targets
    decayPerSec: 20,        // threat fades at this rate
  },

  // Healer
  healer: {
    healAmount: 25,
    healCooldown: 1.2,
    healRange: 6,
  },

  // Abilities
  abilities: {
    taunt: { cooldown: 3.0, radius: 6.0, threat: 200 },
    cleave: { arc: Math.PI * 0.6, range: 1.8, damage: 0.5 }, // fraction of ATK
    pierce: { range: 8.0, damage: 0.7 },                       // fraction of ATK to second target
  },

  // Team formation / behavior
  team: {
    separationRadius: 0.7,
    separationWeight: 2.0,
    tankHoldDistance: 1.5,  // tank holds near entrance
  },
};
