# Validation tools

Measure CourtSense against something fixed before changing how it works. None of these change the app.

| Command (from the repo root) | What it measures | Cost |
|---|---|---|
| `node validate/snapshot.ts` | Today's results on the real session (metrics, the assistant's moments) vs. the frozen baseline. `--save` refreezes. | $0 |
| `node validate/synthetic.ts` | Accuracy against a known ground truth: simulated sessions through the app's own `analyze()`. `--save` refreezes. | $0 |
| `node validate/coach-eval.ts` | AI Coach test set with a scripted fake model: should a given answer reach the coach? The 13 Phase 0 cases, plus extra cases that try to game the check. `--save` refreezes. | $0 |
| `node validate/coach-live.ts [--cap 0.15] [--report]` | Real Muse Spark answers on the real session (and with `--report` the English report), checked by the app and audited offline. $0.50 is the total for all live runs: what earlier runs spent is subtracted first. | ≤ cap |
| `node validate/annotate/pick.ts`, then `node validate/annotate/server.ts` | Hand-marking page at http://127.0.0.1:3461: mark both players' feet in 40 frames (plus 5 shown again). Frames and marks stay in `data/` on this machine. | $0 |
| `node validate/annotate/compare.ts [--save]` | Hand marks vs. what the app computed, per side, in meters (with 95% intervals) and pixels; how repeatable the marks are; what the numbers do not show. Gives no numbers until at least 10 positions are marked. `--save` freezes the result as the before/after baseline. `--self-check` tests the math. | $0 |
| `node --test lib/*.test.ts validate/*.test.ts` | Unit tests: the claim check, the agent loop, the report rewrite, the budget guard. | $0 |

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

## How the claim check works

Every number Muse Spark writes for the coach, in an answer or in the report, must be listed as a claim: player, metric, value, unit, and the moment for timed metrics. `lib/claims.ts` checks two things:
- **The claims.** Each claim is checked against the session's facts: the values the tools show, rounded the same way. A wrong value, player, unit or moment is refused. So is a value with more decimals than the data. Fewer decimals are fine.
- **The text.** Every number in the text must match a claim:
  - in the claim's unit;
  - after the claim's player, when the sentence names one;
  - not next to another metric's words, such as "peak" on an average;
  - with "about" or "yaklaşık" when the player's depth is unreliable.

A refused answer goes back to the model with the reasons. After three refusals the coach gets it marked as not verified. The report gets one rewrite, then it is saved with its verdict.

**Limits:**
- The text check is a heuristic.
  - A number belongs to the last player named before it. A pronoun carries the previous sentence's player.
  - Turkish relative clauses such as "567 m koşan Oyuncu A" are refused and must be rephrased.
- Only numbers are checked. A comparison or conclusion in words ("more than Player A", "pace dropped") is not.
- Numbers written as words ("seven times") are not read. The prompt asks for words only for numbers that are not data, but nothing enforces it.
- Derived numbers are refused even when the arithmetic is right: differences, sums, ratios, per-minute averages. The model has to give the underlying values instead.
- Whole numbers are not rounded: 570 for 567 is refused.
- A time the assistant showed or watched (`shown_time`) is accepted as a reference. What the vision model says it saw there is not checked.

## Checking the coach and report in the browser without API calls

`COURTSENSE_FAKE_MODEL=good` (or `=bad`) swaps Muse Spark for a scripted local model (`lib/fake-model.ts`) and disables SAM. With `MODEL_API_KEY=` left empty as well, Next does not load the key from `.env.local`, so no paid call can be made:

```
COURTSENSE_FAKE_MODEL=good MODEL_API_KEY= npm run dev -- --port 3457
```

- `good`: the coach answer and the report pass the claim check (verified badge).
- `bad`: one number is wrong every time. The answer is refused twice, then shown as not verified, and the report stays not verified after its rewrite.

Every fake answer starts with "(Fake model, no API call.)". Use a separate job folder for the check, because generating a report overwrites that job's `report.<lang>.md`.
