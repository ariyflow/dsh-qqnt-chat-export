"""Model files: where they live, whether to trust them, how they arrive.

The download case uses a `file://` base URL, so it tests the real code path
(temporary file → verify → record → rename) without touching the network.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_models as models   # noqa: E402

MODEL = 'rapidocr-v4'
FILES = models.MODELS[MODEL]['files']


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def place(self, folder, payload=b'model'):
        os.makedirs(folder, exist_ok=True)
        for name in FILES:
            with open(os.path.join(folder, name), 'wb') as handle:
                handle.write(payload + name.encode())

    def test_a_missing_model_is_reported_not_raised(self):
        status = models.status(self.work)[MODEL]
        self.assertFalse(status['installed'])
        self.assertEqual(len(status['files']), len(FILES))
        self.assertEqual(status['bytes'], 0)
        self.assertIn('license', status)

    def test_hand_placed_files_are_accepted_and_recorded(self):
        self.place(os.path.join(self.work, 'models', MODEL))
        report = models.ensure(self.work, MODEL)
        self.assertTrue(report['ok'])
        self.assertEqual(report['missing'], [])
        lock = models.read_lock(self.work)
        self.assertEqual(set(lock[MODEL]), set(FILES))
        self.assertTrue(all(len(item['sha256']) == 64 for item in lock[MODEL].values()))

    def test_a_modified_file_fails_verification(self):
        self.place(os.path.join(self.work, 'models', MODEL))
        models.ensure(self.work, MODEL)
        target = os.path.join(self.work, 'models', MODEL, FILES[0])
        with open(target, 'ab') as handle:
            handle.write(b'tampered')
        status = models.status(self.work, MODEL, verify=True)[MODEL]
        self.assertFalse(status['intact'])
        self.assertTrue(status['installed'])

    def test_download_fills_the_gaps_from_a_base_url(self):
        source = os.path.join(self.work, 'source')
        self.place(source)
        report = models.ensure(self.work, MODEL, download=True,
                               base_url='file://' + source)
        self.assertTrue(report['ok'])
        self.assertEqual(sorted(report['downloaded']), sorted(FILES))
        on_disk = os.listdir(os.path.join(self.work, 'models', MODEL))
        self.assertEqual(sorted(on_disk), sorted(FILES))

    def test_remove_reports_what_it_freed(self):
        self.place(os.path.join(self.work, 'models', MODEL))
        models.ensure(self.work, MODEL)
        result = models.remove(self.work, MODEL)
        self.assertTrue(result['removed'])
        self.assertGreater(result['bytes'], 0)
        self.assertFalse(models.status(self.work)[MODEL]['installed'])

    def test_the_cli_reports_json_for_docs_and_debugging(self):
        out = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'qqnt_models.py'),
             '--work', self.work, 'status'],
            capture_output=True, text=True, check=False)
        self.assertEqual(out.returncode, 0, out.stderr)
        payload = json.loads(out.stdout)
        self.assertIn(MODEL, payload)
        self.assertFalse(payload[MODEL]['installed'])

    def test_an_unknown_model_is_an_error(self):
        with self.assertRaises(models.ModelError):
            models.ensure(self.work, 'no-such-model')
        with self.assertRaises(models.ModelError):
            models.model_dir(self.work, 'no-such-model')


if __name__ == '__main__':
    unittest.main()
