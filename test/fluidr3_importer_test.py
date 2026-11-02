import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
from import_fluidr3 import canonical_source, retain, publish_catalog, decode_notes
from prepare_instrument_assets import render_chunk, validate_pcm


def source_note(pitch=60, silent=False):
    samples=np.zeros((800,2),dtype=np.float32)
    if not silent:
        samples[200:700,0]=.3*np.sin(np.arange(500)*.2)
        samples[200:700,1]=samples[200:700,0]*.5
    info={'midi_pitch':pitch,'name':'C4' if pitch==60 else 'Db4','sha256':'a'*64,
          'frames':800,'sample_rate':8000,'channels':2,'decoded_probe':{'peak':float(np.max(np.abs(samples)))}}
    return info,samples,8000

class ImporterTests(unittest.TestCase):
    def test_silent_exclusion_frame_windows_and_mono_quantization(self):
        a=source_note();b=source_note(61,True)
        content,notes,excluded,rate,frames,error=canonical_source([a,b])
        self.assertEqual([n['midi_pitch'] for n in notes],[60])
        self.assertEqual(excluded[0]['reason'],'silent_source')
        self.assertEqual(excluded[0]['midi_pitch'],61)
        self.assertEqual(frames,800)
        self.assertLessEqual(error,1/32768)
        note=notes[0]
        self.assertEqual(round(note['offset_seconds']*rate),41)
        with sf.SoundFile(io.BytesIO(content)) as audio:
            wav,mappings,_=render_chunk(audio,notes)
        validate_pcm(wav,mappings,rate)
        self.assertEqual(mappings[0]['frames'],759)
        self.assertEqual(mappings[0]['onset_frame'],160)
    def test_phase_cancellation_and_clipping_do_not_silently_publish(self):
        note,pcm,rate=source_note();pcm[:,1]=-pcm[:,0]
        with self.assertRaisesRegex(ValueError,'vanished'): canonical_source([(note,pcm,rate)])
        pcm[:]=2
        with self.assertRaisesRegex(ValueError,'clip'): canonical_source([(note,pcm,rate)])
    def test_decode_shape_and_audit_silence_are_checked(self):
        note,pcm,rate=source_note()
        with self.assertRaises(ValueError):canonical_source([(note,pcm[:-1],rate)])
        with self.assertRaises(ValueError):canonical_source([(note,np.zeros_like(pcm),rate)])
        with self.assertRaises(ValueError):canonical_source([source_note(silent=True)])
    def test_preview_idempotence_conflicts_and_path_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            self.assertTrue(retain(root,'playback/a/file.wav',b'first',False))
            self.assertFalse((root/'playback').exists())
            self.assertTrue(retain(root,'playback/a/file.wav',b'first',True))
            self.assertFalse(retain(root,'playback/a/file.wav',b'first',True))
            with self.assertRaisesRegex(ValueError,'Conflicting'):retain(root,'playback/a/file.wav',b'changed',True)
            with self.assertRaisesRegex(ValueError,'escapes'):retain(root,'../escape.wav',b'bad',True)
    def test_candidate_failure_and_concurrent_change_preserve_active_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'catalog.json';path.write_bytes(b'old')
            with patch('import_fluidr3.subprocess.run',side_effect=subprocess.CalledProcessError(1,'verify')):
                with self.assertRaises(subprocess.CalledProcessError):publish_catalog(root,b'old',b'candidate')
            self.assertEqual(path.read_bytes(),b'old')
            self.assertEqual(list(root.glob('*.next.json')),[])
            def race(*args,**kwargs):path.write_bytes(b'concurrent')
            with patch('import_fluidr3.subprocess.run',side_effect=race):
                with self.assertRaisesRegex(ValueError,'changed'):publish_catalog(root,b'old',b'candidate')
            self.assertEqual(path.read_bytes(),b'concurrent')
            with patch('import_fluidr3.subprocess.run'):
                publish_catalog(root,b'concurrent',b'candidate')
            self.assertEqual(path.read_bytes(),b'candidate')
    def test_legacy_grid_tools_refuse_mixed_catalogs_before_writing(self):
        import index_instruments
        import prepare_instrument_assets
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'catalog.json'
            path.write_text(json.dumps({'instruments':[{'library_id':'fluidr3-gm'}]}))
            before=path.read_bytes()
            with patch('prepare_instrument_assets.subprocess.run'):
                for module in [index_instruments,prepare_instrument_assets]:
                    with self.assertRaisesRegex(ValueError,'mixed-library'):
                        module.run(root,True)
            self.assertEqual(path.read_bytes(),before)
            self.assertEqual(list(root.iterdir()),[path])
    def test_bundle_key_inventory_is_checked_before_decoding(self):
        content=b"if (typeof(MIDI) === 'undefined') var MIDI = {};\nif (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};\nMIDI.Soundfont.flute = {\"C4\":\"data:audio/mp3;base64,YQ==\"}"
        with self.assertRaisesRegex(ValueError,'keys differ'):list(decode_notes({'name':'flute','notes':[]},content))

if __name__=='__main__':unittest.main()
