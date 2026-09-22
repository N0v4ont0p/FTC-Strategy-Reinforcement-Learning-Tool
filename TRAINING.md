# BIOBUZZ Evolution — how to run training

Robots learn BIOBUZZ inside the real, unmodified DSIM simulator. You watch every generation live:
hundreds of robots spawn at the start line, most crash or stall, and the survivors' offspring get a
little better each time. Nothing here needs Claude — it runs on this Mac until you stop it.

## Start

```bash
npm run train
```

That starts (or **resumes**) the run called `solo`. It opens:

- **The viewer** in your browser at http://localhost:4747 — the field drawn by DSIM's own renderer.
- **The dashboard** in the terminal — counters, progress, fitness sparklines, the champion.

In the terminal: **`p`** pause/resume · **`o`** open the viewer · **`q`** stop (it finishes the
generation it is on, saves, then exits). Press `q` twice to leave immediately; the last finished
generation is always saved.

There is **no built-in end**. Training runs until you stop it, and `npm run train` picks up exactly
where it left off — a stop and a resume give the same result as never stopping (proven by
`npm run check:train`).

## What you are looking at

**Generation swarm** (the big field): every robot of one generation, replayed from its recorded
path, all starting from the same spot.
- **gold ring + trail:** the generation's best robot
- **faint robots:** everyone else
- **red ×:** a robot that died by touching the HIVE frame (rule G417)
- **yellow ○:** a robot that died from stalling (20 s without picking up, scoring or shooting)

With *follow live* on, the next generation loads when the current replay finishes.

**Champion match:** the best robot ever, played as a full match by DSIM's own replay player, with
balls, HIVE, and scoring. "Copy DSIM snippet" lets you watch it in the real DSIM app too: paste the
snippet into the Web Inspector console on the DSIM page (Safari: Develop → Show Web Inspector),
then open Records → Career.

**Every generation so far** (the honeycomb): one cell per generation, brighter = higher best score.
Click a cell to replay that generation.

**Charts:** fitness (best / mean / median) and how each generation's robots ended. "Show table"
gives every number as text.

## How a robot learns (what the numbers mean)

- **One life = one match.** A robot is a small neural network that sees the field (its pose,
  hopper, HIVE state, nearest elements, the measured shooting envelope…) and presses the same
  controls a driver has, ten times a second.
- **Fitness** = the real DSIM score − penalties + small hints.
  - Penalties: rule violations, wasted shots, exploiting DSIM physics bugs, crashing.
  - Hints (pickups, shots in, human-player entries) fade to zero over the first 3,000
    generations, so in the end only the real score counts.
- **Every life uses the team's REAL-v0 robot**, sampled from its range each time: turret travel,
  fire rate, speed, accuracy, and so on, with human reaction time. So it learns for the robot you
  will actually have, not the dream build.
- **Curriculum:** robots first learn AUTO (30 s episodes, fast). Once the best AUTO score holds ≥ 28
  for 20 generations in a row (and at least 30 generations have run), they move on to full 2:30
  matches.
- **Algorithms:**
  - `es` (default): evolution strategies. The population explores around one "parent" brain
    that moves in the direction of what worked.
  - `ga`: a genetic algorithm. The best robots breed mutated children — the classic "AI learns
    to drive" look.

## Options

```bash
npm run train -- --name solo2 --fresh          # a new run (never overwrites an existing one)
npm run train -- --algo ga --pop 512           # genetic algorithm, 512 robots per generation
npm run train -- --workers 10                  # use more CPU cores (the M6: try 10–12)
npm run train -- --stage full                  # skip the AUTO curriculum
npm run train -- --driver oracle               # perfect inputs instead of human reaction time
npm run train -- --fixed-robot                 # always the nominal REAL-v0 instead of sampling
npm run train -- --max-gens 500                # stop by itself after 500 generations
npm run train -- --plain                       # one line per generation (no full-screen dashboard)
```

Changing `--algo`, `--pop`, or `--seed` means a new run: use a new `--name`. On resume, only
`--workers` and `--max-gens` change.

## Where things are

| path | what |
|---|---|
| `runs/<name>/checkpoint.json` | everything needed to resume (saved atomically every generation) |
| `runs/<name>/metrics.jsonl` | one line of statistics per generation |
| `runs/<name>/gens/<n>.json` | every robot's path for generation n (last 300 + every 100th kept) |
| `runs/<name>/best.replay.json` · `best.inject.js` | the champion's DSIM replay + the paste snippet |
| `profiles/real-v0.json` | the team robot's ranges — edit when the robot changes, then start a new run |

## Honest limits

- The champion's watchable replay can differ slightly from its training life. Training forces some
  shots to miss (the real launcher's accuracy), and DSIM's replay only re-applies commands; the
  viewer says when this applies.
- Speed depends on the machine and its temperature: 6,000–12,000 full matches an hour on the M5
  laptop with 8 workers; AUTO-only generations are ~5× faster.
- A generation's robots all start from the same anchor with the same match seed, so they are
  compared fairly. The anchor changes from generation to generation.

## Checks

```bash
npm run check:train     # the training platform (23 checks, ~15 s)
npm run check:s0        # the DSIM harness (38 checks, ~5 min)
npm run check:s1        # the motion lab (every gate on outputs/s1)
npm run typecheck
```
