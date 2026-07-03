"""align_cli.py -- force-align a known script to its voiceover (stable-ts).

Usage:
    python scripts/align_cli.py --audio <wav> --script <txt> --out <json>

Aligns the KNOWN script text to the audio (never plain transcription), maps
the aligned words back onto script lines, and writes JSON matching
`{ lines: AlignedLine[] }` from src/types.ts:

    { "lines": [ { "index": 0, "text": "...", "start": 0.1, "end": 4.8,
                   "duration": 4.7, "pause_after": 1.54,
                   "words": [ { "word": "The", "start": 0.1, "end": 0.34 }, ... ] },
                 ... ] }

`index` is the 0-based index over non-empty script lines. `pause_after` is
next.start - this.end (0.0 for the last line). Extra keys (duration,
pause_after) are informational; src/align.ts consumes index/text/start/end/words.

Console output is ASCII-only progress. Data goes ONLY to the --out file.
"""

import argparse
import json
import os
import sys
import warnings


def aprint(msg, stream=None):
    """Print ASCII-only (non-ASCII replaced) so Windows consoles never choke."""
    stream = stream or sys.stdout
    stream.write(msg.encode("ascii", "replace").decode("ascii") + "\n")
    stream.flush()


def fail(msg, code=2):
    aprint("ERROR: " + msg, sys.stderr)
    sys.exit(code)


def normalized_char_len(s):
    """Length of s with all whitespace removed (for character-budget mapping)."""
    return len("".join(s.split()))


def map_words_to_lines(lines, words):
    """Assign aligned words back to script lines.

    Primary: per-line word counts (script joined with single spaces, so the
    aligner's word segmentation normally matches whitespace splitting).
    Fallback: character-budget walk over whitespace-stripped text, which is
    exact even if the aligner split/merged tokens differently, because the
    concatenated non-whitespace characters of the aligned words equal those
    of the joined script text.
    """
    line_word_counts = [len(l.split()) for l in lines]
    if sum(line_word_counts) == len(words):
        chunks, idx = [], 0
        for n in line_word_counts:
            chunks.append(words[idx : idx + n])
            idx += n
        return chunks

    aprint(
        "progress: aligned word count (%d) != script word count (%d); "
        "using character-budget mapping" % (len(words), sum(line_word_counts))
    )
    chunks, wi, carry = [], 0, 0
    for line in lines:
        target = normalized_char_len(line)
        chunk, acc = [], carry
        while wi < len(words) and acc < target:
            chunk.append(words[wi])
            acc += normalized_char_len(words[wi]["word"])
            wi += 1
        carry = acc - target  # overshoot borrows from the next line's budget
        chunks.append(chunk)
    if wi < len(words):
        chunks[-1].extend(words[wi:])
    return chunks


def main():
    parser = argparse.ArgumentParser(
        description="Force-align a known script to a voiceover and emit per-line word timestamps."
    )
    parser.add_argument("--audio", required=True, help="voiceover audio file (wav)")
    parser.add_argument("--script", required=True, help="script text file (one narration line per line)")
    parser.add_argument("--out", required=True, help="output JSON path")
    args = parser.parse_args()

    if not os.path.isfile(args.audio):
        fail("audio file not found: " + args.audio)
    if not os.path.isfile(args.script):
        fail("script file not found: " + args.script)

    with open(args.script, encoding="utf-8") as f:
        lines = [l.strip() for l in f if l.strip()]
    if not lines:
        fail("script has no non-empty lines: " + args.script)
    full_text = " ".join(lines)
    aprint("progress: loaded script (%d lines, %d words)" % (len(lines), len(full_text.split())))

    warnings.filterwarnings("ignore")  # torch/whisper warnings are noise here

    # Disable tqdm globally BEFORE importing stable_whisper: its internal
    # progress bars print non-ASCII block characters (console must stay ASCII).
    # stable-ts passes its own disable= kwarg, so force-override it in __init__.
    os.environ.setdefault("TQDM_DISABLE", "1")
    try:
        from tqdm import tqdm

        _orig_tqdm_init = tqdm.__init__

        def _silent_tqdm_init(self, *a, **kw):
            kw["disable"] = True
            _orig_tqdm_init(self, *a, **kw)

        tqdm.__init__ = _silent_tqdm_init
    except Exception:
        pass  # tqdm absent -> nothing to silence

    aprint("progress: loading stable-ts model 'base' (CPU ok)")
    import stable_whisper  # deferred: slow import, fail fast on bad args first

    model = stable_whisper.load_model("base")

    aprint("progress: aligning audio to script text (~15 sec-of-audio/sec on CPU)")
    result = model.align(args.audio, full_text, language="en", verbose=None)

    words = []
    for seg in result.segments:
        for w in seg.words:
            words.append(
                {
                    "word": str(w.word).strip(),
                    "start": round(float(w.start), 3),
                    "end": round(float(w.end), 3),
                }
            )
    if not words:
        fail("alignment produced no words")
    aprint("progress: aligned %d words" % len(words))

    chunks = map_words_to_lines(lines, words)
    for i, chunk in enumerate(chunks):
        if not chunk:
            fail("no aligned words mapped to line %d" % i)

    out_lines = []
    for i, (line, chunk) in enumerate(zip(lines, chunks)):
        out_lines.append(
            {
                "index": i,
                "text": line,
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "duration": round(chunk[-1]["end"] - chunk[0]["start"], 3),
                "words": chunk,
            }
        )
    for i, entry in enumerate(out_lines):
        if i + 1 < len(out_lines):
            entry["pause_after"] = round(out_lines[i + 1]["start"] - entry["end"], 3)
        else:
            entry["pause_after"] = 0.0

    out_abs = os.path.abspath(args.out)
    out_dir = os.path.dirname(out_abs)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_abs, "w", encoding="utf-8") as f:
        json.dump({"lines": out_lines}, f, indent=2, ensure_ascii=False)

    aprint("progress: wrote %d lines -> %s" % (len(out_lines), out_abs))
    aprint("done")


if __name__ == "__main__":
    main()
