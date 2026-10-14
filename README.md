# BIOBUZZ Strategy Learning Studio

**Made by FTC Team 19859.**

A self-training AI that plays simulated FTC BIOBUZZ (2026–27) matches to find:

- the best 30 s autonomous plan for each kind of alliance partner and start position (the **Playbook**),
- the driver-controlled routes that score most (the **Route library**),
- the mistakes to avoid (the **Mistakes** page, every mistake turned into a training drill).

Matches run in DSIM, an unmodified physics match simulator used as ground truth. See `MASTERPLAN.md` for the design
and results, `PLAN.md` and `TRAINING.md` for details.

## Run

```bash
./start.sh
```

Opens the studio on http://localhost:4747. Nothing trains until you press **Start**.
`./start.sh --install` runs it as a macOS service; `./start.sh --stop` stops it.

## Credit

Made by FTC Team 19859. If you use or build on it, please credit **FTC Team 19859**.
