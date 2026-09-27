import { CliRenderEvents, createCliRenderer, TextRenderable, type CliRenderer, type KeyEvent, type MouseEvent, type PasteEvent } from "@opentui/core"
import type { TuiDimensions } from "./types.js"

export interface TuiRenderer {
  readonly dimensions: TuiDimensions
  render(content: string): void
  onKey(listener: (key: KeyEvent) => void): () => void
  onPaste(listener: (event: PasteEvent) => void): () => void
  onMouseUp(listener: (event: MouseEvent) => void): () => void
  onResize(listener: (dimensions: TuiDimensions) => void): () => void
  onRenderError(listener: (error: Error) => void): () => void
  destroy(): void
}

export interface TuiRendererFactory {
  create(): Promise<TuiRenderer>
}

/** The only module that talks to OpenTUI's imperative renderer API. */
export class OpenTuiRendererFactory implements TuiRendererFactory {
  async create(): Promise<TuiRenderer> {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      clearOnShutdown: true,
    })
    return createOpenTuiRenderer(renderer)
  }
}

/** Allows headless OpenTUI renderer verification without exposing renderer internals. */
export function createOpenTuiRenderer(renderer: CliRenderer): TuiRenderer {
  return new OpenTuiRenderer(renderer)
}

class OpenTuiRenderer implements TuiRenderer {
  private readonly text: TextRenderable

  constructor(private readonly renderer: CliRenderer) {
    this.text = new TextRenderable(renderer, { content: "" })
    renderer.root.add(this.text)
  }

  get dimensions(): TuiDimensions {
    return { columns: this.renderer.width, rows: this.renderer.height }
  }

  render(content: string): void {
    this.text.content = content
    this.renderer.requestRender()
  }

  onKey(listener: (key: KeyEvent) => void): () => void {
    this.renderer.keyInput.on("keypress", listener)
    return () => this.renderer.keyInput.off("keypress", listener)
  }

  onPaste(listener: (event: PasteEvent) => void): () => void {
    this.renderer.keyInput.on("paste", listener)
    return () => this.renderer.keyInput.off("paste", listener)
  }

  onMouseUp(listener: (event: MouseEvent) => void): () => void {
    this.text.onMouseUp = listener
    return () => { this.text.onMouseUp = undefined }
  }

  onResize(listener: (dimensions: TuiDimensions) => void): () => void {
    const handler = (): void => listener(this.dimensions)
    this.renderer.on(CliRenderEvents.RESIZE, handler)
    return () => this.renderer.off(CliRenderEvents.RESIZE, handler)
  }

  onRenderError(listener: (error: Error) => void): () => void {
    const handler = ({ error }: { error: Error }): void => listener(error)
    this.renderer.on(CliRenderEvents.RENDER_ERROR, handler)
    return () => this.renderer.off(CliRenderEvents.RENDER_ERROR, handler)
  }

  destroy(): void {
    this.renderer.destroy()
  }
}
