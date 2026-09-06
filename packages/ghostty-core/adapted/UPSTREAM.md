# Terax Ghostty WASM adaptation

This is the production-candidate terminal core for the pooled Terax renderer
architecture. It adapts the mature bulk render-state bridge from Restty
without importing Restty's application runtime, PTY transport, perpetual
per-terminal frame loop, or per-pane GPU lifecycle.

- Ghostty source: `https://github.com/ghostty-org/ghostty`
- Ghostty commit: `349f026087d948f8f898dca3231ff91438f83ab8`
- Restty source: `https://github.com/wiedymi/restty`
- Restty commit: `7700b14a7643ba9240818209ef1e0aa90d83ad77`
- Zig: `0.16.0`
- Optimization: `ReleaseFast`, WebAssembly SIMD and scalar variants
- SIMD artifact size: `708426` bytes
- Scalar artifact size: `713453` bytes
- SIMD SHA-256: `b41c89cd5463fd4493432b5593f1e86b31597174bbdc9c43891eaf1243571fd6`
- Scalar SHA-256: `6292f24c619279d6d4872b9b697728780f755639ddd8b73f2d9b73370b4332f7`

Terax-specific changes include:

- rebasing the bridge onto the pinned current Ghostty API;
- Ghostty `TinyIo`, avoiding the binary and runtime overhead of threaded I/O;
- independent hard byte and line limits for scrollback;
- a 256 KB maximum retained terminal-reply queue per terminal;
- raw `Uint8Array` PTY writes and replies with no UTF-8 round trip;
- prompt input capability for shells that need direct input instead of blocks;
- native Ghostty key encoding and terminal mode queries in the same instance;
- native tracked selections that survive streaming and reflow, clamp when
  partially pruned, and release their tracked pins deterministically;
- bounded parser-owned semantic events for shell and product integration;
- optional parser-time command markers with 2,048 tracked pins per terminal,
  exact endpoint columns, full signed exit codes, and deterministic cleanup;
- parser-time block invalidation for primary-screen clear and reset, retaining
  bounded marker capacity and preserving later markers within the same write;
- direct text range extraction independent of viewport or selection state;
- current geometry queries even before a hidden terminal synchronizes rendering;
- native mode, size, color, visibility, and version query replies;
- generated upstream Ghostty XTGETTCAP responses and native DECRQSS replies;
- synchronized-output state for damage suppression with bounded recovery;
- one shared WASM instance with one terminal handle per Terax model;
- Ghostty's module-global exact-page WASM pool, avoiding per-terminal geometric
  page-pool growth while reusing released pages across tabs;
- upstream OSC SIMD scanning plus row-recycling, cursor, hyperlink, C0/C1,
  Kitty clipboard, and page-pointer correctness fixes through the pinned tip;
- synchronous SIMD capability detection with a scalar Ghostty artifact for
  older webviews, preserving the same model and renderer architecture;
- cached typed views that are recreated only when WASM memory or pointers move;
- capacity-aware render buffers with bounded headroom, preventing allocation
  churn during repeated window fitting and adjacent-size resize cycles;
- one reallocatable cell-buffer arena instead of sixteen independent WASM
  allocations, removing resize fragmentation and transient high-water growth;
- explicit post-gesture bridge and render-state compaction with hysteresis;
- periodic render-state renewal after 100,000 updates, releasing fragmented
  row arenas and retained high-water allocations during long-running agents;
- explicit presentation-state release for hidden panes and hidden documents,
  with lazy rebuilding that preserves the terminal, selection, and scrollback;
- bounded reusable PTY input, terminal-reply, grapheme, and hyperlink bridge
  storage with oversized transient buffers released after use;
- direct consumption of libghostty's global and per-row dirty state, avoiding
  redundant full-viewport hashing and bridge-array rewrites;
- stable append-only grapheme and hyperlink storage between partial frames,
  with bounded full compaction after high-water thresholds;
- persistent hyperlink interning by owned buffer offsets, avoiding both repeated
  URI retention on dirty rows and borrowed pointers into recycled terminal pages;
- direct typed render-state consumption without a per-frame JS cell repack;
- extended underline styles and colors, overline, inverse-aware decoration
  colors, text blink, graphemes, and wide-cell state;
- a raw `.wasm` asset instead of a multi-megabyte JavaScript string literal.

The bridge deliberately stays below Terax's model/surface boundary. Terax
retains renderer pooling, hidden-tab renderer release, damage-driven frame
scheduling, shell integration, semantic routing, and fallback selection.

## Memory regression gate

The allocator rebase was measured against the previous pinned artifact with an
identical five-terminal, approximately 16 MiB-per-terminal ASCII workload.
Total WASM linear memory after the workload fell from 20,119,552 bytes to
8,978,432 bytes. The current tests also gate fresh multi-terminal allocation,
adjacent resize stability, oversized transient release, and a three-terminal
Unicode-heavy agent workload. These measurements cover linear memory only;
process RSS and GPU allocations are separate release gates.

## Rebuild

From `packages/ghostty-core/adapted/wasm`:

```sh
zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
cp zig-out/bin/terax-ghostty-vt.wasm ../ghostty-vt.wasm
zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast -Dwasm-simd=false
cp zig-out/bin/terax-ghostty-vt.wasm ../ghostty-vt-scalar.wasm
shasum -a 256 ../ghostty-vt.wasm ../ghostty-vt-scalar.wasm
```

`build.zig.zon` pins both the Ghostty archive URL and Zig package hash. A
checksum change must be reviewed together with the source revision and the
terminal compatibility and resource gates.

Both variants run the same adapted-core regression suite. The Rust integration
test `ghostty_artifacts` additionally validates the scalar binary with SIMD and
relaxed SIMD disabled and confirms that the primary binary requires SIMD.
`pnpm bench:ghostty` compares both variants at the same source revision; those
measurements exclude IPC, webview presentation, process RSS, and energy.
