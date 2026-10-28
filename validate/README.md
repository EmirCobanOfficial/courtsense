# Validation tools

Measure CourtSense against something fixed before changing how it works. None of these change the app.

| Command (from the repo root) | What it measures | Cost |
|---|---|---|
| `node validate/snapshot.ts` | Today's results on the real session (metrics, the assistant's moments) vs. the frozen baseline. `--save` refreezes. | $0 |
| `node validate/synthetic.ts` | Accuracy against a known ground truth: simulated sessions through the app's own `analyze()`. `--save` refreezes. | $0 |
| `node validate/coach-eval.ts` | AI Coach test set with a scripted fake model: should a given answer reach the coach? `--save` refreezes. | $0 |
| `node validate/coach-live.ts [--cap 0.5]` | Real Muse Spark answers on the real session, audited offline. Hard cap, at most $0.50. | ≤ cap |
| `node --test validate/*.test.ts` | Unit tests of the budget guard. | $0 |

`snapshot.ts`, `coach-eval.ts` and `coach-live.ts` need the session data in `data/d8650763e4d0` (git-ignored). `synthetic.ts` falls back to the noise model saved in `baseline/synthetic.json` when the data is not there.

## How the synthetic ground truth works

`sim.ts` moves two players along drill-like paths (speeds up to 4.2 m/s, acceleration limited to 4 m/s²). A camera built from the real calibration projects their feet into SAM-like boxes. Three noise sources are applied:
- box-bottom jitter with frame-to-frame correlation;
- dropped frames;
- the net cutting the far player's box short.

The noise model is matched to the real session on three things:
- the box height vs. foot row (fitted);
- the depth noise the app reports per player;
- how far the far-side fix moves the slow far player.

**Limitation:** the far player is not fully matched. The simulated depth noise comes out at 0.19 m against the real 0.41 m, while the fix shift does match. The real far-side error has a structure the model lacks, such as occasional large jumps. Far-player numbers are therefore indicative. Only hand-marked foot positions from the real video can pin them down.

## How the budget guard works

`budget.ts` wraps the API client:
- **Before each request:** it prices the worst case. Input tokens are counted as at most the request bytes plus overhead, and output tokens as at most `max_output_tokens`. If spent plus the worst case would pass the cap, the request is refused before it is sent.
- **After each request:** it books the real usage.
- **Failed calls:** these are charged at their worst case.
- **Video, image and file input:** refused, because their size cannot be bounded in advance. This means `look_at_clip` does not run in live checks.
