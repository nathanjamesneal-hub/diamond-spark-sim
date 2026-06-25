/**
 * "Why the Model Likes This" — transparent bullet readout of the same
 * Diamond Engine outputs already shown elsewhere. Skips any bullet whose
 * source data is missing — never invents a number.
 */
export type WhyBullets = {
  diamondScore: number | null;
  meanProjection: number | null;
  meanLabel?: string; // e.g. "Mean HR"
  probability: number | null;
  probabilityLabel?: string; // e.g. "HR Probability"
  parkFactor?: string | null;
  opposingPitcher?: string | null;
  battingOrder?: number | null;
  weather?: string | null;
  recentForm?: string | null;
};

function fmtPct(p: number | null): string | null {
  if (p == null || !isFinite(p)) return null;
  const v = p <= 1 ? p * 100 : p;
  return `${v.toFixed(1)}%`;
}

export function WhyTheModelLikesThis(props: WhyBullets) {
  const lines: { icon: string; text: string }[] = [];
  if (props.diamondScore != null) lines.push({ icon: "📈", text: `Diamond Score: ${Math.round(props.diamondScore)}` });
  if (props.meanProjection != null && isFinite(props.meanProjection))
    lines.push({ icon: "🎲", text: `${props.meanLabel ?? "Mean"}: ${props.meanProjection.toFixed(2)}` });
  const prob = fmtPct(props.probability);
  if (prob) lines.push({ icon: "💥", text: `${props.probabilityLabel ?? "Probability"}: ${prob}` });
  if (props.parkFactor) lines.push({ icon: "🏟️", text: `Park Factor: ${props.parkFactor}` });
  if (props.opposingPitcher) lines.push({ icon: "👊", text: `Opposing Pitcher: ${props.opposingPitcher}` });
  if (props.battingOrder != null) lines.push({ icon: "📍", text: `Batting ${ordinal(props.battingOrder)}` });
  if (props.weather) lines.push({ icon: "🌡️", text: `Weather: ${props.weather}` });
  if (props.recentForm) lines.push({ icon: "🔥", text: `Recent Form: ${props.recentForm}` });

  if (lines.length === 0) return null;

  return (
    <div className="rounded-md border border-primary/30 bg-primary/[0.05] p-2">
      <div className="mono mb-1 text-[9px] uppercase tracking-widest text-primary">
        Why the Model Likes This
      </div>
      <ul className="grid gap-0.5">
        {lines.map((l, i) => (
          <li key={i} className="text-[11px] leading-snug">
            <span className="mr-1">{l.icon}</span>
            <span className="mono tabular-nums">{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
