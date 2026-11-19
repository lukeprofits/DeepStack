/**
 * A rough copy of the line the human is typing into a session, from the raw bytes they send, so
 * the server can tell what was submitted (only "does it start with /" matters so far). Escape
 * sequences (arrows and the like) are skipped, so editing mid-line is approximate; pastes are
 * taken whole.
 */
export function feedLine(line: string, data: string): { line: string; submitted: string[] } {
  const submitted: string[] = []
  let i = 0
  while (i < data.length) {
    const ch = data[i]
    if (data.startsWith('\x1b[200~', i)) {
      const end = data.indexOf('\x1b[201~', i + 6)
      const body = data.slice(i + 6, end === -1 ? undefined : end)
      line += body.replace(/[\r\n]+/g, ' ')
      i = end === -1 ? data.length : end + 6
      continue
    }
    if (ch === '\x1b') {
      // CSI (ESC [ … final), SS3 (ESC O x), or a lone ESC / ESC + key.
      if (data[i + 1] === '[') {
        let j = i + 2
        while (j < data.length && !/[@-~]/.test(data[j])) j++
        i = j + 1
      } else i += data[i + 1] === 'O' ? 3 : 2
      continue
    }
    if (ch === '\r' || ch === '\n') {
      submitted.push(line)
      line = ''
    } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1)
    else if (ch === '\x15' || ch === '\x03') line = ''
    else if (ch >= ' ') line += ch
    i++
  }
  return { line, submitted }
}

/** A Claude slash command (`/context`, `/model`…), not a prompt that merely mentions a path. */
export const isSlashCommand = (text: string) => /^\/[a-z][\w:-]*(\s|$)/i.test(text.trim())
