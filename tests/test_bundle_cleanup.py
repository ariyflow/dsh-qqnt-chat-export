"""The export bundle staging directory must not outlive a cancelled job.

A cancel is SIGTERM, which Python's default handler turns into an immediate
exit — no `finally`, so the media copy used to stay in `exports/` forever.
`_sweep_bundles` reclaims what a SIGKILL leaves; `_BundleGuard` removes the
directory on a signal.
"""
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import qqnt_query as query  # noqa: E402


class BundleSweepTest(unittest.TestCase):
    def test_stale_bundle_dirs_are_removed_and_fresh_ones_kept(self):
        with tempfile.TemporaryDirectory() as root:
            old = os.path.join(root, '.bundle-old')
            fresh = os.path.join(root, '.bundle-fresh')
            other = os.path.join(root, 'export.txt')
            os.mkdir(old)
            os.mkdir(fresh)
            with open(other, 'w', encoding='utf-8') as handle:
                handle.write('keep')
            stale = time.time() - 2 * 3600
            os.utime(old, (stale, stale))
            os.utime(other, (stale, stale))

            query._sweep_bundles(root)

            self.assertFalse(os.path.exists(old))
            self.assertTrue(os.path.exists(fresh))
            # A finished export is not a staging directory; only the web layer
            # ages those out.
            self.assertTrue(os.path.exists(other))

    def test_sigterm_removes_the_staging_dir(self):
        with tempfile.TemporaryDirectory() as root:
            bundle = os.path.join(root, '.bundle-live')
            code = (
                'import os, sys, time\n'
                'sys.path.insert(0, %r)\n'
                'import qqnt_query as q\n'
                'os.makedirs(%r)\n'
                'open(os.path.join(%r, "media.bin"), "wb").write(b"x" * 1024)\n'
                'q._BundleGuard(%r).__enter__()\n'
                'print("ready", flush=True)\n'
                'time.sleep(30)\n'
            ) % (os.path.join(ROOT, 'scripts'), bundle, bundle, bundle)
            process = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE)
            try:
                self.assertEqual(process.stdout.readline().strip(), b'ready')
                self.assertTrue(os.path.isdir(bundle))
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=15)
                self.assertEqual(process.returncode, 128 + signal.SIGTERM)
                self.assertFalse(os.path.exists(bundle), 'staging directory survived SIGTERM')
            finally:
                if process.poll() is None:
                    process.kill()
                process.stdout.close()


if __name__ == '__main__':
    unittest.main()
