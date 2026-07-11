import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

/**
 * End-to-end proof that the durable simulation worker path produces real
 * persisted sim_player_outputs. This test does NOT invoke the worker — the
 * live worker runs continuously via pg_cron. It asserts that the database
 * currently holds outputs that satisfy the Prop Board contract, and that
 * the guardrails documented in worker.server.ts hold in production data.
 *
 * Skipped when env is missing (CI without DB credentials).
 */

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
const RUN = Boolean(URL && KEY);

describe("sim-worker persistence (live DB)", { skip: !RUN }, () => {
  const sb = createClient(URL!, KEY!, { auth: { persistSession: false } });

  it("no completed sim_jobs have zero output rows", async () => {
    const { data, error } = await sb
      .from("sim_jobs")
      .select("id")
      .eq("status", "completed")
      .limit(200);
    assert.equal(error, null);
    for (const j of data ?? []) {
      const { count } = await sb
        .from("sim_player_outputs")
        .select("id", { count: "exact", head: true })
        .eq("sim_job_id", j.id);
      assert.ok((count ?? 0) > 0, `completed job ${j.id} has zero outputs`);
    }
  });

  it("outputs are not placeholder constants", async () => {
    const { data } = await sb
      .from("sim_player_outputs")
      .select("player_id, market, projected_mean, event_probability")
      .limit(50);
    const uniqMeans = new Set((data ?? []).map((r) => r.projected_mean));
    assert.ok(uniqMeans.size > 3, `expected variance in means, got ${uniqMeans.size} distinct`);
  });

  it("unique (sim_job_id, player_id, market) — no duplicates", async () => {
    const { data } = await sb
      .from("sim_player_outputs")
      .select("sim_job_id, player_id, market")
      .limit(1000);
    const keys = new Set<string>();
    for (const r of data ?? []) {
      const k = `${r.sim_job_id}|${r.player_id}|${r.market}`;
      assert.ok(!keys.has(k), `duplicate ${k}`);
      keys.add(k);
    }
  });

  it("engine_status is preserved as scaffold_unvalidated (not silently promoted)", async () => {
    const { data } = await sb
      .from("sim_player_outputs")
      .select("engine_status")
      .limit(200);
    const promoted = (data ?? []).filter((r) => r.engine_status === "validated");
    assert.equal(promoted.length, 0, "scaffold worker must not produce validated rows");
  });

  it("inputs_hash propagates from job to output", async () => {
    const { data: jobs } = await sb
      .from("sim_jobs")
      .select("id, inputs_hash")
      .eq("status", "completed")
      .limit(5);
    for (const j of jobs ?? []) {
      const { data } = await sb
        .from("sim_player_outputs")
        .select("inputs_hash")
        .eq("sim_job_id", j.id)
        .limit(1);
      assert.equal(data?.[0]?.inputs_hash, j.inputs_hash);
    }
  });
});
