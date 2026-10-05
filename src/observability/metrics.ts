/**
 * Metrics registry and operational telemetry instrumentation (M8.3, M7-C2).
 */

export interface MetricSnapshot {
  readonly counters: Readonly<Record<string, number>>
  readonly gauges: Readonly<Record<string, number>>
  readonly histograms: Readonly<Record<string, { count: number; sum: number; p50: number; p95: number; p99: number }>>
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>()
  private readonly gauges = new Map<string, number>()
  private readonly histograms = new Map<string, number[]>()

  incrementCounter(name: string, value = 1): number {
    const current = this.counters.get(name) ?? 0
    const next = current + value
    this.counters.set(name, next)
    return next
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value)
  }

  getGauge(name: string): number {
    return this.gauges.get(name) ?? 0
  }

  recordTiming(name: string, durationMs: number): void {
    let samples = this.histograms.get(name)
    if (!samples) {
      samples = []
      this.histograms.set(name, samples)
    }
    samples.push(durationMs)
    if (samples.length > 1000) {
      samples.shift()
    }
  }

  getTimingStats(name: string): { count: number; sum: number; p50: number; p95: number; p99: number } {
    const samples = this.histograms.get(name) ?? []
    if (samples.length === 0) {
      return { count: 0, sum: 0, p50: 0, p95: 0, p99: 0 }
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const sum = sorted.reduce((acc, v) => acc + v, 0)
    const count = sorted.length

    const p50 = sorted[Math.floor(count * 0.5)] ?? 0
    const p95 = sorted[Math.floor(count * 0.95)] ?? 0
    const p99 = sorted[Math.floor(count * 0.99)] ?? 0

    return { count, sum, p50, p95, p99 }
  }

  getSnapshot(): MetricSnapshot {
    const counters: Record<string, number> = {}
    for (const [k, v] of this.counters.entries()) {
      counters[k] = v
    }

    const gauges: Record<string, number> = {}
    for (const [k, v] of this.gauges.entries()) {
      gauges[k] = v
    }

    const histograms: Record<string, { count: number; sum: number; p50: number; p95: number; p99: number }> = {}
    for (const k of this.histograms.keys()) {
      histograms[k] = this.getTimingStats(k)
    }

    return { counters, gauges, histograms }
  }

  toPrometheus(): string {
    const lines: string[] = []
    for (const [k, v] of this.counters.entries()) {
      const sanitized = k.replace(/[^a-zA-Z0-9_]/g, "_")
      lines.push(`# TYPE aibr_${sanitized} counter`)
      lines.push(`aibr_${sanitized} ${v}`)
    }
    for (const [k, v] of this.gauges.entries()) {
      const sanitized = k.replace(/[^a-zA-Z0-9_]/g, "_")
      lines.push(`# TYPE aibr_${sanitized} gauge`)
      lines.push(`aibr_${sanitized} ${v}`)
    }
    return lines.join("\n") + "\n"
  }

  clear(): void {
    this.counters.clear()
    this.gauges.clear()
    this.histograms.clear()
  }
}
