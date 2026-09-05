# Ghostty release readiness

Status on 2026-09-05: migration in progress, not ready for a stable release.
The branch uses Ghostty by default on capable webviews. xterm remains installed
for block terminals and final backend selection fallback.

## Verified hardening

- PTY acknowledgments are cumulative parsed-byte offsets. Rust accepts only
  previously sent boundaries, tolerates duplicates and reordering, and keeps
  the 2 MiB data bound and two-chunk window during exit as well as normal output.
- Rejected acknowledgments retain progress and retry with capped backoff.
  Hung IPC calls are bounded to two; stalled delivery is visible. Asynchronous
  parsing preserves byte order, and failed parsing never returns credit.
  Permanent IPC failure requires connection recovery; it cannot be repaired by
  inventing credit or discarding protocol bytes.
- Reader EOF and condition-variable notifications share the queue mutex.
  Exit waits for all final bytes to be parsed. Session registration cannot reap
  a child solely because the child exited before registration completed.
- Windows closes ConPTY while the reader remains alive through EOF, replacing
  the 50 ms final-output heuristic. Explicit close wakes bounded queue workers.
  Input pipe writes run off the IPC dispatch thread so backpressure cannot
  prevent acknowledgment commands from executing.
- Dirty rows reuse persistent hyperlink IDs. The hash table stores offsets into
  owned URI storage, so terminal page recycling and URI-buffer reallocation do
  not invalidate keys. Full damage clears the table with the associated buffers.
- Mode snapshots retain their object identity while modes are unchanged, but
  native mode bits are refreshed before semantic callbacks and on public reads.
- SIMD and scalar WASM artifacts use the same pinned Ghostty source and bridge.
  Backend selection no longer sends non-SIMD webviews to xterm solely for SIMD.
  The loader fetches one artifact per webview.
- Diagnostics load independently of xterm. Native snapshots expose pending and
  in-flight bytes, message counts, sent and acknowledged totals, EOF, close
  status, and host RSS. Snapshot reads start no rendering or periodic sampling.
- Ghostty startup failures remain in the pane with a retry action instead of
  being routed as shell exits. Late failures cannot affect replaced sessions.
  A shell that exits during startup is not reattached as a live PTY. Initial
  fitting does not issue a redundant same-size resize immediately after spawn.
- Renderer replacement adopts the native selection immediately and transfers
  search navigation without resetting the query or advancing past a match.
  Replacement uses current font, theme, and cursor settings. Failed replacement
  releases its partial resources and retains session ownership. Exhausted WebGL
  recovery displays a Retry display action that replaces presentation without
  restarting the PTY or disposing the model.
- Shared cwd and grid-selection APIs route to the owning Ghostty session.
- Native macOS occlusion/sleep joins DOM visibility in a shared presentation
  policy. Frames stop immediately; a two-second grace avoids resource churn
  during short desktop transitions. Sustained invisibility and sleep reclaim
  presentation without losing model state.
- Per-pane deadlines use RAF timestamps, avoiding callback jitter and focused
  panes pulling background panes to 60 fps. WebGPU bounds outstanding frames
  to two, defers hidden device recovery, and owns staging and replaced textures
  through submission. Font/DPR changes apply correctly after a pause.
- A bounded warm CPU glyph cache avoids rasterizing glyphs again after short
  occlusion. Uploads cover only occupied pixels. Disposed WebGL CPU arrays and
  raster canvases are released explicitly, and idle reclamation survives other
  renderer acquisitions.
- An explicit ten-minute resource recorder retains at most 600 samples. The
  reproducible five-model WASM stress run reaches a memory plateau for both
  artifacts. See [resource efficiency](ghostty-resource-efficiency.md).

## Local verification

Completed on macOS arm64:

- Frontend type checking, 150 test files / 972 tests, production Vite build,
  and size budgets. Lint exits successfully with 97 existing warnings and one
  informational diagnostic; the added terminal files have no lint diagnostics.
- Rust Clippy with warnings denied and 333 Rust unit and integration tests.
- macOS arm64 release application compilation with `pnpm tauri build --no-bundle`.
  A local `.app` is built with updater artifact signing disabled using the
  command below. Release updater signing requires the release private key.
  Neither build validation establishes packaged GUI behavior or installer size.
- Local bundle signatures pass `codesign --verify --deep --strict` after ad-hoc
  signing the CLI and application. This is local validation, not notarization.
- Both artifacts pass the same adapted-core tests, including a 5,000-update
  persistent-link regression and growth across multiple URI buffer allocations.
- A Rust validator accepts the scalar artifact with SIMD types and instructions
  disabled and rejects the SIMD artifact under the same restriction. The SIMD
  artifact does not require relaxed SIMD.
- Startup graph checks keep xterm out of both normal startup and diagnostics.

Full Windows cross-compilation was attempted, but this host lacks the Windows
C headers required by `ring` (`assert.h` was unavailable). This is not Windows
validation. Windows, Linux, old webviews, and packaged GUI testing remain open.

### Artifact costs

| Artifact | Raw bytes | Production Vite gzip |
| --- | ---: | ---: |
| SIMD | 705,529 | 210.59 kB |
| Scalar | 710,519 | 210.61 kB |

The scalar variant adds one artifact to the installed bundle; a running webview
loads only one. The combined `size-limit` gzip budget is 450 kB. Existing JavaScript
budgets remain unchanged. SHA-256 values and rebuild instructions live in
`packages/ghostty-core/adapted/UPSTREAM.md`.

### Isolated SIMD comparison

One local run of `pnpm bench:ghostty` on an Apple M5 with 16 GiB RAM, Node
26.5.0, and Vitest 4.1.11, with both artifacts from the same source revision,
measured:

| Operation | SIMD operations/s | Scalar operations/s |
| --- | ---: | ---: |
| Parse bounded streaming fixture | 15,619 | 9,451 |
| Write and synchronize one changed row | 1,006,074 | 831,532 |
| Synchronize unchanged viewport | 2,416,799 | 1,636,612 |

These measurements isolate core execution. They do not measure Tauri IPC,
two-message-window throughput, webview GPU presentation, process memory, energy,
or long-duration stability. Do not use them as application performance claims.

## Release gates still open

| Gate | Required evidence or implementation |
| --- | --- |
| Ghostty blocks | Tracked command ranges through pruning and reflow, block overlays, sticky headers, search, input modes, navigation, copy, and Ask AI |
| Accessibility | Accessible output and scrollback with real screen-reader validation, beyond the current input label |
| Product events | Title, bell, and notification routing; plain-text URL detection |
| Renderer recovery | Packaged GPU/context loss, recovery exhaustion, font/DPR changes, hidden panes, and sleep/wake; preserve model, PTY, selection, and history |
| Shell and input parity | Fish/Starship drag resizing, zsh, bash, pwsh, cmd, WSL, IME, dead keys, AltGr, mouse protocols, synchronized output, and agent TUIs |
| Glyph resources | Cold-glyph eviction under Unicode, emoji, and Nerd Font pressure; verify shared and isolated atlas bounds |
| Scheduling | Per-pane pacing, RAF timestamps, native macOS occlusion, and bounded submissions are implemented; packaged cadence, sleep/wake, resize churn, and other-platform occlusion still need measurements |
| Transport throughput | Packaged 100 MiB plain and ANSI output with end-to-end parsing completion and fault injection, including final output and ConPTY close |
| Memory and energy | Attributed host, WebContent, and GPU processes; 1/5/10/20 tabs, hidden streaming, sustained agents, and multi-hour or multi-day timelines |
| xterm removal | Complete the feature and platform gates, then remove runtime dependencies, addons, CSS, pool, snapshots, DormantRing, and compatibility API seams |

The checked-in Tauri configuration currently declares macOS 13.0 as its minimum
(the migration handoff and earlier TERAX.md text said 10.15). The configuration
was not changed by this hardening pass.

The scalar artifact addresses the instruction-set dependency; it does not by
itself certify all supported WebKit versions or change the OS support policy.
Kitty graphics support is also incomplete and needs an explicit product decision
and implementation before it can be advertised.

## Collecting release evidence

### First local GUI pass

```sh
pnpm tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
codesign --force --sign - src-tauri/target/release/bundle/macos/Terax.app/Contents/MacOS/terax-cli
codesign --force --sign - --entitlements src-tauri/entitlements.plist src-tauri/target/release/bundle/macos/Terax.app
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/Terax.app
```

Use the new local app bundle without replacing the installed daily-driver build:
`src-tauri/target/release/bundle/macos/Terax.app`. The build shares the existing
application identifier and settings; it is not a separate user-data profile.

1. Start Fish with Starship, run several commands, then drag split boundaries
   continuously. Check prompt completeness, glyph geometry, final shell width,
   and normal colors in inactive splits.
2. Select output while an agent streams, copy it, and attach it to AI. Search
   through scrollback, switch tabs, and return to the same selection and match.
3. Run a command that emits substantial output and immediately exits its shell.
   Check the final output is delivered before the terminal exit behavior.
4. Open several tabs and splits, hide streaming tabs, minimize and restore the
   window, then close the tabs. Capture diagnostics before and after this cycle.
5. Exercise emoji, Nerd Font glyphs, OSC 8 links, IME input, bracketed paste,
   alternate-screen TUIs, and your usual coding agents.

6. Switch desktops repeatedly, cover the window completely, and sleep/wake.
   Capture a resource trace and attributed process memory using the
   [resource workflow](ghostty-resource-efficiency.md#capturing-a-desktop-transition-trace).

These checks help identify regressions in this hardening build. They do not
close the feature, platform, and sustained-resource release gates above.

### Diagnostic snapshots

Enable diagnostics, reload, and capture the following before and after each
identical workload on xterm and Ghostty builds:

```js
localStorage.setItem("terax:terminal-diagnostics", "1");
// After reload:
window.__teraxTerm();
await window.__teraxTermSnapshot();
```

`native.hostRssBytes` covers the Rust host only. Collect WebContent and GPU
process attribution separately. WASM and GPU allocation counters describe
owned allocations and must not be added blindly to process RSS because that
would double-count memory. Transport throughput uses differences in parsed or
acknowledged byte counters over elapsed time; shell timing alone can end before
the frontend finishes parsing. Keep diagnostics disabled for final idle-energy
measurements unless the cost of sampling is recorded separately.
