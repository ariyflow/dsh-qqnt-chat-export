/**
 * Named export presets — the format/redaction/media/columns combination a user
 * picks every time ("CSV, time + text only", "TXT with media, redacted").
 *
 * They live in `workDir/presets.json` rather than the browser so the model tool
 * (`qqnt_export_chat` with `preset=`) and the page read the same list. The file
 * holds export options only: no chat ids, no names, no message text.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const PRESET_FORMATS = ['txt', 'csv', 'json', 'md', 'html', 'sqlite']
export const PRESET_REDACT = ['', 'names', 'qq', 'all']
export const PRESET_COLUMNS = ['time', 'sender', 'qq', 'direction', 'kinds', 'text']
/** Enough for a personal workflow; the page renders all of them in one list. */
export const MAX_PRESETS = 20

export function presetFile(workDir) {
  return path.join(workDir, 'presets.json')
}

/**
 * Coerce one entry into the exact shape the exports use, or `null` when the
 * name is missing. Unknown values fall back to the defaults instead of failing
 * the whole file, so a hand-edited presets.json cannot brick the page.
 */
export function normalizePreset(input) {
  const source = input && typeof input === 'object' ? input : {}
  const name = String(source.name || '').trim().slice(0, 40)
  if (name === '') return null
  const format = PRESET_FORMATS.includes(source.format) ? source.format : 'txt'
  const preset = {
    name,
    format,
    redact: PRESET_REDACT.includes(source.redact) ? source.redact : '',
    media: source.media === true,
    embed: source.embed === true,
    split: source.split === 'day' ? 'day' : '',
    frontMatter: source.frontMatter === true,
    columns: [],
  }
  if (format === 'csv') {
    const picked = Array.isArray(source.columns)
      ? PRESET_COLUMNS.filter((column) => source.columns.map(String).includes(column))
      : []
    preset.columns = picked.length > 0 ? picked : PRESET_COLUMNS.slice()
  }
  // Embedding is a single HTML file, so it cannot be split or ZIP-ed.
  if (preset.embed) preset.format = 'html'
  if (preset.embed) preset.split = ''
  return preset
}

/** `[]` when there is no file yet, or when it was hand-edited into garbage. */
export function readPresets(workDir) {
  try {
    const rows = JSON.parse(readFileSync(presetFile(workDir), 'utf8'))
    if (!Array.isArray(rows)) return []
    return rows.map(normalizePreset).filter(Boolean).slice(0, MAX_PRESETS)
  } catch {
    return []
  }
}

/** Atomic replace; `0600` on POSIX so the list follows the work directory. */
export function writePresets(workDir, rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .map(normalizePreset).filter(Boolean).slice(0, MAX_PRESETS)
  const file = presetFile(workDir)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  return list
}

/**
 * Fill export arguments from a preset, letting explicit arguments win.
 *
 * Used by the tool (`preset:` names a saved preset) and by the page when a
 * preset is applied to the export form.
 */
export function applyPreset(args, preset) {
  if (!preset) return { ...args }
  const merged = { ...args }
  if (merged.format === undefined) merged.format = preset.format
  if (merged.redact === undefined) merged.redact = preset.redact
  if (merged.media === undefined) merged.media = preset.media
  if (merged.embed === undefined) merged.embed = preset.embed
  if (merged.split === undefined) merged.split = preset.split
  if (merged.frontMatter === undefined) merged.frontMatter = preset.frontMatter
  if (merged.columns === undefined && Array.isArray(preset.columns) && preset.columns.length > 0) {
    merged.columns = preset.columns.slice()
  }
  return merged
}
