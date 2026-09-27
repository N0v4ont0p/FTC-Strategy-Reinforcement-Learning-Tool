# MASTERPLAN — Learning Studio v2

Status (2026-09-27): phase 0 measured; **phase 1 built** (alliance play, partners, starts, Box Tube,
per-build envelopes, paths, strike rule, stalls, Store, service); **phase 2 built** (AUTO planner,
playbook, studio Playbook tab); **phase 3 built and passed** (sequential-halving search on shared luck:
259.1 vs v1 look-ahead 231.3, +27.8 ± 12.7 on 24 paired exam matches); **phase 4 built** (entity
network, learner, continuous actor/learner/evaluator engine with SPRT, one-button Home); **phase 5
built** (red opponents: presets, mirror self-play, a defender; route library + Routes page); **phase 6
built** (mistake audit with repeats, judgement mistakes from the thinking-ahead exam, drills from
exact state recipes, Mistakes page). The pass conditions of phases 4–6 (network ≥ search, gains
every exam, robust against every opponent, zero repeat mistakes) are measured by training, which the
team runs; the Home, Routes and Mistakes pages show them. Replaces the
generational trainer (TRAINING.md) phase by phase; every phase passes the gate before it ships.

## 1. Goal

After training, REAL-v1 plays BIOBUZZ like a veteran that makes no mistakes, and the team gets three answers:

1. **AUTO playbook** — the best joint 30 s AUTO for REAL-v1 **with each kind of alliance partner**, from each start pairing.
2. **TELEOP route library** — the routes (group order, shooting spots, cycle timing) that score most, and when to use each.
3. **Mistake-free driver** — a network that, with search behind it, plays the full match with zero repeat mistakes.

Training is the phase we are in now. The deliverables are what training produces.

### Success targets (measured on fixed exams, paired, shared luck)

| Target | Today | Goal |
|---|---|---|
| Network alone, full match | 197 | ≥ today's look-ahead (240), then keeps climbing |
| Network + search | 240 | clearly above phase-3 search, every exam |
| AUTO | whatever the champion does solo | beats it with **every** partner type, worst-10% included |
| Repeat mistakes per match (audit) | not measured | 0 on the exam |
| CPU busy while training | ~50% (phases wait on each other) | ≥ 90%, around the clock |
| Clicks to train | preset choice + settings | one button |

## 2. Rules that do not change

- **DSIM is ground truth.** `dsim-main/` is never modified. Every result the team sees is a DSIM score, and every shown plan has a DSIM replay that `verifyReplay` accepts.
- **Everything runs locally** on the Mac mini (12 cores, Apple GPU, 25.8 GB).
- **Measured, not assumed.** Every phase has a pass condition on a fixed exam; the gate grows with each phase.
- **Reward = DSIM score − fouls a referee would call.** No shaping.

## 3. What phase 0 measured (2026-09-26)

| | |
|---|---|
| DSIM, full match, 1 core | ~1.0 s (175× real time); with partner 1.0 s; full 2v2 1.3 s |
| Fork (copy of a match mid-game) | 0.04 ms |
| Whole Mac | ≈ 7,000 full matches or ≈ 240,000 AUTOs per hour |
| Plain match through our trainer | 1.3 s — our code is not slow (62% of CPU is DSIM's Rapier) |
| One lesson match | 84.6 s for 78 decisions → **1.1 s of sim per label** |
| AUTO / transition / TELEOP | 30 s / 8 s / 120 s |

**Why v1 plateaued (98 generations, +19):** labels cost 1.1 s each and are noisy (2 luck draws + a predictor with ~25-point error) while the differences to learn are ~8 points, so the network learned mostly noise (picks the best option 27% of the time). It trains **solo**, so partnering cannot be discovered. ~23 points per match of reward were a strike penalty for ordinary ball contact. 12-match races promoted lucky candidates. Phases ran one after another, leaving cores idle.

## 4. Architecture — one continuous engine, not generations

```
            ┌──────────── Studio (one button, pages below) ────────────┐
            │                                                          │
  Actors (CPU workers) ──states/decisions──▶ Store ◀──reads── Learner (a CPU worker; MLX not used)
   play + search in DSIM                     (all data, forever)       entity transformer
        ▲                                                             │
        └──────────────── new network every few minutes ──────────────┘
  Evaluator (reserved cores): fixed exams per partner type → promotion (SPRT)
  Planner (AUTO): joint-plan search in DSIM → Playbook
  Miner: routes + mistakes from the Store → Route library, Mistake audit
```

- **Actors never wait.** Self-play, search and AUTO planning run continuously on all but the evaluator's cores. The learner trains on the GPU at the same time. A new network is picked up by actors every few minutes (IMPALA/SEED-style), so there are no idle collect→learn→race→exam gaps.
- **Store keeps everything**: every searched decision with its option values and uncertainty, every match, every plan. A new network architecture retrains from the Store without replaying anything.
- **Evaluator is separate and fixed**: its seeds, partners and robot draws never change, so numbers are comparable across weeks.

## 5. Track A — AUTO partnering (planned exhaustively, not learned)

30 s = 0.18 s of sim, so AUTO is searched directly in DSIM at scale.

- **Plan** = per robot, a sequence of skills (collect group, shoot from spot, place into FLOWER, park, wait/yield) with a few numbers each (waypoint, speed cap, timing, element order).
- **Search**, three levels:
  1. Beam search / MCTS over the joint skill sequence of both robots.
  2. CMA-ES over each finalist's numbers.
  3. Robustness: 64+ luck draws per finalist; ranked by mean **and** worst 10% (CVaR), because one blown AUTO costs more than a small gain.
- **Partners**: DSIM's Sniper (single turret), Hauler (dumper), Skimmer (double turret); a REAL-v1 copy; a partner that only parks; a partner that does nothing. Two modes:
  - **Joint** — both robots' AUTOs designed together (for partners who will run our plan).
  - **Best response** — the partner's AUTO is fixed/typical; we plan around it (the common case at events).
- **Start positions**: every legal pairing, so the playbook also says which start to ask for.
- **Collisions, G407, HIVE contact and fouls** cost points automatically, so plans that interfere with the partner lose.
- **Output — Playbook**: table (partner type × start pair) → best plan, expected points ± spread, worst-10%, runner-ups for "partner can only do X", DSIM replay one click away.
- **Partner drivers**: our skill brain drives any build it supports (turret, twin turret). Dumper and other archetypes get scripted skill variants; human replays can be replayed as fixed partners.

## 6. Track B — TELEOP routes (expert iteration with deep search)

- **Search on DSIM forks**, Gumbel-MuZero-style:
  - Sequential halving puts simulations on the options that are close, not on obvious losers.
  - **Chance nodes** for luck: every option is compared on the same luck draws (common random numbers), many draws, not 2.
  - Rollouts run to a natural break (hopper empty, shots done) or match end, so labels do not lean on a predictor.
  - **Adaptive budget**: more simulations where the network is unsure or the gap is small (value of information).
- **Clean labels**: each searched decision stores option values with their standard errors. The learner weights by confidence.
- **Network — entity transformer**: attention over every element, zone, goal and robot (self, partner, later opponents) plus the robot profile. Outputs option policy, value, and uncertainty. Trained on the GPU with MLX; runs on CPU workers.
- **Loop**: search → learn from the search → the network guides the next search (AlphaZero/Gumbel). Promotion via SPRT on the fixed exam across all partner types.
- **Go-Explore starts**: episodes start from interesting mid-match states in the Store (a fork is 0.04 ms), not only from the whistle: late-game states, near-mistake states, states from your 7 replays.
- **Opponents** (phase 5): full 2v2 against archetype opponents (defense, contact, shared fields). Costs only +30% sim.
- **Output — Route library**: recurring routes mined from the Store (group order, shooting spots, cycle times, points/min), with the situations each is best in, and the network as the driver.

## 7. No mistakes — by construction, then by audit

1. **Shield**: rules that must never be broken are enforced in the skill layer as action masks, not learned: > 4 elements held (G407), HIVE frame contact (G417), illegal drop-zone moves. The robot cannot choose them.
2. **Mistake detectors** on every exam match: empty trips, missed/blocked shots, idle seconds, fouls, stalls, and **decisions where deep search beats the network by > X points**.
3. **Drills**: every detected mistake becomes a drill: the state just before it, forked, trained on with extra search. The failures turn into the curriculum.
4. **Judged on the tail**: promotion needs a better mean **and** no worse worst-10%.
5. **Strike guard fixed**: a hard flag with the replay attached, investigated. It is no longer a −5 that teaches the robot to avoid balls.

## 8. Maximum training — squeezing the Mac

- **All cores, all the time**: continuous actor/learner/evaluator pipeline (§4); GPU learner in parallel with CPU actors.
- **Never lose a run**: a macOS **LaunchAgent** runs the studio (not a terminal or the app preview panel, which kills it after 30 idle min). It restarts on crash or reboot, resumes from the last checkpoint, keeps the Mac awake while training, and writes crashes to `runs/studio-crash.log`.
- **Sim spent where it teaches**: sequential halving, adaptive budgets, Go-Explore starts, drills, prioritized replay of decisions the network gets wrong.
- **Variance down**: common random numbers everywhere; paired comparisons; control variates from the value head.
- **Self-tuning**: population-based training adjusts learning rate, search budget and exploration while running. **No presets to pick.**
- **Data forever**: the Store lets any future network learn from everything ever played.
- **Profile-aware**: robot ranges are sampled per match, and the network sees the numbers, so one run covers every version of REAL-v1 as it firms up.

## 9. Ease of use — one button, answers not knobs

- **One command, one button**: `./start.sh` once installs the LaunchAgent; afterwards the studio is always at http://localhost:4747. **Train** / **Pause**. No presets; power settings live under *Advanced* with guard rails, not on the main screen.
- **Home**: one big number (exam score) with its trend, "improving / flat", ETA to the next exam, CPU use, last champion, any problem in plain words.
- **Playbook page**: pick the partner type and start pair → the plan, points ± spread, step-by-step list, play it in DSIM, print it for the drive team.
- **Routes page**: the route library, filterable by situation, each with a DSIM replay.
- **Mistakes page**: the audit, each mistake with its replay moment, trend to zero.
- **Robot page**: paste a DSIM builder export or pick settings → the profile is built with **DSIM's own floors** (mass, sizes) and validated, so a bad range never reaches training.
- **Notifications**: macOS notification for a new champion, a finished playbook, or any failure.
- **Exports**: DSIM replays, paste snippets, printable playbook PDF.
- **Honest by default**: every number shows its ± and sample size; nothing is shown that DSIM did not score.

## 10. Phases

| # | Build | Pass condition |
|---|---|---|
| 0 | Measure (done) | Numbers in §3 |
| 1 | **Foundation**: two-robot seats; partner drivers; shield; strike guard fixed; Store; LaunchAgent + crash log | Gate green; 2-robot matches deterministic and DSIM-verified; 24 h unattended without loss |
| 2 | **AUTO planner** + Playbook page | Beats the current champion's AUTO with every partner type, worst-10% included; every plan DSIM-verified |
| 3 | **TELEOP search** (Gumbel, chance nodes, adaptive budget) | Search beats today's look-ahead (240) on the fixed exam |
| 4 | **Continuous engine**: entity transformer on MLX, actor/learner/evaluator pipeline, PBT, Go-Explore, SPRT promotion; one-button studio home | Network alone ≥ phase-3 search; ≥ 90% CPU; gains every exam, no plateau |
| 5 | **Opponents + Route library** | Route library with points/min; champion robust against every opponent type |
| 6 | **Mistake audit + drills** + Mistakes page | Zero repeat mistakes on the exam |

Order is chosen so each phase is useful on its own: after phase 2 the team already has an AUTO playbook.

## 11. Risks and answers

| Risk | Answer |
|---|---|
| Partner archetypes our skills cannot drive (dumper) | Scripted skill variants; replays as fixed partners; start with turret builds |
| Search too slow for full-match labels | Adaptive budget; natural-break rollouts; Go-Explore starts focus the sim; measure in phase 3 before phase 4 |
| MLX / GPU training issues | Fallback: current CPU trainer code for the network; the Store keeps data regardless |
| REAL-v1 changes | Profile-aware network + sampled ranges; the Playbook reruns overnight for a new build |
| Overfitting to DSIM quirks | Strike guard + DSIM replay check + hard flags on oddities; reported, never silently rewarded |

## 12. Kept, removed

- **Kept**: skills, forking, shared luck, fixed exams, DSIM replay verification, gate, studio, profiles, guards.
- **Removed**: noisy 2-draw lessons, predictor-labelled lessons, 12-match races, presets, solo-only play, generational stop-and-go.
