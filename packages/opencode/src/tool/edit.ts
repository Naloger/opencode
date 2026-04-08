// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "@/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "@/file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "@/bus"
import { Format } from "@/format"
import { FileTime } from "@/file/time"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectory } from "./external-directory"

const MAX_DIAGNOSTICS_PER_FILE = 20

// ─── line-ending helpers ───────────────────────────────────────────────────

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

// ─── edit mode ────────────────────────────────────────────────────────────

/**
 * `replace`  (default) – replace oldString with newString (existing behaviour)
 * `insert`   – insert newString immediately AFTER the line that contains oldString
 * `delete`   – delete every line from startLine to endLine (inclusive, 1-based)
 *              oldString / newString are ignored when delete+line numbers are given
 */
export type EditMode = "replace" | "insert" | "delete"

// ─── tool definition ──────────────────────────────────────────────────────

export const EditTool = Tool.define("edit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("arg:filePath absolute path, example:C:\\\\repo\\\\app\\\\src\\\\main.ts"),
    oldString: z
      .string()
      .optional()
      .describe(
        "arg:oldString exact existing text to search for. Required for replace/insert modes. " +
          "Omit when using delete mode with startLine+endLine.",
      ),
    newString: z
      .string()
      .optional()
      .describe(
        "arg:newString replacement/insertion text. Required for replace/insert modes. " +
          "Omit when using delete mode.",
      ),
    replaceAll: z.boolean().optional().describe("arg:replaceAll optional boolean, example:false (default false)"),
    mode: z
      .enum(["replace", "insert", "delete"])
      .optional()
      .describe(
        "arg:mode edit mode. " +
          "'replace' (default) swaps oldString for newString. " +
          "'insert' places newString on a new line after the line containing oldString. " +
          "'delete' removes lines startLine–endLine (1-based) when provided, " +
          "or removes the block matching oldString when line numbers are omitted.",
      ),
    startLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "arg:startLine 1-based line number. When provided together with endLine the tool " +
          "restricts its search to that range, making matching far more reliable. " +
          "Required for delete mode without oldString.",
      ),
    endLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "arg:endLine 1-based line number (inclusive). Must be >= startLine. " +
          "Required for delete mode without oldString.",
      ),
  }),

  async execute(params, ctx) {
    if (!params.filePath) {
      throw new Error("filePath is required")
    }

    const mode: EditMode = params.mode ?? "replace"

    // ── validate params per mode ──────────────────────────────────────────
    if (mode === "delete") {
      // delete+line-numbers: no oldString/newString needed
      if (params.startLine !== undefined && params.endLine !== undefined) {
        if (params.endLine < params.startLine) {
          throw new Error("endLine must be >= startLine")
        }
      } else if (!params.oldString) {
        throw new Error(
          "delete mode requires either (startLine + endLine) or oldString to identify the block to remove.",
        )
      }
    } else {
      if (params.oldString === undefined) {
        throw new Error(`oldString is required for mode '${mode}'`)
      }
      if (params.newString === undefined && mode !== "delete") {
        throw new Error(`newString is required for mode '${mode}'`)
      }
      if (mode === "replace" && params.oldString === params.newString) {
        throw new Error("No changes to apply: oldString and newString are identical.")
      }
    }

    const filePath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filePath)

    let diff = ""
    let contentOld = ""
    let contentNew = ""

    await FileTime.withLock(filePath, async () => {
      // ── create-file shortcut (oldString === "") ──────────────────────────
      if (mode === "replace" && params.oldString === "") {
        const existed = await Filesystem.exists(filePath)
        contentNew = params.newString!
        diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
        await ctx.ask({
          permission: "edit",
          patterns: [path.relative(Instance.worktree, filePath)],
          always: ["*"],
          metadata: { filepath: filePath, diff },
        })
        await Filesystem.write(filePath, params.newString!)
        await Format.file(filePath)
        Bus.publish(File.Event.Edited, { file: filePath })
        await Bus.publish(FileWatcher.Event.Updated, {
          file: filePath,
          event: existed ? "change" : "add",
        })
        await FileTime.read(ctx.sessionID, filePath)
        return
      }

      // ── read file ────────────────────────────────────────────────────────
      const stats = Filesystem.stat(filePath)
      if (!stats) throw new Error(`File ${filePath} not found`)
      if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
      await FileTime.assert(ctx.sessionID, filePath)
      contentOld = await Filesystem.readText(filePath)

      const ending = detectLineEnding(contentOld)
      const normalizedContent = normalizeLineEndings(contentOld)

      // ── delete mode with explicit line numbers ───────────────────────────
      if (mode === "delete" && params.startLine !== undefined && params.endLine !== undefined) {
        contentNew = deleteLines(normalizedContent, params.startLine, params.endLine)
        contentNew = convertToLineEnding(contentNew, ending)
      } else {
        // ── insert / replace / delete-by-string ────────────────────────────
        const rawOld = params.oldString!
        const old = convertToLineEnding(normalizeLineEndings(rawOld), ending)

        // Narrow the search window to the user-supplied line range
        const windowedContent =
          params.startLine !== undefined && params.endLine !== undefined
            ? extractLineWindow(normalizedContent, params.startLine, params.endLine)
            : null

        const searchIn = windowedContent?.slice ?? normalizedContent

        if (mode === "insert") {
          const insertAfter = convertToLineEnding(old, ending)
          const insertText = convertToLineEnding(normalizeLineEndings(params.newString!), ending)
          contentNew = applyInsert(contentOld, insertAfter, insertText, windowedContent)
        } else {
          // replace or delete (delete = replace with "")
          const next = mode === "delete" ? "" : convertToLineEnding(normalizeLineEndings(params.newString!), ending)

          try {
            const searchContent =
              windowedContent !== null ? convertToLineEnding(normalizeLineEndings(searchIn), ending) : contentOld

            const replacedSlice = replace(searchContent, old, next, params.replaceAll)

            if (windowedContent !== null) {
              // Stitch windowed replacement back into full file
              contentNew =
                contentOld.substring(0, windowedContent.startIndex) +
                replacedSlice +
                contentOld.substring(windowedContent.endIndex)
            } else {
              contentNew = replacedSlice
            }
          } catch (err) {
            // ── closest-match error enrichment ──────────────────────────────
            const suggestions = findClosestMatches(normalizedContent, normalizeLineEndings(rawOld), 3)
            if (suggestions.length > 0) {
              const hint = suggestions
                .map(
                  (s, i) =>
                    `Match ${i + 1} (~${Math.round(s.similarity * 100)}% similar, ` +
                    `lines ${s.startLine}–${s.endLine}):\n` +
                    "```\n" +
                    s.text +
                    "\n```",
                )
                .join("\n\n")
              throw new Error(
                (err as Error).message +
                  "\n\nCould not find an exact match, but here are the closest blocks " +
                  "found in the file. Use the exact text from the best match as your " +
                  `new oldString and retry:\n\n${hint}`,
              )
            }
            throw err
          }
        }
      }

      diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
      )
      await ctx.ask({
        permission: "edit",
        patterns: [path.relative(Instance.worktree, filePath)],
        always: ["*"],
        metadata: { filepath: filePath, diff },
      })

      await Filesystem.write(filePath, contentNew)
      await Format.file(filePath)
      Bus.publish(File.Event.Edited, { file: filePath })
      await Bus.publish(FileWatcher.Event.Updated, { file: filePath, event: "change" })
      contentNew = await Filesystem.readText(filePath)
      diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
      )
      await FileTime.read(ctx.sessionID, filePath)
    })

    const filediff: Snapshot.FileDiff = {
      file: filePath,
      patch: diff,
      additions: 0,
      deletions: 0,
    }
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) filediff.additions += change.count || 0
      if (change.removed) filediff.deletions += change.count || 0
    }

    ctx.metadata({ metadata: { diff, filediff, diagnostics: {} } })

    let output = "Edit applied successfully."
    await LSP.touchFile(filePath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilePath = Filesystem.normalizePath(filePath)
    const issues = diagnostics[normalizedFilePath] ?? []
    const errors = issues.filter((item) => item.severity === 1)
    if (errors.length > 0) {
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      output +=
        `\n\nLSP errors detected in this file, please fix:\n` +
        `<diagnostics file="${filePath}">\n` +
        `${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    return {
      metadata: { diagnostics, diff, filediff },
      title: `${path.relative(Instance.worktree, filePath)}`,
      output,
    }
  },
})

// ─── line-window helpers ──────────────────────────────────────────────────

/**
 * Extracts a slice of `content` corresponding to lines `startLine`–`endLine`
 * (1-based, inclusive) and returns both the slice text and the byte offsets
 * needed to stitch it back into the full file after editing.
 */
export function extractLineWindow(
  content: string,
  startLine: number,
  endLine: number,
): { slice: string; startIndex: number; endIndex: number } {
  const lines = content.split("\n")
  const clampedStart = Math.max(1, startLine) - 1 // 0-based
  const clampedEnd = Math.min(lines.length, endLine) - 1 // 0-based inclusive

  let startIndex = 0
  for (let i = 0; i < clampedStart; i++) {
    startIndex += lines[i].length + 1 // +1 for \n
  }

  let endIndex = startIndex
  for (let i = clampedStart; i <= clampedEnd; i++) {
    endIndex += lines[i].length + (i < lines.length - 1 ? 1 : 0)
  }

  return {
    slice: lines.slice(clampedStart, clampedEnd + 1).join("\n"),
    startIndex,
    endIndex,
  }
}

/**
 * Removes lines `startLine`–`endLine` (1-based, inclusive) from `content`.
 */
export function deleteLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split("\n")
  lines.splice(startLine - 1, endLine - startLine + 1)
  return lines.join("\n")
}

// ─── insert mode helper ───────────────────────────────────────────────────

/**
 * Finds the line containing `anchor` and inserts `insertText` immediately
 * after that line. Respects an optional windowed search range.
 */
function applyInsert(
  content: string,
  anchor: string,
  insertText: string,
  window: { slice: string; startIndex: number; endIndex: number } | null,
): string {
  const searchIn = window ? content.substring(window.startIndex, window.endIndex) : content
  const lines = searchIn.split("\n")
  const anchorTrimmed = anchor.trim()

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === anchorTrimmed || lines[i].includes(anchor.trim())) {
      lines.splice(i + 1, 0, insertText)
      const replaced = lines.join("\n")
      if (window) {
        return content.substring(0, window.startIndex) + replaced + content.substring(window.endIndex)
      }
      return replaced
    }
  }

  throw new Error(
    `insert mode: could not find anchor line containing:\n${anchor.trim()}\n` +
      "Provide more context or use startLine/endLine to narrow the search range.",
  )
}

// ─── closest-match finder ─────────────────────────────────────────────────

export interface ClosestMatch {
  text: string
  similarity: number
  startLine: number
  endLine: number
}

/**
 * Scans `content` for the N blocks most similar to `search` using a sliding
 * window of the same line-count as `search`. Returns matches sorted by
 * similarity descending, above a minimum threshold of 0.4.
 */
export function findClosestMatches(content: string, search: string, topN = 3, minSimilarity = 0.4): ClosestMatch[] {
  const contentLines = content.split("\n")
  const searchLines = search.split("\n").filter((_, i, a) => !(i === a.length - 1 && _ === ""))

  if (searchLines.length === 0) return []

  const windowSize = searchLines.length
  const results: ClosestMatch[] = []

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    const block = contentLines.slice(i, i + windowSize)
    const sim = blockSimilarity(block, searchLines)
    if (sim >= minSimilarity) {
      results.push({
        text: block.join("\n"),
        similarity: sim,
        startLine: i + 1,
        endLine: i + windowSize,
      })
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, topN)
}

function blockSimilarity(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  if (len === 0) return 1
  let total = 0
  for (let i = 0; i < len; i++) {
    const la = (a[i] ?? "").trim()
    const lb = (b[i] ?? "").trim()
    const maxLen = Math.max(la.length, lb.length)
    total += maxLen === 0 ? 1 : 1 - levenshtein(la, lb) / maxLen
  }
  return total / len
}

// ─── replacers ───────────────────────────────────────────────────────────

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") searchLines.pop()

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1
      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) matchEndIndex += 1
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break
      }
    }
  }

  if (candidates.length === 0) return

  const calcSimilarity = (startLine: number, endLine: number): number => {
    const actualBlockSize = endLine - startLine + 1
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck <= 0) return 1.0
    let similarity = 0
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const ol = originalLines[startLine + j].trim()
      const sl = searchLines[j].trim()
      const maxLen = Math.max(ol.length, sl.length)
      if (maxLen === 0) continue
      similarity += (1 - levenshtein(ol, sl) / maxLen) / linesToCheck
      if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break
    }
    return similarity
  }

  const yieldMatch = (startLine: number, endLine: number) => {
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) matchEndIndex += 1
    }
    return content.substring(matchStartIndex, matchEndIndex)
  }

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    if (calcSimilarity(startLine, endLine) >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield yieldMatch(startLine, endLine)
    }
    return
  }

  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1
  for (const { startLine, endLine } of candidates) {
    const sim = calcSimilarity(startLine, endLine)
    if (sim > maxSimilarity) {
      maxSimilarity = sim
      bestMatch = { startLine, endLine }
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    yield yieldMatch(bestMatch.startLine, bestMatch.endLine)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)
  const lines = content.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const match = line.match(new RegExp(pattern))
            if (match) yield match[0]
          } catch {
            // invalid regex, skip
          }
        }
      }
    }
  }

  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmpty = lines.filter((l) => l.trim().length > 0)
    if (nonEmpty.length === 0) return text
    const minIndent = Math.min(
      ...nonEmpty.map((l) => {
        const m = l.match(/^(\s*)/)
        return m ? m[1].length : 0
      }),
    )
    return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) yield block
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (str: string): string =>
    str.replace(/\\([ntr'"`\\\n$])/g, (match, c) => {
      switch (c) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })

  const unescapedFind = unescape(find)
  if (content.includes(unescapedFind)) yield unescapedFind

  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    if (unescape(block) === unescapedFind) yield block
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0
  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break
    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return
  if (content.includes(trimmedFind)) yield trimmedFind

  const lines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    if (block.trim() === trimmedFind) yield block
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === "") findLines.pop()

  const contentLines = content.split("\n")
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0
          for (let k = 1; k < blockLines.length - 1; k++) {
            const bl = blockLines[k].trim()
            const fl = findLines[k].trim()
            if (bl.length > 0 || fl.length > 0) {
              totalNonEmptyLines++
              if (bl === fl) matchingLines++
            }
          }
          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break
          }
        }
        break
      }
    }
  }
}

// ─── diff trimmer ─────────────────────────────────────────────────────────

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (l) =>
      (l.startsWith("+") || l.startsWith("-") || l.startsWith(" ")) && !l.startsWith("---") && !l.startsWith("+++"),
  )
  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const m = content.match(/^(\s*)/)
      if (m) min = Math.min(min, m[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff

  return lines
    .map((line) => {
      if (
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
        !line.startsWith("---") &&
        !line.startsWith("+++")
      ) {
        return line[0] + line.slice(1).slice(min)
      }
      return line
    })
    .join("\n")
}

// ─── core replace function ───────────────────────────────────────────────

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) return content.replaceAll(search, newString)
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
}
