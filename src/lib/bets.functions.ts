import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const insertBetSchema = z.object({
  gamePk: z.number().int().nullable().optional(),
  gameLabel: z.string().max(120).nullable().optional(),
  market: z.string().min(1).max(60),
  selection: z.string().min(1).max(200),
  line: z.number().nullable().optional(),
  odds: z.number().int(),
  stake: z.number().positive(),
  book: z.string().max(40).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const settleSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["won", "lost", "push", "void"]),
  closingOdds: z.number().int().nullable().optional(),
});

function payoutFor(stake: number, odds: number, status: string): number {
  if (status === "push" || status === "void") return stake;
  if (status === "lost") return 0;
  // won
  if (odds > 0) return stake + stake * (odds / 100);
  return stake + stake * (100 / Math.abs(odds));
}

export const listBets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("bets")
      .select("*")
      .order("placed_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const insertBet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => insertBetSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error, data: row } = await context.supabase
      .from("bets")
      .insert({
        user_id: context.userId,
        game_pk: data.gamePk ?? null,
        game_label: data.gameLabel ?? null,
        market: data.market,
        selection: data.selection,
        line: data.line ?? null,
        odds: data.odds,
        stake: data.stake,
        book: data.book ?? null,
        notes: data.notes ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const settleBet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => settleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: bet } = await context.supabase.from("bets").select("stake, odds").eq("id", data.id).single();
    if (!bet) throw new Error("Bet not found");
    const payout = payoutFor(Number(bet.stake), bet.odds, data.status);
    const { error, data: row } = await context.supabase
      .from("bets")
      .update({
        status: data.status,
        payout,
        closing_odds: data.closingOdds ?? null,
        settled_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteBet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("bets").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
