"""Modal (additive, physically-informed) piano and electric bass."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import scipy.signal as S

SR = 44100
_body_rng = np.random.default_rng(7)
_BODY_X = np.linspace(np.log2(25), np.log2(16000), 90)
_BODY_Y = S.filtfilt(*S.butter(2, 0.45), _body_rng.normal(0, 1, 90)) * 3.2   # dB ripple of soundboard


def _body(f):
    return 10 ** (np.interp(np.log2(f), _BODY_X, _BODY_Y) / 20)


def _noise_burst(rng, n, lo, hi, tau):
    x = rng.normal(0, 1, n)
    sos = S.butter(2, [lo / (SR / 2), hi / (SR / 2)], 'band', output='sos')
    x = S.sosfilt(sos, x)
    return x * np.exp(-np.arange(n) / (tau * SR))


_pcache = {}


def piano_note(key, vel, dur):
    """mono piano note. dur = key-down time in seconds."""
    ck = (key, vel, round(dur, 3))
    if ck in _pcache:
        return _pcache[ck]
    rng = np.random.default_rng(1000 + key)
    f0 = 440.0 * 2 ** ((key - 69) / 12)
    v = vel / 127.0
    B = 7e-5 * 2 ** ((key - 36) / 12 * 0.95) if key >= 36 else 7e-5 * 2 ** ((36 - key) / 30)
    n = np.arange(1, 81)
    fn = n * f0 * np.sqrt(1 + B * n * n)
    keep = fn < 13000
    n, fn = n[keep], fn[keep]
    # hammer excitation: strike position comb, velocity dependent brightness
    p = 0.118
    fc = (700 + 8500 * v ** 1.7) * 2 ** ((key - 60) / 40)
    A = (np.abs(np.sin(np.pi * n * p)) + 0.08) / n ** 0.75 * np.exp(-fn / fc)
    A *= fn / np.sqrt(fn ** 2 + 95.0 ** 2)          # soundboard radiates little below ~100 Hz
    A *= _body(fn)
    A /= np.sqrt(np.sum(A ** 2))
    # decay model: prompt + after-sound (detuned second string)
    tp = 0.50 * 2 ** (-(key - 60) / 26)
    ta = 2.6 * 2 ** (-(key - 60) / 20)
    hf = 1.0 / ((1 + 0.07 * (n - 1)) * (1 + (fn / 5500) ** 2))
    tau_p = np.maximum(tp * hf, 0.02)
    tau_a = np.maximum(ta * hf, 0.04)
    damp = key < 90
    tau_r = 0.035 + 0.05 * 2 ** (-(key - 48) / 24)
    L = int((dur + (6 * tau_r if damp else 1.5)) * SR)
    t = np.arange(L) / SR
    cents = rng.uniform(0.5, 1.4) * (1.0 if key >= 40 else 0.35)
    det = 2 ** (cents / 1200)
    ph2 = rng.uniform(0, 2 * np.pi, len(n))
    out = np.zeros(L)
    # chunk over partials to keep memory small
    for i in range(0, len(n), 16):
        sl = slice(i, i + 16)
        w = 2 * np.pi * fn[sl, None] * t[None, :]
        e1 = np.exp(-t[None, :] / tau_p[sl, None])
        e2 = np.exp(-t[None, :] / tau_a[sl, None])
        out += np.sum(A[sl, None] * (0.72 * e1 * np.sin(w) + 0.28 * e2 * np.sin(w * det + ph2[sl, None])), axis=0)
    # attack shape
    ra = int((0.0012 + 0.003 * 2 ** (-(key - 36) / 18)) * SR)
    out[:ra] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(ra) / ra)
    # hammer knock + key thump
    nb = min(L, int(0.08 * SR))
    out[:nb] += 0.10 * v * _noise_burst(rng, nb, 250, 3500, 0.007)
    out[:nb] += 0.05 * v * _noise_burst(rng, nb, 60, 220, 0.02)
    # damper
    if damp:
        k = int(dur * SR)
        out[k:] *= np.exp(-np.arange(L - k) / (tau_r * SR))
    else:
        out *= np.minimum(1, (L - np.arange(L)) / (0.05 * SR))
    amp = (0.18 + 0.82 * v) ** 1.9
    level = 1.0 + 0.15 * (60 - key) / 30        # bass a touch fuller
    out *= amp * np.clip(level, 0.8, 1.25)
    _pcache[ck] = out
    return out


_bcache = {}


def bass_note(key, vel, dur):
    """finger-style electric bass (P-bass-like pickup position), mono, pre-amp."""
    ck = (key, vel, round(dur, 3))
    if ck in _bcache:
        return _bcache[ck]
    rng = np.random.default_rng(5000 + key * 131 + vel)
    f0 = 440.0 * 2 ** ((key - 69) / 12)
    v = vel / 127.0
    B = 9e-5 * (1 + 0.04 * max(0, 45 - key))
    n = np.arange(1, 61)
    fn = n * f0 * np.sqrt(1 + B * n * n)
    keep = fn < 5500
    n, fn = n[keep], fn[keep]
    p, q = 0.17, 0.125                                   # pluck / pickup position from bridge
    A = np.sin(np.pi * n * p) * np.sin(np.pi * n * q) / n
    A *= 1 / np.sqrt(1 + (fn / (1500 + 2500 * v)) ** 4)  # finger softness + tone control
    A /= np.sqrt(np.sum(A ** 2))
    tau = 1.6 / (1 + 0.20 * (n - 1)) * 2 ** (-(key - 33) / 30)
    tau_r = 0.022
    L = int((dur + 8 * tau_r) * SR)
    t = np.arange(L) / SR
    # slight pitch overshoot on attack (string stretch)
    tg = 0.03
    tw = t + (0.004 + 0.006 * v) * tg * (1 - np.exp(-t / tg))
    out = np.zeros(L)
    for i in range(0, len(n), 16):
        sl = slice(i, i + 16)
        env = np.exp(-t[None, :] / tau[sl, None]) * (1 + 0.9 * (n[sl, None] > 2) * np.exp(-t[None, :] / 0.035))
        out += np.sum(A[sl, None] * env * np.sin(2 * np.pi * fn[sl, None] * tw[None, :]), axis=0)
    ra = int(0.004 * SR)
    out[:ra] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(ra) / ra)
    nb = min(L, int(0.04 * SR))
    out[:nb] += 0.07 * v * _noise_burst(rng, nb, 150, 1200, 0.005)
    k = int(dur * SR)
    out[k:] *= np.exp(-np.arange(L - k) / (tau_r * SR))
    out *= (0.3 + 0.7 * v) ** 1.3
    _bcache[ck] = out
    return out


def render_notes(notes, fn, total, pan_fn=None, vel_fn=None):
    """mix notes into a mono (or stereo if pan_fn) buffer"""
    N = int(total * SR)
    buf = np.zeros((N, 2)) if pan_fn else np.zeros(N)
    for nt in notes:
        v = nt['vel'] if vel_fn is None else vel_fn(nt)
        x = fn(nt['key'], int(v), nt['off'] - nt['on']) * nt['gain']
        i = int(round(nt['on'] * SR))
        x = x[:N - i]
        if pan_fn:
            pn = pan_fn(nt['key'])                    # -1..1
            a = (pn + 1) * np.pi / 4
            buf[i:i + len(x), 0] += x * np.cos(a)
            buf[i:i + len(x), 1] += x * np.sin(a)
        else:
            buf[i:i + len(x)] += x
    return buf
