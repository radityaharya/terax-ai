"""Subset the pinned Ghostty font with fonttools==4.59.2 and brotli==1.1.0."""

import argparse
import hashlib
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

SOURCE_SHA256 = "a2f4268a1719b95d1f1448376173a42317919cb598423f18ea327eaca13dd916"
ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "src/assets/fonts/terax-terminal-symbols.woff2"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Pinned JetBrainsMonoNerdFont-Regular.ttf")
    args = parser.parse_args()
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise SystemExit("Source font does not match the pinned Ghostty revision")
    font = TTFont(args.source, recalcTimestamp=False)
    codepoints = [cp for cp in font.getBestCmap() if 0xE000 <= cp <= 0xF8FF or 0xF0000 <= cp <= 0xFFFFD]
    options = subset.Options()
    options.hinting = False
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    for record in font["name"].names:
        if record.nameID in (1, 3, 4, 6, 16, 18, 21):
            value = "TeraxTerminalSymbols" if record.nameID == 6 else "Terax Terminal Symbols"
            record.string = value.encode(record.getEncoding())
    font.flavor = "woff2"
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUTPUT)
    rebuilt = TTFont(OUTPUT)
    if set(rebuilt.getBestCmap()) != set(codepoints):
        raise SystemExit("Symbol coverage changed during subsetting")
    data = OUTPUT.read_bytes()
    if len(data) > 800_000:
        raise SystemExit("Symbol font exceeds the 800,000 byte budget")
    print(f"{len(codepoints)} symbols, {len(data)} bytes, SHA-256 {hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()
