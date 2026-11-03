from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"scripts"))
from verify_standard_kit import source_map,FAMILIES


def inventory():
    return {"percussion_kits":[{"program_zero_based":0,"regions":[{"keys":[note,note],"sample_key":str(note),"instrument_name":"Source"} for note in range(35,82)]}],
      "referenced_sample_windows":{str(note):{"name":FAMILIES[note-35]+"(L)"} for note in range(35,82)}}


class StandardMapTests(unittest.TestCase):
    def test_all_core_identities_have_matching_source_families(self):
        result=source_map(inventory());self.assertEqual(len(result),47);self.assertEqual(result[0]["gm_name"],"Acoustic Bass Drum")
        self.assertEqual(result[-1]["gm_name"],"Open Triangle")

    def test_swapped_or_missing_sound_families_are_rejected(self):
        data=inventory();data["referenced_sample_windows"]["35"]["name"]="Std Snare"
        with self.assertRaises(ValueError):source_map(data)
        data=inventory();data["percussion_kits"][0]["regions"].pop()
        with self.assertRaises(ValueError):source_map(data)


if __name__=="__main__":unittest.main()
