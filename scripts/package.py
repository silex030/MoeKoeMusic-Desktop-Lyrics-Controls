#!/usr/bin/env python3
"""Create a directly installable MoeKoe Music ZIP; no runtime build needed."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
files = ['manifest.json', 'content.js', 'styles.css', 'README.md', 'LICENSE']
files += sorted(set(manifest['icons'].values()))
output = root / 'dist' / f"{manifest['plugin_id']}-v{manifest['version']}.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    for filename in files:
        archive.write(root / filename, f"{manifest['plugin_id']}/{filename}")
print(output)
