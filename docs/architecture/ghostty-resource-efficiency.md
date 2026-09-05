# Ghostty resource efficiency

This pass addresses avoidable presentation churn, GPU backlog, and resource
ownership around desktop transitions, occlusion, and sleep. It does not yet
attribute the reported Activity Monitor spike to a specific process or prove
multi-day application memory and energy stability.

## Window lifecycle

One shared frontend subscription combines DOM visibility with native macOS
window occlusion and workspace sleep/wake notifications. Native snapshots have
monotonic revisions so a late initial IPC response cannot overwrite a newer
event. Duplicate notifications do not restart reclamation timers. Native
observers are removed on application exit, and frontend subscriptions are
released after the final consumer closes.

AppKit reports whether any part of the window is visible. A partly covered
window remains eligible for rendering; an unfocused visible window is paced at
15 fps. This follows [NSWindow occlusion semantics](https://developer.apple.com/documentation/appkit/nswindow/occlusionstate-swift.property).
Linux and Windows currently use DOM visibility and window focus; equivalent
native covered-window reporting is not implemented there.

| State | Presentation behavior |
| --- | --- |
| Visible, focused pane | Damage-driven, at most 60 fps |
| Visible, background pane | Independent deadline, at most 30 fps |
| Visible, unfocused window | At most 15 fps per pane |
| Hidden or fully occluded window | Frames, blink timers, search work, and selection autoscroll pause immediately |
| Invisible for less than two seconds | Retain presentation to avoid desktop-transition allocation churn |
| Invisible for at least two seconds | Release surface buffers, native render state, canvas configuration, and atlas textures; destroy WebGL contexts |
| Native sleep notification | Request immediate reclamation |
| Hidden terminal tab | Release its presentation lease immediately |

All states retain the PTY and terminal model. The OS and webview determine when
sleep notifications reach JavaScript, so native notification delivery and
actual GPU process memory reclamation still require packaged tests.

WebGPU retains at most one unused CPU glyph cache for the existing 30-second
idle lifetime. Its coverage pixels cost 1 MiB; color pixels add 1 MiB only after
emoji use. Glyph maps add bounded metadata. Hidden caches have no GPU textures
or full raster canvas. Restoring the cache preserves glyph coordinates and
uploads only its occupied rectangle. Font and DPR changes during a pause use
current metrics when presentation resumes.

## Submission and ownership

Per-pane deadlines preserve the shared encoder while preventing focused output
from pulling background panes to 60 fps. RAF timestamps prevent callback
jitter from skipping eligible frames. Timers account for the next animation
frame instead of waiting a complete interval before requesting it.

At most two WebGPU frames await completion. Dirty work coalesces while the GPU
is behind, without generating new uploads or submissions. One
[`onSubmittedWorkDone`](https://gpuweb.github.io/types/interfaces/GPUQueue.html#onSubmittedWorkDone)
promise serves each submission and its atlas staging allocations. Replaced
atlas textures remain valid through submission, and submitted staging buffers
stay explicitly owned until completion or disposal.

Device loss releases presentation and defers device recreation while hidden.
Late device acquisition after disposal destroys the acquired device. A
replacement lost during initialization is quarantined instead of starting an
unbounded recovery loop. Existing fallback and Retry display flows retain the
model and PTY.

Additional fixes include uploading the replacement atlas after overflow,
transactional cleanup of failed texture allocations, retaining WebGL idle
reclamation while another slot is acquired, and dropping disposed CPU arrays
and raster canvas storage explicitly.

## Reproducible core stress run

Run without launching Terax:

```sh
TERAX_SOAK_REPORT=/tmp/terax-ghostty-soak.json pnpm soak:ghostty
```

The workload runs five real WASM models through 64 epochs of 2,048 updates,
including colors, Unicode, emoji, OSC 8 links, scrollback pruning, hidden
parsing, presentation release, and resize compaction. Each model has a 10,000
line / 8 MiB scrollback setting. The run crosses the 100,000 render-update
renewal threshold and asserts at most one WASM page of growth in the final
16 epochs.

One local run on Apple M5, Node 26.5.0, macOS arm64:

| Variant | Updates | Input bytes | Elapsed | Final WASM memory | Growth in final 16 samples |
| --- | ---: | ---: | ---: | ---: | ---: |
| SIMD | 655,360 | 62,069,760 | 12.96 s | 67.5 MiB | 0 bytes |
| Scalar | 655,360 | 62,069,760 | 14.32 s | 67.5 MiB | 0 bytes |

The [raw sample report](ghostty-resource-soak-2026-09-05.json) preserves the
recorded timeline and CPU measurements.

These are accelerated core measurements, excluding IPC, WebKit, GPU, total app
RSS, and energy. Node RSS in the optional JSON report is labeled separately;
the variants run sequentially in one process, so that RSS cannot compare their
individual memory cost. WASM memory retains its allocator high-water mark while
models remain alive. The existing runtime releases the WASM instance after the
last model closes and its 60-second idle deadline expires.

Regression tests additionally cover 1,000 rapid window transitions without
surface buffer recreation, selection preservation through reclamation, font
and DPR changes while paused, two-frame GPU backlog bounds, stale native
snapshots, late cleanup, and focused/background pane pacing.

## Capturing a desktop-transition trace

Enable diagnostics in the new test build and reload:

```js
localStorage.setItem("terax:terminal-diagnostics", "1");
// After reload:
var resourceTrace = window.__teraxTermTrace();
// Switch desktops, cover/uncover the window, or sleep/wake.
// Return to the inspector, then capture the JSON:
JSON.stringify(resourceTrace.stop());
```

The recorder samples once per second and on presentation transitions. It keeps
at most 600 samples, stops automatically after ten minutes, and replaces any
previous recording. It starts no PTY workload and does not collect terminal
output. Normal startup has no recorder or sampling timer. Disable diagnostics
for final idle energy measurements, since recording has its own cost.

Compare timestamps with separately attributed Terax host, WebContent, and GPU
process memory. `await window.__teraxTermSnapshot()` adds native PTY queue
counters and host RSS; host RSS alone is not total application memory. Owned
allocation estimates must not be added to process RSS, which would double-count
memory. GPU canvas estimates exclude compositor and driver allocations.

## Build verification

The final macOS arm64 candidate passed 150 frontend test files / 972 tests,
TypeScript checking, lint, 333 Rust tests, Clippy with warnings denied, and the
production application build. Lint retains the repository's 97 existing
warnings and one informational diagnostic. The local app signature verifies
with `codesign --verify --deep --strict` after ad-hoc signing.

Existing compressed size budgets pass: startup JavaScript 383.84 kB, total
client JavaScript 1.58 MB, Ghostty JavaScript 53.16 kB, and both WASM artifacts
414.8 kB. No budget was raised for this resource-efficiency pass.

## Remaining release evidence

Packaged macOS desktop changes, native occlusion, sleep/wake, mixed-DPR displays,
Fish/Starship resize, and real GPU loss need direct validation. Linux WebKitGTK
and Windows WebView2 also need platform runs. A transient process RSS spike
cannot be declared fixed solely because owned allocations are bounded.

Run matching baseline and candidate workloads with 1, 5, 10, and 20 tabs,
including hidden agent output and at least an all-day session. Record throughput,
input latency, frame cadence, host/WebContent/GPU memory, and idle/streaming
energy. Exact canvas resizing, scroll-aware GPU storage, and cold-glyph eviction
remain measured optimization candidates. This pass does not establish battery
savings or eliminate the broader migration release gates.

## Ghostty-only block workload

The final migration removes the xterm parser and compatibility resources entirely.
Block metadata retains at most 1,000 records and 512 KiB of estimated UTF-16 text;
native markers retain at most 2,048 tracked pins. Block code and UI are lazy.
Accessible text is opt-in and limited to 256 rows / 64 KiB with 250 ms coalescing.
OSC clipboard writes retain one in-flight call and the newest pending value.

Run native command tracking under the same streaming/reflow workload with:

```sh
TERAX_SOAK_BLOCKS=1 TERAX_SOAK_REPORT=/tmp/terax-block-soak.json pnpm soak:ghostty
```

The [recorded block run](ghostty-resource-soak-2026-09-05-blocks.json) uses five models,
655,360 writes and 62,684,160 bytes per artifact. SIMD completed in 13.59 seconds,
scalar in 15.29 seconds. Both plateaued at 71,434,240 bytes (68.125 MiB) of WASM
memory with zero growth in the final 16 epochs. The marker rings stayed bounded
at 2,048 pins per model. This does not measure full application RSS or battery use.
