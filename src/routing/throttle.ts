/**
 * Rate-limits advisory hints so a session is nudged once and then only every
 * `every` matching call.
 *
 * The original counted every tool call rather than every *matching* one, so the
 * "nudge once per ten" contract really meant "once per ten unrelated calls" —
 * on a busy session that meant never.
 */
export class AdvisoryThrottle {
  private matching = 0

  constructor(private readonly every: number) {}

  /** Record a matching call; returns whether this one should carry the hint. */
  shouldNudge(): boolean {
    if (this.every <= 0) return false
    this.matching += 1
    return this.matching === 1 || this.matching % this.every === 0
  }

  reset(): void {
    this.matching = 0
  }
}