# S1 Motion Lab — report

Generated 2026-09-22 by `harness/s1/check.ts` from `outputs/s1/*.json`. DSIM pinned (`harness/dsim-pin.json`). All times are DSIM ticks at 60 Hz, shown in seconds.

## Gate

```
PASS  1 sysid REAL-v0: DSIM matches the drive model in all 6 step tests — worst error 3.6e-4
PASS  1 sysid DREAM: DSIM matches the drive model in all 6 step tests — worst error 4.2e-4
PASS  1 sysid REAL-v0-slow: DSIM matches the drive model in all 6 step tests — worst error 4.6e-4
PASS  1 sysid REAL-v0-fast: DSIM matches the drive model in all 6 step tests — worst error 3.2e-4
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
PASS  4 physics ordering on identical trips: slow ≥ nominal ≥ fast — 0 slow wins, 0 fast losses
PASS  4 48 sampled routes re-run from scratch: same time, no HIVE-frame contact, no impact over IMPACT_MAX, arrive within 1 in — 0 bad
PASS  5 REAL-v0: all 17 poses legal; shooting poses clear at every heading
PASS  5 DREAM: all 17 poses legal; shooting poses clear at every heading
PASS  5 REAL-v0-slow: all 17 poses legal; shooting poses clear at every heading
PASS  5 REAL-v0-fast: all 17 poses legal; shooting poses clear at every heading
PASS  6 envelope REAL-v0:north: every scoring spot is outboard of the up CELL — 1283 scoring cells, 0 on the wrong side
PASS  6 envelope REAL-v0:north: scoring range within DSIM's launch limits (≈18–115 in + turret offset) — 16–88 in; 1294 placeable spots release a shot that misses (turret aims at the NEARER cell)
PASS  6 envelope REAL-v0:south: every scoring spot is outboard of the up CELL — 1294 scoring cells, 0 on the wrong side
PASS  6 envelope REAL-v0:south: scoring range within DSIM's launch limits (≈18–115 in + turret offset) — 16–88 in; 1283 placeable spots release a shot that misses (turret aims at the NEARER cell)
PASS  6 envelope DREAM:north: every scoring spot is outboard of the up CELL — 1237 scoring cells, 0 on the wrong side
PASS  6 envelope DREAM:north: scoring range within DSIM's launch limits (≈18–115 in + turret offset) — 16–88 in; 1237 placeable spots release a shot that misses (turret aims at the NEARER cell)
PASS  6 envelope DREAM:south: every scoring spot is outboard of the up CELL — 1237 scoring cells, 0 on the wrong side
PASS  6 envelope DREAM:south: scoring range within DSIM's launch limits (≈18–115 in + turret offset) — 16–88 in; 1237 placeable spots release a shot that misses (turret aims at the NEARER cell)
PASS  6 envelope REAL-v0: north = mirror of south at every spot placeable in both — 3250 mirrored spots compared, 0 differ
PASS  6 envelope DREAM: north = mirror of south at every spot placeable in both — 3057 mirrored spots compared, 0 differ
PASS  7 spill north: all 40 runs tipped and spilled — elements spilled per tip: 7
PASS  7 spill south: all 40 runs tipped and spilled — elements spilled per tip: 7
PASS  7 spill: north and south rest centroids are mirror images (within 1 in) — (12.4, 57.5) vs (12.4, -57.3)
```

## Robots measured

| robot | top speed in/s | accel in/s² | turn rad/s | turn accel rad/s² |
|---|---|---|---|---|
| REAL-v0 | 81.5 | 233 | 8.35 | 33.3 |
| DREAM | 93.4 | 242 | 9.72 | 34.5 |
| REAL-v0-slow | 56.2 | 241 | 5.57 | 34.5 |
| REAL-v0-fast | 106.8 | 219 | 11.40 | 31.3 |

The drive model (DSIM's own `driveParams` + `motorStep`, power draw, and a measured 0.44-tick position lag) matches DSIM to < 1e-3 in and in/s in every step test. **Diagonal driving is slow**: mecanum sum saturation halves both axes, so a full diagonal runs at ~64 % of top speed. Strafe runs at 80 %.

## Travel times, REAL-v0 nominal (seconds, best found; row = from, column = to)

| from \ to | LZ | RLZ | F3R | F4R | F1R | F2R | GARDEN | SPILL_N | SHOOT_N | SHOOT_N_LZ | SPILL_S | SHOOT_S | SHOOT_S_LZ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A0** | 1.93 | 2.10 | 1.28 | 2.40 | 2.78 | 1.32 | 1.08 | 0.77 | 0.78 | 1.32 | 2.25 | 2.48 | 1.93 |
| **A1** | 1.00 | 2.97 | 1.90 | 0.75 | 2.27 | 2.52 | 1.98 | 2.28 | 2.48 | 1.58 | 1.12 | 1.08 | 0.93 |
| **A2** | 1.73 | 2.35 | 0.75 | 2.25 | 3.08 | 1.90 | 0.82 | 1.20 | 1.28 | 0.95 | 2.08 | 2.32 | 1.93 |
| **A3** | 0.77 | 3.25 | 1.72 | 1.08 | 2.33 | 2.87 | 2.35 | 2.37 | 2.50 | 1.62 | 1.18 | 1.28 | 0.85 |
| **LZ** | · | 3.20 | 1.33 | 1.25 | 2.30 | 2.75 | 1.88 | 1.95 | 2.15 | 1.23 | 1.23 | 1.45 | 0.23 |
| **RLZ** | 3.22 | · | 2.30 | 2.77 | 1.33 | 1.25 | 2.13 | 1.53 | 1.60 | 2.33 | 2.33 | 2.48 | 3.05 |
| **F3R** | 1.30 | 2.28 | · | 1.87 | 3.03 | 1.77 | 1.17 | 1.27 | 1.40 | 0.52 | 1.78 | 1.97 | 1.55 |
| **F4R** | 1.27 | 2.75 | 1.80 | · | 1.93 | 2.33 | 1.98 | 2.05 | 2.33 | 1.63 | 0.57 | 0.50 | 1.20 |
| **F1R** | 2.28 | 1.30 | 3.03 | 1.78 | · | 1.93 | 2.93 | 2.13 | 2.28 | 2.73 | 1.53 | 1.62 | 2.20 |
| **F2R** | 2.75 | 1.27 | 1.93 | 2.32 | 1.97 | · | 2.00 | 1.02 | 1.00 | 1.93 | 2.03 | 2.27 | 2.75 |
| **GARDEN** | 1.88 | 2.08 | 1.13 | 1.98 | 2.80 | 1.90 | · | 1.20 | 1.38 | 1.32 | 2.30 | 2.35 | 1.80 |
| **SPILL_N** | 2.30 | 1.38 | 1.48 | 2.28 | 2.17 | 1.07 | 1.18 | · | 0.45 | 1.52 | 2.13 | 2.03 | 2.23 |
| **SHOOT_N** | 2.05 | 1.77 | 1.53 | 2.28 | 2.40 | 0.95 | 1.48 | 0.02 | · | 1.50 | 2.00 | 2.25 | 2.03 |
| **SHOOT_N_LZ** | 1.17 | 2.63 | 0.53 | 1.87 | 2.88 | 1.83 | 1.35 | 1.38 | 1.50 | · | 1.67 | 1.83 | 1.33 |
| **SPILL_S** | 1.62 | 2.37 | 2.05 | 0.63 | 1.40 | 2.00 | 2.47 | 2.13 | 2.13 | 1.88 | · | 0.45 | 1.33 |
| **SHOOT_S** | 1.47 | 2.62 | 1.88 | 0.72 | 1.85 | 2.30 | 2.37 | 1.98 | 2.25 | 1.75 | 0.02 | · | 1.38 |
| **SHOOT_S_LZ** | 0.25 | 3.15 | 1.30 | 1.17 | 2.27 | 2.73 | 1.87 | 1.92 | 2.08 | 1.23 | 1.23 | 1.33 | · |

| robot | pairs | gap to provable lower bound |
|---|---|---|
| REAL-v0 | 208 | median 26%, 90th pct 44% |
| DREAM | 208 | median 24%, 90th pct 42% |
| REAL-v0-slow | 208 | median 34%, 90th pct 60% |
| REAL-v0-fast | 208 | median 19%, 90th pct 38% |

The lower bound ignores obstacles, heading and strafe (straight line at forward top speed with DSIM's own acceleration and braking budget), so part of every gap is geometry the bound cannot see, not controller slack.

## Key poses (REAL-v0)

| pose | x | y | heading° | what |
|---|---|---|---|---|
| A0 | 34.0 | 61.5 | -90 | DSIM start anchor (G304-legal, touches a wall) |
| A1 | 46.0 | -61.5 | 90 | DSIM start anchor (G304-legal, touches a wall) |
| A2 | 61.5 | 45.0 | 180 | DSIM start anchor (G304-legal, touches a wall) |
| A3 | 61.5 | -60.0 | 180 | DSIM start anchor (G304-legal, touches a wall) |
| LZ | 61.0 | -36.0 | 180 | back into blue LOADING ZONE (HP NECTAR drop, loose POLLEN, PARK) |
| RLZ | -61.0 | 36.0 | 0 | red LOADING ZONE (solo mode's free preloads) |
| F3R | 56.3 | 24.0 | 180 | back mouth on FLOWER F3 foot (POLLEN retrieval, approx.) |
| F4R | 24.0 | -56.3 | 90 | back mouth on FLOWER F4 foot (POLLEN retrieval, approx.) |
| F1R | -56.3 | -24.0 | 0 | back mouth on FLOWER F1 foot (POLLEN retrieval, approx.) |
| F2R | -24.0 | 56.3 | -90 | back mouth on FLOWER F2 foot (POLLEN retrieval, approx.) |
| GARDEN | 60.0 | 62.5 | 90 | front bumper toward blue GARDEN |
| SPILL_N | 12.4 | 57.5 | any | centroid of a north-cell spill (measured) |
| SHOOT_N | 12.0 | 58.0 | -89 | scoring spot for the north cell nearest its spill |
| SHOOT_N_LZ | 56.0 | 14.0 | -179 | scoring spot for the north cell nearest the loading zone |
| SPILL_S | 12.4 | -57.3 | any | centroid of a south-cell spill (measured) |
| SHOOT_S | 12.0 | -58.0 | 89 | scoring spot for the south cell nearest its spill |
| SHOOT_S_LZ | 58.0 | -36.0 | 153 | scoring spot for the south cell nearest the loading zone |

## Shooting envelope

- **REAL-v0:north**: 1283 scoring spots on a 2 in grid; 1294 spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).
- **REAL-v0:south**: 1294 scoring spots on a 2 in grid; 1283 spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).
- **DREAM:north**: 1237 scoring spots on a 2 in grid; 1237 spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).
- **DREAM:south**: 1237 scoring spots on a 2 in grid; 1237 spots where DSIM releases a shot that MISSES (it aims at the nearer cell, which is down).
- Scoring spots are always outboard of the up cell. A robot on the wrong half of the field wastes every shot: the S2+ controllers and the rule layer must stop firing there.

## Spill (where a tipped CELL's elements come to rest)

- North tip: centroid (12.4, 57.5); south tip: (12.4, -57.3). 7 elements spill per first tip (3 NECTAR + the POLLEN that tipped it + one more that entered before the release).
- Spill lands ~40–60 in outboard of the cell toward the rear/audience wall — far from the loading zone.

## Honest limits

- Times are for a robot alone on an empty field. Elements on the floor and other robots are S2/S3 concerns.
- FLOWER retrieval poses (F*R) are approximate docking spots; exact docking is an S2 skill.
- "Best found" is optimal within a 12-parameter controller family, tuned by cross-entropy search with every candidate scored in DSIM. The provable bound gives the remaining gap.
- The spill south case is staged the way DSIM stages a south-up cell (spawn.ts `cellNectar`), not reached by play; its mirror agreement with north is checked above.
