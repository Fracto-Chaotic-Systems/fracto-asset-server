import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"scripts"))
from import_fluidr3_percussion import velocity_windows, prepare_hit, pack_hits, import_kit
from fluidr3_drum_renderer import RATE
from audit_fluidr3_percussion import SF2_SHA256


def stereo():
    result=np.zeros((18000,2),dtype=np.float32)
    result[100:1100,0]=np.sin(np.arange(1000)*0.1)*0.2
    result[100:1100,1]=result[100:1100,0]*0.5
    return result


class DrumImporterTests(unittest.TestCase):
    def test_velocity_windows_keep_source_boundaries_and_holes(self):
        note={"midi_note":35,"velocity_ranges":[[1,80],[90,127]]}
        regions=[{"keys":[35,35],"velocities":[1,70]}]
        self.assertEqual(velocity_windows(note,regions),[(1,31,31),(32,63,63),(64,70,70),(71,80,80),(90,95,95),(96,127,127)])

    def test_hit_preparation_retains_attack_tail_and_finite_fades(self):
        pcm,metrics=prepare_hit(stereo())
        self.assertEqual(pcm[0],0);self.assertEqual(pcm[-1],0)
        self.assertTrue(np.any(pcm));self.assertGreater(len(pcm),1000)
        self.assertLessEqual(metrics["quantization_max_error"],1/65536)
        self.assertEqual(metrics["trim_end_frame"]-metrics["trim_start_frame"],len(pcm))

    def test_invalid_silent_cancelled_stereo_and_incomplete_tails_fail(self):
        cases=[np.zeros((18000,2)),np.full((18000,2),np.nan),np.full((18000,2),1.1),np.full((18000,2),0.1)]
        cancelled=stereo();cancelled[:,1]=-cancelled[:,0];cases.append(cancelled)
        for value in cases:
            with self.subTest(shape=value.shape),self.assertRaises(ValueError):prepare_hit(value)

    def test_chunk_packing_has_exact_windows_gaps_hashes_and_memory_bounds(self):
        hits=[{"midi_note":n,"velocity_min":1,"velocity_max":127,"render_velocity":127,"pcm":np.array([0,100,100,0],dtype="<i2")} for n in range(35,48)]
        chunks=pack_hits(hits,"kit-test","a"*64)
        self.assertEqual([len(asset["hits"]) for asset,_ in chunks],[12,1])
        for asset,content in chunks:
            self.assertEqual(asset["sha256"],hashlib.sha256(content).hexdigest())
            self.assertLessEqual(asset["decoded_bytes_at_48000"],48*1024*1024)
            for index,hit in enumerate(asset["hits"]):self.assertEqual(hit["offset_frames"],index*2404)
        with patch("import_fluidr3_percussion.MAX_DECODED_BYTES",1),self.assertRaises(ValueError):pack_hits(hits,"kit-test","a"*64)

    def test_preview_is_read_only_and_failed_render_never_writes_partial_assets(self):
        class Renderer:
            version="2.6.2"
            def render(self,*_):return stereo()
        kit={"id":"fluidr3-percussion-kit-standard","midi_program":0,"enabled":False,"verification_status":"source_audited","notes":[{"midi_note":35,"velocity_ranges":[[1,127]]}]}
        source={"regions":[{"keys":[35,35],"velocities":[1,127]}]}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);audit=root/"fluidr3-percussion";audit.mkdir()
            (audit/"kit-inventory.json").write_text("{}",encoding="utf-8");(audit/"renderer-lock.json").write_text("{}",encoding="utf-8")
            candidate,report=import_kit(root,audit,kit,source,Renderer(),False)
            self.assertEqual(report["hits"],4);self.assertFalse(candidate["enabled"])
            candidate["verification_status"]="playback_verified"
            repeated,_=import_kit(root,audit,candidate,source,Renderer(),False)
            self.assertEqual(candidate,repeated)
            candidate["enabled"]=True
            repeated,_=import_kit(root,audit,candidate,source,Renderer(),False)
            self.assertEqual(candidate,repeated)
            changed=copy.deepcopy(candidate);changed["notes"][0]["velocity_ranges"]=[[1,126]]
            with self.assertRaises(ValueError):import_kit(root,audit,changed,source,Renderer(),False)

            self.assertEqual(kit["verification_status"],"source_audited")
            self.assertFalse((root/"playback").exists());self.assertFalse((root/"indexes").exists())
            with patch.object(Renderer,"render",side_effect=ValueError("bad render")),self.assertRaises(ValueError):import_kit(root,audit,kit,source,Renderer(),True)
            self.assertFalse((root/"playback").exists())


if __name__=="__main__":unittest.main()
