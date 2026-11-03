import sys
from pathlib import Path
import struct
import unittest
from unittest.mock import patch
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from audit_fluidr3_percussion import audit, chunks, zones, records, value_range, run


def chunk(tag, data):
    return tag + struct.pack("<I", len(data)) + data + (b"\0" if len(data) % 2 else b"")


def fixture(start=0, end=32, sample_id=0):
    info = chunk(b"LIST", b"INFO" + chunk(b"ifil", struct.pack("<HH", 2, 1)))
    pcm = chunk(b"LIST", b"sdta" + chunk(b"smpl", struct.pack("<32h", *([1000] * 32))))
    values = {
      b"phdr": struct.pack("<20sHHHIII", b"Standard",0,128,0,0,0,0)+struct.pack("<20sHHHIII",b"EOP",0,0,1,0,0,0),
      b"pbag": struct.pack("<4H",0,0,1,0),
      b"pgen": struct.pack("<4H",41,0,0,0),
      b"inst": struct.pack("<20sH",b"Drums",0)+struct.pack("<20sH",b"EOI",1),
      b"ibag": struct.pack("<4H",0,0,3,0),
      b"igen": struct.pack("<8H",43,35+(81<<8),57,1,53,sample_id,0,0),
      b"shdr": struct.pack("<20sIIIIIBbHH",b"Hit",start,end,2,16,32000,60,0,0,1)+struct.pack("<20sIIIIIBbHH",b"EOS",0,0,0,0,0,0,0,0,1),
    }
    pdta = chunk(b"LIST", b"pdta" + b"".join(chunk(k,v) for k,v in values.items()))
    payload = b"sfbk" + info + pcm + pdta
    return b"RIFF" + struct.pack("<I",len(payload)) + payload


class PercussionAuditTests(unittest.TestCase):
    def test_standard_coverage_is_key_identity_not_transposition(self):
        report=audit(fixture())
        kit=report["percussion_kits"][0]
        self.assertEqual(kit["program_zero_based"],0)
        self.assertEqual(kit["gm_35_81_missing"],[])
        self.assertEqual(len(kit["coverage"]),47)
        self.assertTrue(all(k["complete_1_127"] for k in kit["coverage"].values()))
        self.assertEqual(kit["exclusive_classes"],[1])
        self.assertEqual(kit["regions"][0]["keys"],[35,81])
        self.assertFalse(next(iter(report["referenced_sample_windows"].values()))["silent"])

    def test_rejects_truncation_bounds_and_terminal_sample_reference(self):
        for content in (fixture()[:-1],fixture(start=33),fixture(end=100),fixture(sample_id=1),b"not sf2"):
            with self.subTest(size=len(content)),self.assertRaises(ValueError):audit(content)

    def test_global_generators_are_inherited_and_local_velocity_overrides(self):
        result=zones([("Drum",0),("EOI",2)],[(0,0),(2,0),(4,0)],[(44,1+(60<<8)),(57,1),(44,61+(127<<8)),(53,0),(0,0)],53)
        self.assertEqual(value_range(result[0][0],44),(61,127))
        self.assertEqual(result[0][0][57],1)

    def test_changed_source_fails_before_publishing_audit_artifacts(self):
        with tempfile.TemporaryDirectory() as directory, patch("audit_fluidr3_percussion.read_source", return_value=b"untrusted"):
            with self.assertRaisesRegex(ValueError,"checksum"):
                run(Path(directory),offline=True)
            self.assertFalse((Path(directory)/"source-lock.json").exists())

    def test_malformed_ranges_records_and_chunks_fail_closed(self):
        with self.assertRaises(ValueError):value_range({43:100+(20<<8)},43)
        with self.assertRaises(ValueError):records(b"x","<HH")
        with self.assertRaises(ValueError):list(chunks(b"abcd",0,4))
        with self.assertRaises(ValueError):zones([("A",0),("EOI",4)],[(0,0),(0,0)],[(0,0)],53)


if __name__ == "__main__": unittest.main()
