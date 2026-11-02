import io
import sys
from pathlib import Path
import unittest
import wave
import numpy as np
import soundfile as sf
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
from prepare_instrument_assets import plan_chunks, mono_pcm, render_chunk, validate_pcm, estimated_bytes

class PlaybackAssetTests(unittest.TestCase):
    def note(self, pitch, start=.1, end=.3):
        return {'midi_pitch':pitch,'offset_seconds':start,'end_seconds':end,
                'onset_seconds':start+.02,'tail_guarded':False}

    def test_octave_and_memory_budget_boundaries(self):
        notes=[self.note(59),self.note(60),self.note(61)]
        self.assertEqual([len(x) for x in plan_chunks(notes,1000)],[1,2])
        notes=[self.note(p,0,1) for p in [60,61,62]]
        self.assertEqual([len(x) for x in plan_chunks(notes,1000,max_bytes=400000)],[2,1])
        self.assertRaises(ValueError,plan_chunks,notes,1000,100)
        self.assertEqual(estimated_bytes(1000,1000),192000)

    def test_mono_preserves_gain_and_fades_edges(self):
        samples=np.tile([.1,.3],(1000,1)).astype('float32')
        pcm,peak=mono_pcm(samples,1000)
        self.assertAlmostEqual(peak,.2,places=6)
        self.assertLess(abs(pcm[100]/32768-.2),1/32768)
        self.assertEqual(int(pcm[0]),0)
        self.assertEqual(int(pcm[-1]),0)

    def test_nonfinite_and_clipping_sources_fail(self):
        for value in [float('nan'),float('inf'),1.1]:
            self.assertRaises(ValueError,mono_pcm,np.full((100,2),value),1000)
        self.assertRaises(ValueError,mono_pcm,np.empty((0,2)),1000)

    def source(self):
        times=np.arange(2000)/1000
        samples=np.column_stack([.1*np.sin(2*np.pi*17*times),.3*np.sin(2*np.pi*17*times)])
        # This marker is outside both selected windows and must not be copied.
        samples[700:800]=.9
        buffer=io.BytesIO()
        sf.write(buffer,samples,1000,format='WAV',subtype='FLOAT')
        buffer.seek(0)
        return buffer,samples

    def test_crops_are_frame_accurate_deterministic_and_separated_by_silence(self):
        buffer,samples=self.source()
        with sf.SoundFile(buffer) as source:
            first,mappings,_=render_chunk(source,[self.note(60),self.note(61,1.2,1.4)])
            second,_,_=render_chunk(source,[self.note(60),self.note(61,1.2,1.4)])
        self.assertEqual(first,second)
        validate_pcm(first,mappings,1000)
        self.assertEqual(mappings[0]['source_start_frame'],100)
        self.assertEqual(mappings[1]['offset_frames'],250)
        with wave.open(io.BytesIO(first),'rb') as reader:
            self.assertEqual(reader.getnchannels(),1)
            pcm=np.frombuffer(reader.readframes(reader.getnframes()),dtype='<i2')
        self.assertTrue(np.all(pcm[200:250]==0))
        np.testing.assert_allclose(pcm[20:170]/32768,samples[120:270].mean(axis=1),atol=1/32768)
        self.assertLess(np.max(np.abs(pcm/32768)),.21)

    def test_readback_rejects_bad_boundary_samples(self):
        buffer,_=self.source()
        with sf.SoundFile(buffer) as source:
            content,mappings,_=render_chunk(source,[self.note(60)])
        corrupt=bytearray(content);corrupt[44:46]=b'\x01\x00'
        self.assertRaises(ValueError,validate_pcm,bytes(corrupt),mappings,1000)

if __name__=='__main__':
    unittest.main()
