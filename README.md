# sokoban-solver-01 — push-optimal Sokoban solver

[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/kinoy-1/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/kinoy-1/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for [the make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121) — one program answers all 5 instances of a set in under a second, in exactly P\* pushes.

## The idea

The level's rooms are provably independent: a box pushed out of its room through the door can never be pushed back (the player would have to stand on the hallway's far side, which is wall), so every box stays in its room and the level's push-optimal count P\* is the sum of its rooms' optima. The solver therefore splits the level into rooms — by cutting the dead squares of the hallway row — and solves each 3–4-box room push-optimally with A\* over pushes:

- **Admissible heuristic**: min-cost assignment of boxes to goals by walking distance (DP over goal subsets), so A\* returns the fewest pushes, not just a solution.
- **Exact dead-square pruning**: pull-back analysis from the goals; a box on a dead square can never reach a goal again.
- **Frozen 2×2 pruning**: a box wedged in a wall-and-box 2×2 block is dead.
- **Deterministic by work, never by clock**: every search is bounded by a fixed state cap, so two runs write the same bytes.

Fallbacks (only for levels that are not a set of rooms): whole-level push A\*, greedy best-first per room, then a move-based A\* that minimises pushes first. An unsolved level still writes a valid empty answer — the run never crashes.

## Results

| Set | Score | Pushes vs P\* |
|---|---|---|
| Practice (kit) | **1,000,000** | 13/13, 16/16, 29/29, 47/47, 60/60 |
| 13 freshly drawn sets (kit generator, random seeds) | **1,000,000 each** | 65/65 instances exactly at P\* |

House baseline (plain-astar 1.0.0) on the same fresh sets: 400,000 / 288,235 / 85,714. Runtime ≈ 0.4 s per set (limit 60 s).

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22+ runs `main.ts` directly (erasable TypeScript, standard library only). It reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` (LURD moves, upper-case letters mark pushes).

<sub>Entered on [make.fun](https://make.fun/?ref=qzezv1jd&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards · Referral code: `qzezv1jd`</sub>
