import { createFileRoute } from "@tanstack/react-router";
import { queryOptions } from "@tanstack/react-query";
import { getSimulationLeaders } from "@/lib/sim.functions";
import { DiamondConsensusPage } from "./diamond-consensus";

const leadersQuery = (date: string | undefined) =>
  queryOptions({
    queryKey: ["sim-leaders", date ?? "today"],
    queryFn: () => getSimulationLeaders({ data: date ? { date } : {} }),
  });

export const Route = createFileRoute("/_authenticated/forecasts/consensus")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Diamond Consensus · Forecasts" },
      { name: "description", content: "Where Diamond Score, Sim Mean, Sim Probability, and lineup confidence agree." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(leadersQuery(undefined)),
  component: DiamondConsensusPage,
});
