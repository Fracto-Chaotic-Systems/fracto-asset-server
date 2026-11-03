import copy
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"scripts"))
from catalog_fluidr3_percussion import extend_catalog, coverage_ranges
from audit_fluidr3_percussion import COMMIT, SF2_SHA256


def inputs():
    catalog={"library_version":4,"default_library_id":"fluidr3-gm","libraries":[{"id":"fluidr3-gm","name":"Melodic"}],"instruments":[{"id":"existing","enabled":True}]}
    lock={"commit":COMMIT,"source":{"sha256":SF2_SHA256},"repository":"https://github.com/pianobooster/fluid-soundfont"}
    inventory={"percussion_kits":[{"name":"Standard" if i==0 else "Kit "+str(i),"program_zero_based":i,"exclusive_classes":[1],"regions":[{"keys":[35,35],"exclusive_class":1}],"coverage":{"35":{"velocity_ranges":[[1,80],[81,127]]}}} for i in range(31)]}
    return catalog,lock,inventory


class DrumCatalogTests(unittest.TestCase):
    def test_metadata_extension_is_idempotent_and_preserves_melodic_state(self):
        catalog,lock,inventory=inputs();original=copy.deepcopy(catalog)
        result=extend_catalog(catalog,lock,inventory)
        self.assertEqual(catalog,original)
        self.assertEqual(result["instruments"],original["instruments"])
        self.assertEqual(result["default_library_id"],"fluidr3-gm")
        self.assertEqual(len(result["drum_kits"]),31)
        self.assertFalse(any(k["enabled"] for k in result["drum_kits"]))
        self.assertEqual(result["drum_kits"][0]["notes"][0]["velocity_ranges"],[[1,127]])
        self.assertEqual(extend_catalog(result,lock,inventory),result)

    def test_changed_pin_or_imported_state_cannot_be_overwritten(self):
        catalog,lock,inventory=inputs()
        bad=copy.deepcopy(lock);bad["source"]["sha256"]="0"*64
        with self.assertRaises(ValueError):extend_catalog(catalog,bad,inventory)
        result=extend_catalog(catalog,lock,inventory);result["drum_kits"][0]["enabled"]=True
        with self.assertRaises(ValueError):extend_catalog(result,lock,inventory)

    def test_velocity_union_preserves_real_holes(self):
        self.assertEqual(coverage_ranges([[1,40],[30,80],[90,127]]),[[1,80],[90,127]])


if __name__=="__main__":unittest.main()
