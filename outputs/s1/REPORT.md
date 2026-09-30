# S1 Motion Lab — report

Generated 2026-09-29 by `harness/s1/check.ts` from `outputs/s1/*.json`. DSIM pinned (`harness/dsim-pin.json`). All times are DSIM ticks at 60 Hz, shown in seconds.

## Gate

```
PASS  1 sysid REAL-v0: DSIM matches the drive model in all 6 step tests (speeds and translations to 1e-3; a full-rate spin's heading within one tick) — worst error 4.1e-4, spin heading 0.057 rad
PASS  1 sysid DREAM: DSIM matches the drive model in all 6 step tests (speeds and translations to 1e-3; a full-rate spin's heading within one tick) — worst error 5.2e-4, spin heading 0.064 rad
PASS  1 sysid REAL-v0-slow: DSIM matches the drive model in all 6 step tests (speeds and translations to 1e-3; a full-rate spin's heading within one tick) — worst error 5.1e-4, spin heading 0.041 rad
PASS  1 sysid REAL-v0-fast: DSIM matches the drive model in all 6 step tests (speeds and translations to 1e-3; a full-rate spin's heading within one tick) — worst error 6.1e-4, spin heading 0.070 rad
PASS  2 table REAL-v0: every one of 208 pairs arrived
PASS  2 table REAL-v0: no DSIM time beats its provable lower bound
PASS  3 table REAL-v0: every best time reproduced by its own re-run
PASS  2 table DREAM: every one of 208 pairs arrived
PASS  2 table DREAM: no DSIM time beats its provable lower bound
PASS  3 table DREAM: every best time reproduced by its own re-run
PASS  2 table REAL-v0-slow: every one of 208 pairs arrived
PASS  2 table REAL-v0-slow: no DSIM time beats its provable lower bound
PASS  3 table REAL-v0-slow: every best time reproduced by its own re-run
PASS  2 table REAL-v0-fast: every one of 208 pairs arrived
PASS  2 table REAL-v0-fast: no DSIM time beats its provable lower bound
PASS  3 table REAL-v0-fast: every best time reproduced by its own re-run
PASS  4 physics ordering on identical trips: slow ≥ nominal ≥ fast (on the same route, once top speed matters) — 0 slow wins, 0 fast losses; 1 hop too short for top speed to count (LZ->SHOOT_S_LZ)
PASS  4 48 sampled routes re-run from scratch: same time, no HIVE-frame contact, no impact over IMPACT_MAX, arrive within 1 in — 0 bad
PASS  5 REAL-v0: all 17 poses legal; shooting poses clear at every heading
PASS  5 DREAM: all 17 poses legal; shooting poses clear at every heading
PASS  5 REAL-v0-slow: all 17 poses legal; shooting poses clear at every heading
PASS  5 REAL-v0-fast: all 17 poses legal; shooting poses clear at every heading
PASS  6 envelope REAL-v0:north: every scoring spot is outboard of the up CELL — 978 scoring cells, 0 on the wrong side
PASS  6 envelope REAL-v0:north: scoring range within DSIM's launch limits (≈18–115 in + turret offset) — 21–87 in; 1485 placeable spots release a shot that misses (turret aims at the NEARER cell)
PASS  6 envelope REAL-v0:south: every scoring spot is outboard of the up CELL — 981 scoring cells, 0 on the wrong side
PASS  6 envelope REAL-v0:south: scoring range within DSIM's launch limits (≈18–115 in + turret offset) — 21–87 in; 1482 placeable spots release a shot that misses (turret aims at the NEARER cell)
PASS  6 envelope DREAM:north: every scoring spot is outboard of the up CELL — 956 scoring cells, 0 on the wrong side
PASS  6 envelope DREAM:north: scoring range within DSIM's launch limits (≈18–115 in + turret offset) — 21–87 in; 1438 placeable spots release a shot that misses (turret aims at the NEARER cell)
PASS  6 envelope DREAM:south: every scoring spot is outboard of the up CELL — 957 scoring cells, 0 on the wrong side
PASS  6 envelope DREAM:south: scoring range within DSIM's launch limits (≈18–115 in + turret offset) — 21–87 in; 1437 placeable spots release a shot that misses (turret aims at the NEARER cell)
PASS  6 envelope REAL-v0: north = mirror of south, at all but a few percent of the spots placeable in both — 3099 mirrored spots compared, 48 differ (1.5 %)
PASS  6 envelope DREAM: north = mirror of south, at all but a few percent of the spots placeable in both — 2937 mirrored spots compared, 46 differ (1.6 %)
PASS  7 spill north: all 40 runs tipped and spilled — elements spilled per tip: 7
PASS  7 spill south: all 40 runs tipped and spilled — elements spilled per tip: 7
PASS  7 spill: north and south rest centroids are mirror images (within 5 in) — (8.5, 67.5) vs (11.4, -65.4)
```

## Robots measured

| robot | top speed in/s | accel in/s² | turn rad/s | turn accel rad/s² |
|---|---|---|---|---|
| REAL-v0 | 81.5 | 233 | 8.35 | 33.3 |
| DREAM | 93.4 | 238 | 9.72 | 34.0 |
| REAL-v0-slow | 56.2 | 241 | 5.57 | 34.5 |
| REAL-v0-fast | 106.8 | 219 | 11.40 | 31.3 |

The drive model (DSIM's own `driveParams` + `motorStep`, power draw, and a measured 0.44-tick position lag) matches DSIM to < 1e-3 in and in/s in every step test. **Diagonal driving is slow**: mecanum sum saturation halves both axes, so a full diagonal runs at ~64 % of top speed. Strafe runs at 80 %.

## Travel times, REAL-v0 nominal (seconds, best found; row = from, column = to)

| from \ to | LZ | RLZ | F3R | F4R | F1R | F2R | GARDEN | SPILL_N | SHOOT_N | SHOOT_N_LZ | SPILL_S | SHOOT_S | SHOOT_S_LZ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A0** | 2.23 | 2.10 | 1.27 | 2.38 | 2.77 | 1.32 | 1.05 | 0.83 | 0.85 | 1.13 | 2.22 | 2.48 | 1.93 |
| **A1** | 0.98 | 2.93 | 1.85 | 0.80 | 2.25 | 2.52 | 1.95 | 2.32 | 2.52 | 1.73 | 1.17 | 1.07 | 0.90 |
| **A2** | 1.73 | 2.37 | 0.77 | 2.22 | 3.03 | 1.87 | 0.78 | 1.22 | 1.32 | 0.80 | 2.17 | 2.35 | 1.92 |
| **A3** | 0.78 | 3.23 | 1.72 | 1.12 | 2.32 | 2.83 | 2.22 | 2.43 | 2.58 | 1.95 | 1.20 | 1.28 | 0.85 |
| **LZ** | · | 3.18 | 1.33 | 1.23 | 2.28 | 2.75 | 1.95 | 2.03 | 2.22 | 1.50 | 1.25 | 1.35 | 0.28 |
| **RLZ** | 3.17 | · | 2.27 | 2.73 | 1.33 | 1.23 | 2.12 | 1.48 | 1.52 | 2.15 | 2.27 | 2.43 | 3.03 |
| **F3R** | 1.28 | 2.27 | · | 1.90 | 3.07 | 1.78 | 1.17 | 1.30 | 1.42 | 0.30 | 1.78 | 1.97 | 1.53 |
| **F4R** | 1.25 | 2.73 | 1.80 | · | 1.93 | 2.32 | 1.95 | 2.03 | 2.30 | 1.77 | 0.63 | 0.63 | 1.15 |
| **F1R** | 2.27 | 1.28 | 3.05 | 1.77 | · | 1.92 | 2.88 | 2.08 | 2.22 | 2.88 | 1.50 | 1.57 | 2.17 |
| **F2R** | 2.75 | 1.25 | 1.98 | 2.30 | 1.92 | · | 1.87 | 0.95 | 0.85 | 1.82 | 2.00 | 2.22 | 2.75 |
| **GARDEN** | 1.90 | 2.05 | 1.12 | 1.97 | 2.77 | 1.88 | · | 1.23 | 1.42 | 1.13 | 2.30 | 2.32 | 1.82 |
| **SPILL_N** | 2.38 | 1.60 | 1.50 | 2.22 | 2.12 | 1.02 | 1.23 | · | 0.43 | 1.38 | 2.12 | 2.12 | 2.27 |
| **SHOOT_N** | 2.13 | 1.67 | 1.55 | 2.25 | 2.35 | 0.87 | 1.50 | 0.12 | · | 1.38 | 1.97 | 2.20 | 2.13 |
| **SHOOT_N_LZ** | 1.38 | 2.23 | 0.30 | 1.92 | 2.97 | 1.80 | 1.15 | 1.27 | 1.40 | · | 1.80 | 1.97 | 1.55 |
| **SPILL_S** | 1.65 | 2.32 | 2.10 | 0.68 | 1.35 | 1.97 | 2.45 | 2.12 | 2.12 | 2.08 | · | 0.43 | 1.33 |
| **SHOOT_S** | 1.45 | 2.58 | 1.93 | 0.62 | 1.78 | 2.27 | 2.37 | 1.97 | 2.20 | 1.92 | 0.02 | · | 1.37 |
| **SHOOT_S_LZ** | 0.30 | 3.08 | 1.28 | 1.13 | 2.23 | 2.72 | 1.77 | 1.98 | 2.10 | 1.50 | 1.23 | 1.33 | · |

| robot | pairs | gap to provable lower bound |
|---|---|---|
| REAL-v0 | 208 | median 29%, 90th pct 46% |
| DREAM | 208 | median 26%, 90th pct 45% |
| REAL-v0-slow | 208 | median 38%, 90th pct 61% |
| REAL-v0-fast | 208 | median 20%, 90th pct 38% |

The lower bound ignores obstacles, heading and strafe (straight line at forward top speed with DSIM's own acceleration and braking budget), so part of every gap is geometry the bound cannot see, not controller slack.

## Key poses (REAL-v0)

| pose | x | y | heading° | what |
|---|---|---|---|---|
| A0 | 33.8 | 60.2 | -90 | DSIM start anchor (G304-legal, touches a wall) |
| A1 | 45.8 | -60.2 | 90 | DSIM start anchor (G304-legal, touches a wall) |
| A2 | 60.2 | 44.8 | 180 | DSIM start anchor (G304-legal, touches a wall) |
| A3 | 60.2 | -60.2 | 180 | DSIM start anchor (G304-legal, touches a wall) |
| LZ | 59.7 | -35.3 | 180 | back into blue LOADING ZONE (HP NECTAR drop, loose POLLEN, PARK) |
| RLZ | -59.7 | 35.3 | 0 | red LOADING ZONE (solo mode's free preloads) |
| F3R | 54.9 | 23.4 | 180 | back mouth on FLOWER F3 foot (POLLEN retrieval, approx.) |
| F4R | 23.4 | -54.9 | 90 | back mouth on FLOWER F4 foot (POLLEN retrieval, approx.) |
| F1R | -54.9 | -23.4 | 0 | back mouth on FLOWER F1 foot (POLLEN retrieval, approx.) |
| F2R | -23.4 | 54.9 | -90 | back mouth on FLOWER F2 foot (POLLEN retrieval, approx.) |
| GARDEN | 59.0 | 61.2 | 90 | front bumper toward blue GARDEN |
| SPILL_N | 9.0 | 57.0 | any | nearest turn-safe spot to where a north-cell spill rests (measured) |
| SHOOT_N | 8.0 | 56.0 | -84 | scoring spot for the north cell nearest its spill |
| SHOOT_N_LZ | 52.0 | 26.0 | -162 | scoring spot for the north cell nearest the loading zone |
| SPILL_S | 10.0 | -57.0 | any | nearest turn-safe spot to where a south-cell spill rests (measured) |
| SHOOT_S | 10.0 | -56.0 | 86 | scoring spot for the south cell nearest its spill |
| SHOOT_S_LZ | 56.0 | -36.0 | 152 | scoring spot for the south cell nearest the loading zone |

## Shooting envelope

- **REAL-v0:north**: 978 scoring spots on a 2 in grid; 1485 spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).
- **REAL-v0:south**: 981 scoring spots on a 2 in grid; 1482 spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).
- **DREAM:north**: 956 scoring spots on a 2 in grid; 1438 spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).
- **DREAM:south**: 957 scoring spots on a 2 in grid; 1437 spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).
- Scoring spots are always outboard of the up cell. A robot on the wrong half of the field wastes every shot: the S2+ controllers and the rule layer must stop firing there.

## Spill (where a tipped CELL's elements come to rest)

- North tip: centroid (8.5, 67.5); south tip: (11.4, -65.4). 7 elements spill per first tip (3 NECTAR + the POLLEN that tipped it + one more that entered before the release).
- Spill lands ~40–60 in outboard of the cell toward the rear/audience wall — far from the loading zone.

## Honest limits

- Times are for a robot alone on an empty field. Elements on the floor and other robots are S2/S3 concerns.
- FLOWER retrieval poses (F*R) are approximate docking spots; exact docking is an S2 skill.
- "Best found" is optimal within a 12-parameter controller family, tuned by cross-entropy search with every candidate scored in DSIM. The provable bound gives the remaining gap.
- The spill south case is staged the way DSIM stages a south-up cell (spawn.ts `cellNectar`), not reached by play; its mirror agreement with north is checked above.
