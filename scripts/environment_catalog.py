"""Search and check the local 3D model catalog without external services."""
import argparse
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(os.environ.get('FRACTO_ENVIRONMENT_CATALOG_DIR', Path(__file__).resolve().parents[1] / 'models'))


def local_path(base, relative):
    path = (base / relative).resolve()
    if not path.is_relative_to(base.resolve()):
        raise ValueError(f'Path outside asset directory: {relative}')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['list', 'validate'])
    parser.add_argument('query', nargs='?', default='')
    args = parser.parse_args()
    catalog = json.loads((ROOT / 'catalog.json').read_text())
    seen = set()
    for entry in catalog['assets']:
        record_path = local_path(ROOT, entry['record'])
        record = json.loads(record_path.read_text())
        asset_id = record['id']
        if asset_id in seen or asset_id != entry['id']:
            raise ValueError(f'Duplicate or mismatched ID: {asset_id}')
        seen.add(asset_id)
        if args.command == 'list':
            searchable = ' '.join([asset_id, record['name'], *record['tags']]).lower()
            if args.query.lower() in searchable:
                print(f"{asset_id} v{record['version']}: {record['name']} "
                      f"[license: {record['attribution']['status']}]")
            continue
        base = record_path.parent
        for source in record['sources']:
            path = local_path(base, source['path'])
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual != source['sha256']:
                raise ValueError(f'Source checksum mismatch: {path}')
        preview = record.get('preview') or {}
        for relative in [record['runtime']['path'], *([preview['path']] if preview.get('path') else []),
                         *record['working_files']]:
            if relative and not local_path(base, relative).is_file():
                raise ValueError(f'Missing asset file: {relative}')
        print(f"OK {asset_id}; attribution: {record['attribution']['status']}; "
              f"runtime: {record['runtime']['status']}")
    if args.command == 'validate':
        for entry in catalog['assets']:
            record = json.loads(local_path(ROOT, entry['record']).read_text())
            if record.get('parent_id') and record['parent_id'] not in seen:
                raise ValueError(f"Unknown parent: {record['parent_id']}")
        print(f'Validated {len(seen)} asset(s).')


if __name__ == '__main__':
    main()
