import * as React from "react";
import { cn } from "@/lib/utils";
import { getTeamColor } from "@/lib/team-colors";

/**
 * DiamondCard — elevated dark surface with optional team-color rail.
 */
type Size = "sm" | "md" | "lg";

const padBySize: Record<Size, string> = {
  sm: "p-3 md:p-4",
  md: "p-4 md:p-5",
  lg: "p-5 md:p-7",
};

export const DiamondCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { size?: Size; teamAbbr?: string | null }
>(({ className, size = "md", teamAbbr, style, ...props }, ref) => {
  const mergedStyle = teamAbbr
    ? { ...style, borderLeftColor: getTeamColor(teamAbbr).primary }
    : style;
  return (
    <div
      ref={ref}
      className={cn("card-elevated", padBySize[size], teamAbbr && "team-rail", className)}
      style={mergedStyle}
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
      className={cn("display text-2xl leading-tight tracking-tight text-foreground", className)}
      {...props}
    />
  );
}
