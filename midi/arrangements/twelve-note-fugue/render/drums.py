"""Drum part v2: tight studio feel - Purdie-style half-time shuffle with ghost notes for the grooves,
Peart-style ride-bell drive, band-hit accents and descending tom runs for the climaxes and fills.
Kit: FluidR3 Standard (from the Fracto asset library)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import scipy.signal as S
from score import SR, EIGHTH, bar_tick
import sampler

SLOT_OFF = [4, 39, 29, 30, 30, 17, 21, 26, 13, 12, 11, -1]   # micro-timing of the MIDI's own eighths (ticks)

KEY = dict(kick=36, snare=38, ghost=38, rim=40, stick=37, hh=42, oh=46, hf=44, ride=51, bell=53,
           crash0=49, crash1=57, splash=55, china=52, t1=50, t2=48, t3=47, t4=45, t5=43, t6=41)
GROUP = dict(kick='kick', snare='snare', ghost='snare', rim='snare', stick='snare', hh='hats', oh='hats', hf='hats',
             ride='cym', bell='cym', crash0='cym', crash1='cym', splash='cym', china='cym',
             t1='toms', t2='toms', t3='toms', t4='toms', t5='toms', t6='toms')
# stereo placement (audience view) applied on top of the kit's own stereo samples
PAN = dict(kick=0, snare=0.03, ghost=0.03, rim=0.03, stick=0.03, hh=0.28, oh=0.28, hf=0.28, ride=-0.35, bell=-0.35,
           crash0=-0.4, crash1=0.45, splash=0.15, china=-0.55, t1=0.35, t2=0.2, t3=0.05, t4=-0.1, t5=-0.3, t6=-0.45)
TRIM = dict(ghost=0.5, stick=1.3, hh=1.0, hf=0.8, bell=0.85, ride=1.0, china=0.8, splash=0.8)


def arrange(sc):
    """returns list of hits [time, inst, vel 0..1]"""
    rng = np.random.default_rng(42)

    def T(bar, slot):
        s = int(np.floor(slot))
        t0 = float(sc.t2s(bar_tick(bar) + s * EIGHTH + SLOT_OFF[s % 12]))
        if slot != s:                                   # second stroke of a double: halfway to the next eighth
            t0 += (slot - s) * float(sc.t2s(bar_tick(bar) + (s + 1) * EIGHTH) - sc.t2s(bar_tick(bar) + s * EIGHTH))
        return t0

    ons = {}
    for name, ns in sc.tracks.items():
        for n in ns:
            ons.setdefault((n['bar'], n['slot']), []).append(name)

    def cnt(b, s, track=None):
        l = ons.get((b, s), [])
        return len(l) if track is None else sum(1 for x in l if x == track)

    def chord(b, s):
        return cnt(b, s, 'keys1') + cnt(b, s, 'keys2') >= 3

    def section(b):
        #        intensity style
        if b <= 10: return 0.55, 'half_light'
        if b <= 18: return 0.74, 'half'
        if b <= 26: return 0.86, 'drive'
        if b <= 34: return 0.60, 'half_light'
        if b <= 42: return 0.80, 'half'
        if b <= 50: return 1.00, 'climax'
        if b <= 53: return 0.35, 'break'
        if b <= 56: return 0.85, 'half'
        if b <= 60: return 0.82, 'half'
        if b <= 64: return 0.80, 'drive'
        if b <= 72: return 0.92, 'drive'
        return 1.00, 'climax'

    crash_bars = {3: 0.45, 11: 0.75, 19: 0.9, 23: 0.7, 35: 0.8, 39: 0.6, 43: 1.0, 47: 0.85, 54: 0.75, 57: 0.9, 61: 0.6,
                  65: 0.95, 69: 0.75, 73: 1.0, 77: 0.85}
    D = 0.5   # offset of a double stroke
    light = [(10, 'snare', .45), (10 + D, 'snare', .35), (11, 'snare', .9)]
    pickup = [(9, 'snare', .7), (9 + D, 'snare', .45), (10, 't3', .8), (11, 't6', .95)]
    medium = [(6, 'snare', .75), (6 + D, 'snare', .45), (7, 't1', .8), (8, 't2', .85), (8 + D, 't2', .55),
              (9, 't3', .85), (10, 't4', .9), (11, 't6', 1.0)]
    big = [(3, 'snare', .85), (4, 'snare', .5), (4 + D, 'snare', .45), (5, 'snare', .8),
           (6, 'snare', .9), (6 + D, 'snare', .6), (7, 't1', .85), (7 + D, 't1', .7), (8, 't2', .9), (8 + D, 't2', .7),
           (9, 't3', .9), (9 + D, 't3', .75), (10, 't4', .95), (10 + D, 't5', .8), (11, 't6', 1.0), (11 + D, 't6', .85)]
    fills = {10: light, 18: big, 26: medium, 34: medium, 42: big, 53: pickup, 56: big, 60: light, 64: medium,
             68: light, 72: medium, 76: light}
    hits = []

    def add(b, s, inst, v, late=0.0):
        hits.append([T(b, s) + late + rng.normal(0, 0.0015), inst, float(np.clip(v * rng.uniform(0.94, 1.05), 0.04, 1.1))])

    # pickup into the tune in the 6/8 bar
    add(2, 3, 'snare', .4); add(2, 3 + D, 'snare', .3); add(2, 4, 't3', .6); add(2, 5, 'snare', .9); add(2, 5, 'kick', .75)

    for b in range(3, 81):
        I, style = section(b)
        any0 = sum(cnt(b, 0, t) for t in sc.tracks)
        antic = any0 == 0 and cnt(b - 1, 11) >= 2
        nxt_antic = b < 80 and sum(cnt(b + 1, 0, t) for t in sc.tracks) == 0 and cnt(b, 11) >= 2
        fill = fills.get(b)
        f0 = min(s for s, _, _ in fill) if fill else 12
        if b == 80:
            f0 = 6
        if b == 50:                       # the stop
            add(b, 0, 'kick', 1.0); add(b, 0, 'snare', 1.0); add(b, 0, 'crash1', 0.95); add(b, 0, 'china', 0.7)
            continue
        stab = cnt(b, 1) >= 1 and cnt(b, 2) == 0            # band plays the 0-1-(3)-7 figure
        # ---------------- kick
        if style == 'break':
            ks = []
        elif b >= 57 and style != 'climax':
            ks = [0, 1, 8]
        elif stab:
            ks = [0, 1, 7]
        elif style == 'climax':
            ks = [0, 5, 6, 11] if b % 2 else [0, 6, 8]
            ks = sorted(set(ks) | {s for s in range(12) if chord(b, s) and s not in (3, 9)})
        elif style == 'drive':
            ks = [0, 5, 6] if b % 2 else [0, 6, 11]
        else:                               # half-time shuffle: kick leads into the backbeat
            ks = [0, 5, 8] if b % 2 else [0, 5, 11]
        for s in ks:
            if (s == 0 and antic) or s >= max(f0, 6) and fill is big and s not in (6, 9) or (b == 80 and s > 5):
                continue
            if s == 11 and nxt_antic:
                continue
            add(b, s, 'kick', (1.0 if s in (0, 6) else 0.82) * (0.74 + 0.26 * I))
        if nxt_antic and style != 'break':
            add(b, 11, 'kick', 0.95)
            if (b + 1) in crash_bars:
                add(b, 11, 'crash%d' % (b % 2), crash_bars[b + 1])
                if I >= 0.85:
                    add(b, 11, 'china', 0.6)
            if fill is None:
                add(b, 11, 'snare', 0.85 * I)
        # ---------------- backbeat and ghosts
        if style in ('half', 'half_light'):
            back = [6]
        elif style in ('drive', 'climax'):
            back = [3, 9]
        else:
            back = []
        bb = 'stick' if style == 'half_light' else 'snare'
        for s in back:
            if s < f0:
                add(b, s, bb, 0.8 if bb == 'stick' else (0.82 + 0.18 * I), late=0.004)
        if style == 'break' and b == 52:
            add(b, 6, 'stick', 0.6)
        if style != 'break':
            # ghost notes on the middle triplets - the Purdie texture
            gv = {'half_light': 0.2, 'half': 0.3, 'drive': 0.28, 'climax': 0.3}[style]
            for s in (1, 4, 7, 10):
                if s >= f0 or s in ks:
                    continue
                if style in ('drive', 'climax') and s in (4, 10) and rng.uniform() < 0.5:
                    continue
                add(b, s, 'ghost', gv * (1.25 if s == 7 and style.startswith('half') else 1.0))
            if style == 'half' and 5 < f0 and b % 2 == 0:
                add(b, 5, 'ghost', gv * 1.3)                    # drag into the backbeat
        # band accent on the "3" stab during half-time grooves
        if stab and style == 'half' and 3 < f0 and chord(b, 3):
            add(b, 3, 'rim', 0.6 * I)
        # ---------------- time keeping
        for s in range(12):
            if s >= f0:
                break
            beat = s % 3 == 0
            if style == 'break':
                if beat:
                    add(b, s, 'hf', 0.5)
                continue
            if s % 3 == 1:
                continue
            v = (1.0 if beat else 0.5) * (0.55 + 0.45 * I)
            if style in ('half', 'half_light'):
                if style == 'half' and s == 11 and b % 2 == 1 and not fill and not nxt_antic:
                    add(b, s, 'oh', 0.75 * I)                   # hi-hat bark, closed again on the downbeat
                elif style == 'half' and s == 5 and b % 4 == 2 and chord(b, 3):
                    add(b, s, 'oh', 0.6 * I)
                else:
                    add(b, s, 'hh', v * (1.1 if s == 6 else 1.0))
            else:
                bell = beat and (style == 'climax' or s in (0, 6))
                add(b, s, 'bell' if bell else 'ride', v)
                if s in (3, 9):
                    add(b, s, 'hf', 0.5)
        # ---------------- cymbal punctuation
        if b in crash_bars and not antic:
            add(b, 0, 'crash%d' % (b % 2), crash_bars[b])
        if style == 'climax' and not fill:
            hitslots = [s for s in (5, 8, 11) if chord(b, s)]
            if hitslots and b in (47, 49):
                add(b, hitslots[0], 'splash', 0.8)
                add(b, 6, 'china', 0.7)
        if style in ('drive', 'half') and b % 4 == 2 and I >= 0.8 and not fill and chord(b, 7):
            add(b, 7, 'splash', 0.6)
        # ---------------- fills
        if fill:
            for s, inst, v in fill:
                if int(s) == 11 and nxt_antic:
                    if s == 11:
                        add(b, 11, 'snare', 1.0)
                    continue
                add(b, s, inst, v * (0.72 + 0.28 * I))
            if fill is big:
                add(b, 3, 'kick', 0.8)
            if fill in (big, medium) and (b + 1) not in crash_bars and not nxt_antic:
                add(b + 1, 0, 'crash%d' % (b % 2), 0.75)
        if b == 80:                         # ending
            for s, inst, v in ((6, 't2', .8), (6 + D, 't3', .7), (7, 't5', .9), (7 + D, 't6', .85)):
                add(b, s, inst, v)
            add(b, 8, 'kick', 1.0); add(b, 8, 'snare', 1.0); add(b, 8, 'crash0', 1.0); add(b, 8, 'crash1', 0.9, late=0.003)
            add(b, 8, 'china', 0.7)
    hits.sort(key=lambda h: h[0])
    return hits


def render(hits, total):
    """returns dict of stereo stems: kick snare hats cym toms"""
    N = int(total * SR)
    stems = {g: np.zeros((N, 2)) for g in ('kick', 'snare', 'hats', 'cym', 'toms')}
    oh = np.zeros((N, 2))
    ev = sorted([(t, inst) for t, inst, v in hits if inst in ('hh', 'hf', 'oh')])

    def place(x, inst):
        p = PAN[inst]
        y = x.copy()
        # narrow the kit's own stereo a little, then position
        m = y.mean(1, keepdims=True)
        y = m + 0.6 * (y - m)
        y[:, 0] *= min(1.0, 1 - p)
        y[:, 1] *= min(1.0, 1 + p)
        return y

    for t, inst, v in hits:
        x = sampler.drum(KEY[inst])
        i = int(t * SR)
        if i >= N:
            continue
        g = v ** 1.7 * TRIM.get(inst, 1.0)
        if inst == 'ghost':
            x = S.lfilter(*S.butter(1, 5000 / (SR / 2)), x[:int(0.25 * SR)], axis=0)
            x = x * np.exp(-np.arange(len(x)) / (0.06 * SR))[:, None]
            g = (v * 2) ** 1.3 * TRIM['ghost'] * 0.35
        elif inst in ('snare', 'kick', 'hh', 'ride', 't1', 't2', 't3', 't4', 't5', 't6') and v < 0.8:
            x = S.lfilter(*S.butter(1, min(0.95, (3000 + 16000 * v) / (SR / 2))), x, axis=0)
        if inst in ('hh', 'hf'):
            x = x[:int(0.35 * SR)] * np.exp(-np.arange(min(len(x), int(0.35 * SR))) / (0.09 * SR))[:, None]
        if inst.startswith('t'):
            x = x * np.exp(-np.arange(len(x)) / (0.32 * SR))[:, None]       # damped studio toms
        x = place(x, inst)[:N - i] * g
        if inst == 'oh':
            # choke at the next closed/foot hat
            nxt = next((tt for tt, ii in ev if tt > t + 0.01 and ii != 'oh'), None)
            if nxt is not None:
                k = int((nxt - t) * SR)
                if k < len(x):
                    x = x[:k + int(0.03 * SR)].copy()
                    f = len(x) - k
                    x[k:] *= np.linspace(1, 0, f)[:, None]
            oh[i:i + len(x)] += x
            continue
        stems[GROUP[inst]][i:i + len(x)] += x
    stems['hats'] += oh
    return stems
