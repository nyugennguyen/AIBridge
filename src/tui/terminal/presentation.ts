import type { TerminalAttachmentMode, TerminalViewModel } from "./types.js"

const CONTROL_PICTURES_START = 0x2400

/**
 * Produces inert plain text for the renderer. Terminal escape/control bytes are
 * made visible instead of being interpreted as local UI input or ANSI control.
 */
export function presentTerminalBytes(data: Uint8Array): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data)
  let result = ""
  for (const character of decoded) {
    const code = character.codePointAt(0)!
    if (code === 0x0a) result += "\n"
    else if (code === 0x09) result += "\t"
    else if (code < 0x20) result += String.fromCodePoint(CONTROL_PICTURES_START + code)
    else if (code === 0x7f) result += "␡"
    else result += character
  }
  return result
}

export function terminalStatus(mode: TerminalAttachmentMode): TerminalViewModel["status"] {
  switch (mode) {
    case "detached": return "DETACHED"
    case "attaching": return "ATTACHING"
    case "read-only": return "READ ONLY"
    case "requesting-input": return "REQUESTING INPUT"
    case "input-owned": return "INPUT OWNED"
    case "detaching": return "DETACHING"
    case "closed": return "CLOSED"
  }
}

export function terminalFooter(mode: TerminalAttachmentMode): string {
  if (mode === "input-owned") return "INPUT — Ctrl+] returns to commands"
  if (mode === "read-only" || mode === "requesting-input") return "READ ONLY — i requests input"
  if (mode === "attaching") return "COMMAND — attaching read-only"
  if (mode === "detaching") return "COMMAND — detaching; session continues"
  if (mode === "closed") return "COMMAND — terminal view closed; session continues"
  return "COMMAND — terminal detached; session continues"
}
