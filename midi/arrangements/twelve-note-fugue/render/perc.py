"""Background hand-percussion part: bongos keep time, timbales mark sections and fills.
Samples: FluidR3 Standard kit GM percussion (Fracto asset library)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import scipy.signal as S
from score import SR, EIGHTH, bar_tick
import sampler
from drums import SLOT_OFF

KEY = dict(bh=60, bl=61, th=65, tl=66)
PAN = dict(bh=0.32, bl=0.22, th=-0.3, tl=-0.4)
GROUP = dict(bh='bongo', bl='bongo', th='timb', tl='timb')


def arrange(sc):
    rng = np.random.default_rng(7)

    def T(bar, slot):
        s = int(np.floor(slot))
        t0 = float(sc.t2s(bar_tick(bar) + s * EIGHTH + SLOT_OFF[s % 12]))
        if slot != s:
            t0 += (slot - s) * float(sc.t2s(bar_tick(bar) + (s + 1) * EIGHTH) - sc.t2s(bar_tick(bar) + s * EIGHTH))
        return t0

    ons = {}
    for name, ns in sc.tracks.items():
        for n in ns:
            ons.setdefault((n['bar'], n['slot']), []).append(name)

    def cnt(b, s):
        return len(ons.get((b, s), []))

    def chord(b, s):
        l = ons.get((b, s), [])
        return sum(1 for x in l if x != 'bass') >= 3

    def inten(b):
        for lim, v in ((10, .5), (18, .65), (26, .8), (34, .55), (42, .72), (50, .95), (53, 0.0), (56, .75), (64, .75), (72, .85), (80, .95)):
            if b <= lim:
                return v

    # top note of the leading line per bar/slot (piano, else organ, else bass)
    lead = {}
    for name in ('bass', 'keys2', 'keys1'):
        for n in sc.tracks[name]:
            d = lead.setdefault(n['bar'], {})
            if name == 'keys1' or n['slot'] not in d or name == 'keys2':
                d[n['slot']] = max(n['key'], d.get(n['slot'], 0)) if name != 'bass' else d.get(n['slot'], n['key'])

    def solo_scale(b, s):
        t = T(b, s) + 0.04
        act = sum(1 for ns in sc.tracks.values() if any(n['on'] <= t < n['off'] + 0.05 for n in ns))
        return 0.4 if act <= 1 else 1.0

    D = 0.5
    TURNS = [
        [(9, 'bh', .7), (10, 'bl', .6), (11, 'bl', .85)],
        [(9, 'bl', .7), (10, 'bh', .5), (10 + D, 'bh', .5), (11, 'bl', .85)],
        [(9, 'bh', .75), (9 + D, 'bh', .5), (10, 'bh', .6), (11, 'bl', .8)],
        [(10, 'bl', .7), (10 + D, 'bl', .55), (11, 'bh', .9)],
        [(9, 'bh', .6), (10, 'bh', .72), (11, 'bh', .85), (11, 'th', .35)],
        [(9, 'bl', .7), (10 + D, 'bh', .6), (11, 'bl', .5), (11 + D, 'bh', .7)],
        [(9, 'bh', .8), (10, 'bl', .5), (10 + D, 'bh', .45), (11, 'bh', .6), (11 + D, 'bl', .75)],
    ]
    turn_order = list(np.random.default_rng(3).permutation(len(TURNS)))
    light = [(10, 'th', .6), (11, 'tl', .8)]
    medium = [(9, 'th', .7), (10, 'th', .6), (10 + D, 'th', .55), (11, 'tl', .9)]
    big = [(6, 'th', .75), (7, 'th', .6), (7 + D, 'th', .55), (8, 'tl', .8), (9, 'th', .85), (9 + D, 'th', .6), (10, 'tl', .85), (11, 'tl', .95)]
    fills = {10: light, 18: big, 26: medium, 34: light, 42: big, 53: medium, 56: big, 60: light, 64: medium, 68: light, 72: medium, 76: light}
    marks = {11: .6, 19: .75, 35: .65, 43: .85, 54: .6, 57: .75, 65: .8, 73: .85}
    hits = []

    def add(b, s, inst, v):
        if v > 0.02:
            hits.append([T(b, s) + rng.normal(0, 0.002), inst, float(np.clip(v * rng.uniform(0.9, 1.08), 0.03, 1.1))])

    for b in range(3, 81):
        I = inten(b)
        fill = fills.get(b)
        f0 = min(s for s, _, _ in fill) if fill else 12
        if b == 80:
            f0 = 6
        if b == 50:
            add(b, 0, 'tl', .9); add(b, 0, 'th', .8)
            continue
        antic = sum(1 for t in sc.tracks if (b, 0) in ons and t in ons[(b, 0)]) == 0 and cnt(b - 1, 11) >= 2
        if I > 0 and b >= 5:
            I = I * (0.6 if b == 5 else 0.8 if b == 6 else 1.0)       # ease in
            stab = cnt(b, 1) >= 1 and cnt(b, 2) == 0
            # --- where is the syncopation? off-beat band hits, or the peaks of the running line
            if stab:
                acc = [s for s in (1, 3, 7, 10) if cnt(b, s) and (s != 10 or cnt(b, 9) == 0)]
            else:
                line = lead.get(b, {})
                acc = [s for s in range(1, 12) if s != 6 and s in line and line[s] > line.get(s - 1, -1) and line[s] >= line.get(s + 1, -1)]
                acc = sorted(acc, key=lambda s: -line[s])[:3]
            off = [s for s in range(12) if s not in (0, 6) and chord(b, s) and s not in acc]
            acc = sorted(set(acc) | set(off[:2]))
            thin = []
            for x in acc:                                   # no runs of accents: syncopation needs air around it
                if not thin or x - thin[-1] >= 2 or (stab and x in (1, 3, 7)):
                    thin.append(x)
            acc = thin
            pat = {}
            for s in range(12):
                pat[s] = ('bh', .2)                         # fingertips keep the triplets moving
            pat[0] = ('bl', .3); pat[6] = ('bl', .26)       # beats 1 and 3 only touched lightly
            for j, s in enumerate(acc):
                pat[s] = ('bl' if (s >= 8 and j % 2) else 'bh', .95 if s % 3 else .8)
                if s + 1 < 12 and s + 1 not in acc:
                    pat.pop(s + 1, None)                    # let the accent ring
            if not acc:
                pat[3] = ('bh', .6); pat[9] = ('bl', .6)
            # --- turnaround at the end of every other bar, never the same twice running
            if b % 2 == 0 and not fill:
                for s in (9, 10, 11):
                    pat.pop(s, None)
                var = TURNS[turn_order[(b // 2) % len(TURNS)]]
                extra = var
            else:
                extra = []
            for s, (inst, v) in sorted(pat.items()):
                if s >= f0:
                    continue
                k = solo_scale(b, s)
                if k < 1 and v < .5:
                    continue                                # a soloist is alone: leave the space
                add(b, s, inst, v * (0.45 + 0.55 * I) * k)
            for s, inst, v in extra:
                if s < f0:
                    add(b, s, inst, v * (0.5 + 0.5 * I) * solo_scale(b, int(s)))
            if I >= 0.8 and 9 < f0 and b % 2 == 1:         # louder sections: a timbale stroke on beat 4 of odd bars
                add(b, 9, 'th', .45 * I)
        if b in marks and not antic:
            add(b, 0, 'tl', marks[b]); add(b, 0 + 0.12, 'th', marks[b] * .8)
        if (b + 1) in marks and cnt(b + 1, 0) == 0 and cnt(b, 11) >= 2 and not (fill and any(int(s) == 11 for s, _, _ in fill)):
            add(b, 11, 'tl', marks[b + 1])
        if fill:
            for s, inst, v in fill:
                add(b, s, inst, v * (0.6 + 0.4 * max(I, 0.5)))
        if b == 80:
            for s, inst, v in ((6, 'th', .7), (6 + D, 'th', .6), (7, 'th', .8), (7 + D, 'tl', .75)):
                add(b, s, inst, v)
            add(b, 8, 'tl', 1.0); add(b, 8, 'th', .95)
    hits.sort(key=lambda h: h[0])
    return hits


def render(hits, total):
    N = int(total * SR)
    stems = {g: np.zeros((N, 2)) for g in ('bongo', 'timb')}
    for t, inst, v in hits:
        x = sampler.drum(KEY[inst])
        i = int(t * SR)
        if i >= N:
            continue
        if v < 0.8:
            x = S.lfilter(*S.butter(1, min(0.95, (2200 + 15000 * v) / (SR / 2))), x, axis=0)
        m = x.mean(1, keepdims=True)
        y = m + 0.5 * (x - m)
        p = PAN[inst]
        y = y * np.array([min(1.0, 1 - p), min(1.0, 1 + p)])
        y = y[:N - i] * v ** 1.6
        stems[GROUP[inst]][i:i + len(y)] += y
    return stems


# ------------------------------------------------------------------ brushes + hi-hat (second player)
BKEY = dict(sw=(40, 40), bt=(38, 40), hc=(42, 0), hf=(44, 0))      # (midi note, FluidR3 kit): Brush kit swirl/tap, Standard hats
BPAN = dict(sw=-0.12, bt=-0.12, hc=-0.3, hf=-0.3)


def arrange_brush(sc):
    """soft, sustained counterpart to the hand drums: swirls carry the beat the bongos leave open,
    quiet taps on 2 and 4, hi-hat whispering the shuffle."""
    rng = np.random.default_rng(21)

    def T(bar, slot):
        return float(sc.t2s(bar_tick(bar) + slot * EIGHTH + SLOT_OFF[slot % 12]))

    def solo(b, s):
        t = T(b, s) + 0.04
        return sum(1 for ns in sc.tracks.values() if any(n['on'] <= t < n['off'] + 0.05 for n in ns)) <= 1

    def inten(b):
        for lim, v in ((10, .55), (18, .7), (26, .85), (34, .6), (42, .75), (49, 1.0), (53, 0.0), (56, .8), (64, .8), (72, .9), (80, 1.0)):
            if b <= lim:
                return v
    hits = []

    def add(b, s, inst, v, late=0.0):
        hits.append([T(b, s) + late + rng.normal(0, 0.003), inst, float(np.clip(v * rng.uniform(0.9, 1.1), 0.03, 1.0))])

    for b in range(3, 81):
        I = inten(b)
        if I == 0:
            continue
        last = 6 if b == 80 else 12
        for s in range(last):
            k = 0.45 if solo(b, s) else 1.0
            beat = s % 3 == 0
            if beat:
                add(b, s, 'sw', (0.8 if s in (0, 6) else 0.6) * (0.6 + 0.4 * I) * k, late=-0.02)   # sweep starts just ahead of the beat
            if k < 1:
                continue
            if s in (3, 9):
                add(b, s, 'hf', 0.5 * (0.6 + 0.4 * I))
                if b >= 11:
                    add(b, s, 'bt', 0.42 * (0.6 + 0.4 * I), late=0.005)
            elif b >= 11 and s % 3 == 2:
                add(b, s, 'hc', 0.3 * (0.6 + 0.4 * I))
                if s == 11 and b % 2 == 1:
                    add(b, s, 'bt', 0.22)
            elif b >= 11 and s in (0, 6):
                add(b, s, 'hc', 0.38 * (0.6 + 0.4 * I))
    hits.sort(key=lambda h: h[0])
    return hits


def render_brush(hits, total):
    N = int(total * SR)
    stems = {g: np.zeros((N, 2)) for g in ('brush', 'bhat')}
    for t, inst, v in hits:
        key, kit = BKEY[inst]
        x = sampler.drum(key, kit)
        if inst == 'sw':
            x = x.copy(); r = int(0.035 * SR); x[:r] *= np.linspace(0.15, 1, r)[:, None]     # sweep, not a hit
        if inst in ('hc', 'hf'):
            n = int(0.25 * SR); x = x[:n] * np.exp(-np.arange(min(n, len(x))) / (0.06 * SR))[:, None]
            x = S.lfilter(*S.butter(1, 9000 / (SR / 2)), x, axis=0)
        i = int(t * SR)
        if i < 0 or i >= N:
            continue
        m = x.mean(1, keepdims=True); y = m + 0.6 * (x - m)
        p = BPAN[inst]
        y = (y * np.array([min(1.0, 1 - p), min(1.0, 1 + p)]))[:N - i] * v ** 1.4
        stems['brush' if inst in ('sw', 'bt') else 'bhat'][i:i + len(y)] += y
    return stems


# ------------------------------------------------------------------ v6: stirred brush + double-time hi-hat
def _ctl(sc):
    """per-eighth control points: time, section level, solo flag"""
    def inten(b):
        for lim, v in ((10, .55), (18, .7), (26, .85), (34, .6), (42, .75), (49, 1.0), (53, 0.0), (56, .8), (64, .8), (72, .9), (80, 1.0)):
            if b <= lim:
                return v
    pts = []
    for b in range(3, 81):
        for s in range(12):
            t = float(sc.t2s(bar_tick(b) + s * EIGHTH + SLOT_OFF[s]))
            act = sum(1 for ns in sc.tracks.values() if any(n['on'] <= t + 0.04 < n['off'] + 0.05 for n in ns))
            pts.append((b, s, t, inten(b), act <= 1))
    return pts


def render_stir(sc, total):
    """brush kept on the head and moved in circles: a continuous sound with no attacks, one circle per beat.
    Timbre is taken from the FluidR3 'Brush Swirl' sample (its spectrum shapes the noise)."""
    N = int(total * SR)
    rng = np.random.default_rng(5)
    sw = sampler.drum(40, 40).mean(1)[int(0.04 * SR):int(0.5 * SR)]
    f, P = S.welch(sw, SR, nperseg=1024)
    mag = np.sqrt(P / P.max()); mag[f < 150] *= (f[f < 150] / 150) ** 2
    fir = S.firwin2(1025, f / (SR / 2), mag)
    out = np.zeros((N, 2))
    pts = _ctl(sc)
    tt = np.arange(N) / SR
    # beat phase: one circle per dotted quarter
    bt = np.array([p[2] for p in pts if p[1] % 3 == 0]); bt = np.concatenate([bt, bt[-1] + np.diff(bt)[-1] * np.arange(1, 9)])
    beta = np.interp(tt, bt, np.arange(len(bt)))
    circle = 0.62 + 0.38 * np.cos(2 * np.pi * (beta - 0.06))             # fullest just after the beat
    circle *= 1 + 0.12 * (0.5 - 0.5 * np.cos(np.pi * beta))               # a little more weight on 2 and 4
    # level: section dynamics, back off under solos, nothing before the piece has begun or in the break
    ct = np.array([p[2] for p in pts]); cv = np.array([(0.55 + 0.45 * p[3]) * (0.4 if p[4] else 1.0) * (p[3] > 0) for p in pts])
    t_in = pts[1][2]
    cv[ct < t_in] = 0
    cv *= np.clip((ct - t_in) / (ct[24] - t_in), 0.25, 1.0)             # eases in over the first two bars
    end = float(sc.t2s(bar_tick(80) + 8 * EIGHTH))
    cv[ct > end] = 0
    g = np.interp(tt, ct, cv, left=0, right=0)
    a = 1 - np.exp(-1 / (0.12 * SR)); g = S.lfilter([a], [1, -(1 - a)], g)
    wob = S.lfilter(*S.butter(2, 1.2 / (SR / 2)), rng.normal(0, 1, N)); wob = 1 + 0.12 * wob / (np.abs(wob).max() + 1e-9) * 3
    for ch in range(2):
        nz = S.fftconvolve(rng.normal(0, 1, N), fir, mode='same')
        dark = S.lfilter(*S.butter(1, 2800 / (SR / 2)), nz)
        br = np.clip((circle - 0.24) / 0.76, 0, 1)                         # faster part of the circle is brighter
        out[:, ch] = (dark * (1 - 0.6 * br) + (nz - dark) * br * 1.2) * circle * g * wob
    return out / np.abs(out).max() * 0.3


def arrange_hat(sc):
    """double-time closed hi-hat on every eighth; now and then it opens for a split second, at irregular places."""
    rng = np.random.default_rng(33)
    pts = _ctl(sc)
    hits = []
    next_open = 9 + rng.integers(0, 6)
    for i, (b, s, t, I, solo) in enumerate(pts):
        if I == 0 or i < 2 or (b == 80 and s > 7):
            continue
        ease = min(1.0, 0.35 + 0.65 * (i - 2) / 22.0)                      # no entrance on the opening downbeat; fades in
        v = (0.5 if s % 3 == 0 else 0.32 if s % 3 == 2 else 0.26) * (0.6 + 0.4 * I) * (0.5 if solo else 1.0) * ease
        t = t + rng.normal(0, 0.002)
        if i >= next_open and not solo and s not in (0, 6) and i + 1 < len(pts) and pts[i + 1][3] > 0 and b >= 7:
            hits.append([t, 'ho', min(1.0, v * 1.9), pts[i + 1][2] - t])
            next_open = i + int(rng.choice([7, 10, 11, 13, 16, 17, 20, 23]))     # never settles into a pattern
        else:
            hits.append([t, 'hc', v, 0])
    return hits


def render_hat(hits, total):
    N = int(total * SR)
    out = np.zeros((N, 2))
    hc = sampler.drum(42, 0); ho = sampler.drum(46, 0)
    n = int(0.2 * SR)
    hc = hc[:n] * np.exp(-np.arange(n) / (0.045 * SR))[:, None]
    for t, inst, v, gap in hits:
        i = int(t * SR)
        if inst == 'hc':
            x = hc
            if v < 0.5:
                x = S.lfilter(*S.butter(1, min(0.95, (5000 + 16000 * v) / (SR / 2))), x, axis=0)
        else:
            k = int(min(gap * 0.72, 0.1) * SR)                              # open for a split second, then clamped shut
            x = ho[:k + int(0.02 * SR)].copy()
            x[k:] *= np.linspace(1, 0, len(x) - k)[:, None] ** 2
        m = x.mean(1, keepdims=True); y = (m + 0.6 * (x - m)) * np.array([1.0, 0.72])
        y = y[:N - i] * v ** 1.4
        out[i:i + len(y)] += y
    return out
