import * as React from "react";
import { getTeamColor, normalizeTeamAbbrev } from "@/lib/team-colors";
import { cn } from "@/lib/utils";

type Size = "xs" | "sm";

const dotSize: Record<Size, string> = {
  xs: "h-1.5 w-1.5",
  sm: "h-2 w-2",
};

const labelSize: Record<Size, string> = {
  xs: "text-[10px]",
  sm: "text-xs",
};

export function TeamSwatch({
  abbrev,
  size = "xs",
  showLabel = true,
  className,
}: {
  abbrev: string | null | undefined;
  size?: Size;
  showLabel?: boolean;
  className?: string;
}) {
  const color = getTeamColor(abbrev);
  const label = normalizeTeamAbbrev(abbrev) ?? "—";
  return (
    <span className={cn("mono inline-flex items-center gap-1.5 align-middle", className)}>
      <span
        aria-hidden
        className={cn("inline-block rounded-full ring-1 ring-black/40", dotSize[size])}
        style={{ background: color.primary }}
      />
      {showLabel ? (
        <span className={cn("font-semibold uppercase tracking-wider text-foreground", labelSize[size])}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
