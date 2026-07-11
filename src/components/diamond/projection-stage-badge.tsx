/**
 * ProjectionStageBadge — small, dark research-terminal badge.
 * Never implies a stage the pipeline did not actually produce.
 */
import { cn } from "@/lib/utils";

export type ProjectionStage =
  | "early"
  | "updated"
  | "lineup_confirmed"
  | "final_pregame";

const LABEL: Record<ProjectionStage, string> = {
  early: "Early projection — expected lineup",
  updated: "Updated projection — expected lineup",
  lineup_confirmed: "Confirmed lineup projection",
  final_pregame: "Final pregame projection",
};

const SHORT: Record<ProjectionStage, string> = {
  early: "EARLY",
  updated: "UPDATED",
  lineup_confirmed: "CONFIRMED",
  final_pregame: "FINAL PREGAME",
};

const TONE: Record<ProjectionStage, string> = {
  early: "border-amber-500/40 text-amber-300 bg-amber-500/10",
  updated: "border-sky-500/40 text-sky-300 bg-sky-500/10",
  lineup_confirmed: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
  final_pregame: "border-fuchsia-500/40 text-fuchsia-300 bg-fuchsia-500/10",
};

export function ProjectionStageBadge({
  stage,
  short = false,
  className,
}: {
  stage: ProjectionStage | null | undefined;
  short?: boolean;
  className?: string;
}) {
  if (!stage) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide",
          "border-neutral-700 text-neutral-400 bg-neutral-800/40",
          className,
        )}
        title="No pregame projection is currently available."
      >
        NO PROJECTION
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide",
        TONE[stage],
        className,
      )}
      title={LABEL[stage]}
    >
      {short ? SHORT[stage] : LABEL[stage]}
    </span>
  );
}
