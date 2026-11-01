/**
 * Turning what a person says into a chat in the index.
 *
 * The export tools work on `chatKind` + `chatId`, but a user says "示例课程群",
 * "群号 123", "和妈妈的私聊" or "课程群". This module ranks the indexed chats
 * against such a phrase and reports why each one matched, so a tool can either
 * export with confidence or explain the ambiguity instead of guessing.
 *
 * Pure functions only: the index arrives as the helper's `sessions` list (plus
 * the user's aliases), so all of this is testable without Python.
 */

/** Lowercase, NFKC (full-width → ASCII), no whitespace, "群号：123" → "123". */
export function normalizeChatText(value) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
  return text.replace(/^群号?[:：]?(\d+)$/, '$1')
}

/**
 * The phrase plus the readings people actually use.
 *
 * "和妈妈的私聊" is not a chat name; "妈妈" is. Stripping is limited to the
 * suffixes that cannot be part of a name on their own, and the original phrase
 * is always tried first.
 */
export function chatPhrases(query) {
  const base = String(query ?? '').trim()
  if (base === '') return []
  const out = []
  const add = (value) => {
    const text = String(value ?? '').trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  /** "和妈妈的私聊" → "和妈妈"; "聊天记录" alone stays as it is. */
  const stripSuffix = (text) => {
    for (const suffix of ['的私聊', '的私信', '的群聊', '私聊', '私信', '聊天记录', '记录']) {
      if (text.endsWith(suffix) && text.length > suffix.length) return text.slice(0, -suffix.length)
    }
    return ''
  }
  add(base)
  // "group/123" is how the tools print a chat id; accepting it back means a
  // model that copies an id from a previous answer still resolves.
  const scoped = /^(group|private)[/:](.+)$/.exec(base)
  if (scoped) add(scoped[2])
  const withoutSuffix = stripSuffix(base)
  add(withoutSuffix)
  // 和妈妈 / 跟妈妈 / 与妈妈 — both before and after dropping the suffix, so
  // "和妈妈的私聊" still reaches "妈妈".
  for (const text of [base, withoutSuffix]) {
    if (text !== '') add(text.replace(/^(和|跟|与)/, ''))
  }
  return out
}

/** How literally a chat matches a phrase; 0 means "not at all". */
export function chatScore(chat, query) {
  const wanted = normalizeChatText(query)
  if (wanted === '') return 0
  // `originalName` is the QQ name behind a user-set alias, so either one finds
  // the chat.
  const names = [chat?.name, chat?.alias, chat?.originalName]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map(normalizeChatText)
  const ids = [chat?.id, chat?.qq]
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value) => normalizeChatText(value))
  // Exact beats prefix beats substring: "课程群" must prefer the chat with that
  // exact name over "课程群 2024 届".
  if (names.includes(wanted)) return 100
  if (ids.includes(wanted)) return 95
  if (names.some((name) => name.startsWith(wanted))) return 70
  if (names.some((name) => name.includes(wanted))) return 50
  if (ids.some((id) => id.includes(wanted))) return 40
  return 0
}

const SCORE_LABELS = {
  100: '名称完全一致',
  95: 'id 或 QQ 一致',
  70: '名称开头匹配',
  50: '名称包含',
  40: 'id 包含',
}

/**
 * Every chat that matches, best first.
 *
 * `matched` is the phrase that won when it differs from what the caller typed
 * ("和妈妈的私聊" matched through "妈妈"), so an answer can say so.
 */
export function rankChats(chats, query) {
  const ranked = []
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat || typeof chat !== 'object') continue
    let best = { score: 0, phrase: '' }
    for (const phrase of chatPhrases(query)) {
      const score = chatScore(chat, phrase)
      if (score > best.score) best = { score, phrase }
    }
    if (best.score === 0) continue
    ranked.push({
      chat,
      score: best.score,
      why: SCORE_LABELS[best.score] || '匹配',
      matched: best.phrase,
    })
  }
  // Ties are broken by size, then recency: with two chats of the same name the
  // active one usually is the one being talked about.
  ranked.sort((a, b) => b.score - a.score
    || (Number(b.chat.messages) || 0) - (Number(a.chat.messages) || 0)
    || (Number(b.chat.last) || 0) - (Number(a.chat.last) || 0))
  return ranked
}

/**
 * The one chat a phrase clearly means.
 *
 * `tie` is true when two chats share the top score — the caller must ask which
 * one, because exporting the wrong conversation cannot be undone by the tool.
 */
export function pickChat(chats, query) {
  const ranked = rankChats(chats, query)
  if (ranked.length === 0) return { chat: null, ranked: [], tie: false }
  const top = ranked.filter((item) => item.score === ranked[0].score)
  if (top.length === 1) return { chat: top[0].chat, ranked, tie: false }
  return { chat: null, ranked, tie: true }
}

/** One line a human and a model both read well: `group 123 示例群 — 6 条，最后 …`. */
export function describeChat(chat) {
  const name = chat?.name || '(未命名)'
  const count = Number(chat?.messages) || 0
  const last = chat?.lastTime || '-'
  const hidden = chat?.hidden === true ? '（已隐藏）' : ''
  return `${chat?.kind} ${chat?.id} ${name}${hidden} — ${count} 条，最后 ${last}`
}
