/**
 * Prediction Drivers chip grid. Renders only inputs that exist; missing
 * inputs render dimmed "—" so the UI is consistent. No new math.
 */
export type DriverFields = {
  battingOrder: number | null;
  opposingPitcher: string | null;
  opposingPitcherDetail?: string | null; // e.g. "HR/9 1.62 · K/9 9.4"
  bullpenAdjustment?: string | null;
  parkFactor?: string | null;
  platoonAdvantage?: string | null;
  weather?: string | null;
  recentForm?: string | null;
  lineupStatus?: string | null;
};

export function PredictionDrivers(props: DriverFields) {
  const chips: { label: string; value: string | null }[] = [
    { label: "Batting Order", value: props.battingOrder == null ? null : `#${props.battingOrder}` },
    { label: "Opposing Pitcher", value: props.opposingPitcher ?? null },
    { label: "Opp SP detail", value: props.opposingPitcherDetail ?? null },
    { label: "Bullpen Adj", value: props.bullpenAdjustment ?? null },
    { label: "Park Factor", value: props.parkFactor ?? null },
    { label: "Platoon", value: props.platoonAdvantage ?? null },
    { label: "Weather", value: props.weather ?? null },
    { label: "Recent Form", value: props.recentForm ?? null },
    { label: "Lineup Status", value: props.lineupStatus ?? null },
  ];
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-2">
      <div className="mono mb-1 text-[9px] uppercase tracking-widest text-muted-foreground">
        Prediction Drivers
      </div>
      <ul className="grid grid-cols-2 gap-1 sm:grid-cols-3">
        {chips.map((c) => (
          <li
            key={c.label}
            className="flex items-center justify-between gap-2 rounded bg-secondary/40 px-2 py-1 text-[11px]"
          >
            <span className="mono text-[9px] uppercase tracking-widest text-muted-foreground">{c.label}</span>
            <span className={`mono truncate tabular-nums ${c.value ? "text-foreground" : "text-muted-foreground italic"}`}>
              {c.value ?? "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
