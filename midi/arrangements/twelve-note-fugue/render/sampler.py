"""Sample-based instruments from the Fracto asset library:
GrandB piano (Legacy recordings), FluidR3 acoustic bass, FluidR3 Standard drum kit."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import scipy.signal as S
from sf2 import SF2

SR = 44100
INSTRUMENTS = os.environ.get('FRACTO_INSTRUMENTS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'instruments'))
FLUID = os.path.join(INSTRUMENTS, 'fluidr3-percussion', 'source-cache', 'FluidR3_GM.sf2')
GB = os.path.join(os.environ.get('TNF_WORK', os.getcwd()), 'gb')

# ------------------------------------------------------------------ GrandB piano
_gb = {}
LAYERS = ['p', 'mp', 'mf', 'f']
DIV = [128, 128, 144, 256]          # same velocity->gain law as sdk/music/MidiPianoSamples.js


def piano_note(key, vel, dur):
    """stereo. Layer choice and gain follow the Fracto player's piano_sample()."""
    li = min(3, vel // 40)
    layer = LAYERS[li]
    if layer not in _gb:
        _gb[layer] = np.load('%s/%s.npz' % (GB, layer))
    seg = _gb[layer][str(key)]
    gain = vel / DIV[li]
    n = min(len(seg), int((dur + 0.6) * SR))
    x = seg[:n].astype(np.float64) * gain
    k = min(n, int(dur * SR))
    tau = 0.07 + 0.05 * 2 ** (-(key - 48) / 24)             # damper falls: low strings ring a little longer
    x[k:] *= np.exp(-np.arange(n - k) / (tau * SR))[:, None]
    f = min(n, int(0.02 * SR))
    x[-f:] *= np.linspace(1, 0, f)[:, None]
    return x


# ------------------------------------------------------------------ FluidR3
_sf = None
_cache = {}


def sf():
    global _sf
    if _sf is None:
        _sf = SF2(FLUID)
    return _sf


def _smp(sh):
    return sf().smpl[sh[1]:sh[2]].astype(np.float64) / 32768.0


_bass_regions = None
_bass_fix = {}


def _cents_off(x, sr, f_expected):
    seg = x[int(0.15 * sr):int(1.2 * sr)]
    seg = seg * np.hanning(len(seg))
    F = np.abs(np.fft.rfft(seg, 1 << 19)); fr = np.fft.rfftfreq(1 << 19, 1 / sr)
    est = []
    for h in (2, 3, 4):
        k = (fr > f_expected * h * 0.96) & (fr < f_expected * h * 1.04)
        est.append(1200 * np.log2(fr[k][F[k].argmax()] / (f_expected * h)))
    return float(np.median(est))


def bass_note(key, vel, dur):
    """FluidR3 'Acoustic Bass' (upright), mono."""
    global _bass_regions
    ck = (key, vel, round(dur, 3))
    if ck in _cache:
        return _cache[ck]
    if _bass_regions is None:
        _bass_regions = [z for z in sf().regions(0, 32)[1] if z['vlo'] <= 100 <= z['vhi']]
    z = next(r for r in _bass_regions if r['klo'] <= key <= r['khi'])
    sh = z['sh']
    root = z.get(58, sh[6])
    x = _smp(sh)
    ls, le = sh[3] - sh[1], sh[4] - sh[1]
    if sh[1] not in _bass_fix:
        _bass_fix[sh[1]] = _cents_off(x, sh[5], 440.0 * 2 ** ((root - 69) / 12))
    ratio = 2 ** ((key - root) / 12 + (z.get(52, 0) + sh[7] - _bass_fix[sh[1]]) / 1200) * sh[5] / SR
    n = int((dur + 0.25) * SR)
    pos = np.arange(n) * ratio
    over = pos >= le
    pos[over] = ls + (pos[over] - le) % (le - ls)
    up = 4
    xu = S.resample_poly(np.concatenate([x[:le], x[ls:ls + 64]]), up, 1)
    y = np.interp(pos * up, np.arange(len(xu)), xu)
    v = vel / 127.0
    # softer plucks are rounder
    y = S.lfilter(*S.butter(1, min(0.95, (900 + 9000 * v ** 1.5) / (SR / 2))), y)
    k = int(dur * SR)
    y[k:] *= np.exp(-np.arange(n - k) / (0.03 * SR))
    y[-64:] *= np.linspace(1, 0, 64)
    y *= (0.25 + 0.75 * v) ** 1.5
    _cache[ck] = y
    return y


_kit = {}


def drum(key, kit=0):
    """raw stereo one-shot of a kit piece at full level (FluidR3 kit, default Standard)."""
    if (kit, key) in _kit:
        return _kit[(kit, key)]
    rs = [z for z in sf().regions(128, kit)[1] if z['klo'] <= key <= z['khi'] and z['vlo'] <= 127 <= z['vhi']]
    out = None
    for z in rs:
        sh = z['sh']
        x = _smp(sh)
        root = z.get(58, sh[6])
        ratio = 2 ** ((key - root) / 12 + (z.get(52, 0) + sh[7]) / 1200) * sh[5] / SR
        if abs(ratio - 1) > 1e-4:
            x = np.interp(np.arange(0, len(x) - 1, ratio), np.arange(len(x)), x)
        pan = np.clip(z.get(17, 0) / 500.0, -1, 1)
        a = (pan + 1) * np.pi / 4
        st = np.stack([x * np.cos(a), x * np.sin(a)], 1) * 10 ** (-z.get(48, 0) * 0.4 / 200)
        if out is None:
            out = st
        else:
            m = max(len(out), len(st)); o = np.zeros((m, 2)); o[:len(out)] += out; o[:len(st)] += st; out = o
    _kit[(kit, key)] = out
    return out
