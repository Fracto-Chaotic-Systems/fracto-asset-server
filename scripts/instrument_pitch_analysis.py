"""Offline pitch/index measurements. No source audio is rewritten or uploaded."""
import math
import numpy as np

METHOD_VERSION = "chromatic-index-v1"
PROBES = ((0.06, 0.22), (0.2, 0.55), (0.8, 0.8), (1.8, 0.8))


def pitch_evidence(samples, sample_rate, pitch):
    """Require a pitched fundamental or coherent missing-fundamental series.

    This tests an indexing hypothesis, not arbitrary music transcription.
    Piano fundamentals may be weak; identifying only the largest FFT peak
    would mislabel many low notes by one or more octaves.
    """
    if len(samples) < 128:
        return None
    x = samples.astype(np.float64)
    x -= x.mean()
    signal_rms = float(np.sqrt(np.mean(x * x)))
    if signal_rms < 0.0002:
        return None
    nfft = 131072
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x)), nfft))
    maximum = float(spectrum.max())
    expected = 440 * 2 ** ((pitch - 69) / 12)
    resolution = sample_rate / nfft
    partials = []
    for harmonic in range(1, 13):
        center = expected * harmonic
        if center > sample_rate * 0.45:
            break
        lo = math.ceil(center * 2 ** (-0.65 / 12) / resolution)
        hi = math.floor(center * 2 ** (0.65 / 12) / resolution) + 1
        if hi - lo < 3:
            continue
        k = lo + int(np.argmax(spectrum[lo:hi]))
        if k == lo or k == hi - 1:
            continue
        floor = float(np.median(spectrum[max(1, int(center * 0.7 / resolution)):
                                         min(len(spectrum), int(center * 1.4 / resolution) + 1)]))
        ratio = float(spectrum[k] / maximum)
        prominence = float(spectrum[k] / max(floor, 1e-20))
        if ratio < 0.015 or prominence < 6:
            continue
        y = np.log(np.maximum(spectrum[k - 1:k + 2], 1e-20))
        denominator = y[0] - 2 * y[1] + y[2]
        delta = 0.5 * (y[0] - y[2]) / denominator if denominator else 0
        frequency = (k + float(np.clip(delta, -0.5, 0.5))) * resolution
        cents = 1200 * math.log2(frequency / center)
        if abs(cents) < 50:
            partials.append((harmonic, cents, ratio))
    direct = any(h == 1 and ratio >= 0.015 for h, _, ratio in partials)
    coherent = (len(partials) >= 3 and sum(p[2] for p in partials) >= 0.15
                and math.gcd(*(p[0] for p in partials)) == 1)
    if not (direct or coherent):
        return None
    return {
        "median_partial_cents": round(float(np.median([p[1] for p in partials])), 2),
        "matched_partials": len(partials),
        "fundamental_detected": direct,
    }


def probe_pitch(audio, nominal, pitch):
    results = []
    for delay, length in PROBES:
        if nominal + delay + length > len(audio) / audio.samplerate:
            continue
        audio.seek(round((nominal + delay) * audio.samplerate))
        samples = audio.read(round(length * audio.samplerate), dtype="float32", always_2d=True)
        result = pitch_evidence(samples.mean(axis=1), audio.samplerate, pitch)
        if result:
            results.append(result)
    if len(results) < 2:
        return None
    return {
        "matching_windows": len(results),
        "median_partial_cents": round(float(np.median([r["median_partial_cents"] for r in results])), 2),
        "max_matched_partials": max(r["matched_partials"] for r in results),
        "fundamental_detected": any(r["fundamental_detected"] for r in results),
    }


def choose_grid(audio):
    anchors = [60, 69, 72]
    scores = {}
    for spacing in [10, 20]:
        scores[spacing] = [pitch for pitch in anchors
                           if probe_pitch(audio, spacing * (pitch - 20), pitch)]
    ranking = sorted(scores, key=lambda spacing: len(scores[spacing]), reverse=True)
    if len(scores[ranking[0]]) < 2 or len(scores[ranking[0]]) == len(scores[ranking[1]]):
        raise ValueError(f"Ambiguous grid: {scores}")
    spacing = ranking[0]
    return spacing, scores[spacing]


def rms_envelope(audio):
    audio.seek(0)
    hop = round(audio.samplerate * 0.01)
    values = []
    for samples in audio.blocks(blocksize=hop * 100, dtype="float32", always_2d=True):
        count = len(samples) // hop
        if count:
            blocks = samples[:count * hop].reshape(count, hop, -1).astype(np.float64)
            values.extend(np.sqrt(np.mean(blocks * blocks, axis=(1, 2))))
    return np.array(values), hop / audio.samplerate


def note_bounds(envelope, hop_seconds, nominal, spacing, duration):
    """Approximate acoustic onset/tail; explicit guard excludes the next slot."""
    left = max(0, int((nominal - 0.3) / hop_seconds))
    right = min(len(envelope), int((nominal + spacing - 0.3) / hop_seconds))
    background = envelope[max(0, int((nominal - 1) / hop_seconds)):
                          max(0, int((nominal - 0.35) / hop_seconds))]
    noise = float(np.median(background)) if len(background) else 0
    attack = envelope[left:min(right, int((nominal + 1) / hop_seconds))]
    if len(attack) < 3:
        return None
    threshold = max(0.0001, noise * 4, float(attack.max()) * 0.003)
    active = envelope[left:right] > threshold
    runs = np.convolve(active[:len(attack)].astype(int), np.ones(3, dtype=int), "valid")
    onsets = np.flatnonzero(runs == 3)
    indices = np.flatnonzero(active)
    if not len(onsets) or not len(indices):
        return None
    onset = (left + int(onsets[0])) * hop_seconds
    tail = (left + int(indices[-1]) + 1) * hop_seconds
    start = max(nominal - 0.3, onset - 0.02, 0)
    # Preserve 50ms after the measured tail; never cross the next slot guard.
    guard = min(duration, nominal + spacing - 0.3)
    end = min(guard, tail + 0.05)
    if end <= onset:
        return None
    return {
        "onset_seconds": round(onset, 6),
        "tail_end_seconds": round(tail, 6),
        "offset_seconds": round(start, 6),
        "end_seconds": round(end, 6),
        "duration_seconds": round(end - start, 6),
        "onset_deviation_seconds": round(onset - nominal, 6),
        "rms_threshold": round(threshold, 8),
        "background_rms": round(noise, 8),
        "tail_guarded": tail >= guard - 2 * hop_seconds,
    }
