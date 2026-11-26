"""Tonewheel organ (free-running wheels, drawbars, percussion, key click, scanner chorus)
and a two-rotor rotary speaker."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import scipy.signal as S

SR = 44100
OFFS = [-12, 7, 0, 12, 19, 24, 28, 31, 36]      # 16' 5 1/3' 8' 4' 2 2/3' 2' 1 3/5' 1 1/3' 1'


def _wheel_midi(m):
    while m > 114:
        m -= 12
    while m < 24:
        m += 12
    return m


def tonewheel(notes, total, drawbars='888400002', perc=(12, 0.9, 0.22), seed=1, click=0.5):
    """notes: list of dicts(on, off, key, vel, gain). Returns mono signal."""
    rng = np.random.default_rng(seed)
    N = int(total * SR)
    out = np.zeros(N)
    lv = [0 if c == '0' else 10 ** (-(8 - int(c)) * 3.0 / 20) for c in drawbars]
    # wheel phase offsets are fixed for the whole piece (wheels never stop turning)
    wph = rng.uniform(0, 2 * np.pi, 128)
    ns = sorted(notes, key=lambda n: n['on'])
    held_until = -1.0
    for nt in ns:
        i0 = int(nt['on'] * SR)
        i1 = int(nt['off'] * SR)
        g = nt['gain'] * (0.85 + 0.15 * nt['vel'] / 64.0)
        for d, l in enumerate(lv):
            if l == 0:
                continue
            m = _wheel_midi(nt['key'] + OFFS[d])
            f = 440.0 * 2 ** ((m - 69) / 12)
            taper = (f / 440.0) ** -0.18 * (0.75 if f > 4000 else 1.0)
            a = i0 + int(rng.uniform(0, 0.0035) * SR)          # contact bounce: bus bars close at slightly different times
            b = i1 + int(rng.uniform(0, 0.002) * SR)
            b = min(b, N)
            if b <= a:
                continue
            idx = np.arange(a, b)
            env = np.ones(b - a)
            ra = max(2, int(0.0004 * SR))
            rr = max(2, int(0.0025 * SR))
            env[:ra] = np.linspace(0, 1, ra)[:len(env[:ra])]
            env[-rr:] *= np.linspace(1, 0, rr)[-len(env[-rr:]):]
            out[a:b] += g * l * taper * env * np.sin(2 * np.pi * f * idx / SR + wph[m])
        # single-trigger percussion: only when no other key is down
        if perc and nt['on'] >= held_until - 0.004:
            m = _wheel_midi(nt['key'] + perc[0])
            f = 440.0 * 2 ** ((m - 69) / 12)
            b = min(N, i0 + int(1.2 * SR))
            idx = np.arange(i0, b)
            env = np.exp(-(idx - i0) / (perc[2] * SR))
            ra = int(0.0005 * SR)
            env[:ra] *= np.linspace(0, 1, ra)
            # percussion stops when the key is released
            k = max(0, i1 - i0)
            if k < len(env):
                env[k:] *= np.exp(-np.arange(len(env) - k) / (0.004 * SR))
            out[i0:b] += g * perc[1] * env * np.sin(2 * np.pi * f * idx / SR + wph[m])
        held_until = max(held_until, nt['off'])
        # extra key-click transient
        if click:
            nb = int(0.004 * SR)
            if i0 + nb < N:
                c = rng.normal(0, 1, nb) * np.exp(-np.arange(nb) / (0.0008 * SR))
                out[i0:i0 + nb] += g * click * 0.12 * c
    # slight wheel leakage / hum floor keeps it from sounding sterile
    return out


def scanner_chorus(x, depth=0.00028, rate=6.87, mix=0.5):
    n = len(x)
    t = np.arange(n)
    d = (1 + np.sin(2 * np.pi * rate * t / SR)) * depth * SR
    y = np.interp(t - d - 8, t, x)
    return (1 - mix) * x + mix * y


def drive(x, amount=1.6):
    # asymmetric tube-ish saturation, level compensated
    k = amount
    y = np.tanh(k * x + 0.08 * k) - np.tanh(0.08 * k)
    return y / k


def _var_delay(x, d):
    t = np.arange(len(x), dtype=float)
    return np.interp(t - d, t, x)


def leslie(x, fast, total=None):
    """x mono, fast = array (len x) of 0/1 speed switch. returns stereo."""
    n = len(x)
    # rotor inertia
    def glide(target, tau):
        a = 1 - np.exp(-1 / (tau * SR))
        return S.lfilter([a], [1, -(1 - a)], target, zi=[target[0] * (1 - a)])[0]
    horn_hz = 0.80 + (6.80 - 0.80) * glide(fast, 0.7)
    drum_hz = 0.67 + (5.70 - 0.67) * glide(fast, 3.0)
    th_h = 2 * np.pi * np.cumsum(horn_hz) / SR
    th_d = -2 * np.pi * np.cumsum(drum_hz) / SR + 1.0
    sos_lo = S.butter(2, 800 / (SR / 2), 'low', output='sos')
    sos_hi = S.butter(2, 800 / (SR / 2), 'high', output='sos')
    lo = S.sosfilt(sos_lo, S.sosfilt(sos_lo, x))
    hi = S.sosfilt(sos_hi, S.sosfilt(sos_hi, x))
    # horn has a strong resonant, band-limited character
    hi = S.sosfilt(S.butter(2, 6500 / (SR / 2), 'low', output='sos'), hi)
    hi_dull = S.sosfilt(S.butter(1, 2200 / (SR / 2), 'low', output='sos'), hi)
    out = np.zeros((n, 2))
    for ch, phi in ((0, -1.05), (1, 1.05)):
        c = np.cos(th_h - phi)
        dly = (0.00055 * (1 - c) + 0.0002) * SR
        direct = _var_delay(hi, dly)
        dull = _var_delay(hi_dull, dly)
        h = dull * (0.8 + 0.2 * c) + (direct - dull) * (0.35 + 0.65 * (0.5 + 0.5 * c) ** 1.5) * 1.5
        # cabinet reflection from the opposite side of the rotation
        c2 = np.cos(th_h - phi + 2.4)
        h += 0.35 * _var_delay(hi_dull, (0.00055 * (1 - c2) + 0.0038) * SR) * (0.7 + 0.3 * c2)
        cd = np.cos(th_d - phi)
        d = _var_delay(lo, (0.00022 * (1 - cd) + 0.0003) * SR) * (1 + 0.28 * cd)
        out[:, ch] = h + d
    return out
