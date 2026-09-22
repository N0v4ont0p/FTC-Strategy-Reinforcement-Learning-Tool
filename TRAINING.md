# BIOBUZZ Evolution Studio — how to train

Robots learn BIOBUZZ inside the real, unmodified DSIM simulator. Each robot already knows HOW to play:
drive a planned path, collect with its intake, pull POLLEN from a FLOWER, shoot, press the human-player
button, park. What evolution learns is **WHAT TO DO NEXT**: field or FLOWER or loading zone, shoot
now or collect one more, when to use the human player, when to park. That order is the strategy.

## Start everything

```bash
./start.sh
```

(or `npm start`). This starts, and keeps running until you close the terminal or press Ctrl-C:

- **The studio** at http://localhost:4747 (opens in your browser): runs, training controls,
  checkpoints, rewind, settings, evaluation, and the live field.
- **DSIM itself** at http://localhost:5173 (alpha channel, local), for watching a champion in the real app.

**Nothing trains until you press Start training in the studio.** When the terminal closes, a
generation in progress is thrown away and the run stays at its last saved generation, so nothing is
ever half-saved.

Options: `./start.sh --no-dsim` (studio only) · `--port 4747` · `--dsim-port 5173` · `--no-open`.

## The studio

**Top bar.** Pick a run or make a new one, then control it:
- **Start / Resume training** runs until you pause or stop it. There is no built-in end.
- **Pause** waits for the current generation to finish, then holds.
- **+1 gen / +10 gens** runs exactly that many generations, then pauses.
- **Stop** finishes the generation, saves, and stops.
- **Abort generation** throws away the generation in progress. The run is exactly as it was before it started.

**The field** is drawn by DSIM's own renderers:
- **Whole generation:** every robot of one generation at once. Each of the top 24 has a dashed line
  to what it is going for, coloured by the option: field, loading zone, FLOWER, shoot, human
  player, park. The gold ring is the generation's best robot. A flash means a shot went in.
  A red × means it crashed into the HIVE frame; a yellow ○ means it stalled.
- **Best of generation** and **Champion:** one life redrawn **exactly as it was trained**, from
  frames recorded inside the training match. You see every element, both HIVEs, the FLOWER
  stacks, the score, the tips, the hopper and the current decision. Forced misses show as they
  happened.
- **No speed buttons.** Playback runs as fast as needed to keep pace with training (the speed shows
  next to the clock). With *follow live* on, the next generation loads when a replay ends.

**Side panel:**

| tab | what you can do |
|---|---|
| Overview | counters, DSIM score per generation (with your best replay and the greedy baseline as reference lines), fitness, how robots ended, the champion (watch it, copy its DSIM snippet, download its network, export metrics as CSV) |
| Checkpoints | save a named checkpoint; **Rewind here**, **Fork** into a new run (optionally with a new population or mutation size), **Pin** (never auto-deleted), **Delete** (type "delete" to confirm) |
| Settings | change evolution and fitness settings between generations (see below) |
| Evaluate | score any policy on held-out matches with a 95% confidence interval: the champion, the current policy, the greedy baseline, the imitation of your replays, or the champion of any checkpoint |
| Lineage | how a generation was made: elites, mutants, crossovers, each robot's id, parents (with their rank in the previous generation) and genes changed |
| Log | every event: settings changes, checkpoints, rewinds, evaluations, new champions |

**Bottom:**
- **What the robots choose to do:** the share of each option per generation. Evolution changing
  the order shows here.
- **Honeycomb:** one cell per generation. Click one to replay it.

## Checkpoints and rewind

A checkpoint is the whole run between two generations: every robot's network, the algorithm's state, the
settings, the champion and the history.
- **Automatic:** every 10 generations; the last 30 are kept.
- **Named:** click Save checkpoint. If you save during a generation, it is taken the moment that
  generation finishes.
- **Rewind:**
  - The run goes back to the checkpoint.
  - The present is saved first, as a pinned checkpoint called "before rewind", so a rewind can
    itself be undone.
  - Rewinding is exact: running the same generations again gives identical results (the gate
    proves it).
- **Fork:** makes a separate run starting at a checkpoint. The original run is untouched.

## Settings you can change mid-run

- **Evolution:**
  - Population.
  - Mutation size σ.
  - Share of genes mutated.
  - Crossover rate.
  - Elites kept unchanged.
  - Parent fraction.
  - Tournament size.
  - ES only: learning rate and weight decay.
- **What counts:**
  - The hint weights (per pickup, shot in, human-player entry) and how many generations they fade
    out over, so in the end only the DSIM score counts.
  - The penalties (rule violation, missed shot, physics exploit, HIVE-frame crash).
- **The robots' world:**
  - Matches per robot (more means less luck, and slower).
  - Episode type: full matches, AUTO only, or AUTO first.
  - Driver: exact, or with human reaction time.
  - Whether every life uses a new robot drawn from the REAL-v0 range.
- **Housekeeping:** CPU workers, checkpoint interval and how many are kept, generations kept on
  disk, and a generation limit.

Fixed per run: the algorithm, the seed, the robot profile and how generation 0 was made. To change
one of those, fork the run or create a new one.

## How a robot learns

- **One life = one full DSIM match**, solo, on the team's REAL-v0 robot:
  - A different robot from its range every life (speed, fire rate, turret travel, accuracy, size).
  - Misses at the launcher's accuracy.
  - Every rule guard on.
- **Start pose:** back against the blue wall just right of FLOWER F3 (bottom right as DSIM shows
  it), facing the field. It is legal for every robot size in the range.
- **Skills (`train/skills.ts`):**
  - **Paths:** planned around the HIVE frame and FLOWER feet with the S1 motion lab's speed law. A
    look-ahead safety layer stops the robot from swinging a corner into the frame (a G417 crash).
  - **Collecting:** the intake end faces the element, on a clear approach; elements against a wall
    are taken square to it.
  - **FLOWERs:** the robot drives an intake end square into the foot.
  - **Shooting:** from measured scoring spots. Fire is held whenever the aimed cell will be taking
    shots when the ball arrives, including during the other cell's swing after a tip.
- **The network** scores every option available right now: the field state plus that option's
  features (travel time, cluster size, FLOWER POLLEN, distance to a scoring spot after, whether
  it is on the up cell's side). The robot takes the best one.
- **Generation 0** can be mutants of a network fitted to **your replays** in `Training data/`
  (the default), or random networks.
  - Each human decision in a replay becomes a demonstration.
  - One replay is held out: the fitted network picks the same next option as you about 46% of the
    time, versus 11% by chance.
  - Add more replays to `Training data/` and new runs refit automatically.
  - Your runs used a front+back intake build, so only the order transfers. Fitness is always our
    own robot's DSIM score.
- **Algorithms:**
  - `GA` (default): a genetic algorithm with elites, tournament selection, crossover and mutation.
    Every robot has an id and parents.
  - `ES`: evolution strategies.

## Terminal-only training

```bash
npm run train -- --name solo --pop 128          # create or resume a run and train now, with a live dashboard
```

This is the same engine. Keys: `p` pause, `o` open the studio, `q` stop.

## Where things are

| path | what |
|---|---|
| `runs/<name>/checkpoint.json` | the run now (saved atomically every generation) |
| `runs/<name>/checkpoints/` | named, automatic and pinned checkpoints (state + history) |
| `runs/<name>/metrics.jsonl` · `events.jsonl` · `evals.jsonl` | per-generation statistics, the log, evaluations |
| `runs/<name>/gens/<n>.json` · `<n>.frames.json.gz` | every robot's path and choices; the best robot's exact frames (last 300 generations + every 100th) |
| `runs/<name>/best.*` | the champion: exact frames, DSIM replay, DSIM paste snippet |
| `Training data/` | your DSIM replays (imitation) |
| `outputs/imitation/policy.json` | the fitted imitation network + how well it agrees with a held-out replay |
| `profiles/real-v0.json` | the team robot's ranges: edit when the robot changes, then start a new run |

## Honest limits

- **Speed:** a full match costs ~1.8 s of CPU, almost all DSIM's own physics. With all cores but
  one, expect a few hundred robots a minute on the laptop; the M6 is faster.
- **Skills are not perfect.** The greedy baseline scores ~150–250 per match on the sampled real robot.
  - Your world-record replays score 790–825 on a faster two-intake build, tipping every 4 s.
  - Part of that gap is strategy, which is what evolution learns.
  - Part of it is skill quality: sweeping pickups, shooting on the move, and your build's speed.
  - Improving the skills later raises every run's ceiling.
- **The DSIM snippet** replays the champion's commands. Forced misses can land differently in DSIM.
  The studio's Champion view is the exact life.
- **Old run:** `runs/_ui-test` came from the first version (raw joystick control, which never learned
  to shoot). It is listed as an old version and cannot continue. Its files are untouched.

## Checks

```bash
npm run check:train     # the studio + trainer gate (41 checks, ~2 min)
npm run check:s0        # the DSIM harness (38 checks, ~5 min)
npm run check:s1        # the motion lab
npm run imitate         # refit the imitation network on Training data/ and report agreement
npm run typecheck
```
