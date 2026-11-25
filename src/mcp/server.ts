/**
 * Minimal dependency-free MCP server over stdio: JSON-RPC 2.0, one message per
 * line. stdout carries protocol frames ONLY; diagnostics go to stderr.
 */
import { CLI_VERSION } from "../version.js"
import { BridgeTools, TOOL_DEFINITIONS } from "./bridge-tools.js"

export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"]
export const FALLBACK_PROTOCOL_VERSION = "2025-06-18"

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: unknown
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 } as const

export class McpServer {
  constructor(private readonly tools: BridgeTools) {}

  /** Handle one raw line. Returns the response line to write, or null for notifications. */
  async handleLine(line: string): Promise<string | null> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return JSON.stringify(errorResponse(null, ERR.parse, "Parse error"))
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return JSON.stringify(errorResponse(null, ERR.invalidRequest, "Invalid Request"))
    }
    const response = await this.handle(message as JsonRpcRequest)
    return response === null ? null : JSON.stringify(response)
  }

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // Notifications (no id) never get a response: notifications/initialized, notifications/cancelled, ...
    if (req.id === undefined) return null
    const id = req.id
    if (typeof req.method !== "string") return errorResponse(id, ERR.invalidRequest, "Invalid Request")
    const params = req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {}

    switch (req.method) {
      case "initialize": {
        const requested = params.protocolVersion
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL_VERSION
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "aibridge", version: CLI_VERSION },
          },
        }
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} }
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } }
      case "tools/call": {
        const name = params.name
        if (typeof name !== "string" || !TOOL_DEFINITIONS.some((t) => t.name === name)) {
          return errorResponse(id, ERR.invalidParams, `Unknown tool: ${String(name)}`)
        }
        const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {}
        return { jsonrpc: "2.0", id, result: await this.tools.call(name, args) }
      }
      default:
        return errorResponse(id, ERR.methodNotFound, `Method not found: ${req.method}`)
    }
  }
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

export interface StdioStreams {
  readonly input: AsyncIterable<string | Uint8Array>
  readonly write: (line: string) => void
}

/** Read newline-delimited messages until input ends; handle them concurrently. */
export async function serveStdio(server: McpServer, io: StdioStreams): Promise<void> {
  const pending = new Set<Promise<void>>()
  const decoder = new TextDecoder()
  let buffer = ""
  const dispatch = (line: string) => {
    if (line.trim() === "") return
    const task: Promise<void> = server
      .handleLine(line)
      .then((out) => {
        if (out !== null) io.write(out + "\n")
      })
      .catch(() => {
        io.write(JSON.stringify(errorResponse(null, -32603, "Internal error")) + "\n")
      })
      .finally(() => {
        pending.delete(task)
      })
    pending.add(task)
  }
  for await (const chunk of io.input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      dispatch(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
    }
  }
  dispatch(buffer)
  await Promise.all(pending)
}
