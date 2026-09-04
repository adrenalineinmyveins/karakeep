import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Github } from "lucide-react";

import { DOCS_LINK, GITHUB_LINK } from "./constants";

export default function Pricing() {
  return (
    <div className="container mx-auto">
      <div className="py-16">
        <div className="text-center">
          <h1 className="text-4xl font-bold sm:text-6xl">Free & Self-Hosted</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-600">
            Saiye is a free, open-source project. There are no paid plans and
            no hosted cloud service — you run it on your own server, and every
            feature is included.
          </p>
        </div>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href={GITHUB_LINK}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "gap-2 px-8",
              buttonVariants({ variant: "default", size: "lg" }),
            )}
          >
            <Github className="size-5" /> View on GitHub
          </a>
          <a
            href={`${DOCS_LINK}/installation/docker`}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "gap-2 px-8",
              buttonVariants({ variant: "outline", size: "lg" }),
            )}
          >
            Self-Hosting Guide
          </a>
        </div>

        <div className="mx-auto mt-16 max-w-3xl px-6">
          <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
            <h2 className="text-2xl font-semibold text-gray-900">
              Everything included, forever
            </h2>
            <p className="mt-3 text-gray-600">
              No subscriptions, no accounts with us, and no telemetry. Deploy
              with Docker, bring your own AI credentials, and keep full
              control of your data on your own infrastructure.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
