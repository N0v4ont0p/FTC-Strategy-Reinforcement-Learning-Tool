# BIOBUZZ Evolution Studio — how to train

Robots learn BIOBUZZ inside the real, unmodified DSIM simulator. Each robot already knows HOW to play:
drive a planned path, sweep up a whole group of elements with its intake, pull POLLEN from a FLOWER,
shoot, press the human-player button, park. What evolution learns is **WHAT TO DO NEXT**: which group,
FLOWER or loading zone, shoot now or collect more, when to use the human player, when to park. That
order is the strategy. The genome also carries three skill settings (see *Skills*).

## Start and stop everything

```bash
./start.sh
```

(or `npm start`). This starts, and keeps running until you quit:

- **The studio** at http://localhost:4747 (opens in your browser): runs, training, checkpoints,
  settings, training data, evaluation and the live field.
- **DSIM itself** at http://localhost:5173 (alpha channel, local), for watching a champion in the real app.

**Nothing trains until you press Start training.** To stop everything, press **Quit studio** (top
right): training stops (a generation in progress is discarded; the run keeps its last saved
generation), DSIM and the studio shut down, and the studio's and DSIM's browser tabs close. The first
time, macOS asks whether the terminal may control Safari or Chrome; if you decline, the page says
"Studio closed" and you close the tab yourself. Closing the terminal or Ctrl-C also stops everything.

Options: `./start.sh --no-dsim` (studio only) · `--port 4747` · `--dsim-port 5173` · `--no-open`.

## The field: Live or a replay

- **Live** follows training. It shows every robot of the newest generation, replayed as fast as
  training runs (the speed is shown, e.g. "10× · keeping pace with training"), and moves to the next
  generation when the replay ends. There is nothing to set. When nothing is training it plays at 1×.
- **Generation best** replays one robot **exactly as it was trained** (frames recorded inside the
  training match): every element, both HIVEs, FLOWER stacks, score, tips, hopper and its current
  decision. Normal speed **1×** or **2×**, pause, restart and a time slider. It stays on that
  generation while training goes on; "newest" in the header loads the latest. Click a honeycomb cell
  to replay that generation's best.
- **Champion** replays the champion the same way.

## The side panel

| tab | what you can do |
|---|---|
| Overview | counters, the champion (score ± 95 % interval over the validation matches; watch it, copy its DSIM snippet, download its network, export metrics), DSIM score by generation (best, mean, champion; your best replay and the greedy baseline as reference lines), fitness, how robots ended |
| Runs | every run on this Mac with generation, champion, size and last training time: **Open, Rename, Duplicate, Delete** (type the name to confirm). Old-version runs can only be deleted |
| Checkpoints | save a named checkpoint; **Rewind here, Fork, Rename, Pin, Delete**; delete all automatic (or all unpinned) at once |
| Settings | **How to train**: pick a preset and apply it (the changes are listed first). **Every setting**: all of them by hand |
| Training data | your replays, which are included, their score and lessons; **Refresh**, **Add replays…**; what the students achieve |
| Evaluate | score any policy on held-out matches with a 95 % interval: champion, current, greedy baseline, imitation of your replays, any checkpoint |
| Lineage | **What works**: how often each kind of child reaches the top quarter; how a generation was made, robot by robot |
| Log | every event |

## Presets (Settings → How to train)

| preset | for |
|---|---|
| Balanced (default) | 128 robots, best 3 proven on 8 validation matches, 15 % behaviour mutations, adaptive students, all cores but one |
| Full push | maximum results and load: 256 robots × 2 matches, best 4 proven on 16 matches, every core (~4× slower per generation) |
| Explore new strategies | when progress stalls: bigger mutations, 30 % behaviour mutations, 10 % random newcomers |
| Refine the champion | small mutations, 3 matches per robot, best 5 proven on 16 matches |
| Learn from my replays | a third of each generation are students (up to half), longer lessons |
| Quick look | 32 robots, fast and noisy, for watching and testing |
| Background | half the cores, 64 robots |

A preset only sets how hard and how the run trains. What the robots play (episode type, driver, robot,
hints, penalties) is never touched. A hand edit afterwards shows the settings as "custom".

## How the training works

Every generation (genetic algorithm):

1. **Every robot plays** its matches on the generation's common seeds: the same field and the same
   robot draw for everybody, so differences are the policy's, not luck's.
2. **The best few are validated** on the run's fixed validation matches (never used for training,
   never the evaluation seeds). The **champion** is the best *mean* over them, and it changes only
   when a challenger beats it on the very same matches. One lucky match can no longer make a champion.
3. **The champion's own decisions** are kept as *experience*.
4. **The next generation is bred** from the top quarter:
   - **elites** kept unchanged, and the champion always kept;
   - **mutants** (small nudges) and **crossovers** (genes mixed from two parents);
   - **behaviour mutations: 15 %** of every generation. A large change to one part of the network (a
     hidden unit, one option's preference, a burst of big nudges) or to a skill setting, repeated until
     it provably changes what the robot chooses on at least 10 % of test decisions. Small nudges alone
     mostly change nothing a robot does;
   - **students**: a parent that takes a short lesson (behaviour cloning) on your replays and on the
     champion's own decisions;
   - **random newcomers** (3 %).
5. **What works is measured**: for each kind of child, how often it reaches the top quarter. The
   students' share follows it: it grows while students beat plain mutants and shrinks while they do
   not (adaptive pursuit). Later generations "know" whether learning from the replays pays off.

**Generation 0** is the network fitted to your replays, its mutants and behaviour mutations, and 25 %
random robots, so the AUTO order is not fixed to what the replays did (e.g. FLOWERs first).

Techniques used (all standard, with references in `train/algos.ts`): deep neuroevolution GA with
elitism and tournament selection; common random numbers; validation-based model selection; hall of
fame; imitation as a genetic operator (policy optimization by genetic distillation); self-imitation;
behaviour-changing mutations checked on probe decisions; adaptive operator selection.

**Honest note:** no training method is provably the best for every problem (the no-free-lunch
theorems). This one is chosen so every part does measurable work, and the gate checks each part.

## Training data (your replays)

- Put DSIM replays (Records → the run → ↓ Data) in `Training data/`, or use **Add replays…**.
- Each replay is re-simulated in DSIM. Every decision in it (which group, FLOWER, shoot, human player)
  becomes a lesson. A sweep of one group counts as one decision; a shot counts as "went to shoot"
  only when no pickup follows within a second (your runs shoot while sweeping, which the robot does
  on its own).
- **Refresh** re-simulates the ticked replays and refits (a few seconds per replay). The open run
  switches to the new set from its next generation.
- A run records which data set it learns from, so rewinding re-learns exactly as before.
- Today: 7 replays → 583 decisions; the fitted network picks the same next option as you 56 % of the
  time on a replay it never saw (chance: 21 %).
- Your runs used a front+back intake build, so the order of choices transfers, not the numbers.
  Fitness is always our own robot's DSIM score.

## Skills

- **Group sweep**: elements closer than 16 in (chained) are one group; the robot commits to the group
  and takes them nearest-next with the intake leading, slowing to its capture speed, until the hopper
  is full or the group is gone. A slow element is skipped, not the whole group.
- **Crossing at a tip**: the moment a CELL starts to tip, shots go to the other CELL (it takes them
  from the release, 2 s into the swing), so the robot crosses immediately instead of waiting.
- **Shooting from where it stands** when that is a measured scoring position, otherwise from the
  nearest turn-safe spot. Fire is held whenever a shot can land, including while collecting.
- **Paths** avoid the HIVE frame and FLOWER feet; a look-ahead stops frame crashes (0 in 64 mixed
  robots in the last check).
- **Skill genes** evolve with the network: slow down to fire while collecting once holding N
  elements; only on robots allowed to fire at ≥ V in/s; re-decide the moment a tip starts. Defaults
  are the measured-best values; behaviour mutations flip them.
- **Start pose**: back against the blue wall just right of FLOWER F3, facing the field.

Measured on 12 identical matches with the sampled real robot (no learning, greedy order): the new
skills score **207 points** on average vs **152** for the previous version (better in every match),
9.7 vs 7.0 tips per match, same miss rate, 0 crashes.

## Terminal-only training

```bash
npm run train -- --name solo --pop 128          # create or resume a run and train now, with a live dashboard
```

The same engine. Keys: `p` pause, `o` open the studio, `q` stop.

## Where things are

| path | what |
|---|---|
| `runs/<name>/checkpoint.json` | the run now (saved atomically every generation) |
| `runs/<name>/checkpoints/` | named, automatic and pinned checkpoints (state + history) |
| `runs/<name>/metrics.jsonl` · `events.jsonl` · `evals.jsonl` | per-generation statistics, the log, evaluations |
| `runs/<name>/gens/<n>.json` · `<n>.frames.json.gz` | every robot's path and choices; the best robot's exact frames |
| `runs/<name>/best.*` | the champion: exact frames, DSIM replay, DSIM paste snippet |
| `Training data/` | your DSIM replays |
| `outputs/imitation/` | the data sets (`sets/`, never deleted), the fitted network, excluded replays |
| `profiles/real-v0.json` | the team robot's ranges: edit when the robot changes, then start a new run |

## Honest limits

- **Speed**: a full match costs ~1.6 s of CPU, almost all DSIM's own physics. Validation adds about
  20 % per generation.
- **The robot is not your replay build.** REAL-v0 fires at 2–13 shots/s with up to 1 s of aim settle,
  must slow down to capture and to fire, and holds 4. Your runs (730–825) used a faster two-intake
  build. The skills set the ceiling; evolution finds the best order within it.
- **The DSIM snippet** replays the champion's commands. Forced misses can land differently in DSIM.
  The studio's Champion view is the exact life.
- **Old runs** from earlier versions are listed as old versions and cannot continue; their files are
  untouched until you delete them.

## Checks

```bash
npm run check:train     # the studio + trainer gate (~4 min)
npm run check:s0        # the DSIM harness
npm run check:s1        # the motion lab
npm run imitate         # rebuild the data set from Training data/ and refit
npm run typecheck
```
