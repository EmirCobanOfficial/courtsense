# CourtSense

Movement data from a tennis coach's training video, built on Meta **SAM 3.1** and **Muse Spark 1.3**.

> Built during the **Meta Global AI Developer Hackathon** (Oct 26 – Nov 4, 2026). Nothing in this repository existed before the hackathon; the commit history shows the build.

Demo video (3 min): https://youtu.be/fbqArD7z1YA

## What it does

A club coach films practice with one fixed camera behind the baseline. CourtSense turns that footage into numbers:

- **Upload** the session and pick the part to analyze (start / end time).
- **SAM 3.1** (Meta Model API, video segmentation) finds and tracks both players through every frame.
- **Four clicks** on court-line intersections calibrate the camera; every foot position becomes a point on the court, in meters.
- **Metrics** per player: distance, average and peak speed, time behind the baseline / at the baseline / mid-court / at the net, left / center / right split, side changes, and a measurement-confidence score.
- **Heatmap** (bird's-eye) and the **SAM masks drawn on the video**, rendered in the browser with Meta's `@meta-sam/react` and `@meta-sam/graphics`.
- **Coach assistant**: a Muse Spark agent answers questions such as "Where did Player A run fastest?". It chooses its own tools, jumps the masked video to the moment it talks about, can watch a short clip (Muse Spark video understanding), and every number in its answer is checked against the data before the coach sees it.
- **Coach report** written by Muse Spark from the measured numbers only.
- English UI with a Turkish switch (the coach's language); the agent and the report answer in the selected language.

## How it works

```
video ──ffmpeg (1080p, 15 fps)──▶ SAM 3.1 "tennis player" ──▶ tracks.json (boxes per object id per frame)
                                                                   │
            4 calibration clicks ──▶ homography (image px → court m)
                                                                   ▼
             playerPositions(): foot points → court meters, bystanders and frame-edge boxes dropped,
             SAM id reuse handled, far-side net fix, 1 s smoothing
                                                                   ▼
             metrics · heatmap · masks on video · coach assistant · report
```

Details that matter for accuracy:

- **Far-side net occlusion.** With a low camera the net often hides the far player's feet, which only ever cuts the SAM box short from below. Taking the lowest box bottom within ±0.5 s cut the far player's depth noise from 2.4 m to about 0.4–0.55 m.
- **Honest numbers.** Each player's frame-to-frame depth noise is measured; above 0.3 m the distance, speed and zone values are shown as rough (`~`) and the agent and report say so. Left / right stays reliable.
- **Tracking hygiene.** People outside the court (benches, the next court) are filtered by position; SAM sometimes hands a player's id to someone else later, so each id only counts inside the frame span where it belonged to that player; boxes cut by a frame edge are dropped.
- **Cost.** SAM 3.1 video is $0.20 per 1,000 frames: a 12-minute session (10,688 frames) costs about $2.14. Results are cached on disk, so re-uploading the same file never pays twice.

## The coach assistant

The agent follows the loop from Meta's [legal-agent-workshop](https://github.com/meta-models/legal-agent-workshop): each turn Muse Spark 1.3 picks **one** tool (Responses API, `parallel_tool_calls: false`, `store: false` with encrypted reasoning replayed), our code runs it and sends the result back, up to 8 turns.

| Tool | What it does |
|---|---|
| `get_metrics` | session metrics per player, with reliability notes |
| `find_moments` | fastest 1 s moments, longest runs, visits to the net, in video time |
| `minute_breakdown` | meters per full minute |
| `show_moment` | jumps the coach's masked video to a time |
| `look_at_clip` | cuts 2–8 s of the video and asks Muse Spark what is visible |
| `answer` | the final answer; **verification runs here** |

Verification sits inside the `answer` tool, so the model cannot skip it: every number in the answer (decimals with a comma or dot, percentages, m:ss times) must appear in an earlier tool result. A refused answer goes back to the model with the offending numbers; after three refusals the answer is shown as "Not verified". The route streams each step to the UI as NDJSON.

## Code map

| Path | |
|---|---|
| `lib/court.ts` | court geometry, homography (DLT) |
| `lib/metrics.ts` | tracks → court positions → metrics and heatmap |
| `lib/jobs.ts` | job storage and processing (ffmpeg, SAM 3.1 request, caching) |
| `lib/coach.ts` | the agent: tools, loop, grounding check |
| `lib/report.ts` | Muse Spark coach report |
| `lib/i18n.ts` | English / Turkish UI strings |
| `app/page.tsx` | the UI (upload, calibration, metrics, report) |
| `app/components/` | `MaskVideo` (SAM masks on video), `Heatmap`, `CoachChat` |
| `app/api/jobs/…` | upload, video (HTTP Range), SAM output, calibration, report, ask (agent stream) |
| `scripts/demo/render-hero.ts` | renders the demo video's mask + bird's-eye clips from the same data |
| `lib/*.test.ts` | unit tests (`node:test`) |

## Run it

Requirements: Node 22.18+ (the tests run TypeScript directly), `ffmpeg` and `ffprobe` on the PATH, and a Meta Model API key.

```bash
npm install
echo "MODEL_API_KEY=your-key" > .env.local
npm run dev            # http://localhost:3000
node --test lib/*.test.ts
```

Upload a video, set the analysis start and end, wait for SAM 3.1, click the four court points, and save.

## Limitations

- No ball tracking: SAM 3.1 mistook ceiling lights and signs for the ball in our footage, so there are no shot or score statistics.
- With a low camera the far player's depth is rough; the app marks it rather than guessing.
- Slow camera drift (gimbal pan) is not compensated yet.
- One SAM request covers up to 15,000 frames (about 16 minutes at 15 fps).

## Privacy

Training videos and SAM outputs stay in `data/`, which is git-ignored. The players consented to the recording being used for this project.

## License

MIT, see [LICENSE](LICENSE). The `@meta-sam/*` packages it depends on are under Meta's SAM License.
