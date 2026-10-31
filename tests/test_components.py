"""The optional Python components behind OCR, speech and embeddings.

No `pip` runs in these tests: `install()` takes an injectable runner, so the
argv is asserted directly. The venv guard is the part that matters most — a
plugin that silently pip-installs into the system interpreter is a plugin that
breaks a distribution's Python.
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_components as components   # noqa: E402


class StatusTests(unittest.TestCase):
    def test_every_feature_has_a_component_entry(self):
        status = components.status()
        self.assertEqual(sorted(status), ['asr', 'embed', 'ocr'])
        for name, item in status.items():
            self.assertEqual(item['id'], name)
            self.assertTrue(item['label'])
            self.assertTrue(item['modules'])
            self.assertEqual(item['installed'], item['missing'] == [])
            self.assertIn('venv', item)
            self.assertEqual(item['python'], sys.executable)

    def test_missing_lists_exactly_the_absent_modules(self):
        with mock.patch.object(components, '_present', side_effect=lambda m: m == 'numpy'):
            status = components.status()
        self.assertEqual(status['embed']['missing'], ['onnxruntime', 'tokenizers'])
        self.assertFalse(status['embed']['installed'])
        self.assertEqual(status['ocr']['missing'], ['rapidocr_onnxruntime'])

    def test_a_fully_installed_group_reports_no_missing(self):
        with mock.patch.object(components, '_present', return_value=True):
            status = components.status()
        self.assertTrue(all(item['installed'] for item in status.values()))
        self.assertTrue(all(item['missing'] == [] for item in status.values()))


class InstallTests(unittest.TestCase):
    def setUp(self):
        # The suite runs under a bare interpreter here; the venv guard has its
        # own case, so everything else starts from "we are inside a venv".
        patcher = mock.patch.object(components, 'in_venv', return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_packages_are_deduplicated_and_passed_to_pip(self):
        calls = []

        def runner(argv, progress):
            calls.append(argv)
            return True, ['ok']

        result = components.install(['ocr', 'embed', 'ocr'], runner=runner)
        self.assertTrue(result['ok'])
        self.assertEqual(result['groups'], ['ocr', 'embed'])
        argv = calls[0]
        self.assertEqual(argv[1:4], ['-m', 'pip', 'install'])
        self.assertIn('rapidocr-onnxruntime', argv)
        self.assertIn('tokenizers', argv)
        self.assertEqual(argv.count('rapidocr-onnxruntime'), 1)

    def test_an_unknown_group_is_refused_before_pip(self):
        with self.assertRaises(ValueError):
            components.install(['warp-drive'], runner=lambda *_: (True, []))
        with self.assertRaises(ValueError):
            components.install([], runner=lambda *_: (True, []))

    def test_a_failing_pip_keeps_its_last_lines(self):
        def runner(argv, progress):
            return False, ['ERROR: no matching distribution', 'hint: check network']

        result = components.install(['asr'], runner=runner)
        self.assertFalse(result['ok'])
        self.assertIn('no matching distribution', result['error'])
        self.assertIn('hint: check network', result['error'])

    def test_a_non_venv_interpreter_is_refused_without_running_pip(self):
        called = []
        with mock.patch.object(components, 'in_venv', return_value=False):
            result = components.install(['ocr'], runner=lambda *_: called.append(1))
        self.assertFalse(result['ok'])
        self.assertIn('虚拟环境', result['error'])
        self.assertEqual(called, [])

    def test_an_explicit_python_is_accepted_even_when_this_one_is_not_a_venv(self):
        seen = []

        def runner(argv, progress):
            seen.append(argv[0])
            return True, []

        with mock.patch.object(components, 'in_venv', return_value=False):
            result = components.install(['ocr'], runner=runner, python='/opt/venv/bin/python')
        self.assertTrue(result['ok'])
        self.assertEqual(seen, ['/opt/venv/bin/python'])

    def test_progress_receives_the_command_and_pip_lines(self):
        lines = []

        def runner(argv, progress):
            progress('Collecting rapidocr-onnxruntime')
            return True, []

        components.install(['ocr'], runner=runner, progress=lines.append)
        self.assertTrue(any('rapidocr-onnxruntime' in line for line in lines))

    def test_status_and_install_agree_on_component_ids(self):
        self.assertEqual(sorted(components.COMPONENTS), ['asr', 'embed', 'ocr'])
        self.assertEqual(components.remove_note()[:2], '组件')


if __name__ == '__main__':
    unittest.main()
