# Twelve Note Fugue - arrangement

Version-controlled record of the arrangement work on *Twelve Note Fugue*: what was added to
the composer's MIDI, why, and everything needed to render the audio again.

| File | Purpose |
| --- | --- |
| `source/TwelveNoteFugue.mid` | The composer's MIDI, unchanged (piano, rock organ, acoustic bass). |
| `TwelveNoteFugue.arranged.mid` | Source tracks byte-identical, plus track 5 `Percussion` on MIDI channel 10 (bongos 60/61, timbales 65/66, hi-hat 42/46). This is the arrangement as playable data. |
| `arrangement.json` | Arrangement notes: instrument mapping, percussion design rules, section dynamics, organ/piano balance, the dialogue swells, version history and open ideas. Read this first when resuming work. |
| `render/` | Offline Python scripts (numpy, scipy, ffmpeg) that render and mix the audio. Not used by any service at runtime. See `render/README_remix.md`. |

## What is and is not in the MIDI

- In the MIDI: every percussion stroke with its timing and velocity.
- Only in `arrangement.json` and `render/`: section dynamics, the organ-behind-piano balance,
  the piano/organ dialogue swells, reverb and mastering. The melodic tracks are deliberately
  left exactly as composed.

## Audio

Rendered audio is not stored in git. Regenerate it with `render/`; the piano and percussion
samples come from this service's instrument library (`instruments/originals/GrandB_*.mp3`,
`instruments/indexes/grandb-*.json`, `instruments/fluidr3-percussion/source-cache/FluidR3_GM.sf2`),
which are local asset storage, not tracked files.

## Updating

1. Change the part or mix in `render/` and re-render.
2. Regenerate the MIDI: `python3 render/export_midi.py TwelveNoteFugue.arranged.mid`.
3. Update `arrangement.json` (`arrangement_version`, `history`, the affected section, the
   `sha256` of the arranged MIDI) and commit the folder as one change.

Reserve `variants/` here for alternative versions (for example a no-percussion or drum-kit
variant) described as differences from this arrangement.
