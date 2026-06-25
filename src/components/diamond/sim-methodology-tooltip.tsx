/**
 * Shared info tooltip explaining what a "Mean Projection" and "Probability"
 * mean in the Diamond simulation engine. Display-only.
 */
export function SimMethodologyTooltip({ className = "" }: { className?: string }) {
  const copy =
    "Mean Projection is the average result across 2,000 Monte Carlo simulations. " +
    "Probability is calculated from how often a player exceeds the selected threshold across those same simulations.";
  return (
    <span
      role="img"
      aria-label="Simulation methodology"
      title={copy}
      className={`mono inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border/70 text-[9px] font-bold text-muted-foreground hover:text-foreground ${className}`}
    >
      i
    </span>
  );
}
