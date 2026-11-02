import sys
from pathlib import Path
import unittest
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
from instrument_pitch_analysis import pitch_evidence, note_bounds

class PitchAnalysisTests(unittest.TestCase):
    def tone(self, pitch, harmonics=(1,)):
        rate = 44100
        times = np.arange(round(rate * .8)) / rate
        frequency = 440 * 2 ** ((pitch - 69) / 12)
        samples = sum(.1 / order * np.sin(2 * np.pi * frequency * order * times) for order in harmonics)
        return samples, rate

    def test_correct_pitch_and_neighbour_rejection(self):
        samples, rate = self.tone(60)
        proof = pitch_evidence(samples, rate, 60)
        self.assertTrue(proof['fundamental_detected'])
        self.assertLess(abs(proof['median_partial_cents']), 1)
        self.assertIsNone(pitch_evidence(samples, rate, 59))
        self.assertIsNone(pitch_evidence(samples, rate, 61))

    def test_missing_fundamental_and_octave_rejection(self):
        samples, rate = self.tone(60, (2, 3, 4, 5))
        proof = pitch_evidence(samples, rate, 60)
        self.assertFalse(proof['fundamental_detected'])
        self.assertGreaterEqual(proof['matched_partials'], 3)
        self.assertIsNone(pitch_evidence(samples, rate, 48))

    def test_silence_dc_and_noise_are_not_pitches(self):
        for samples in [np.zeros(44100), np.ones(44100) * .1,
                        np.random.default_rng(7).normal(0, .05, 44100)]:
            self.assertIsNone(pitch_evidence(samples, 44100, 60))

    def test_bounds_preserve_early_attack_tail_and_exclude_next_slot(self):
        envelope = np.zeros(2100)
        envelope[998:1770] = .1
        envelope[1990:2099] = .1
        bounds = note_bounds(envelope, .01, 10, 10, 21)
        self.assertAlmostEqual(bounds['onset_seconds'], 9.98)
        self.assertAlmostEqual(bounds['offset_seconds'], 9.96)
        self.assertAlmostEqual(bounds['end_seconds'], 17.75)
        self.assertLess(bounds['end_seconds'], 19.9)

    def test_continuous_background_does_not_create_an_attack(self):
        self.assertIsNone(note_bounds(np.full(2100, .01), .01, 10, 10, 21))

    def test_long_tails_are_guarded_before_next_note(self):
        envelope = np.zeros(2100)
        envelope[1000:] = .1
        bounds = note_bounds(envelope, .01, 10, 10, 21)
        self.assertTrue(bounds['tail_guarded'])
        self.assertLessEqual(bounds['end_seconds'], 19.7)

if __name__ == '__main__':
    unittest.main()
