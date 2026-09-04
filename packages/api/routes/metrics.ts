// Import stats to register Prometheus metrics
import "@saiye/trpc/stats";

import { prometheus } from "@hono/prometheus";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { register } from "prom-client";

import serverConfig from "@saiye/shared/config";

type PrometheusHandlers = ReturnType<typeof prometheus>;

const globalForPrometheus = globalThis as typeof globalThis & {
  __saiyeApiPrometheus?: PrometheusHandlers;
};

const prometheusHandlers = (globalForPrometheus.__saiyeApiPrometheus ??=
  prometheus({
    registry: register,
    prefix: "saiye_",
    collectDefaultMetrics: true,
  }));

export const { printMetrics, registerMetrics } = prometheusHandlers;

const app = new Hono().get(
  "/",
  bearerAuth({ token: serverConfig.prometheus.metricsToken }),
  printMetrics,
);

export default app;
