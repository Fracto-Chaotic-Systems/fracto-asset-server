"""Write the arrangement MIDI: the source file's tracks unchanged + one channel-10 percussion track."""
import os, sys, struct, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from score import Score, MIDI_PATH
import perc

OUT = sys.argv[1]
sc = Score()
src = open(MIDI_PATH, 'rb').read()
assert src[:4] == b'MThd'
fmt, ntr, div = struct.unpack('>HHH', src[8:14])
pos = 14; chunks = []
for _ in range(ntr):
    ln = struct.unpack('>I', src[pos + 4:pos + 8])[0]
    chunks.append(src[pos:pos + 8 + ln]); pos += 8 + ln

# seconds -> ticks (inverse tempo map)
tk = np.concatenate([sc.ticks, [sc.ticks[-1] + 10_000_000]])
sec = np.concatenate([sc.secs, [sc.secs[-1] + 10_000_000 * sc.us[-1] / 1e6 / div]])
def s2t(t): return int(round(float(np.interp(t, sec, tk))))

GM = dict(bh=60, bl=61, th=65, tl=66, hc=42, ho=46)
ev = []          # (tick, order, bytes)
def note(t, key, vel, dur_ticks):
    a = s2t(t); ev.append((a, 1, bytes([0x99, key, vel]))); ev.append((a + max(1, dur_ticks), 0, bytes([0x89, key, 0])))
counts = {}
for t, inst, v in perc.arrange(sc):
    note(t, GM[inst], int(np.clip(round(127 * v ** 0.8), 1, 127)), 120); counts[inst] = counts.get(inst, 0) + 1
for t, inst, v, gap in perc.arrange_hat(sc):
    k = 'ho' if inst == 'ho' else 'hc'
    dur = s2t(t + min(gap * 0.72, 0.1)) - s2t(t) if k == 'ho' else 100
    note(t, GM[k], int(np.clip(round(127 * v ** 0.7), 1, 127)), dur); counts[k] = counts.get(k, 0) + 1
ev.sort(key=lambda e: (e[0], e[1]))
def vlq(n):
    b = [n & 0x7f]; n >>= 7
    while n: b.append((n & 0x7f) | 0x80); n >>= 7
    return bytes(reversed(b))
name = b'Percussion'
body = b'\x00\xff\x03' + vlq(len(name)) + name + b'\x00\xb9\x07\x64' + b'\x00\xb9\x0a\x40'
last = 0
for t, _, b in ev:
    body += vlq(t - last) + b; last = t
end_tick = max(last, int(sc.ticks[-1]) if False else last)
body += vlq(0) + b'\xff\x2f\x00'
trk = b'MTrk' + struct.pack('>I', len(body)) + body
open(OUT, 'wb').write(src[:8] + struct.pack('>HHH', 1, ntr + 1, div) + b''.join(chunks) + trk)
print(json.dumps(dict(tracks=ntr + 1, division=div, percussion_notes=counts, first_perc_tick=ev[0][0], last_perc_tick=last)))
