import base64
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from audit_fluidr3 import parse_bundle, pitch, blob_hash, verify_blob

def bundle(body):
    return ("\nif (typeof(MIDI) === 'undefined') var MIDI = {};\n"
            "if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};\n"
            "MIDI.Soundfont.flute = " + body + "\n").encode()

class AuditTests(unittest.TestCase):
    def test_note_octaves_accidentals_and_bounds(self):
        self.assertEqual([pitch(n) for n in ['A0','Bb0','C4','C8']], [21,22,60,108])
        self.assertEqual(pitch('C#4'), pitch('Db4'))
        for name in ['C-2','G#9','H4','../A0','A0.mp3']:
            with self.assertRaises(ValueError): pitch(name)
    def test_upstream_trailing_comma_is_data_only(self):
        body='{"Bb0":"data:audio/mp3;base64,'+base64.b64encode(b'opaque audio').decode()+'",\n\n}'
        self.assertEqual(parse_bundle(bundle(body),'flute'), {'Bb0':b'opaque audio'})
    def test_executable_suffix_wrong_wrapper_and_duplicate_keys_rejected(self):
        uri='data:audio/mp3;base64,YQ=='
        for content in [bundle(json.dumps({'A0':uri})+'; throw new Error("executed")'),
                        bundle('{"A0":"'+uri+'","A0":"'+uri+'"}'),
                        bundle('{"C#4":"'+uri+'","Db4":"'+uri+'"}'),
                        bundle(json.dumps({'A0':uri})).replace(b'Soundfont.flute', b'Soundfont.oboe')]:
            with self.assertRaises(ValueError): parse_bundle(content,'flute')
    def test_bad_note_uri_and_base64_rejected(self):
        for value in ['https://example.test/sample.mp3','data:audio/wav;base64,YQ==','data:audio/mp3;base64,!!!']:
            with self.assertRaises(ValueError): parse_bundle(bundle(json.dumps({'A0':value})),'flute')
    def test_exact_git_blob_size_and_hash_required(self):
        self.assertEqual(blob_hash(b''),'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
        expected={'size':3,'sha':blob_hash(b'abc')}
        verify_blob(b'abc',expected)
        for data in [b'abd',b'abcd']:
            with self.assertRaises(ValueError): verify_blob(data,expected)

if __name__=='__main__': unittest.main()
