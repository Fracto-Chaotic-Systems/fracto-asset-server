"""Section dynamics: the MIDI is almost flat in velocity, so the build of the piece is shaped here."""
import numpy as np
SEC = [(1, -3.0), (3, -5.0), (11, -3.0), (19, -1.5), (27, -4.0), (35, -2.0), (43, 0.0), (50.5, -5.0),
       (54, -2.0), (57, -1.5), (65, -0.75), (73, 0.0), (82, 0.0)]


def sec_db(bar):
    """bar = bar number + fraction. Crescendo through the last bar before a louder section."""
    bar = np.atleast_1d(np.asarray(bar, float))
    out = np.zeros(len(bar))
    for i, (b0, g0) in enumerate(SEC[:-1]):
        b1, g1 = SEC[i + 1]
        m = (bar >= b0) & (bar < b1)
        if g1 > g0:
            r = np.clip((bar[m] - (b1 - 1.0)) / 1.0, 0, 1)
            out[m] = g0 + (g1 - g0) * r
        else:
            out[m] = g0
    return out
