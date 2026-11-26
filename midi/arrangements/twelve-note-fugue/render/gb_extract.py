"""Cut the GrandB piano recordings (one note every 20 s) into per-note stereo segments with exact onsets."""
import os, sys, json, subprocess, numpy as np
O = os.environ.get('FRACTO_INSTRUMENTS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'instruments'))
WORK = os.path.join(os.environ.get('TNF_WORK', os.getcwd()), 'gb'); os.makedirs(WORK, exist_ok=True)
SR = 44100; KEEP = 7.0
for layer in ('p', 'mp', 'mf', 'f'):
    raw = os.path.join(WORK, '%s.raw' % layer)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', '%s/originals/GrandB_%s.mp3' % (O, layer),
                    '-f', 's16le', '-ac', '2', '-ar', str(SR), raw], check=True)
    x = np.memmap(raw, dtype='<i2', mode='r').reshape(-1, 2)
    idx = json.load(open('%s/indexes/grandb-%s.json' % (O, layer)))
    out = {}; info = []
    for n in idx['notes']:
        p = n['midi_pitch']
        if not 24 <= p <= 96: continue
        a = int((n['offset_seconds'] - 0.25) * SR)
        seg = x[a:a + int((KEEP + 0.5) * SR)].astype(np.float32) / 32768
        env = np.abs(seg).max(axis=1)
        pk = env[:int(1.5 * SR)].max()
        on = int(np.argmax(env > 0.06 * pk))          # first real hammer energy
        on = max(0, on - int(0.004 * SR))
        seg = seg[on:on + int(KEEP * SR)]
        out[str(p)] = seg
        info.append((p, round((a + on) / SR - n['onset_seconds'], 3), round(float(pk), 3), n['pitch_evidence'].get('median_partial_cents')))
    np.savez(os.path.join(WORK, '%s.npz' % layer), **out)
    os.remove(raw)
    print(layer, len(out), 'notes; onset shift vs index (s), peak, cents for 45/57/60/69/81:', [i for i in info if i[0] in (45, 57, 60, 69, 81)])
