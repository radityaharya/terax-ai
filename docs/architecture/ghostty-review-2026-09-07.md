# Ghostty PR review, September 7

Review: [PR 1223](https://github.com/crynta/terax-ai/pull/1223), CodeRabbit's
September 7 review of `4834c01`. All 26 major findings and the documentation
index comment were checked against the implementation. No PR comments were
posted and no review threads were marked resolved automatically.

## Dispositions

| Finding | Disposition |
| --- | --- |
| PTY exit can wait forever for credit | Fixed. After child exit, a 30-second acknowledgment inactivity deadline wakes blocked readers and flushers. Valid progress renews it; successful drains retain final output. Timeout logs the undelivered byte counts and reports exit status -1. It is armed before ConPTY close and either thread join. Live shells have no new timeout or heartbeat. |
| Inconsistent, lossy ESC paste handling | Fixed the inconsistent single-line submission path. Retained the deliberate policy of rendering ESC as U+241B inside bracketed paste, including malicious end delimiters. We do not silently remove substrings or allow copied escape sequences to break out of paste framing. Ordinary single-line commands keep their existing encoding. |
| Receiver rejects a third pending chunk | No change. Rust negotiates exactly two in-flight chunks. Cumulative credit is granted only after parsing, so three unparsed chunks violate the protocol. Existing asynchronous parser and credit tests cover this boundary. Removing the check would weaken the object-count bound. |
| Checkout credentials remain accessible during installation | Fixed all five CI checkouts with `persist-credentials: false`. These jobs do not push commits. |
| URL suffix trimming is quadratic | Fixed with one delimiter count and one suffix scan. Tests include 30,000 mixed closing delimiters and balanced IPv6/path delimiters. |
| Clear leaves text before the cursor on row zero | Intended behavior. The clear action preserves the current prompt/command line while removing earlier output and history. Added a repeated-clear assertion at row zero. Shell erase sequences independently clear block metadata. |
| Block search scans an entire command synchronously | Fixed with batches of at most 128 lines or approximately four milliseconds, a 500-match cap, cancellation, and a pending indicator. Closing or replacing a query cancels it; clearing, pruning its start pin, reflow, or disposal invalidates it. Search scans the whole retained range rather than silently dropping matches after an arbitrary line cap. |
| Metadata eviction can remove the live block | Not reachable with current bounds. A command is capped at 8,192 UTF-16 units and cwd at 32,768, totaling 40,960, below the 262,144-unit budget. The newest entry remains after older entries are removed. Existing tests verify the newest command survives budget pressure. |
| Large accessible append announces its oldest portion | Fixed to announce the newest 2,048 characters of the changed suffix. |
| Focus recreates accessible subscriptions and announces the viewport | Fixed. Focus is read through an effect event, and losing focus clears the old announcement without recreating the model subscription. |
| Legacy scrolled viewport rebuilds on every read | Removed the unused legacy application model. The file now contains only the shared model contracts. Production already uses the adapted model. |
| Legacy reply drain can loop on an empty response | Removed with the unused legacy application model. |
| ShellInput loses a draft when unmounted in plain mode | Fixed by saving before editor destruction and retaining that saved value in the later registration cleanup. |
| Old WebGL boolean preference is not migrated | No change. The old boolean chose xterm WebGL versus its software renderer. The new setting chooses WebGPU versus WebGL, both GPU renderers. Mapping false to WebGL would not preserve a software-renderer preference; mapping true to WebGL would force every prior default user onto the fallback. New settings default to Automatic and preserve explicit WebGL choices. |
| Scrollbar reads layout on every frame | Fixed. Geometry comes from fitting; unchanged history, offset, geometry, and modes skip DOM reads and writes. Native scrolling and presentation changes invalidate the cache. Fractional positions remain intact. |
| Idle atlas destruction races GPU work | Partially valid. Encoded but unsubmitted uploads now prevent every idle reclamation path, including the warm-atlas timer, without repeated timer wakeups. Destroying resources after submission is permitted by WebGPU and does not require extending their JavaScript ownership until completion. |
| WebGL background changes rebuild the full grid | Stable per-row rectangle counts now use dirty-row construction and range uploads. Structural changes still rebuild the compact rectangle stream. This retains one background draw without reserving worst-case per-cell rectangle storage or adding one draw per row. GPU buffer capacity is reused, and rectangle uploads are counted. |
| Failed configuration poisons reused WebGL slots | Fixed for new, idle/reused, and already-leased renderers. A failed slot is detached, disposed, and removed before retry. |
| Official wrapper retains freed input storage after OOM | Fixed pointer/capacity ownership and tested retry and immediate disposal against the real reference WASM with allocator failure injection. This bridge is test-only. |
| Adapted wrapper retains freed input storage after OOM | Fixed with the same failure-injection coverage for the production bridge. |
| Legacy bridge calls WASM after terminal free | Guarded native access after disposal and released the cached cell pool. This bridge remains only for compatibility comparisons. |
| Legacy InputHandler bypasses native navigation encoding | Removed the unused handler and its package export. Production input uses `GhosttyInputController` and native key encoding. |
| Legacy cell pool returns stale entries after shrinking | Fixed the active pool length while retaining a stable array between reads. |
| Legacy viewport/scrollback allocation can return zero | Added allocation checks and cleared freed pointer/capacity state before allocation. Both read paths have failure-injection tests. Also corrected its input-buffer retry ownership. |
| Oversized legacy semantic events lose framing | Decoder now skips the declared payload across chunks using a bounded counter and emits one overflow event. Payload bytes cannot become event headers; subsequent valid events remain decodable. |
| Legacy InputHandler conflates Ctrl+Alt with AltGr | Removed the unused handler. Production composition/key behavior stays in the existing tested controller. |
| Architecture index describes retired mechanisms | Updated the index to the ConPTY lifecycle lock and persistent models with presentation pooling. |

The atlas disposition follows the [WebGPU texture destruction contract](https://gpuweb.github.io/gpuweb/#texture-destruction):
previously submitted operations retain the resource until their GPU use completes.
Encoded commands must still retain valid resources until submission.

## Validation and limits

- 163 frontend test files, 1,128 tests; 353 Rust tests.
- Type checking, production build, Clippy with warnings denied, and all five
  asset budgets pass. Lint retains the pre-existing 89 warnings and one info.
- The WebGL test changes one background row in a 24-row terminal: 36 background
  bytes uploaded, versus the previous 864-byte full stream, with no GPU buffer
  reallocation. This is an upload regression measurement, not an application
  CPU or energy benchmark.
- Startup JavaScript: 228.09 kB gzip; primary Ghostty chunks: 45.97 kB; lazy
  WebGL: 14.04 kB; both WASM variants: 413.4 kB. The WASM artifacts are unchanged.

These checks do not establish packaged WKWebView, WebKitGTK, WebView2, ConPTY,
assistive-technology behavior, or multi-day process memory and energy stability.
The desktop-transition memory spike remains unattributed. The existing
[release gates](ghostty-release-readiness.md) still apply before declaring
cross-platform production readiness.
