# Twelve Note Fugue remix - render scripts (state at v8, 2026-11-25)

Renders the MIDI to audio with numpy/scipy and ffmpeg only.

## Inputs
- `../source/TwelveNoteFugue.mid` (override with env `TNF_MIDI`)
- This service's instrument library, `instruments/` (override with env `FRACTO_INSTRUMENTS`):
  `originals/GrandB_{p,mp,mf,f}.mp3`, `indexes/grandb-{p,mp,mf,f}.json`,
  `fluidr3-percussion/source-cache/FluidR3_GM.sf2`.

Run the steps from a scratch directory outside the repository (or set `TNF_WORK`): the scripts
write large intermediate `.npy`/`.npz`/`.wav` files into the current directory.

## Steps
1. `python3 <render>/gb_extract.py`               - cut the GrandB recordings into per-note samples (once)
2. `python3 <render>/render_stems.py piano --all` - piano, organ, bass, drum-kit and percussion stems
3. `python3 <render>/mix.py piano OUT --perc`     - mix + master with bongos/timbales/hi-hat  (v8)
   `python3 <render>/mix.py piano OUT --nodrums`  - no percussion
   `python3 <render>/mix.py piano OUT`            - with the v2 drum kit

## Where things are
- `score.py`   MIDI timing, bars and eighth-note slots
- `dyn.py`     section dynamics (the MIDI velocities are nearly flat)
- `sampler.py` GrandB piano, FluidR3 bass (with tuning correction), kit pieces
- `organ.py`   modelled tonewheel organ + rotary speaker
- `drums.py`   v2 drum-kit part (Purdie/Peart style) - not used in v8
- `perc.py`    bongos + timbales, double-time hi-hat; brush stir (`render_stir`, removed from the mix in v7)
- `export_midi.py` writes the arranged MIDI (source tracks + channel-10 percussion)
- `mix.py`     EQ, levels (`LV`), organ/piano balance, dialogue swells (`roles`, `GP`, `GO`), reverb, master

## Version history
v1 modelled instruments + rock kit; v2 Fracto samples + tighter kit; v3 organ back, bongos/timbales;
v4 syncopated bongos, turnarounds, room; v5 brushes + hat, bongos down; v6 brush stir, double-time hat,
clear opening; v7 brush removed; v8 piano/organ dialogue swells.
Open idea: brush stir with a long-short motion instead of equal circles.
