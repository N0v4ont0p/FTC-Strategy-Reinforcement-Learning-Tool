# BIOBUZZ Learning Studio — how to train

Robots learn BIOBUZZ inside the real, unmodified DSIM simulator. Each robot already knows HOW to play:
drive a planned path, sweep up a group of elements, pull POLLEN from a FLOWER, shoot, press the
human-player button, park, and run the **tip cycle** by the HIVE (your replays' loop). What it
learns is **what to do next**, and **how** its skills are tuned. It learns from every decision it
makes, with one clear reward.

## The reward

**One number, the same everywhere: DSIM's score for the match, minus the foul points of the rules DSIM
does not enforce.** Those rules are checked by our guards and counted as if deliberate:
- G417 (HIVE frame), G407 (controlling 5+ elements), G409 (catching a spill), G426 (human player in
  AUTO): 15 points each (a MAJOR FOUL);
- G427 C (human player while the drop area is covered): 5 (a MINOR FOUL);
- profiting from a physics oddity: 5 for each element knocked faster than any robot moves that then
  scores for us (enters a HIVE cell, or lies in our GARDEN 3 s later). A strike alone is only
  reported: a ball bounces off a moving chassis at up to twice its speed, and fining every strike
  (v1) taught the robot to stay away from elements — about 23 points a match on REAL-v1.

With a partner, the reward is the ALLIANCE's: its DSIM score minus both robots' guard fouls.

There are no hints and no shaping. The headline number in the studio is the champion's **points per
match over the no-learning robot on the same exam matches** (± its 95 % range). 0 means as good as the
no-learning robot; +30 means 30 points a match better.

## The alliance (v2 phase 1)

Every match can have an **alliance partner** (MASTERPLAN §5). Partner types (`train/team.ts`):

| partner | what it is |
|---|---|
| A second REAL-v1 | our robot again, its own draw from the profile |
| Sniper · Hauler · Skimmer | DSIM's own preset builds: swerve single turret · tank rear dumper · x-drive double turret |
| Parks only | drives off its wall and parks: LEAVE + PARK, nothing else |
| Does nothing | never moves (it still takes up space and keeps its preloads) |

Partners play with the same skills as ours (the no-learning order unless given a network) and a
typical robot's limits (our profile's nominal fire rate, speeds and accuracy). Each robot's shots
miss at its own rate.

**Starts:** our start (side wall, right of FLOWER F3) and DSIM's four anchors, which DSIM seats for
any build. Two robots of one alliance may not overlap: 16 of the 20 ordered pairs are legal
(F3 / top side and bottom audience / bottom side overlap).

**Playing together:**
- each robot posts its job on a shared board, and its partner leaves those elements, that FLOWER and
  that shooting spot alone;
- a robot never drives into another: the part of its motion toward the other robot is dropped (it
  slides past or waits). Another robot counts as a disc as wide as its corners reach, since a dumper
  aiming spins its whole chassis. A tank, which cannot slide, stops;
- two robots park at the two ends of the loading zone.

Measured (48 matches each, the no-learning order, sampled REAL-v1): alone 218 · beside a second
REAL-v1 306 · Sniper 295 · Skimmer 312 · Hauler 235 · a parker 183 · a robot that does nothing 191. A
weak partner costs points: it holds its own preloads, which would otherwise be in the loading zone.

### What else changed in the skills
- **The Box Tube.** A robot with a Box Tube (REAL-v1) places a held NECTAR into a FLOWER after the
  1:00 cue (G410): the top-most NECTAR owns the FLOWER (2 a scoring element) and the bottom-most
  earns 5 — about 15 points on a staged FLOWER. REAL-v1 owns 3–4 FLOWERs at the end of a match.
- **Shooting envelopes per build** (`train/envelope.ts`, `outputs/envelopes/`). v1 used REAL-v0's
  S1 envelope for every robot; REAL-v1's turrets sit at the back corners, and a robot parked on a
  spot that gave it no shot stalled the match. Each build family is now measured in DSIM (a spot
  counts only if the shot goes in from all four headings: ~15 s a build).
- **Paths** keep a turning robot's corners clear (the footprint's half-diagonal + 1.5 in), and a goal
  near the HIVE frame is reached around the frame instead of through it.
- **A tank** (the Hauler) steers by turning — DSIM tank takes side drives, not strafe.
- **A stall** (20 s without progress) no longer ends the match: it is a counted mistake. Ending the
  match threw away the end-game (PARK, FLOWERs) of a robot that was busy but unlucky.

## The AUTO playbook (v2 phase 2)

The **Playbook** tab answers "our partner can do X — what do we run in AUTO?": the best 30 s AUTO for
our robot beside every kind of partner, from every legal pair of starts (165 entries for REAL-v1),
found by **search in DSIM**, not learned (`train/auto.ts`, `train/playbook.ts`).

- **A plan** is what each robot does at each of its job starts, in order ("shoot the preloads",
  "FLOWER F3", "the group at element 23", "park"). A step is found again by what it is, so a plan
  found under one luck draw still applies under another. Each planned job runs to its end; past its
  plan, a robot plays on with its own brain.
- **Beam search**: under a reference draw the plan is played until a planned robot starts a job past
  it; each of that robot's most promising options extends the plan. Every candidate plays the whole
  AUTO on the same luck draws (common random numbers); the best go on.
- **Finalists** play 64 fresh draws and are ranked on the average and the worst tenth (one blown AUTO
  costs more than a small gain). "No plan" — every robot its own AUTO — is a finalist too, so the
  playbook never recommends a plan that is not better; the entry then says so.
- **CMA-ES** tunes our robot's skill settings (speeds, margins) for the winning plan.
- **Modes**: *best response* — the partner runs its own AUTO, only ours is planned (the case at an
  event); *joint* — both AUTOs planned together, for a partner who will run ours.

Each entry shows its AUTO points ± 95 %, the worst tenth, the gain over no plan, the result on robots
drawn from the profile's whole range, the **timing sheet** (who does what, when) and an exact replay
(**Watch it**). A full build is about 90 s an entry (~4 h for all of REAL-v1, resumable: a build only
plans what is missing); *Quick look* is about 15 s an entry. The playbook needs every core, so it is
refused while training runs. Stored in `outputs/playbook/<robot>.db` and `outputs/playbook/<robot>/`.

Measured (quick budget, our start F3): alone 51.7 ± 4.4 AUTO points against 31.6 for the robot's own
AUTO; planned jointly with a second REAL-v1, 72.8 against 53.6.

## One button: continuous training (v2 phases 3–4)

The **Home** tab is the new way to train: pick the robot, press **Train**, and it goes on until
**Pause** — no generations, no presets (`train/continuous.ts`). Three kinds of work share every core:

- **Actors** play matches with the champion beside every kind of partner and **think ahead** through a
  30-second stretch of each match (a different stretch each time, late game included: a match reaches
  any moment in about a second, so the simulation goes where the decisions are). Every searched
  decision is a lesson, kept in `runs/.v2/<robot>/store.db`.
- **Thinking ahead v2** (`train/episode.ts` `searchHalving`, MASTERPLAN phase 3): at a job start
  *every* option is played 10 s ahead on 2 shared luck draws; the better half 20 s ahead on 4; the
  best two 30 s ahead on 8. The same draws for every option (common random numbers), so the
  comparison measures the options, not the dice. The network's own choice always reaches the last
  round and is overruled only by a clear winner there (more than 2 points and one standard error
  of the paired difference). **Measured** on 24 paired exam matches (REAL-v1, the no-learning order
  as the network): **259.1** with it, 231.3 with v1's look-ahead (+27.8 ± 12.7), 221.2 without
  (+37.9 ± 12.6). It costs ~7 s of simulation per decision (v1: ~0.5 s).
- **The entity network** (`train/entnet.ts`) reads the field as a *set*: every robot and every
  element in play is one entity, and each option attends over all of them (v1 saw the six nearest
  elements). It scores each option in points and also predicts the points still to come. ~11 k
  weights, forward and backward written by hand (the gate checks them against finite differences),
  0.1 ms a decision, so it trains on the CPU while the other cores play. Genomes start with `ent1:`.
- **The learner** (`train/entlearn.ts`), every 400 new lessons: fits the network to the searched
  values — within each round, each option's value relative to the round's average (the rounds
  differ in length, so only differences within a round mean anything), the deep, well-sampled
  rounds weighted most. Three learning rates each time; the best on held-out matches wins and the
  learning rate follows it (population-based training). Held out: how often the network's first
  choice is the search's, and the points its choice gives away.
- **The evaluator** plays each new network on the **fixed exam** — 24 seeds × every partner kind
  (no partner, a second REAL-v1, Skimmer, Sniper, Hauler, one that only parks), the same forever —
  paired with the champion's own exam matches, and decides by a **sequential test** (SPRT: it stops
  as soon as the evidence is clear). A network takes over only when clearly better and not worse in
  its worst tenth. The first champion to beat is the no-learning robot.
- Every few hours the champion also takes a **thinking-ahead exam** (6 solo exam matches with the
  search on): the goal of phase 4 is the network alone as good as the network with search.

Home shows the champion's exam score and its trend, how busy the cores are, lessons learned, every
candidate's verdict, the exam beside each partner kind and what it is doing now. Evaluator work jumps
the queue, then the learner, then the actors, so nothing waits long and no core idles. It survives a
crash or a restart (the service carries on where it was); Pause is the only stop. One trainer at a
time: Train is refused while a generational run trains or the playbook builds, and the other way
round.

## Start and stop everything

```bash
./start.sh
```

(or `npm start`). This starts the studio at http://localhost:4747 and DSIM at http://localhost:5173.
**Nothing trains until you press Start training.**

- **Quit studio** (top right) stops training (the generation in progress is discarded), DSIM and the
  studio, and closes their tabs. **A run that was training carries on by itself the next time you
  start the studio.** Press **Stop** first if you do not want that.
- While training, the Mac is kept from sleeping (`caffeinate`); it may sleep again once training stops.
- The Overview shows when the last generation finished. It turns red when that is much longer ago than
  usual, so a stopped run is obvious.

Options: `./start.sh --no-dsim` · `--port 4747` · `--dsim-port 5173` · `--no-open`.

**For long training, do not run the studio from the Claude app's preview panel**: the app stops what
it started after 30 idle minutes (that ended a run on 2026-09-25). Run it as a service instead:

```bash
./start.sh --install      # a macOS LaunchAgent: starts at login, restarts after a crash, resumes training
./start.sh --background   # or detached from this terminal (no login start)
./start.sh --status       # is it running, and how
./start.sh --stop         # quit it (a run that was training resumes next start)
./start.sh --uninstall    # remove the LaunchAgent
```

Both restart the studio after a crash (at most 10 times an hour) but not after Quit. Output goes to
`runs/studio.log`; a crash's reason to `runs/studio-crash.log`. Only one studio ever runs: a second
one sees the first on its port and exits. If macOS keeps the LaunchAgent out of this folder (the log
says "Operation not permitted"), give `node` Full Disk Access or use `--background`.

## How the robot learns — every generation

1. **Lessons.** The champion plays 20 matches (Balanced). At every job start, and at a share of its
   quarter-second re-thinks, the match is **copied** (every piece of state, bit-exact) and **every
   option is played out on the copies**. On each copy the forced option runs **to completion** (then
   the champion plays on), so an option is measured as it would really be done. Round 1 plays them
   all 15 s ahead under one fresh luck draw (the same draw for every option, never the real match's
   future). Round 2 plays the better half again under a second draw. Then the rest-of-match
   predictor values what is left. The points each option made are the lesson. The real match is
   never touched: it goes on as the champion plays it.
2. **Learning.** A candidate network is trained, starting from the champion's weights, to prefer
   options by those points. It uses the last 4 generations' lessons (your replays' decisions only with
   the "Lean on my replays" preset). It enters the race only if, on lessons from matches it never trained on, its
   picks lose fewer points than the champion's. The rest-of-match predictor is refitted on the
   champion's own matches.
3. **Skill settings (CMA-ES).** 12 variations of the champion's 18 skill settings each play 6 matches
   against the champion with identical luck. CMA-ES (Hansen's evolution strategy, the standard for
   tuning a few dozen numbers from noisy comparisons) moves toward what wins. Its new centre enters
   the race.
4. **The race.** The champion and up to 3 contenders play the same brand-new matches (12 per
   generation) with the same luck. A contender's lead adds up across generations. It becomes champion
   only when both hold:
   - its lead passes z ≥ 2.3 (a Pocock group-sequential boundary: safe although it is checked every
     generation);
   - it is not worse in its bad matches (its worst fifth).

   Clearly worse contenders, and ones that could not prove themselves in 96 matches, are dropped.
5. **The exam.** Every new champion (and at least every 10 generations) plays the same 64 matches.
   They are the same for every run, so runs are comparable. It plays alone, and thinking ahead on half
   of them, next to the no-learning robot on the same matches. That is the **learning curve**. The
   exam also:
   - plays match 1 again: the result must be identical;
   - plays the champion on your replays' own robot and on each replay's own match seed, and has DSIM
     itself re-simulate that replay: same score, same world hash, same tick count;
   - builds the **gap report**.

Why this is sound:
- **Rollout / policy improvement.** Acting on the champion's own exact what-if values is never worse
  than the champion. The network only approximates that, which is why every candidate must also win
  the race.
- **Common random numbers.** Options, candidates and exams share luck, so the comparison measures the
  robot, not the dice.
- **Sequential testing.** The race is built to be checked every generation without crowning luck.

### What was measured while building it
- **Copying a match is exact.** A copy played on finishes bit-identical; a copy played differently
  leaves the real match untouched; taking lessons never changes the real match. A copy costs 0.08 ms.
- **Thinking ahead at job starts** made the no-learning robot better: +40 ± 19 points over 18 paired
  matches (best 3 options, 10 s ahead). Doing it at every quarter-second re-think made it worse
  (−26): noisy estimates flipped jobs back and forth. So it only thinks ahead when a job starts.
- **One generation of lessons** (40 matches) produced a network that beat the no-learning network by
  **+20.3 ± 12.9** points over 40 fresh paired matches (won 26). A first attempt, which learned only
  which option was best, gained nothing (−3 ± 15). Learning each option's points fixed that.
- **In lessons, options are played out to completion.** In the first Full push trial the candidate
  raced at −31.5 ± 16.4. A what-if of an option the champion dislikes (the new tip cycle) had
  measured "start it, drop it at the next re-think", so the network learned to pick and keep an
  option it had never seen played out. Now, in a lesson, a forced option runs to its end (the options
  framework). Then "carry on with a job" means the same at a re-think as "start it" at a job start.
  Re-measured with the tip cycle on the list: one generation of lessons (40 matches, 3,209 lessons)
  → held-out points lost per decision 9.15 → 7.41 → the candidate beat its starting network by
  **+19.4 ± 14.3** over 40 fresh paired matches (won 29), with slightly fewer fouls.
- **Thinking ahead is a one-step deviation.** It does not commit: the robot keeps re-thinking
  afterwards, as the what-if assumed. Committing measured only +12.7 ± 14.0; the one-step form
  +39.7 ± 19.4, and **+35.0 ± 12.3** on the exam of the first Full push trial.
- At a decision, the no-learning robot's choice loses about **6.8 points** to the best what-if
  option. The "points lost to choices" chart tracks that number for the champion. Picking the best
  of noisy play-outs overstates it a little, so watch the trend.

### The first live Full push generation (2026-09-25)
- The candidate learned from generation 0's lessons (3,193 lessons; held-out points lost per
  decision 9.63 → 7.51, best-option hits 27 % → 35 %) won the race on 24 fresh matches with the
  same luck, **+28.1 ± 17.6**, and became champion.
- **Its exam (64 fixed matches): 221.0, +26.6 ± 9.9 over the no-learning robot. Thinking ahead:
  251.7, +61.4 ± 14.4** (32 matches). Deterministic ✓, DSIM-verified ✓.
- Mistakes per exam match, starting champion → new one:
  - missed shots 30.5 → 20.2;
  - empty trips 19.3 (48 s) → 7.0 (22 s);
  - foul points 25 → 20.6.
- The generation took 38.5 min: lessons 26.3, learning 1.3, race 0.9, exam 10.0.

## The tip cycle (from your replays)

Measured on your 7 replays: a tip every 4.3 s, about 9 shots per tip, the robot about 44 in from its
HIVE the whole time. The tipped cell's spill lands beside the HIVE; you sweep it up there and shoot it
into the other cell, which tips and spills in turn. The **tip cycle** job does that loop:
- it takes the nearest element in the 54 in zone around its own HIVE and fires whenever a shot can
  score;
- when full, it shoots from the zone;
- it waits beside a coming spill;
- it leaves when the zone runs dry, or when nothing has been taken or shot for a while (then it is
  left alone for a few seconds).

The no-learning robot never picks it (so the bar stays the same). In what-if play at its decisions,
the tip cycle was the best option 30 % of the time it was available; chance would be about 11 %. The
network learns when.

## The field: Live or a replay

- **Live** follows training: the champion's lesson matches of the newest generation, replayed as fast
  as training runs.
- **Generation best** replays that generation's best lesson match, exactly as played. It plays at 1×
  or 2×, with pause, restart and a slider.
- **Champion** replays the champion's showcase (exam match 1, thinking ahead). Under it, the
  **decision inspector** shows, at every moment:
  - every option it had;
  - what its network scored;
  - what each option made when played out (what-if points);
  - which one it took, and whether thinking ahead overruled the network.

## The side panel

| tab | what you can do |
|---|---|
| Overview | the champion's points over the no-learning robot (exam), exam alone / thinking ahead, its race record, watch / DSIM snippet / download; **learning curve** (exam by hours); **points lost to choices**; **seconds lost per match** (idle, empty trips, blocked shots); score by generation |
| Race | the contenders (matches, lead ± 95 %, z), what was learned this generation (lessons, held-out regret before → after, predictor error, CMA-ES), the champion's skill settings |
| Report | the **gap report** (you · the champion on your build and matches · the champion on REAL-v0: points, tips, s/tip, pickups/min, shots/min, accuracy, shots per load, where the time went), the checks (deterministic, DSIM-verified), mistakes on the exam |
| Runs | open, rename, duplicate, delete (type the name to confirm) |
| Checkpoints | save; rewind (exact), fork, rename, pin, delete; delete all automatic / all unpinned |
| Settings | presets, every setting |
| Training data | your replays: include/exclude, refresh, add |
| Evaluate | any policy on held-out matches: champion alone or thinking ahead, greedy, the no-learning network, imitation of your replays, any checkpoint |
| Log | every event |

## Presets

| preset | for |
|---|---|
| Balanced (default) | 20 lesson matches per generation, 12 skill settings tried, 12 race matches, all cores but one |
| Full push | 40 lesson matches, 6 generations of lessons remembered, 16 skill settings × 8 matches, 24 race matches, every core |
| Lean on my replays | your replays weigh as much as a lesson at first, fading over 30 generations |
| Quick look | 6 lesson matches, 8 s play-outs, 16-match exam without thinking ahead: for watching, not results |
| Background | half the cores, 10 lesson matches |

## Honest limits

- **Luck is large:** two robots on the same match differ by about ±40 points. The race needs many
  matches to prove a small gain, so the champion changes only now and then. A flat champion line
  means nothing has been proven better yet, not that nothing was learned.
- **The build.** On your replays' own robot (front+back intake, ideal limits), the champion (the
  no-learning network at the start) scores about 400–470 on your own matches, against your 801. On
  REAL-v0 it scores about 205. The gap report splits this: roughly 250 points are the robot build,
  roughly 350 are brain and skills. That second part is what training works on.
- **Cost, measured:** a lesson match costs about 8 CPU-minutes (every option played out at every
  decision). A Full push generation on this Mac took 36.5 min: lessons 25.2, learning 1.2, race 0.8,
  exam 9.3 (the exam runs only for a new champion, and at least every 10 generations). Balanced
  (20 lesson matches) is about half that. Expect 2–3 generations an hour with Full push.
- **The DSIM snippet** replays the champion's commands. On REAL-v0, simulated misses change the world
  after DSIM steps, so only runs without misses (the build check) re-simulate exactly. The studio's
  Champion view is always the exact match.
- Runs from earlier versions cannot continue; their files are untouched until you delete them.

## Terminal-only training

```bash
npm run train -- --name solo --preset full-push     # create or resume a run and train now
```

Keys: `p` pause, `o` open the studio, `q` stop.

## Where things are

| path | what |
|---|---|
| `runs/<name>/checkpoint.json` | the run now (saved atomically every generation) |
| `runs/<name>/lessons/<n>.json.gz` | generation n's lessons and predictor data (~70 KB per lesson match; the last 20 generations are kept, so a rewind is exact within them) |
| `runs/<name>/metrics.jsonl` · `exams.jsonl` · `events.jsonl` · `evals.jsonl` | per generation, every exam, the log, evaluations |
| `runs/<name>/gens/<n>.json` · `<n>.frames.json.gz` | the lesson matches' paths; the best one's exact frames (~2.4 MB a generation; the last 60 and every 100th are kept) |
| `runs/<name>/best.*` | the champion's showcase: exact frames with its what-if values, DSIM replay, paste snippet |
| `Training data/` | your DSIM replays |
| `outputs/imitation/` | replay data sets, the fitted network, the distilled no-learning network, the starting predictor |
| `profiles/real-v0.json` | the team robot's ranges |
| `runs/.v2/<robot>/state.json` · `store.db` · `events.jsonl` | continuous training (Home): its state, every searched decision, the log |

## Checks

```bash
npm run check:train     # the gate (~20 min): copies, lessons, search, tip cycle, CMA-ES, learning, predictor, engine, exact rewind, server
npm run check:s0        # the DSIM harness
npm run check:s1        # the motion lab
npm run typecheck
```
