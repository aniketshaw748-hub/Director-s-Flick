"""Phase 0 alignment smoke test: force-align known script text to the TTS voiceover
and derive per-line timestamps + inter-line pauses (the app's core ingest primitive)."""
import json
import stable_whisper

AUDIO = r"C:\Coding\Video Automation\phase0\test_vo.wav"
SCRIPT = r"C:\Coding\Video Automation\phase0\script.txt"
OUT = r"C:\Coding\Video Automation\phase0\alignment.json"

with open(SCRIPT, encoding="utf-8") as f:
    lines = [l.strip() for l in f if l.strip()]
text = " ".join(lines)

model = stable_whisper.load_model("base")  # CPU is fine for this clip
result = model.align(AUDIO, text, language="en")

words = [w for seg in result.segments for w in seg.words]
print(f"aligned {len(words)} words")

# Walk aligned words back onto script lines by per-line word counts
line_word_counts = [len(l.split()) for l in lines]
report, idx = [], 0
for i, (line, n) in enumerate(zip(lines, line_word_counts)):
    chunk = words[idx : idx + n]
    idx += n
    report.append({
        "line": i + 1,
        "text": line,
        "start": round(chunk[0].start, 3),
        "end": round(chunk[-1].end, 3),
        "duration": round(chunk[-1].end - chunk[0].start, 3),
    })
for i in range(len(report) - 1):
    report[i]["pause_after"] = round(report[i + 1]["start"] - report[i]["end"], 3)

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(report, f, indent=2)

for r in report:
    pause = f" | pause after: {r.get('pause_after', '—')}s" if "pause_after" in r else ""
    print(f"L{r['line']}: {r['start']:7.2f} → {r['end']:7.2f}  ({r['duration']:.2f}s){pause}")
