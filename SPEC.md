# Dungeon Autobattler — Build Spec

A 2D (top-down) autobattler prototype. Your team of 4 fights through a dungeon
room against a swarm of bats. Placeholder art is fine (colored shapes). The
goal is a playable, tunable prototype — not polish.

## Tech

- **Three.js** (or plain Canvas 2D — pick whichever is faster to get running).
- Single HTML file + JS modules is fine. No build step required unless it helps.
- **Deterministic simulation** separated from rendering. The sim runs on a
  fixed timestep (e.g. 30 Hz) and owns all game state. Rendering just reads
  sim state each frame and draws it. This makes the game replayable and
  balanceable later.

## Core architecture

Two layers, strictly separated:

1. **Sim layer** — pure data + logic, no rendering. Units, positions, HP,
   AI state machines, combat resolution. Runs in fixed timesteps.
2. **Render layer** — reads sim state, draws shapes. Never mutates sim state.

## The room

- A rectangular room with walls on all sides.
- **Obstacles** (pillars/rocks) scattered inside — they block movement and
  line-of-sight.
- **One entrance door** (top) and **one exit door** (bottom).
- The team enters through the entrance and must reach the exit.

## Win / lose

- **Win**: any team member reaches the exit door.
- **Lose**: all 4 team members die.

## Movement models (two separate systems)

### Ground units (your team)
- Pathfind on a **grid overlay** (e.g. 0.5m cells) using A*.
- Blocked by walls and obstacles.
- Funneled through doors.
- Steering: follow path + **separation** so units don't stack into one blob.

### Bats (flying)
- **Ignore the navmesh and obstacles entirely** — they fly over everything.
- Move with **boids**: separation + cohesion + seek toward target.
- They dive the backline (archer/healer), not the tank.

## The team — stats and behaviors

| Unit   | HP  | ATK | Range | Speed | Armor | Behavior |
|--------|-----|-----|-------|-------|-------|----------|
| Tank   | 300 | 15  | melee | slow  | high  | Hold chokepoint, taunt |
| Soldier| 180 | 30  | melee | med   | med   | Follow tank, focus-fire |
| Archer | 100 | 40  | long  | med   | none  | Max range, kite, lowest-HP target |
| Healer | 80  | 0   | med   | med   | none  | Stay back, heal lowest-HP ally |

(These numbers are starting points — tune freely.)

### Tank
- Moves to the nearest chokepoint (doorway) and **holds position**.
- **Taunt**: forces nearby enemies to target the tank for a few seconds.
- Body-blocks the door so bats can't flood past.

### Soldier
- Stays near the tank.
- **Focus-fires** the tank's current target.
- **Cleave**: hits all enemies in a small arc in front.

### Archer
- Keeps at max range.
- **Kites** (backs away) if an enemy gets close.
- Targets the **lowest-HP enemy** in range.
- **Piercing shot**: hits the first enemy and one behind it.

### Healer
- Stays behind the whole team, keeps distance from enemies.
- **Heals** the lowest-HP ally.
- **Healing generates threat** — bats notice and target the healer.

## Bats

- Low HP, low damage, fast, swarm in numbers.
- **Prefer squishy targets** (archer/healer) over the tank.
- Default to nearest target, but bias toward low-HP / backline units.

## Aggro / threat system

- Each unit tracks a threat value per enemy.
- Tank's taunt = force target (highest threat).
- Healer's heals add threat to the healer.
- Bats: nearest + bias toward low-HP/backline.

## AI state machine (per unit)

```
Idle → SeekTarget → MoveToRange → Attack → (repeat)
```

- **Idle**: no target, wait.
- **SeekTarget**: pick target by role rules (above).
- **MoveToRange**: pathfind/steer until in attack range.
- **Attack**: resolve damage on a timer (not on contact). Then re-evaluate.

Optional states: `Kite` (ranged units back off), `Retreat` (flee at low HP),
`Hold` (tank at chokepoint).

## Combat

- Tick-based, not contact-based. Attacks resolve on a per-unit cooldown timer.
- Damage = ATK − armor (min 1).
- Death removes the unit.

## The design tension (what makes it a game)

- Bats want to **bypass the tank** and kill the archer/healer.
- The tank's taunt + body-blocking is the only thing stopping them.
- The healer keeps the tank alive, but **healing draws aggro**.
- If any member dies, the formation collapses.

## Build order (do these in sequence)

1. Room + grid overlay + A* pathfinding. One unit walks entrance → exit.
2. Bats: boids swarm + dive a stationary target (prove both movement models coexist).
3. Tank holds the door, bats try to get past — **this is the make-or-break moment**.
4. Add soldier/archer/healer with the targeting table above.
5. Combat loop (HP, attacks, deaths, win/lose).
6. Tune: can the team actually reach the exit? Is the tank actually blocking?

## Hardest part (budget time here)

**The tank actually blocking the door.** If bats just fly over/around, the tank
is pointless. Make the door narrow enough that the tank's body + collision
blocks it, or give the tank a "block zone" that bats can't pass.

## Placeholder art

- Tank: large blue square.
- Soldier: medium red square.
- Archer: green triangle.
- Healer: white circle with a cross.
- Bats: small purple triangles.
- Walls/obstacles: dark gray rectangles.
- Doors: gaps in the wall, marked with a colored outline.
- Health bars above each unit.

## Controls (minimal)

- **Space** or a button: start the round (team auto-plays from there).
- **R**: reset/restart.
- Optional: click to place units before starting (skip if it slows you down —
  auto-place is fine for the prototype).

## Definition of done

- Team of 4 auto-plays through the room against a bat swarm.
- Tank holds the door, bats try to bypass, healer sustains, archer deals damage.
- Win (reach exit) and lose (all dead) both work.
- Runs in a browser with no install.
