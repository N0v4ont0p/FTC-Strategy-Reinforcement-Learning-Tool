# BIOBUZZ AI — Routes, Strategy, AUTO & Alliance Play (plan v7, nothing built)

**Purpose.** A research and training tool for FTC 19859 Reflection. It answers what nobody knows
yet: the most efficient **routes, strategies, AUTO paths and alliance cooperation** in BIOBUZZ.
It then turns the answers into playbooks and practice that real drivers use.
Order: **SOLO first** (baseline, then teach), then DUO, then full 4-robot matches with defense.

## Decisions log

| date | decision |
|---|---|
| 2026-09-22 | runs 100% locally; full-time M6 Mac desktop, 24 GB (dev on M5 laptop, 10 cores) |
| 2026-09-22 | DSIM stays original; only small hooks; no rebuild, no forked physics |
| 2026-09-22 | no human replay corpus; learn from the sim plus our own planners |
| 2026-09-22 | solo → duo → 4-robot |
| 2026-09-22 | drivers use an **Xbox gamepad** (analog); DSIM runs in **Safari** |
| 2026-09-22 | real robot concept: **twin turret (POLLEN + NECTAR), hopper 4, NO FLOWER scoring, intake ONE side** |
| 2026-09-22 | **real robot not built or CAD-finished** → no measurements yet. Unknowns are RANGES; strategies must be robust across them; calibration comes after the build |
| 2026-09-22 | current focus: routes, strategy, cooperation, AUTO paths |
| 2026-09-22 | intake on the side OPPOSITE the shooter's default direction → **BACK intake** (turrets' home = front) |
| 2026-09-22 | drivetrain: **mecanum** (likely) → baseline; tank/swerve only as low-priority WHAT-IF |
| 2026-09-22 | real auto framework: **Pedro Pathing** → AUTO is optimized in Pedro's own path representation (§5.1) |
| 2026-09-22 | no competition deadline — goal is the best possible training, not a date (§14.4 #1) |
| 2026-09-22 | real robot: one operator, with a 1-operator and a 2-operator mode; **DSIM = 1 operator**. DSIM is used for **pathing and strategy**, not joystick skill → the human tier keeps reaction/decision limits; gamepad-ergonomics modeling is low priority (#11, §3) |
| 2026-09-22 | team practices little in DSIM → outputs must stand on their own: playbooks, AUTO, path cards (#15) |
| 2026-09-22 | downloads approved (#21); all other §14.4 defaults accepted; "full push": S-1 → S0 → S1 run back-to-back, each gate checked before the next |

Facts marked **(code)** were read from DSIM source on 2026-09-22 (zip snapshot, no git), and are
re-verified in S0 against the pinned copy.

---

## 0. "No mistakes" charter

1. **Truth = DSIM.** Every number comes from the real DSIM `step()` from tick 0.
2. **Measured optimality gap.** Every plan comes with an upper bound.
3. **Statistics.** ≥1,000 seeds per claim; mean / 5th percentile / worst; confidence intervals.
4. **Rule-clean.** Zero DSIM fouls + zero hits on our guard list (§7).
5. **Exploit-clean.** Physics-anomaly detectors on every match.
6. **Robust to unknowns.**
   - guessed game constants (§7.3)
   - the unbuilt robot's unknown performance (§2.3)
   - unknown partners (§6)
7. **Reproducible.** DSIM hash + profile id + seed + replay stored with every result.
8. **Honest labels.** Every output names its robot profile and flags any sim simplification it
   depends on.
9. **Fair play.** AI and filters run in local practice only — never online/ranked.

---

## 1. Robots

### 1.1 REAL-v0 — the team's concept (primary)

| field | value | status |
|---|---|---|
| launcher | twin turret: POLLEN turret + NECTAR turret | known |
| hopper | 4, shared POLLEN + NECTAR | known; S0 checks DSIM's coerced cap for a one-side intake is still 4 |
| FLOWER scoring | **none** (no Box Tube) | known |
| intake | sweeper, **one side: BACK** (opposite the shooter's default direction) | known |
| drivetrain | mecanum | likely; baseline |
| turret cells | a legal twin pair (code: front↔back, left↔right or diagonal; never centre or neighbours) — front/back assumed | WHAT-IF knob |
| RPM, mass, size | ranges (§2.3) | unknown until CAD |
| fire rate, aim time, intake time, accuracy | ranges (§2.3) | unknown until built |

### 1.2 DREAM — the current DSIM builder build (reference ceiling)
- mecanum 510 RPM
- twin turret (front / back)
- Box Tube at F·LEFT
- sweeper front+back
- 14.5 × 16 in, 24.1 lb, hopper 4

App card 96 in/s / 247 in/s² / 9.9 rad/s / 35.3 rad/s² matches the code formulas (cross-check
passed).

### 1.3 What REAL-v0 changes vs DREAM (code)
- **No FLOWER scoring at all.** Launched elements never enter a FLOWER (code). Every FLOWER point
  and the FLOWER endgame are gone for this robot.
- Score sources left:
  - LEAVE 3
  - PARK 5 + 5
  - HIVE TIPs, 20 each
  - elements left in the UP cell, 2 each
  - GARDEN, 1 each — only by pushing; ram-launching is guarded (§7)
- **FLOWER retrieval still works** (a mouth on the foot face pulls the bottom POLLEN every 0.35 s),
  so the 16 staged FLOWER POLLEN are a **POLLEN source** for this robot.
- NECTAR capable → the **HIVE recycling loop** applies: spilled NECTAR can be collected again, and
  more NECTAR per cell means fewer POLLEN per tip.
- **BACK intake** → collects only while reversing into elements. Every route plans heading as
  well as position: back toward elements, turrets aim independently.
  - Tests whether collect-then-shoot needs a turn at all. In DSIM, turret yaw is unlimited, so
    the answer depends on the real turret's yaw range (§2.3).
  - Mecanum strafe runs at 0.8× speed, so sideways approaches cost time and are weighed as such.
- **So REAL-v0 solo = the HIVE game.** Cycle time and NECTAR economy decide the score.

### 1.4 DSIM idealizations (apply to every profile)

| DSIM behavior | idealized how |
|---|---|
| shots | never miss (release only if they will land) |
| chassis velocity | not inherited → free shoot-on-move |
| intake | instant capture |
| turrets | no limits |
| robot mechanics | no randomness |

Handled by knob layers B/C (§2.2) and flagged on every output.

---

## 2. Robot profiles and tweaking

### 2.1 Profile families
- **REAL-vN:** the team's robot. v0 = concept + ranges; later versions calibrated.
- **DREAM:** the ceiling.
- **WHAT-IF:** design alternatives, e.g.
  - add Box Tube
  - front+back intake
  - single turret (POLLEN only)
  - hopper 3
  - RPM options
- **PARTNER / OPPONENT types:** for duo and 4-robot play (§6).

A profile = builder spec + command-filter settings + perturbation settings, each with an
uncertainty, versioned.

### 2.2 Knob layers (DSIM never forked)

| layer | what | watchable in DSIM | live driver practice |
|---|---|---|---|
| **A. Native builder** | drivetrain, RPM 200–600, mass, size, launcher kind, mounts, Box Tube or none, intake mount, hopper 1–4 | yes | yes |
| **B. Command filters** (harness) | speed caps, slew limits, fire-rate gating, aim/secure dwell, no shoot above v_fire, seeded intake dropouts, reaction delay | yes (filtered commands recorded) | with hook P1 (§10) |
| **C. State perturbations** (harness) | shot misses/dispersion, jams | numbers only, unless P2 (§10) | P2 only |

### 2.3 Design envelope — robot not built yet
Unknown values are ranges, not guesses:

| knob | range (v0, adjustable) | layer |
|---|---|---|
| drive RPM | 300–600 (covers common FTC gearings) | A |
| mass | DSIM floor for this build (~22 lb) – 42 lb | A |
| size | DSIM-legal envelope for twin turret + one-side intake | A |
| fire rate | 2–13 shots/s | B |
| aim/settle before first shot | 0–1.0 s | B |
| shoot while moving | allowed / capped at v_fire 0–40 in/s | B |
| intake secure time | 0–0.5 s at ≤ v_intake 10–60 in/s | B |
| intake success | 70–100% | B |
| shot accuracy | 60–100% | C |
| turret yaw range vs chassis | 180°–unlimited (real turrets are limited by wiring/stops; DSIM is unlimited) | B (fire blocked outside range) |
| turret slew | 2–7 rad/s | B (fire delayed until slewed) |
| turret cell pair | front/back, left/right, diagonal | A |
| driver reaction | 150–350 ms | B |

**Three uses, all available BEFORE the robot exists:**
1. **Robust strategy:** the playbook's routes and plans must hold across the whole envelope, or
   say exactly where they flip ("if fire rate < 4/s, switch to plan B").
2. **Global sensitivity analysis (Sobol indices):** which unknowns actually move the score, and
   which don't matter. This tells the build team where precision and effort pay off.
3. **Design targets + upgrade value:** points/match vs each capability, and the marginal value of
   WHAT-IF changes. For example: is a Box Tube worth adding for duo endgames? Is a second intake
   side worth it? Which RPM? The robot's design can be decided with numbers.

### 2.4 Calibration — later, once built
Test sheets:
- sprint / strafe / stop
- turn rate
- intake success at 3 speeds
- accuracy grid, standing and moving
- fire rate
- aim time
- human-player delay

→ Bayesian fit → held-out full-cycle drill must match the sim within ±10% → `REAL-v1`.
Measurement tools: odometry/IMU logs if available, 60/240 fps phone video otherwise. Every
REAL-v0 result gets re-checked on REAL-v1.

### 2.5 Profile-conditioned AI
- Planners are re-run per profile (hours).
- The learned agent trains across the envelope with the profile vector as input, then is
  fine-tuned per profile.
- A profile change never means starting over.

---

## 3. Driver model (Human-executable tier)

Every result has two tiers:
- **Oracle:** perfect 60 Hz input — the best possible.
- **Human-executable:** what a real driver can do — this is what gets taught.

Human-executable details:
- **Xbox gamepad:** AI stick outputs go through DSIM's own deadzone + expo curve (the driver's
  saved bindings) and 1/127 quantization.
- ~250 ms reaction, ≤ 10 Hz decisions, stick noise.
- **Thumbs:** left thumb = left stick OR D-pad; right thumb = right stick OR ABXY. The human-player
  button is on D-left (code), so pressing it releases the drive stick. Binding layouts are tested
  in the sim and the best one is recommended.
- **Human player is a separate person** in real FTC; modeled with their own cue delay. Gets their
  own card.
- **Drive-mode aids live in DSIM's client, not the sim (code, `game.ts`).** The harness emulates
  them exactly:
  - **flip front** (Y): reverses robot-centric drive, so a back-intake driver can make the intake
    "forward"
  - **park mode** (X): caps drive magnitude for precision
- **Drive modes are compared, not assumed:** field-centric vs robot-centric vs robot-centric +
  flip, in the human tier. For a back intake this is a real question: reversing into elements is
  where drivers lose time.

---

## 4. The solo game (code)

### 4.1 Field (144 × 144 in, origin centre, blue owns x > 0)

| element | position / details |
|---|---|
| HIVE pivots | (±12.75, 0), cells at y = ±13.37, opening at z 53.5–67.6 |
| HIVE colliders | only the frame bars; robots drive under the cells |
| FLOWERs | F1 (−69.46, −24), F2 (−24, 69.46), F3 (69.46, 24), F4 (24, −69.46) |
| blue LOADING ZONE | x 61–72, y −48…−24 |
| blue GARDEN | x 49–72, y 70–72 |
| start anchors | 4 per alliance; G304 enforced by our harness |

### 4.2 Elements and rules that shape REAL-v0 solo
- **Elements:** 40 POLLEN; 8 + 8 NECTAR.
- **Staging:** 4 POLLEN per FLOWER (a POLLEN source via retrieval) and 4 per GARDEN; 4 preloads;
  3 NECTAR in the staged UP cell; 5 NECTAR human-player stock.
- **Tip rule:** POLLEN ≥ `[8, 7, 6, 3, 1, 0][NECTAR]`. Rows 1, 2, 4 and 5 are unconfirmed.
- **Swing:** 4 s. Spill at 2 s. +20 at the end. The UP cell swaps sides.
- **Shooting position:** outboard of the UP cell, 18–115 in horizontal range. Turrets aim at the
  NEARER cell, so the robot must be on the UP side.
- **Human player:** +1 NECTAR owed per own tip; all remaining stock in the last 60 s. The last
  minute is NECTAR-rich, so tips get cheaper.
- **Solo quirk:** absent robots' preloads sit in the LOADING ZONEs. A "real-staging" solo variant
  runs without them, so habits don't depend on it.

### 4.3 Hypotheses (tested per profile, never assumed)
- **H1.** A tip in AUTO from preloads (3 staged NECTAR + 3 POLLEN).
- **H2.** Two tips in AUTO (spill recollect + human-player NECTAR).
- **H3.** TELEOP = tip → recollect → shoot loop. Cycle time decides the score.
- **H4.** Best POLLEN sources in order: spill vs ground vs FLOWER retrieval vs GARDEN (taking your
  own GARDEN's POLLEN costs 1 each).
- **H5.** Last-60 s NECTAR flood changes the loop — how.
- **H6.** Sensitivity of H1–H5 to the unconfirmed tip rows and to the §2.3 envelope.

---

## 5. AUTO program (priority)

AUTO is **deterministic until the first HIVE spill** (code: the seeded generator is used only by
spill scatter and human-player jitter). So AUTO is solved by **exact search**, not trial and error.

- **Solo AUTO, per start anchor (4 anchors):**
  - time-optimal paths (S1)
  - shot timing, turret pre-slew during driving, first tip
  - spill recollect, second tip if reachable
  - LEAVE + PARK
  - branch and bound over the action sequence → provably best under the model, with the gap stated
- **Alliance AUTO, per anchor pair and partner type:** joint two-robot plans.
  - Who shoots first (one HIVE is shared).
  - Who collects the spill.
  - Collision-free timing (conflict-based search).
  - G402: never be fully across mid-field in contact with an opponent.
- **Partner-compatibility matrix:** for each partner AUTO type, our best AUTO and the expected
  alliance points. Partner types:
  - does nothing
  - LEAVE+PARK only
  - 1 tip
  - strong
  - unknown

  Used in alliance talks before quals: "you run X → we run Y".
- **Robust across the envelope** (§2.3). An AUTO that only works if the robot turns out fast is
  flagged as such.
- **Outputs:**
  - watchable replays in DSIM
  - timing sheets
  - Pedro files (§5.1)
- Note: DSIM's `.pp` import is disabled for BIOBUZZ (`autoPaths: false`). Not needed — AUTO
  playback uses replays.

### 5.1 Pedro-native AUTO (what makes it transfer)
A free-form "optimal trajectory" is useless if Pedro can't follow it. So:

- **Search space = Pedro's own representation.**
  - Chains of BezierLine / BezierCurve segments (control points).
  - Per-segment heading interpolation (constant / linear / tangential).
  - Action events on the path (fire, intake on/off, wait for tip).
  - The optimizer moves control points and event timings, not raw commands.
- **Executed in DSIM by a Pedro-style follower** in our harness — drive vector, heading and
  centripetal correction, end-of-path hold. It drives the sim robot through ordinary
  `RobotCommand`s, so DSIM stays untouched and replays stay exact. The sim result is therefore
  what a Pedro follower achieves, not an ideal controller.
- **Follower gains + robot constraints (max power, braking) are envelope knobs** (§2.3). After
  the build they are replaced with the team's tuned Pedro constants.
- **Export:** `.pp` for the Pedro visualizer (visualizer.pedropathing.com) plus a Java
  path/sequence skeleton matching the event list.
  - Coordinates via the transform DSIM already uses (141.5 in Pedro field ↔ 144 in sim,
    `MatchSetup.tsx`).
  - Format and API checked against current Pedro docs (Context7) when the exporter is built —
    not from memory.
  - The round trip is tested: export → re-import → identical path.
- **Labeled sim-derived.** Re-verified on the real robot after the build (S-cal).

---

## 6. Cooperation (DUO) — planned now, built after solo

**Alliance economics (code):** both robots feed ONE HIVE whose UP cell swaps sides after every
4 s swing. The HIVE is the shared bottleneck, so cooperation = keeping it fed while the other
robot collects.

- **Two control modes:**
  1. **One brain, two robots:** the upper bound on teamwork.
  2. **Two cooperating brains:** MAPPO — trained together, each acting on its own. Realistic, since
     two teams can't share one controller.
- **Role structures to discover, not assume:**
  - both cycle
  - feeder + shooter
  - one handles spill-side recollect
  - one plays FLOWERs (only if the partner has FLOWER scoring)
  - defense later (§8)
- **Partner profiles** (WHAT-IF):
  - twin turret vs POLLEN-only single turret vs dumper
  - with / without Box Tube
  - fast / slow
  - reliable / flaky
  - passive
- **Partner-population training (Fictitious Co-Play):** trained with many partner types, so the AI
  adapts to a random qualification partner rather than only its twin.
- **Traffic:** collision-free timing between partners (conflict-based search). Congestion at the
  HIVE's outboard shooting side is modeled explicitly.
- **Outputs:**
  - **Alliance playbook:** "if partner can X, we do Y", per role
  - joint AUTO matrix (§5)
  - handoff rules (who takes spill, who takes the human-player NECTAR)
  - practice with an AI partner in DSIM (hook P1)

---

## 7. Rule guards — what DSIM doesn't enforce, so we do

### 7.1 DSIM enforces (code)
- G410, G402, G421 (pins)
- G407 as a warning only
- structural blocks on G408, G418, G426, G403 and G404

### 7.2 Our guard list

| guard | rule | why it's needed |
|---|---|---|
| start pose legal | G304 | call `bbActiveStartLegal` |
| no HIVE frame contact | G417 | disabled in DSIM |
| no spill capture within 0.4 s | G409 | a 25 in drop takes ~0.36 s; DSIM grounds spill instantly |
| ≤ 4 controlled incl. herded | G407 | treated as MAJOR |
| no ram-launching elements | G405 / exploit | DSIM lets struck POLLEN hit 90 in/s |
| human player during AUTO | G426 / G401 | verify against the manual text before allowing |
| AUTO is a planned routine, no driver | G401 | — |

### 7.3 Guessed constants → sensitivity sweeps
- tip rows 1, 2, 4, 5
- `BB_FLOWER_MID_Z` (duo partners with FLOWER scoring)
- spill speed and fan
- HIVE x (APPROX)
- zone and garden edges (APPROX)
- CELL accept radius

Re-run on each Team Update.

### 7.4 DSIM physics oddities → anomaly detectors
- chassis drives through a pinned POLLEN
- persistent 2.1 in overlap
- struck POLLEN faster than the robot that hit it
- ball "trains"
- frictionless held balls

---

## 8. Stages and exit gates

| stage | build | gate |
|---|---|---|
| **S-1 feasibility check** | prove the environment before building anything — steps and pass criteria in §14.2 | every §14.2 check passes, or the plan is revised before S0 |
| **S0 harness** | pin DSIM + hash; headless runner (`initPhysics` → `createBiobuzzWorld` → set `match.preCountdown` → `biobuzzStep` 1/60); explicit assists; `localizeCommand` quantization; layer-B/C framework; profile loader (REAL-v0, DREAM); snapshot/restore via `structuredClone(world)` (proven in S-1); benchmark; replay viewing via `decodesim.practice.v1`; read driver settings from Safari (below) | exact replay re-run; 10k random matches with no crash; coerced REAL-v0 spec = intended; matches/hour |
| **S1 motion** | drivetrain system-ID across the RPM/mass envelope; time-optimal paths (CasADi/IPOPT); travel-time tables; shooting-envelope map; one-side-intake heading-aware sweep routing | every entry confirmed in DSIM |
| **S2 skills** | drive-to-pose, collect (one-side), shoot, FLOWER retrieval, park, human-player timing | ≥ 99% success (95% CI) at each envelope corner |
| **S3 solo AUTO + planner** | exact AUTO per anchor (§5); TELEOP MCTS planner; upper bounds; Sobol sensitivity | ≥1,000 seeds; gaps stated → **Solo Playbook v0 + AUTO v0** |
| **S4 learned solo** | profile-conditioned transformer policy; DAgger → PPO + population-based training; decision-time search | beats S3 at 95% confidence; robust across the envelope |
| **S5 duo AUTO + duo planner** | joint AUTO matrix; partner types; role discovery | **Alliance Playbook v0** |
| **S6 learned duo** | MAPPO + one-brain upper bound; partner-population training; hook P1 for AI-partner practice | robust to unseen partner types |
| **S7 4-robot** | self-play league + exploiters; PSRO equilibrium; legal defense; opponent profiles | low and falling exploitability; zero penalties |
| **S-cal (after build)** | measure → REAL-v1 → re-verify every playbook | drill match ±10% |

**Reading driver settings in Safari (S0):** Safari Settings → Advanced → enable "Show features for
web developers" → open DSIM → Develop → Show Web Inspector → Console:
`copy(localStorage.getItem('decodesim.settings.v1'))`, then paste into
`profiles/dsim-settings.json`. That gives the bindings, deadzone/curve and assists. The robot for
training is defined by the profiles, not by this file.

---

## 9. What drivers get
1. **AUTO sheets + replays** per start anchor, solo and per partner type; `.pp` waypoints.
2. **Solo and Alliance playbooks:** readable decision trees (VIPER) — e.g. "tip → human player
   enters NECTAR → recollect spill on the south side".
3. **Path cards:** routes, times, shooting envelopes, heading plans for the one-side intake.
4. **Cycle breakdown:** where every second goes, AI vs driver.
5. **Binding recommendation + human-player card.**
6. **Practice loop:** drills on the biggest gaps → segments → full matches; ghost runs; AI partner
   (P1).
7. **Driver scorecard:** local practice runs (`decodesim.practice.v1`) re-simulated and compared to
   the AI, tracked over time.
8. **Build team report:** Sobol sensitivity, design targets, upgrade value table (§2.3).

---

## 10. Attaching to DSIM (no rebuild)

```
FTC Sim autonomous/
  dsim-main/          original, pinned
  BIOBUZZ_..._V1.pdf  rules
  PLAN.md             this
  (later) profiles/   REAL-vN, DREAM, WHAT-IF, PARTNER/OPPONENT + dsim-settings.json
  (later) harness/    Node: DSIM workers, filters, perturbations, guards, detectors
  (later) brain/      Python: planners, RL, search, evaluation
  (later) outputs/    playbooks, AUTO sheets, .pp files, replays, reports
```

- **Training/evaluation: zero DSIM edits.**
- **P1 — command-filter hook (small, off = byte-identical, needed from S6):** every local robot
  command (human or AI) can pass through our function before `step()`. Gives AI partners AND
  REAL-profile limits for human practice. Local modes only.
- **P2 — seeded shot-dispersion hook (optional):** only if the §2.3 sensitivity shows accuracy
  changes the strategy.
- **Stack:**
  - Node 22 via nvm (DSIM's build version: `Dockerfile` uses node:22, CI uses 20); Node 25.9 only if S-1 shows it works
  - Python 3.13 + PyTorch (MPS); 3.12 via pyenv if a package lacks 3.13 wheels (S-1 checks)
  - OR-Tools, CasADi/IPOPT
  - ONNX or socket bridge (S0 benchmark decides)

---

## 11. Compute
- **Solo:** 0.0245 cores in real time → ~40× real time per core → ~9,000 matches/hour on 10 cores.
- **2v2:** ~29× real time per core.
- The envelope multiplies runs ~2–5×; exact planners are cheap.
- The M6 running full time covers S7.
- **These are ESTIMATES.** DSIM's figure was measured on an unspecified laptop (`HANDOFF.md`) and
  includes snapshot serialization. The M5 has 4 performance + 6 efficiency cores, and the
  efficiency cores are slower. S-1 measures the real rate on this Mac, and again on the M6.

---

## 12. Risks
1. **Robot unknown** → envelope + robust plans now; S-cal re-verifies later. Plans that only win
   at the envelope's fast end are labeled as such.
2. **Unconfirmed tip rows** → sweeps; re-run on Team Updates.
3. **Sim idealizations** (no misses, instant intake) → layers B/C + two tiers.
4. **DSIM updates** → pinned snapshot.
5. **Solo is a practice construct** → real-staging variant; duo is the real target.
6. **Private season + noncommercial license** → nothing published without DSIM owner's OK.
7. **Environment** (Node/Python versions, the Rapier wasm engine under Node, import boundaries) →
   proven in S-1 before any build.

---

## 13. Open questions
See **§14.4**. 29 questions with proposed defaults; answers are recorded there before S-1 starts.

---

## 14. Final pre-build check (2026-09-22)

Status key:
- **code-read:** confirmed by reading DSIM source, not yet run
- **untested:** plausible, never tried
- **S-1:** proven or disproven by the feasibility check (§14.2)

### 14.1 Can the tool control every part of DSIM?

| aspect | control | how | status |
|---|---|---|---|
| robot inputs | **full** | every `RobotCommand` field BIOBUZZ reads (listed below), sent as `Map<robotId, RobotCommand>` into `biobuzzStep` each tick | code-read → S-1 |
| match setup | **full** | seed, specs, assists, start anchor or pose, robot count and alliances via `createBiobuzzWorld(mode, seed, setups)` — DSIM's own smoke tests build matches this way | code-read → S-1 |
| match phases / clock | **full** | set `match.preCountdown`, or force the phase as `scripts/smoke-biobuzz/field.ts` does | code-read |
| reading state | **full** | `World` is plain JSON: robots, all 56 elements, HIVEs, FLOWERs, score, fouls, `rngState` | code-read |
| snapshot / restore | **full (likely)** | `structuredClone(world)`. Why it should be complete: physics builds a FRESH Rapier world every step and frees it (`src/sim/physicsEngine.ts` header); the seeded RNG lives in `world.rngState` (`play.ts` `nextRandomValue`); button-edge memory lives in `world.biobuzz.held`; DSIM already clones worlds this way (`scenes.ts`: "a structural clone is complete") | code-read → **S-1: clone at tick t, run clone and original with the same commands, must stay identical** |
| editing state mid-match (layer C, custom scenarios) | **full (likely)** | mutate `World` between steps; physics re-reads it next step | code-read → S-1. Command-only replays can't reproduce edits (§2.2) |
| flip front, park mode | **emulated** | they live in DSIM's client (`game.ts`, `frameLogic`), not the sim; the harness copies the logic exactly | code-read |
| gamepad shaping | **emulated** | copy of `shape()` in `src/input/gamepad.ts` (deadzone + curve) using the driver's saved values | code-read |
| physics and rules | **none, by design** | DSIM stays original | — |
| shot misses | **only via layer C or P2** | DSIM never releases a shot that won't land | code-read |
| live DSIM app in Safari | **none** | my screen-control tool can only *view* browsers (no clicks or typing); live AI control needs P1 + DSIM's local dev server | — |
| BIOBUZZ in a local app | **likely** | `VITE_APP_CHANNEL=alpha npm run dev` (`src/seasons.ts`, `appChannel()` in `src/net/env.ts`); no code change | untested → S-1 |
| watching AI replays in DSIM | **likely** | write into `decodesim.practice.v1` storage (`src/net/practiceRuns.ts`) and open from Career; versions must match (balance 4, sim 2) | untested → S-1 |
| online / ranked play | **never** | fair play (§0.9) | — |

BIOBUZZ `RobotCommand` fields:
- `driveX`, `driveY`, `rotate`
- `leftDrive`, `rightDrive` (tank only)
- `intake`, `fire`
- `bbPlace`, `bbPlaceNectar` (Box Tube profiles)
- `bbNectar` (human player)
- `driveMode` (butterfly only)

### 14.2 Can it run locally, smoothly, controlled by the tool?

**Evidence for:**
- DSIM's own BIOBUZZ tests run headless (`scripts/smoke-biobuzz/harness.ts`; `index.ts` awaits
  `initPhysics()`).
- DSIM measured 0.0245 cores per solo room and 0.0345 per 2v2 in real time (`HANDOFF.md`, on a
  laptop — not ours).

**Not yet verified:**
1. **Dependencies are not installed** (no `node_modules`). devDependencies include `electron` ^43
   and `electron-builder` (a large binary download). Electron isn't needed, so install with
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.
2. **Node version.** No `engines` field. `Dockerfile` builds on node:22, CI release uses Node 20;
   this Mac has 25.9.0. Fallback: Node 22 via nvm (already installed).
3. The **Rapier wasm engine** (`@dimforge/rapier2d-compat` 0.19.3) starting under Node/tsx
   outside DSIM's own scripts.
4. **Import boundary.** Some modules read `import.meta.env` and only work inside Vite
   (`src/net/env.ts`, `src/seasonVisibility.ts`). The harness must import sim-side modules only
   (`src/games/sim.ts` is DSIM's server-safe registry).
5. **Speed on this Mac.**
6. **Replay → practice storage → Career playback.**
7. **BIOBUZZ visible in the local dev server** with `VITE_APP_CHANNEL=alpha`.
8. **Python stack on 3.13:** PyTorch (MPS), OR-Tools, CasADi/IPOPT wheels. Fallback: 3.12 via
   pyenv (already installed).

**S-1 feasibility check.** All short one-shot commands; nothing long-running.

| # | step | pass criterion |
|---|---|---|
| a | copy `dsim-main` → pinned snapshot, record hash | hash recorded |
| b | `npm install` with the Electron download skipped | installs cleanly on Node 25, or on Node 22 |
| c | run DSIM's own `npm test` | green (the environment is sound) |
| d | one headless BIOBUZZ solo match, REAL-v0 spec, scripted commands (drive, intake, fire, human player) | match reaches `post`; score and fouls read correctly |
| e | coerced spec check | DSIM's coerced spec = the intended REAL-v0 (hopper 4, no Box Tube, back intake, twin turret) |
| f | record replay → `verifyReplay` | identical re-run |
| g | clone at a random tick → continue both | identical to the end |
| h | benchmark: 1 core, then N workers | matches/hour recorded for M5 |
| i | local dev server with the alpha channel, in the built-in browser pane; inject a replay into practice storage | BIOBUZZ visible; replay plays and matches |
| j | Python imports + a tiny solve in each library | all import and run |

**Fail on any step** → stop, report, and revise the plan before S0. Nothing is built on an
unproven base.

**S-1 RESULT (2026-09-22): PASS.** Run on the M5, Node 25.9.0, Python 3.13.5.

| # | outcome |
|---|---|
| a | pinned: 612 files, tree sha256 `69dbcc6d…767a` (`harness/dsim-pin.json`); re-hashed after install, unchanged |
| b | `npm ci` with the Electron download skipped. The network dropped connections (~300 KB/s); succeeded after retries with 3 sockets. `package-lock.json` untouched |
| c | DSIM `npm test` on Node 25: exit 0; "1308 CHECKS, ALL PASS" (BIOBUZZ suite) + the DECODE/CR suite; 3,128 PASS lines, 0 FAIL, 92 s. Node 22 fallback not needed |
| d | scripted REAL-v0 solo match reached `post` and settled (9,756 ticks); blue 48 points, 2 TIPs, 0 fouls. A dumb script already tips twice |
| e | coerced REAL-v0 = intended: twin turret front/back, `lift: null` (no Box Tube), intake `back`, hopper 4, mecanum. `intake` style coerced to `sloped` |
| f | replay → `verifyReplay`: score, world hash and tick count identical |
| g | `structuredClone` at tick 4000 (TELEOP), both copies continued: full-JSON identical, and equal to an uninterrupted run. Same seed twice → identical world. **Snapshot/restore for search is PROVEN** |
| h | one process: **~129× real time** (1.2 s per full match). 4 procs 9,545/h, **8 procs ~12,300 matches/h**, 10 procs 11,600/h (efficiency cores + ~1 s tsx start-up per process). Persistent workers will do better |
| i | `VITE_APP_CHANNEL=alpha` local dev server: BIOBUZZ visible. Harness replay injected into `decodesim.practice.v1` → listed in Career → Watch → **FINAL 31 = harness 31**. AI runs are watchable in unmodified DSIM |
| j | numpy 2.5.3, scipy 1.18.1, CasADi 3.8.1 (IPOPT min-time test exact: T = 2.0000 s), OR-Tools 9.15 (CP-SAT optimal). **PyTorch deferred to S4** (127 MB, not cached) |

**Findings to carry forward:**
- **Two assist records exist.** The coerced spec carries its own `spec.assists` (`autoIntake: true`) next to the setup's `assists` (`autoIntake: false`). S0 must verify which one the sim uses and set both explicitly.
- **Solo red score is non-zero** (10) from staged GARDEN/zone elements. Record score = blue total − red's foul points; red's points are irrelevant.
- **Downloads:** one package per command, only what the next stage needs (user's internet went down on a batched install).

**S0 RESULT (2026-09-22): PASS — 38/38 checks** (`harness/s0-check.ts`, log `outputs/s0/s0-gate.log`).
Harness: `harness/{dsim,profiles,filters,perturb,guards,control,export,pool,worker,jobs,pin,geom,rng}.ts`, profiles `profiles/{real-v0,dream}.json`. `dsim.ts` is the ONLY file that imports DSIM.

| area | proven |
|---|---|
| pin | re-pinned 610 files (`a95f38ea…`): now skips `.impeccable/` (a design-tool hook writes a cache into dsim-main) and symlinks (9 skill links). Verified by mtime that nothing else changed |
| profiles | REAL-v0 and DREAM coerce exactly as asked; 300 envelope samples, zero silent clamps. DSIM-legal REAL-v0 envelope: L 13.5–15, W 14.5–17, RPM 200–600, mass ≥ 21.3 |
| assists | the SIM reads the setup's assists (`spawn.ts` 807–810); `spec.assists` is UI-only |
| layer B | at DREAM limits + no rule holds it is an exact identity (full JSON); every gate unit-tested: intake speed/dwell/failure, fire speed/settle/rate, turret travel + slew, human-player delay / AUTO hold / G427 C hold with 2-tick lookahead, driver reaction + 10 Hz hold |
| replays | filtered + human-tier runs replay bit-exact in DSIM; exported file re-verifies |
| layer C | miss = vertical speed capped so the apex stays under the CELL opening (certain at any range). **Scaling horizontal speed was tried first and scored 2 of 4 "misses"** — DSIM's descending accept window is long. Forced-miss counts match sampled accuracy within 3σ (2,380 vs 2,345 ± 124) |
| guards | each rule verified to fire AND not to fire on the legal twin: G417 frame contact, G409 (HIVE spills only, not landed shots), G407, G426, G427 C |
| determinism | same seed with every layer on → identical world |
| crash test | 800 random-agent matches on sampled robots: all settle, 56 elements, finite, zero invalid-state; ~9–12k matches/hour on 8 persistent workers |

**DSIM physics oddities, measured (informational; a strategy must not profit from them):**
- A struck ball faster than ANY point of the robot (speed + spin × corner radius) by > 10 in/s occurs ~18× per random match, mostly a ball squeezed between robot and wall, ejected at DSIM's 90 in/s cap (feedback 000 #3). The first two detector versions over-counted (absolute threshold; centre speed ignoring spin) — fixed and tested.
- A ball > 1 in inside a solid chassis face for ≥ 0.5 s occurs ~1.7× per random match, up to ~3 in overlap (feedback 000 #2 reports ~2.1 in).

**Decisions made in S0:**
- Human-player entry in AUTO: held until TELEOP by default (G401 "indirectly interact" ambiguity); a switch exists, and its value is reported separately.
- G427 C enforced in the filter: no human-player entry while any robot covers or is about to cover the drop area.
- The plan's 10k-match crash test ran as 800 here (short-command rule); a 10k run is one command for the user's terminal: `dsim-main/node_modules/.bin/tsx harness/s0-check.ts --matches 10000`.

**S1 RESULT (2026-09-22): PASS — every gate check** (`harness/s1/{drive,sysid,lab,paths,jobs,run,check}.ts`; data and full report in `outputs/s1/`, `outputs/s1/REPORT.md`).

- **Drive model = DSIM**, to < 5e-4 in and in/s in every step test (forward, reverse, strafe, diagonal, half stick, spin) for all 4 robots. It uses DSIM's own `driveParams` + `motorStep` + power draw, plus one measured constant: DSIM's position trails by 0.44 tick.
- **Travel-time table:** 17 key poses × 4 robots (REAL-v0 nominal / slow corner / fast corner, DREAM) = 832 trips, all arriving.
  - Every trip is DSIM-measured, re-run identically, and at or above a provable lower bound (median gap 19–34%).
  - Slow ≥ nominal ≥ fast holds on every identical trip.
  - Routes are seeded by a visibility-graph planner (both HIVE legs, 4 FLOWER feet), then tuned by cross-entropy search scored in DSIM, and cross-seeded between robots.
  - REAL-v0 median trip 1.93 s, longest 3.27 s.
- **Shooting envelope:** 2-in grid, both cells, REAL and DREAM. ~1,280 scoring spots per cell, all outboard of the up cell, and north = exact mirror of south wherever both are placeable (3,250 spots, 0 differ). About the same number of spots release a shot that MISSES, because DSIM aims at the nearer cell.
- **Spill:** 80 real tips; 7 elements spill per first tip, resting around (12.4, ±57.4); north/south mirror within 1 in.

**Mistakes the S1 gate caught and fixed (kept here so they are not repeated):**
1. System-ID start points drove into walls → placements chosen so the motion stays clear.
2. The heading controller limit-cycled at ±0.39 rad/s against DSIM's 1/127 stick quantization → brake-aware heading profile + 0.3° deadband.
3. Travel jammed on FLOWER feet and walls (29/208) → perpendicular depart/approach points, visibility-graph seeding, up to 4 waypoints, corridor starts.
4. A shooting pose was picked beside a FLOWER foot and the robot could not turn there → shooting poses must be clear at every heading.
5. **The "provable" bound was beaten by crashing into walls.** DSIM stops a robot dead at any speed → trips may not hit anything above 20 in/s (`IMPACT_MAX`), and the bound for wall-adjacent goals only asks for ≤ 20 in/s there.
6. **The envelope depended on the turret's leftover yaw** (43 north-only spots) → the turret settles 1 s before every measurement; now mirror-exact.
7. A stale reference to DSIM's HIVE state (DSIM replaces `hives[a]` every tick) → read fresh.

### 14.3 Is the whole pipeline planned, with room to keep improving?

**Planned:**
- layers L1–L5
- stages S-1 → S7 + S-cal, each with a gate
- robot profiles and knob layers A/B/C
- design envelope
- driver model
- rule guards and anomaly detectors
- Pedro-native AUTO
- outputs

**Deliberately decided by experiment at each stage start** (fixing them now would be guessing):
- reward weights and shaping schedule
- network sizes
- hyperparameters
- the exact decision rate (10–15 Hz)
- the macro-action set
- search budgets
- league composition
- refined envelope ranges

**Improvement loops (they keep running while there is measurable room left):**
1. **Expert iteration** (AlphaZero-style): search over DSIM clones improves the network; the
   network makes search faster and deeper; repeat.
2. **League self-play with exploiters** (duo / 4-robot). Every weakness found becomes training data.
3. **Population-based training** for hyperparameters and reward weights.
4. **Failure mining:** automatically find starts, seeds and profiles where the agent trails the
   planner or the bound → add them to the curriculum.
5. **Bound tightening:** better relaxations → smaller, truer optimality gap → shows exactly
   where improvement is left.
6. **Distill → verify:** VIPER trees are re-simulated in DSIM; where tree and network disagree
   becomes new training data.
7. **Driver loop:** scorecards expose human-tier gaps → drills + a more accurate driver model.
8. **External triggers:** REAL-vN calibration, FIRST Team Updates, and DSIM version bumps
   re-run the affected stages.

**Honest ceilings:**
- The game's optimum under DSIM — once the gap ≈ 0, there is nothing left to gain.
- DSIM's fidelity.
- Finite compute.
- DSIM-optimal ≠ real-field-optimal until S-cal.
- The human tier is only as accurate as the measured driver model.

### 14.4 Questions to answer before S-1

"Default" is what the tool does if the answer is left blank.

**Goals and timing**

| # | question | default | why it matters |
|---|---|---|---|
| 1 | Date of the first competition? | — | decides what gets built first |
| 2 | Success metric: max points, win rate, or ranking points? RP thresholds ("all other events"): SWARM ≥ 16 LEAVE+PARK points, POLLINATOR 1 ≥ 4 TIPS, POLLINATOR 2 ≥ 7 TIPS | optimize win + RP jointly; report points too | RP can favor a different plan than max points |
| 3 | Risk preference: best average or safest floor? | show both | changes which plan is "best" |
| 4 | Who reads outputs (drivers / coach / build / programmers), and in what format (Word, PDF, web)? | Word doc per playbook + web pages for maps | output design |

**Robot**

| # | question | default | why it matters |
|---|---|---|---|
| 5 | Turrets on front + back cells, intake at the back, shooter's default direction = front? | yes | intake heading, shot geometry |
| 6 | Intake as wide as the robot (DSIM sweeper), or narrower? | full width | collection routes |
| 7 | Target frame size, or the largest legal? | largest legal, plus a smaller WHAT-IF | speed, envelope |
| 8 | Odometry: Pinpoint / dead-wheel pods? | yes, Pinpoint | Pedro accuracy assumptions |
| 9 | Keep Box Tube as a WHAT-IF? | yes | upgrade value |
| 10 | Known turret limits (rotation range, cable wrap)? | 180°–unlimited range | shoot-while-collecting |

**Drive team**

| # | question | default | why it matters |
|---|---|---|---|
| 11 | One driver doing everything (like DSIM), or driver + operator on 2 gamepads (standard in FTC)? | model both; recommend | changes the whole human model |
| 12 | How many drivers train; per-driver scorecards? | 2 drivers; per-driver scorecards | driver tracking |
| 13 | Field-centric, robot-centric, or let the tool decide? | tool tests all three | human tier |
| 14 | Who is the human player; will they practice with a timing card? | yes | NECTAR timing |
| 15 | Hours per week of DSIM practice? | — | practice-plan sizing |

**Strategy scope**

| # | question | default | why it matters |
|---|---|---|---|
| 16 | Solo target: DSIM leaderboard score (includes the free-preload quirk) or real match staging? | both, labeled | habits vs record |
| 17 | Defense later: strategic legal defense OK, or minimal? | legal defense allowed; referee-model margin | S7 scope |
| 18 | Preferred start positions, or tool picks? | tool picks, all anchors reported | AUTO matrix |
| 19 | Unconfirmed tip rows: DSIM values as baseline + sweeps? | yes | core strategy |
| 20 | Rule doubts (e.g. human player during AUTO): I read the manual and choose the conservative reading? | yes, each one flagged to you | legality |

**Machine and operations**

| # | question | default | why it matters |
|---|---|---|---|
| 21 | Permission to download: DSIM npm dependencies (Electron skipped), and Python PyTorch + OR-Tools + CasADi (~1–2 GB total) | needs your explicit yes | nothing runs without it |
| 22 | Long runs (hours/days): I give start commands for **your** terminal and read the results afterwards? | yes (matches your no-long-background-jobs preference) | training operations |
| 23 | Build on the M5 now, move to the M6 later? | yes | timeline |
| 24 | Our code in this folder with its own git repo (DSIM snapshot untouched)? | yes | traceability |
| 25 | Is this zip the alpha snapshot; who brings in new DSIM versions? | stay frozen until you say | version pinning |
| 26 | Are you on the DSIM dev team? | assume no → everything private | patch upstream, sharing |
| 27 | Share results with alliance partners, or team only? | team only | privacy |
| 28 | Approve each stage before the next starts? | yes | gates |
| 29 | Run the S-1 feasibility check first (needs #21)? | yes | proves §14.1/§14.2 before building |
