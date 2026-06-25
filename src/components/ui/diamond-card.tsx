import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * DiamondCard — elevated surface for the Diamond Design System 2.0.
 * Uses the `card-elevated` utility (white card, subtle shadow, hover lift).
 * Drop-in alongside existing shadcn Card; pick whichever fits the surface.
 */
type Size = "sm" | "md" | "lg";

const padBySize: Record<Size, string> = {
  sm: "p-3 md:p-4",
  md: "p-4 md:p-5",
  lg: "p-5 md:p-7",
};

export const DiamondCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { size?: Size }
>(({ className, size = "md", ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn("card-elevated", padBySize[size], className)}
      {...props}
    />
  );
});
DiamondCard.displayName = "DiamondCard";

export function DiamondCardEyebrow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mono text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export function DiamondCardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("font-display text-2xl leading-tight tracking-tight text-foreground", className)}
      {...props}
    />
  );
}
