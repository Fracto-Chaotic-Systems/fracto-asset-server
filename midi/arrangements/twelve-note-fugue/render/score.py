"""Load the MIDI into note lists in seconds, with bar/slot helpers."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from midi import parse

SR = 44100
MIDI_PATH = os.environ.get('TNF_MIDI', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'source', 'TwelveNoteFugue.mid'))
EIGHTH = 512          # ticks (div = 1024 per quarter)
BAR = 6144            # 12/8 bar
FIRST_FAST_BAR = 3
FAST_START = 9216     # tick where bar 3 begins (bar 1 = 12/8 slow, bar 2 = 6/8)
LAST_BAR = 80


class Score:
    def __init__(self, path=MIDI_PATH):
        fmt, div, tr = parse(path)
        tm = {}
        for e in tr[0]:
            if e[1] == 'meta' and e[2] == 0x51:
                tm[e[0]] = int.from_bytes(e[3], 'big')
        self.ticks = np.array(sorted(tm), float)
        self.us = np.array([tm[t] for t in sorted(tm)], float)
        self.secs = np.concatenate([[0], np.cumsum(np.diff(self.ticks) * self.us[:-1] / 1e6 / div)])
        self.div = div
        self.tracks = {}
        for k, name in ((1, 'keys1'), (2, 'keys2'), (3, 'bass')):
            self.tracks[name] = self._notes(tr[k])
        self.end = float(self.t2s(tr[0][-1][0]))

    def t2s(self, t):
        t = np.asarray(t, float)
        i = np.clip(np.searchsorted(self.ticks, t, side='right') - 1, 0, len(self.ticks) - 1)
        return self.secs[i] + (t - self.ticks[i]) * self.us[i] / 1e6 / self.div

    def _notes(self, ev):
        on = {}
        out = []
        cc7 = 110
        for t, st, ch, d in ev:
            if st == 0xb0 and d[0] == 7:
                cc7 = d[1]
            elif st == 0x90 and d[1] > 0:
                on.setdefault(d[0], []).append((t, d[1], cc7))
            elif st in (0x80, 0x90) and on.get(d[0]):
                t0, v, c = on[d[0]].pop(0)
                out.append(dict(tick=t0, on=float(self.t2s(t0)), off=float(self.t2s(t)),
                                key=d[0], vel=v, gain=(c / 110.0) ** 2))
        out.sort(key=lambda n: (n['tick'], n['key']))
        for n in out:
            n['bar'], n['slot'] = bar_slot(n['tick'])
        return out

    def bar_time(self, bar, slot=0.0):
        return float(self.t2s(bar_tick(bar) + slot * EIGHTH))


def bar_tick(bar):
    if bar == 1:
        return 0
    if bar == 2:
        return BAR
    return FAST_START + (bar - 3) * BAR


def bar_slot(tick):
    """bar number and nearest eighth-slot for a tick"""
    if tick < BAR:
        b, o = 1, tick
    elif tick < FAST_START:
        b, o = 2, tick - BAR
    else:
        b, o = 3 + (tick - FAST_START) // BAR, (tick - FAST_START) % BAR
    s = int(round((o - 40) / EIGHTH))  # onsets sit 0..~60 ticks late, never early
    s = max(s, 0)
    return int(b), s


if __name__ == '__main__':
    sc = Score()
    print('end', sc.end, 'bar3', sc.bar_time(3), 'bar4', sc.bar_time(4), 'bar80 end', sc.bar_time(81))
    # micro-timing: mean onset offset (ticks) per slot
    import collections
    off = collections.defaultdict(list)
    for name in sc.tracks:
        for n in sc.tracks[name]:
            if n['bar'] >= 3:
                off[n['slot']].append(n['tick'] - bar_tick(n['bar']) - n['slot'] * EIGHTH)
    for s in sorted(off):
        a = np.array(off[s])
        print(s, len(a), 'median', np.median(a), 'min', a.min(), 'max', a.max())
