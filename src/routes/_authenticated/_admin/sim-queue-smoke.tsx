import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useMutation, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getSimQueueDiagnostics,
  runSimWorkerTick,
  type SimQueueDiagnostics,
} from "@/lib/sim-queue/worker.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";

const diagQuery = () =>
  queryOptions({
    queryKey: ["sim-queue-diagnostics"],
    queryFn: () => getSimQueueDiagnostics({ data: {} }),
  });

export const Route = createFileRoute("/_authenticated/_admin/sim-queue-smoke")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sim Queue — Pipeline Smoke Test" },
      { name: "description", content: "Phase 3a durable worker smoke test — plumbing only, uncalibrated outputs." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(diagQuery()),
  component: SimQueueSmokePage,
});

function EngineBadge({ status }: { status: "scaffold_unvalidated" | "validated" }) {
  if (status === "validated") return <Badge className="bg-emerald-600">Validated</Badge>;
  return (
    <Badge variant="destructive" className="bg-amber-600 hover:bg-amber-600">
      Pipeline Test / Uncalibrated
    </Badge>
  );
}

function SimQueueSmokePage() {
  const { data } = useSuspenseQuery(diagQuery());
  const qc = useQueryClient();
  const tick = useServerFn(runSimWorkerTick);
  const [log, setLog] = useState<string[]>([]);
  const mut = useMutation({
    mutationFn: () => tick({ data: { maxJobs: 3 } }),
    onSuccess: (r) => {
      setLog((prev) => [
        `[${new Date().toLocaleTimeString()}] worker=${r.workerId.slice(0, 8)} picked=${r.picked} chunks=${r.chunksExecuted} completed=${r.jobsCompleted} failed=${r.jobsFailed}`,
        ...r.events.map((e) => `  · ${e.jobId.slice(0, 8)} ${e.kind}${e.chunkIndex != null ? ` c${e.chunkIndex}` : ""}${e.detail ? ` — ${e.detail}` : ""}`),
        ...prev,
      ].slice(0, 200));
      qc.invalidateQueries({ queryKey: ["sim-queue-diagnostics"] });
    },
  });

  const g = data.guardrails;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Sim Queue — Pipeline Smoke Test</h1>
          <p className="text-sm text-muted-foreground max-w-2xl mt-1">
            Phase 3a durable worker. Outputs on this screen are produced by a
            <strong> placeholder simulator</strong> and are labeled{" "}
            <em>Pipeline Test / Uncalibrated</em>. They exist only to prove queue
            plumbing (lease pickup, chunk resumability, idempotent writes,
            stale/current flips, retry, timeout). They are <strong>not</strong>{" "}
            Official 20K runs, and every downstream consumer (Form Movers,
            Projection Leaders, Prop Leaders, Diamond Consensus, auto-lock,
            grading) MUST filter <code>engine_status = 'scaffold_unvalidated'</code>.
          </p>
        </div>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? "Ticking…" : "Run worker tick"}
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Guardrail label="Total output rows" value={g.total_rows} />
        <Guardrail label="Scaffold rows" value={g.scaffold_rows} tone="warn" />
        <Guardrail label="Validated rows" value={g.validated_rows} tone={g.validated_rows > 0 ? "ok" : "muted"} />
        <Guardrail
          label="Partial jobs (blocked from official consumers)"
          value={g.partial_jobs_blocked_from_leaderboards}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Jobs</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {data.jobs.length === 0 && (
            <p className="text-sm text-muted-foreground">No sim jobs yet. Enqueue jobs from the slate orchestrator, then click <em>Run worker tick</em>.</p>
          )}
          {data.jobs.map((j) => <JobCard key={j.id} job={j} />)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Tick log</CardTitle></CardHeader>
        <CardContent>
          <pre className="text-xs whitespace-pre-wrap font-mono max-h-80 overflow-auto">
            {log.length ? log.join("\n") : "(no ticks yet)"}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

function Guardrail({ label, value, tone = "muted" }: { label: string; value: number; tone?: "muted" | "warn" | "ok" }) {
  const cls = tone === "warn" ? "text-amber-600" : tone === "ok" ? "text-emerald-600" : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold ${cls}`}>{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function JobCard({ job }: { job: SimQueueDiagnostics["jobs"][number] }) {
  const chunkPct = Math.round((job.chunks_done / Math.max(1, job.chunks_total)) * 100);
  const dupClass = job.outputs.duplicate_rows === 0 ? "text-emerald-600" : "text-red-600";
  return (
    <div className="rounded border p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{job.tier}</Badge>
        <Badge variant="outline">{job.label}</Badge>
        <Badge>{job.status}</Badge>
        <EngineBadge status={job.engine_status} />
        <span className="text-xs text-muted-foreground">game_pk={job.game_pk}</span>
        <span className="text-xs text-muted-foreground">hash={job.inputs_hash.slice(0, 10)}</span>
        <span className="text-xs text-muted-foreground ml-auto">attempts {job.attempts}/{job.max_attempts}</span>
      </div>

      <div className="text-xs">
        chunks {job.chunks_done}/{job.chunks_total} ({chunkPct}%) · lease{" "}
        {job.worker_lease_expires_at ? new Date(job.worker_lease_expires_at).toLocaleTimeString() : "—"}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
        <Stat label="rows" value={job.outputs.row_count} />
        <Stat label="players" value={job.outputs.distinct_players} />
        <Stat label="markets" value={job.outputs.distinct_markets} />
        <Stat label="current" value={job.outputs.current_row_count} />
        <Stat label="stale" value={job.outputs.stale_row_count} />
        <Stat label="dupes (must be 0)" value={job.outputs.duplicate_rows} className={dupClass} />
      </div>

      {(job.last_error || job.failure_reason || job.finalizer_status) && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {job.failure_reason && <div>failure: {job.failure_reason}</div>}
          {job.last_error && <div>last_error: {job.last_error}</div>}
          {job.finalizer_status && <div>finalizer: {job.finalizer_status}</div>}
        </div>
      )}

      {job.chunk_runs.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Chunk history ({job.chunk_runs.length})</summary>
          <table className="w-full mt-2">
            <thead className="text-left">
              <tr><th>chunk</th><th>attempt</th><th>status</th><th>dur ms</th><th>err</th></tr>
            </thead>
            <tbody>
              {job.chunk_runs.map((c, i) => (
                <tr key={i} className="border-t">
                  <td>{c.chunk_index}</td>
                  <td>{c.attempt}</td>
                  <td>{c.status}</td>
                  <td>{c.duration_ms ?? "—"}</td>
                  <td className="truncate max-w-[240px]">{c.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={`font-mono ${className ?? ""}`}>{value.toLocaleString()}</div>
    </div>
  );
}
