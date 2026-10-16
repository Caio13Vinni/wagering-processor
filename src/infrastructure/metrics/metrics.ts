/**
 * Métricas em memória — contadores/gauges rotulados, expostos em
 * GET /metrics. Sem dependência externa (Prometheus/OpenTelemetry ficam como
 * evolução: este registry é o ponto de coleta).
 */

type Labels = Record<string, string>;

function render(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.length === 0 ? '' : `{${keys.map((k) => `${k}="${labels[k]}"`).join(',')}}`;
}

class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, labels: Labels = {}): void {
    const key = name + render(labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  gauge(name: string, value: number, labels: Labels = {}): void {
    this.gauges.set(name + render(labels), value);
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }
}

export const metrics = new MetricsRegistry();
