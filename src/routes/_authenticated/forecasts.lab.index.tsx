import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getEngineStatus, type EngineStatusPayload } from "@/lib/projection-lab.functions";
import { formatDateTimeInAppTz } from "@/lib/timezone";

const engineQuery = queryOptions({
  queryKey: ["projection-lab", "engine-status"],
  queryFn: () => getEngineStatus(),
  staleTime: 30_000,
});

export const Route = createFileRoute("/_authenticated/forecasts/lab/")({
  ssr: false,
  loader: ({ context }) => context.queryClient.ensureQueryData(engineQuery),
  component: EngineStatusPage,
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-7xl px-4 py-6 text-sm text-destructive md:px-6">
      Couldn't load engine status: {error.message}
    </div>
  ),
});

function Pill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
        : tone === "bad"
          ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
          : "border-border/60 bg-card/60 text-muted-foreground";
  return (
    <span className={`mono inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${cls}`}>
      {children}
    </span>
  );
}

function EngineStatusPage() {
  const { data } = useSuspenseQuery(engineQuery);
  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 md:px-6">
      <ActiveVersionCard data={data} />
      <TodayLifecycleCard data={data} />
      <RecentUsageCard data={data} />
      <ShadowCard data={data} />
      <ChangelogCard data={data} />
    </div>
  );
}

function ActiveVersionCard({ data }: { data: EngineStatusPayload }) {
  const active = data.active_versions;
  const tone: "ok" | "warn" | "bad" =
    active.length === 1 ? "ok" : active.length === 0 ? "bad" : "warn";
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-5">
      <div className="mono mb-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Currently deployed engine
      </div>
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="font-display text-3xl tracking-tight">
          {active.length === 0 ? "No active version" : active.join(" · ")}
        </span>
        <Pill tone={tone}>
          {active.length === 1
            ? "Single active version"
            : active.length === 0
              ? "Misconfigured — no active row"
              : `${active.length} active versions`}
        </Pill>
        {data.drifted ? (
          <Pill tone="warn">
            Writer drift — recent runs use {data.recent_usage[0]?.model_version}
          </Pill>
        ) : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
        <Stat
          label="Latest official publication"
          value={
            data.latest_official_publication_at
              ? formatDateTimeInAppTz(data.latest_official_publication_at)
              : "—"
          }
        />
        <Stat
          label="Today has official forecasts"
          value={data.today_lifecycle.has_official_today ? "Yes" : "No"}
        />
        <Stat
          label="Calibration last computed"
          value={
            data.calibration.last_computed_at
              ? formatDateTimeInAppTz(data.calibration.last_computed_at)
              : "Never"
          }
        />
        <Stat
          label="Iterations per snapshot (latest observed)"
          value={
            data.iterations_observed.latest_value != null
              ? String(data.iterations_observed.latest_value)
              : "Not persisted"
          }
          hint={
            data.iterations_observed.persisted_count + data.iterations_observed.missing_count > 0
              ? `${data.iterations_observed.persisted_count} of ${
                  data.iterations_observed.persisted_count + data.iterations_observed.missing_count
                } recent runs store this field`
              : undefined
          }
        />
      </dl>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="text-base text-foreground">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground/80">{hint}</div> : null}
    </div>
  );
}

function TodayLifecycleCard({ data }: { data: EngineStatusPayload }) {
  const byStatus = Object.fromEntries(data.today_lifecycle.by_status.map((x) => [x.status, x.count]));
  const byClass = Object.fromEntries(data.today_lifecycle.by_class.map((x) => [x.projection_class, x.count]));
  const rows: Array<[string, number]> = [
    ["Published", byStatus["published"] ?? 0],
    ["Locked", byStatus["locked"] ?? 0],
    ["Superseded", byStatus["superseded"] ?? 0],
  ];
  const classRows: Array<[string, number]> = [
    ["Official", byClass["official"] ?? 0],
    ["Preview (admin only)", byClass["preview"] ?? 0],
  ];
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-5">
      <div className="mono mb-3 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Today ({data.today}) — Forecast lifecycle
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Mini rows={rows} title="By status" />
        <Mini rows={classRows} title="By class" />
      </div>
    </div>
  );
}

function Mini({ rows, title }: { rows: Array<[string, number]>; title: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-3">
      <div className="mono mb-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </div>
      <ul className="grid gap-1 text-sm">
        {rows.map(([k, v]) => (
          <li key={k} className="flex items-center justify-between">
            <span className="text-muted-foreground">{k}</span>
            <span className="mono tabular-nums text-foreground">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentUsageCard({ data }: { data: EngineStatusPayload }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-5">
      <div className="mono mb-3 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Model version usage — last 7 days (official runs only)
      </div>
      {data.recent_usage.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No official forecast runs in the last 7 days.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="py-2">Version</th>
              <th>Runs</th>
              <th>First</th>
              <th>Last</th>
              <th>Active?</th>
            </tr>
          </thead>
          <tbody>
            {data.recent_usage.map((u) => (
              <tr key={u.model_version} className="border-t border-border/40">
                <td className="py-2 font-medium">{u.model_version}</td>
                <td className="mono tabular-nums">{u.count}</td>
                <td className="text-muted-foreground">{u.first ? formatDateTimeInAppTz(u.first) : "—"}</td>
                <td className="text-muted-foreground">{u.last ? formatDateTimeInAppTz(u.last) : "—"}</td>
                <td>
                  {data.active_versions.includes(u.model_version) ? (
                    <Pill tone="ok">active</Pill>
                  ) : (
                    <Pill tone="muted">shadow / inactive</Pill>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ShadowCard({ data }: { data: EngineStatusPayload }) {
  if (data.shadow_candidates.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
      <div className="mono mb-2 text-[10px] uppercase tracking-[0.22em] text-amber-300">
        Shadow versions detected
      </div>
      <p className="mb-3 text-sm text-foreground/90">
        These versions are writing forecast runs but are not marked active in{" "}
        <code className="mono text-xs">model_versions</code>. New formula or
        calibration work must run in shadow until it beats the active version
        on trusted locked historical forecasts.
      </p>
      <ul className="grid gap-1 text-sm">
        {data.shadow_candidates.map((s) => (
          <li key={s.version} className="flex items-center justify-between">
            <span className="font-medium">{s.version}</span>
            <span className="mono tabular-nums text-muted-foreground">
              {s.runs} runs · last {formatDateTimeInAppTz(s.last)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangelogCard({ data }: { data: EngineStatusPayload }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-5">
      <div className="mono mb-3 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Model changelog
      </div>
      {data.model_versions.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No model versions registered.
        </div>
      ) : (
        <ul className="grid gap-3">
          {data.model_versions.map((m) => (
            <li
              key={m.version}
              className="rounded-md border border-border/40 bg-background/40 p-3"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-display text-lg">{m.version}</span>
                {m.active ? <Pill tone="ok">active</Pill> : <Pill tone="muted">archived</Pill>}
                {m.release_date ? (
                  <span className="mono text-[11px] text-muted-foreground">
                    released {m.release_date}
                  </span>
                ) : null}
              </div>
              {m.notes ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {m.notes}
                </p>
              ) : (
                <p className="mt-1 text-sm italic text-muted-foreground/70">
                  No changelog notes recorded.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
