/**
 * Turning a phrase into a chat.
 *
 * The export tools must never write the wrong conversation, so the interesting
 * cases are the ones where a name is ambiguous or only partly known.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chatPhrases, chatScore, describeChat, normalizeChatText, pickChat, rankChats,
} from '../chatlookup.js'

const chats = [
  { kind: 'group', id: '123', name: '示例课程群', messages: 1204, last: 1759473400, lastTime: '2025-10-03 14:36' },
  { kind: 'group', id: '456', name: '示例课程群 2024 届', messages: 88, last: 1759473000, lastTime: '2025-10-03 14:30' },
  { kind: 'private', id: 'u_1', name: '妈妈', qq: '10086', messages: 42, last: 1759472000, lastTime: '2025-10-03 14:13' },
  { kind: 'group', id: '789', name: '项目群', alias: '装修群', messages: 300, last: 1759471000, lastTime: '2025-10-03 13:56' },
]

test('normalizing ignores spaces, case and full-width digits', () => {
  assert.equal(normalizeChatText('  A B  '), 'ab')
  assert.equal(normalizeChatText('１２３'), '123')
  assert.equal(normalizeChatText('群号：123'), '123')
  assert.equal(normalizeChatText(null), '')
})

test('a phrase also reads as the name people mean', () => {
  assert.deepEqual(chatPhrases('和妈妈的私聊'), ['和妈妈的私聊', '和妈妈', '妈妈的私聊', '妈妈'])
  assert.deepEqual(chatPhrases('课程群'), ['课程群'])
  assert.deepEqual(chatPhrases(''), [])
})

test('exact beats prefix beats substring, and ids count', () => {
  assert.equal(chatScore(chats[0], '示例课程群'), 100)
  assert.equal(chatScore(chats[1], '示例课程群'), 70)
  assert.equal(chatScore(chats[1], '2024'), 50)
  assert.equal(chatScore(chats[2], '10086'), 95)
  assert.equal(chatScore(chats[2], '妈妈'), 100)
  assert.equal(chatScore(chats[3], '装修群'), 100, 'an alias is a name too')
  assert.equal(chatScore({ ...chats[3], originalName: '项目群' }, '项目群'), 100,
    'the QQ name still finds a chat the user renamed')
  assert.equal(chatScore(chats[0], '不存在'), 0)
})

test('ranking prefers the exact name over a longer one that contains it', () => {
  const ranked = rankChats(chats, '示例课程群')
  assert.deepEqual(ranked.map((item) => item.chat.id), ['123', '456'])
  assert.equal(ranked[0].why, '名称完全一致')
  assert.equal(ranked[1].why, '名称开头匹配')
})

test('pickChat refuses to choose between two equally good matches', () => {
  const twins = [
    { kind: 'group', id: '1', name: '课程群', messages: 10 },
    { kind: 'group', id: '2', name: '课程群', messages: 99 },
  ]
  const tied = pickChat(twins, '课程群')
  assert.equal(tied.chat, null)
  assert.equal(tied.tie, true)
  assert.equal(tied.ranked.length, 2)

  const one = pickChat(chats, '装修群')
  assert.equal(one.tie, false)
  assert.equal(one.chat.id, '789')

  const none = pickChat(chats, '查无此群')
  assert.equal(none.chat, null)
  assert.equal(none.tie, false)
})

test('an id copied from a previous answer still resolves', () => {
  assert.equal(pickChat(chats, 'group/123').chat.id, '123')
  assert.equal(pickChat(chats, 'private:u_1').chat.id, 'u_1')
})

test('a private chat is reachable by "和X的私聊"', () => {
  const picked = pickChat(chats, '和妈妈的私聊')
  assert.equal(picked.chat.id, 'u_1')
  assert.equal(picked.ranked[0].matched, '妈妈')
})

test('describeChat is the one line both a human and a model read', () => {
  assert.equal(describeChat(chats[0]), 'group 123 示例课程群 — 1204 条，最后 2025-10-03 14:36')
  assert.equal(describeChat({ kind: 'private', id: 'u_2', hidden: true }), 'private u_2 (未命名)（已隐藏） — 0 条，最后 -')
})
