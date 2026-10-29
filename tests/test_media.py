"""Media path parsing and lookup (no SQLCipher needed)."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import qqnt_media as media        # noqa: E402

MD5 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'


def _varint(value):
    out = b''
    while True:
        byte = value & 0x7F
        value >>= 7
        out += bytes([byte | (0x80 if value else 0)])
        if not value:
            return out


def _bytes_field(number, value):
    return _varint(number << 3 | 2) + _varint(len(value)) + value


def _int_field(number, value):
    return _varint(number << 3) + _varint(value)


def _blob(*segments):
    # Each element is its own 40800 record, exactly like a real message blob.
    return b''.join(_bytes_field(40800, segment) for segment in segments)


def _image(name='pic.jpg', path='', md5=MD5, size=1234):
    segment = (_int_field(45002, 2) + _bytes_field(45402, name.encode())
               + _int_field(45405, size)
               + _bytes_field(45406, bytes.fromhex(md5)))
    if path:
        segment += _bytes_field(45812, path.encode())
    return segment


def _voice(md5=MD5):
    return (_int_field(45002, 4) + _bytes_field(45402, (md5 + '.amr').encode())
            + _bytes_field(45406, bytes.fromhex(md5)))


def _transfer(uuid, name='report.docx'):
    return (_int_field(45002, 3) + _bytes_field(45402, name.encode())
            + _bytes_field(45503, ('/' + uuid).encode()))


class SegmentTests(unittest.TestCase):
    def test_picture_fields_become_a_media_item(self):
        items = media.blob_media(_blob(_image(path='/data/Pic/2024-01/Ori/x.jpg')))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['kind'], 'image')
        self.assertEqual(items[0]['name'], 'pic.jpg')
        self.assertEqual(items[0]['md5'], MD5)
        self.assertEqual(items[0]['size'], 1234)
        self.assertEqual(items[0]['path'], '/data/Pic/2024-01/Ori/x.jpg')

    def test_text_and_other_segments_are_ignored(self):
        text = _int_field(45002, 1) + _bytes_field(45101, '你好'.encode())
        self.assertEqual(media.blob_media(_blob(text)), [])
        self.assertEqual(media.blob_media(None), [])

    def test_voice_keeps_its_hash_for_lookup(self):
        items = media.blob_media(_blob(_voice()))
        self.assertEqual([item['kind'] for item in items], ['voice'])
        self.assertEqual(items[0]['path'], '')

    def test_multiple_media_segments_keep_order(self):
        items = media.blob_media(_blob(_image(), _voice()))
        self.assertEqual([item['kind'] for item in items], ['image', 'voice'])


class LocateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, *parts, content=b'x'):
        path = os.path.join(self.data, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(content)
        return path

    def test_a_recorded_absolute_path_wins(self):
        path = self.put('Pic', '2024-01', 'Ori', 'x.jpg')
        item = {'kind': 'image', 'md5': MD5, 'path': path, 'server': ''}
        found = media.locate(item, self.data)
        self.assertEqual(found['path'], path)
        self.assertFalse(found['thumbnail'])

    def test_emoji_are_skipped(self):
        path = self.put('Emoji', 'emoji-recv', '2024-01', 'Ori', 'x.0')
        item = {'kind': 'image', 'md5': MD5, 'path': path, 'server': ''}
        self.assertEqual(media.locate(item, self.data)['reason'], 'emoji')

    def test_an_image_is_found_by_hash_and_prefers_the_original(self):
        thumb = self.put('Pic', '2023-05', 'Thumb', MD5 + '_720.jpg')
        ori = self.put('Pic', '2023-05', 'Ori', MD5 + '.jpg')
        item = {'kind': 'image', 'md5': MD5, 'path': '', 'server': ''}
        found = media.locate(item, self.data)
        self.assertEqual(found['path'], ori)
        self.assertFalse(found['thumbnail'])

    def test_a_thumbnail_is_reported_as_such(self):
        thumb = self.put('Pic', '2023-05', 'Thumb', MD5 + '_720.jpg')
        item = {'kind': 'image', 'md5': MD5, 'path': '', 'server': ''}
        found = media.locate(item, self.data)
        self.assertEqual(found['path'], thumb)
        self.assertTrue(found['thumbnail'])

    def test_voice_and_video_are_found_by_hash(self):
        voice = self.put('Ptt', '2024-01', 'Ori', MD5 + '.amr')
        video = self.put('Video', '2024-01', 'Ori', MD5 + '.mp4')
        self.assertEqual(
            media.locate({'kind': 'voice', 'md5': MD5, 'path': '', 'server': ''},
                         self.data)['path'], voice)
        self.assertEqual(
            media.locate({'kind': 'video', 'md5': MD5, 'path': '', 'server': ''},
                         self.data)['path'], video)

    def test_a_transfer_is_found_by_its_uuid_directory(self):
        path = self.put('File', 'Ori', 'deadbeef_' + 'u-1', 'report.docx')
        item = {'kind': 'file', 'md5': MD5, 'path': '', 'server': '/u-1'}
        self.assertEqual(media.locate(item, self.data)['path'], path)

    def test_a_missing_file_says_why(self):
        found = media.locate({'kind': 'voice', 'md5': MD5, 'path': '',
                              'server': ''}, self.data)
        self.assertEqual(found['path'], '')
        self.assertEqual(found['reason'], 'not-downloaded')
        self.assertEqual(media.locate({'kind': 'voice', 'md5': '', 'path': '',
                                       'server': ''}, self.data)['reason'], 'no-hash')


class CopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, 'data')
        self.out = os.path.join(self.tmp.name, 'bundle')
        os.makedirs(self.data)

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, *parts, content=b'x'):
        path = os.path.join(self.data, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(content)
        return path

    def test_files_are_copied_with_a_stable_name(self):
        self.put('Ptt', '2024-01', 'Ori', MD5 + '.amr')
        items = {7: [{'kind': 'voice', 'md5': MD5, 'path': '', 'server': '',
                      'name': MD5 + '.amr'}]}
        refs, stats = media.copy_files(items, os.path.join(self.out, 'media', 'c1'),
                                       'media/c1', self.data)
        self.assertEqual(stats['files'], 1)
        self.assertEqual(stats['bytes'], 1)
        self.assertEqual(len(refs[7]), 1)
        self.assertEqual(refs[7][0]['file'], 'media/c1/' + refs[7][0]['file'].split('/')[-1])
        self.assertTrue(os.path.exists(os.path.join(self.out, *refs[7][0]['file'].split('/'))))

    def test_missing_and_oversized_files_are_reported_not_fatal(self):
        big = self.put('Ptt', '2024-01', 'Ori', MD5 + '.amr', content=b'x' * 10)
        items = {
            1: [{'kind': 'voice', 'md5': 'f' * 32, 'path': '', 'server': '',
                 'name': 'gone.amr'}],
            2: [{'kind': 'voice', 'md5': MD5, 'path': '', 'server': '',
                 'name': MD5 + '.amr'}],
        }
        budget = {'left': 5}
        refs, stats = media.copy_files(items, self.out, 'media', self.data,
                                       budget=budget)
        self.assertEqual(stats['missingCount'], 1)
        self.assertEqual(stats['skippedCount'], 1)
        self.assertEqual(refs, {})
        self.assertEqual(stats['missing'][0]['reason'], 'not-downloaded')
        self.assertEqual(stats['skipped'][0]['reason'], 'total-limit')

    def test_redaction_drops_the_original_file_name(self):
        self.put('File', 'Ori', 'dead_u1', '张三的简历.docx')
        items = {3: [{'kind': 'file', 'md5': '', 'path': '', 'server': '/u1',
                      'name': '张三的简历.docx'}]}
        refs, _stats = media.copy_files(items, os.path.join(self.out, 'media'),
                                        'media', self.data, redactor=_Redactor())
        self.assertTrue(refs[3][0]['file'].startswith('media/文件-3-01-'))
        self.assertNotIn('张三', refs[3][0]['file'])


class EmbedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, *parts, content=b'x'):
        path = os.path.join(self.data, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(content)
        return path

    def test_a_picture_becomes_a_data_uri(self):
        path = self.put('Pic', '2024-01', 'Ori', MD5 + '.png', content=b'\x89PNG')
        items = {5: [{'kind': 'image', 'md5': MD5, 'path': path,
                      'server': '', 'name': 'x.png'}]}
        refs, stats = media.embed_images(items, self.data)
        self.assertEqual(stats['files'], 1)
        self.assertEqual(stats['bytes'], 4)
        self.assertTrue(refs[5][0]['data'].startswith('data:image/png;base64,'))
        self.assertEqual(refs[5][0]['file'], '')

    def test_non_picture_media_is_not_inlined(self):
        path = self.put('Ptt', '2024-01', 'Ori', MD5 + '.amr')
        items = {6: [{'kind': 'voice', 'md5': MD5, 'path': '', 'server': '',
                      'name': MD5 + '.amr'}]}
        refs, stats = media.embed_images(items, self.data)
        self.assertEqual(refs, {})
        self.assertEqual(stats['skippedCount'], 1)
        self.assertEqual(stats['skipped'][0]['reason'], 'not-inline')

    def test_oversized_images_are_reported(self):
        path = self.put('Pic', '2024-01', 'Ori', MD5 + '.jpg', content=b'x' * 10)
        items = {7: [{'kind': 'image', 'md5': MD5, 'path': path,
                      'server': '', 'name': 'x.jpg'}]}
        refs, stats = media.embed_images(items, self.data, budget={'left': 4})
        self.assertEqual(refs, {})
        self.assertEqual(stats['skipped'][0]['reason'], 'total-limit')


class _Redactor:
    hide_names = True


if __name__ == '__main__':
    unittest.main()
