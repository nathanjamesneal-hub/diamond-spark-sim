import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "positive" | "warning" | "negative" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-muted text-foreground border-border",
  positive: "bg-[color-mix(in_oklab,var(--color-success)_12%,transparent)] text-[var(--color-success)] border-[color-mix(in_oklab,var(--color-success)_25%,transparent)]",
  warning: "bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] text-[var(--color-warning)] border-[color-mix(in_oklab,var(--color-warning)_25%,transparent)]",
  negative: "bg-[color-mix(in_oklab,var(--color-destructive)_10%,transparent)] text-destructive border-[color-mix(in_oklab,var(--color-destructive)_25%,transparent)]",
  info: "bg-[color-mix(in_oklab,var(--color-primary)_10%,transparent)] text-primary border-[color-mix(in_oklab,var(--color-primary)_25%,transparent)]",
};

export interface StatPillProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
}

export function StatPill({ label, value, tone = "neutral", className, ...props }: StatPillProps) {
  return (
    <div
      className={cn(
        "inline-flex flex-col items-start gap-0.5 rounded-lg border px-3 py-1.5",
        toneClasses[tone],
        className
      )}
      {...props}
    >
      <span className="mono text-[9px] uppercase tracking-[0.2em] opacity-80">{label}</span>
      <span className="mono text-base font-semibold leading-none tabular-nums">{value}</span>
    </div>
  );
}
