"""Mix + master. usage: mix.py [piano|organ] outname"""
import os, sys, subprocess, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import scipy.signal as S
import scipy.io.wavfile as W
from scipy.ndimage import minimum_filter1d, uniform_filter1d
from score import Score, SR
import organ
from dyn import sec_db
from score import bar_tick, BAR

keys1 = sys.argv[1] if len(sys.argv) > 1 else 'piano'
outname = sys.argv[2] if len(sys.argv) > 2 else 'mix'
PERC = '--perc' in sys.argv
DR = 0.0 if ('--nodrums' in sys.argv or PERC) else 1.0
sc = Score()


# ------------------------------------------------------------------ dsp helpers
def biquad(kind, f, q=0.707, g=0.0):
    A = 10 ** (g / 40); w = 2 * np.pi * f / SR; cs, sn = np.cos(w), np.sin(w); al = sn / (2 * q)
    if kind == 'peak':
        b = [1 + al * A, -2 * cs, 1 - al * A]; a = [1 + al / A, -2 * cs, 1 - al / A]
    elif kind == 'lowshelf':
        s2 = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) - (A - 1) * cs + s2), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - s2)]
        a = [(A + 1) + (A - 1) * cs + s2, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - s2]
    elif kind == 'highshelf':
        s2 = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) + (A - 1) * cs + s2), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - s2)]
        a = [(A + 1) - (A - 1) * cs + s2, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - s2]
    elif kind == 'hp':
        b = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2]; a = [1 + al, -2 * cs, 1 - al]
    elif kind == 'lp':
        b = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2]; a = [1 + al, -2 * cs, 1 - al]
    return np.array(b) / a[0], np.array(a) / a[0]


def eq(x, *bands):
    for bd in bands:
        b, a = biquad(*bd)
        x = S.lfilter(b, a, x, axis=0)
    return x


def comp(x, thr, ratio, att, rel, knee=6.0, makeup=0.0, sc_sig=None, hop=16):
    """feed-forward compressor, stereo linked. returns processed signal and gain reduction (dB) curve"""
    s = x if sc_sig is None else sc_sig
    m = np.abs(s) if s.ndim == 1 else np.abs(s).max(axis=1)
    nb = len(m) // hop
    pk = m[:nb * hop].reshape(nb, hop).max(axis=1)
    lv = 20 * np.log10(pk + 1e-9)
    over = lv - thr
    gr = np.where(over <= -knee / 2, 0.0, np.where(over >= knee / 2, over, (over + knee / 2) ** 2 / (2 * knee))) * (1 - 1 / ratio)
    ca = np.exp(-hop / (att * SR)); cr = np.exp(-hop / (rel * SR))
    out = np.empty(nb); g = 0.0
    for i in range(nb):
        c = ca if gr[i] > g else cr
        g = c * g + (1 - c) * gr[i]
        out[i] = g
    grs = np.interp(np.arange(len(m)), np.arange(nb) * hop + hop / 2, out)
    gain = 10 ** ((makeup - grs) / 20)
    return (x * gain if x.ndim == 1 else x * gain[:, None]), grs


def make_ir(rt60, length, seed, predelay=0.012, damp=0.5, er=True):
    rng = np.random.default_rng(seed)
    n = int(length * SR); t = np.arange(n) / SR
    ir = np.zeros((n, 2))
    for ch in range(2):
        nz = rng.normal(0, 1, n)
        lo = S.sosfilt(S.butter(2, 500 / (SR / 2), 'low', output='sos'), nz)
        hi = S.sosfilt(S.butter(2, 4000 / (SR / 2), 'high', output='sos'), nz)
        mid = nz - lo - hi
        y = lo * np.exp(-6.91 * t / (rt60 * 1.15)) + mid * np.exp(-6.91 * t / rt60) + hi * np.exp(-6.91 * t / (rt60 * damp))
        y *= (1 - np.exp(-t / 0.012))
        if er:
            for k in range(9):
                d = int(rng.uniform(0.004, 0.06) * SR)
                y[d] += rng.choice([-1, 1]) * 12 * np.exp(-d / (0.03 * SR))
        ir[:, ch] = y
    ir = np.concatenate([np.zeros((int(predelay * SR), 2)), ir])
    ir /= np.sqrt((ir ** 2).sum(axis=0).mean())
    return ir


def reverb(x, ir):
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    y = np.stack([S.fftconvolve(x[:, c], ir[:, c])[:len(x)] for c in range(2)], 1)
    # a little cross-feed for width
    return y


def db(g):
    return 10 ** (g / 20)


def lufs(x):
    tmp = '/tmp/_m.wav'
    x2 = x if x.ndim == 2 else np.stack([x, x], 1)
    W.write(tmp, SR, x2.astype(np.float32))
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', tmp, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr
    s = r[r.rindex('Summary'):]
    return float(re.search(r'I:\s+(-?[\d.]+)', s).group(1)), float(re.search(r'Peak:\s+(-?[\d.]+)', s).group(1)), float(re.search(r'LRA:\s+(-?[\d.]+)', s).group(1))


def to_level(x, target):
    l, _, _ = lufs(x)
    return x * db(target - l)


def pan_st(x, p):
    a = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], 1) * np.sqrt(2)


def balance(x, p):
    y = x.copy()
    y[:, 0] *= min(1, 1 - p); y[:, 1] *= min(1, 1 + p)
    return y


def width(x, w):
    m = x.mean(1); s = (x[:, 0] - x[:, 1]) / 2
    return np.stack([m + w * s, m - w * s], 1)


def L(name):
    return np.load(name).astype(np.float64)


# ------------------------------------------------------------------ stems
N = len(L('raw_bass.npy'))
tt = np.arange(N) / SR


# swell-pedal curve from the section dynamics (per sample)
_bars = np.arange(1, 82.01, 1 / 24.0)
_bt = np.array([sc.bar_time(int(b), (b % 1) * 12) if b < 81 else sc.bar_time(80, 12 + (b - 81) * 12) for b in _bars])
SWELL = 10 ** (np.interp(tt, _bt, sec_db(_bars)) / 20)
_a = 1 - np.exp(-1 / (0.05 * SR)); SWELL = S.lfilter([_a], [1, -(1 - _a)], SWELL, zi=[SWELL[0] * (1 - _a)])[0]


def leslie_switch(ranges):
    f = np.zeros(N)
    for b0, b1 in ranges:
        f[int(sc.bar_time(int(b0), (b0 % 1) * 12) * SR):int(sc.bar_time(int(b1), (b1 % 1) * 12) * SR)] = 1
    return f


def organ_chain(dry, fast_ranges, drive_amt=1.3, seed=0):
    x = dry / 6.5 * SWELL
    x = organ.scanner_chorus(x)
    x = eq(x, ('hp', 55), ('peak', 180, 0.8, -2.0), ('peak', 2800, 0.8, 3.0))
    x = organ.drive(x, drive_amt)
    y = organ.leslie(x, leslie_switch(fast_ranges))
    y = eq(y, ('hp', 78), ('hp', 78), ('lowshelf', 150, 0.7, -2.5), ('peak', 300, 0.9, -2.5), ('peak', 2200, 0.8, 3.0), ('highshelf', 5000, 0.7, 3.0))
    return y


# keys 2: the rock organ
org = organ_chain(L('raw_organ.npy'), [(18.0, 19.5), (23.0, 27.0), (42.0, 50.4), (56.0, 57.5), (65.0, 69.0), (73.0, 81.0)])

if keys1 == 'piano':
    p = L('raw_keys1_piano.npy')              # GrandB samples: keep them natural
    p = eq(p, ('hp', 35), ('peak', 350, 0.8, -2.5), ('peak', 2800, 0.7, 3.5), ('highshelf', 6000, 0.7, 3.5))
    p = to_level(p, -20)
    p, gr = comp(p, -14, 2.0, 0.015, 0.2, makeup=0)
    print('piano GR max %.1f mean %.1f' % (gr.max(), gr.mean()))
    k1 = balance(width(p, 1.1), -0.2)
    k1_send = -15.0
else:
    k1 = organ_chain(L('raw_keys1_organ.npy'), [(42.0, 50.4), (73.0, 81.0)], drive_amt=1.0)
    k1 = balance(k1, -0.3)
    org = balance(org, 0.3)
    k1_send = -17.0
if keys1 == 'piano':
    org = balance(org, 0.25)

# bass: upright, mic + a little DI-style definition
b = L('raw_bass.npy')
b = eq(b, ('hp', 36), ('peak', 95, 1.0, 1.5), ('peak', 260, 1.0, -2.5), ('peak', 850, 1.0, 2.5), ('peak', 2400, 1.0, 2.0), ('lp', 7000, 0.7))
b = to_level(b, -20)
b = b + 0.45 * eq(np.tanh(9.0 * b) / 9.0, ('hp', 160), ('hp', 160), ('lp', 3500, 0.7)) * 2.0     # string growl so it reads on small speakers
b = eq(b, ('lowshelf', 90, 0.7, -3.5))
b, gr = comp(b, -15, 3.5, 0.02, 0.14, makeup=0)
print('bass GR max %.1f mean %.1f' % (gr.max(), gr.mean()))
bass = pan_st(b, 0.0) / np.sqrt(2)

# drums
kick = L('raw_dr_kick.npy'); snare = L('raw_dr_snare.npy'); hats = L('raw_dr_hats.npy'); cym = L('raw_dr_cym.npy'); toms = L('raw_dr_toms.npy')
kick = eq(kick, ('hp', 38), ('peak', 70, 1.0, 2.0), ('peak', 350, 1.0, -4.0), ('peak', 4000, 1.0, 3.0))
kick = to_level(kick, -24); kick, _ = comp(kick, -12, 3.0, 0.02, 0.1)
snare = eq(snare, ('hp', 100), ('peak', 220, 1.0, 1.5), ('peak', 800, 1.2, -1.5), ('highshelf', 6000, 0.7, 1.5))
snare = to_level(snare, -24); snare, _ = comp(snare, -12, 3.0, 0.01, 0.09)
hats = eq(hats, ('hp', 350), ('highshelf', 9000, 0.7, 1.0))
cym = eq(cym, ('hp', 250))
toms = eq(toms, ('hp', 60), ('peak', 380, 1.0, -3.0), ('peak', 4500, 1.0, 2.0))

# ------------------------------------------------------------------ balance (integrated LUFS per stem)
LV = dict(k1=-20.5, org=-23.5, bass=-23.5, kick=-26.5, snare=-25.5, hats=-33.0, cym=-33.0, toms=-27.0)
if keys1 != 'piano':
    LV['k1'] = -21.5
stems = dict(k1=k1, org=org, bass=bass, kick=kick, snare=snare, hats=hats, cym=cym, toms=toms)
for k in stems:
    stems[k] = to_level(stems[k], LV[k])

# ---- dialogue: when piano and organ trade the running melody against the syncopated figure,
# the one with the melody swells forward and the other settles back into the rhythm
def roles():
    slots = {}
    for name in ('keys1', 'keys2'):
        for n in sc.tracks[name]:
            slots.setdefault((name, n['bar']), set()).add(n['slot'])
    out = {}
    for b in range(3, 81):
        a = len(slots.get(('keys1', b), ())); o = len(slots.get(('keys2', b), ()))
        if a >= 9 and 0 < o <= 7:
            out[b] = 'piano'
        elif o >= 9 and 0 < a <= 7:
            out[b] = 'organ'
    return out


ROLES = roles()
print('piano leads:', sorted(b for b, r in ROLES.items() if r == 'piano'))
print('organ leads:', sorted(b for b, r in ROLES.items() if r == 'organ'))
GP = {'piano': 2.5, 'organ': -2.5}; GO = {'piano': -1.5, 'organ': 3.5}
ALT = {b for b in ROLES if ROLES.get(b - 1) not in (None, ROLES[b]) or ROLES.get(b + 1) not in (None, ROLES[b])}
print('bar-by-bar exchange (full swell):', sorted(ALT))
pts_t, pts_p, pts_o = [0.0], [0.0], [0.0]
for b in range(3, 82):
    prev, cur = ROLES.get(b - 1), ROLES.get(b)
    # the hand-over happens on the pick-up notes into the bar
    for t_, r, bb in ((sc.bar_time(b - 1, 8.4), prev, b - 1), (sc.bar_time(b - 1, 9.6), cur, b)):
        k = 1.0 if bb in ALT else 0.5                    # long stretches with one leader get a gentler lift
        pts_t.append(t_); pts_p.append(k * GP.get(r, 0.0)); pts_o.append(k * GO.get(r, 0.0))
dia_p = 10 ** (np.interp(tt, pts_t, pts_p) / 20); dia_o = 10 ** (np.interp(tt, pts_t, pts_o) / 20)
stems['k1'] = stems['k1'] * dia_p[:, None]
# keep the organ from covering the piano: it dips a little whenever the piano is playing
stems['org'], gr = comp(stems['org'], -27, 1.35, 0.008, 0.18, knee=10, sc_sig=stems['k1'])
print('organ duck from piano: max %.1f mean %.1f dB' % (gr.max(), gr.mean()))
stems['org'] = stems['org'] * dia_o[:, None]
drum_dry = stems['kick'] + stems['snare'] + stems['hats'] + stems['cym'] + stems['toms']
room = make_ir(0.30, 0.45, 5, predelay=0.004, damp=0.55)
drum_room = reverb(stems['snare'] + stems['toms'] + 0.35 * stems['kick'] + 0.5 * stems['hats'] + 0.6 * stems['cym'], room)
drum_room = eq(drum_room, ('hp', 150), ('lp', 9000, 0.7))
drums = drum_dry + db(-15) * drum_room
# parallel "smash" compression for weight
smash, _ = comp(drums, -34, 8.0, 0.004, 0.12, makeup=10)
drums = drums + db(-19) * eq(smash, ('hp', 60), ('lp', 10000, 0.7))

drums = drums * DR
if PERC:
    bongo = eq(L('raw_pc_bongo.npy'), ('hp', 120), ('peak', 400, 1.0, -2.0), ('peak', 3500, 0.8, -2.0), ('highshelf', 7000, 0.7, -2.0))
    bongo = to_level(bongo, -24)
    bongo, bgr = comp(bongo, -15, 3.0, 0.001, 0.06, hop=4)                      # take the edge off the hardest slaps
    print('bongo peak taming: max %.1f dB' % bgr.max())
    timb = eq(L('raw_pc_timb.npy'), ('hp', 110), ('highshelf', 7000, 0.7, -1.5))
    brush = eq(L('raw_pc_brush.npy'), ('hp', 180), ('peak', 5000, 0.8, 1.5))
    bhat = eq(L('raw_pc_bhat.npy'), ('hp', 600))
    pc = to_level(bongo, -34.5) + to_level(timb, -32.0) + to_level(bhat, -38.0)
    proom = make_ir(0.75, 1.0, 8, predelay=0.010, damp=0.6)                      # a live room around the hand drums
    drums = pc + db(-4.5) * eq(reverb(pc, proom), ('hp', 140), ('lp', 9000, 0.7))
plate = make_ir(1.25, 1.8, 11, predelay=0.022, damp=0.45)
send = db(k1_send + 1.5) * stems['k1'] + db(-13.5) * stems['org'] + DR * (db(-23) * (stems['snare'] + stems['toms']) + db(-28) * stems['cym'])
wet = eq(reverb(send, plate), ('hp', 220), ('lp', 8500, 0.7))

mixb = stems['k1'] + stems['org'] + stems['bass'] + drums + wet

for k in ('k1', 'org', 'bass'):
    print(k, 'LUFS %.1f' % lufs(stems[k])[0])
print('pre-master mix', lufs(mixb))

# ------------------------------------------------------------------ master
m = eq(mixb * SWELL[:, None] ** 0.5, ('hp', 27, 0.707), ('peak', 240, 0.8, -1.0))
m, gr = comp(m, -12, 1.8, 0.03, 0.25, knee=8)
print('glue GR max %.1f mean %.1f' % (gr.max(), gr.mean()))


def limiter(x, ceiling_db=-1.1, look=0.005, rel=0.12):
    c = db(ceiling_db)
    up = np.abs(S.resample_poly(x, 4, 1, axis=0))          # inter-sample (true) peaks
    pk = np.maximum(up[:len(x) * 4].reshape(len(x), 4, 2).max(axis=(1, 2)), np.abs(x).max(axis=1))
    pk = np.maximum(pk, np.roll(pk, 1)); pk = np.maximum(pk, np.roll(pk, -1))
    g = np.minimum(1.0, c / np.maximum(pk, 1e-9))
    w = int(look * SR)
    g = minimum_filter1d(g, 2 * w + 1)
    # release smoothing at block rate
    hop = 8; nb = len(g) // hop
    gb = g[:nb * hop].reshape(nb, hop).min(axis=1)
    cr = np.exp(-hop / (rel * SR)); o = np.empty(nb); s = 1.0
    for i in range(nb):
        s = gb[i] if gb[i] < s else cr * s + (1 - cr) * gb[i]
        o[i] = s
    gs = np.repeat(o, hop); gs = np.concatenate([gs, np.full(len(g) - len(gs), gs[-1])])
    gs = np.minimum(gs, g)
    gs = uniform_filter1d(minimum_filter1d(gs, w + 1), w + 1)
    return x * gs[:, None], 20 * np.log10(gs)


target = -14.0
gain = target - lufs(m)[0]
for it in range(4):
    y, lg = limiter(m * db(gain))
    l, tp, lra = lufs(y)
    print('iter', it, 'gain %.2f LUFS %.2f TP %.2f LRA %.1f  limiter GR max %.1f, >1dB %.2f%% of time' % (gain, l, tp, lra, -lg.min(), 100 * (lg < -1).mean()))
    if abs(l - target) < 0.1:
        break
    gain += target - l
if tp > -1.0:
    y *= db(-1.0 - tp - 0.05)
# trim tail & fades
end = int((sc.end + 4.2) * SR)
y = y[:end]
k = int(1.5 * SR); y[-k:] *= np.linspace(1, 0, k)[:, None] ** 2
lead = int(0.25 * SR)
y = np.concatenate([np.zeros((lead, 2)), y])
# TPDF dither to 16 bit
rng = np.random.default_rng(0)
d = (rng.uniform(-0.5, 0.5, y.shape) + rng.uniform(-0.5, 0.5, y.shape)) / 32768
W.write(outname + '.wav', SR, np.clip((y + d) * 32767, -32768, 32767).astype(np.int16))
np.save(outname + '_stems.npy', {k: v.astype(np.float32) for k, v in dict(k1=stems['k1'], org=stems['org'], bass=stems['bass'], drums=drums, wet=wet).items()}, allow_pickle=True)
print('wrote', outname + '.wav', len(y) / SR, 's')
