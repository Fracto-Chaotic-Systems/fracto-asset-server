"""Render raw instrument stems from the MIDI. usage: render_stems.py [keys1=piano|organ]"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from score import Score, SR
import modal, organ, drums, sampler, perc
from dyn import sec_db

keys1 = sys.argv[1] if len(sys.argv) > 1 else 'piano'
sc = Score(); T = sc.end + 5.0
rng = np.random.default_rng(3)

def human(nt, acc=5, jit=3, step=3, base=0.0, k=4.0):
    v = nt['vel'] + base + (acc if nt['slot'] % 3 == 0 else 0) + rng.normal(0, jit) + k * float(sec_db(nt['bar'] + nt['slot'] / 12.0)[0])
    return int(np.clip(round(v / step) * step, 20, 124))

def render_stereo(notes, fn, total, vel_fn):
    N = int(total * SR); buf = np.zeros((N, 2))
    for nt in notes:
        x = fn(nt['key'], vel_fn(nt), nt['off'] - nt['on']) * nt['gain']
        i = int(round(nt['on'] * SR)); x = x[:N - i]
        buf[i:i + len(x)] += x
    return buf


t = time.time()
if keys1 == 'piano':
    p = render_stereo(sc.tracks['keys1'], sampler.piano_note, T, lambda n: human(n, 5, 2.5, 1, base=14.0, k=5.0))
    np.save('raw_keys1_piano.npy', p.astype(np.float32))
else:
    o1 = organ.tonewheel(sc.tracks['keys1'], T, drawbars='888000000', perc=(19, 1.0, 0.2), seed=11, click=0.6)
    np.save('raw_keys1_organ.npy', o1.astype(np.float32))
print('keys1', time.time() - t)
if not os.path.exists('raw_bass.npy') or '--all' in sys.argv:
    b = modal.render_notes(sc.tracks['bass'], sampler.bass_note, T, vel_fn=lambda n: human(n, 6, 3, 3))
    np.save('raw_bass.npy', b.astype(np.float32))
    # where the organ doubles a piano note, play it softer so the piano carries the line
    k1 = {}
    for n in sc.tracks['keys1']:
        k1.setdefault((n['bar'], n['slot']), set()).add(n['key'] % 12)
    org_notes = [dict(n, gain=n['gain'] * (0.45 if n['key'] % 12 in k1.get((n['bar'], n['slot']), ()) else 1.0)) for n in sc.tracks['keys2']]
    o = organ.tonewheel(org_notes, T, drawbars='858865435', perc=(12, 0.8, 0.22), seed=1)
    np.save('raw_organ.npy', o.astype(np.float32))
    hits = drums.arrange(sc)
    st = drums.render(hits, T)
    for k, v in st.items():
        np.save('raw_dr_%s.npy' % k, v.astype(np.float32))
    ps = perc.render(perc.arrange(sc), T)
    for k, v in ps.items():
        np.save('raw_pc_%s.npy' % k, v.astype(np.float32))
print('done', time.time() - t)
