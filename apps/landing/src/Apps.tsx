import appleIcon from "/apple-icon.svg?url";
import chromeIcon from "/chrome-icon.svg?url";
import firefoxIcon from "/firefox-icon.svg?url";
import googlePlayIcon from "/google-play-icon.svg?url";
import obsidianIcon from "/obsidian-icon.svg?url";
import openclawIcon from "/openclaw-icon.svg?url";
import raycastIcon from "/raycast-icon.svg?url";
import safariIcon from "/safari-icon.svg?url";

import { GITHUB_LINK } from "./constants";

interface Listing {
  name: string;
  description: string;
  url: string;
  badge?: string;
  initials?: string;
}

const mobileApps: Listing[] = [
  {
    name: "iOS App",
    description:
      "Save links and notes from your iPhone and iPad. Build from source via the GitHub repo.",
    url: GITHUB_LINK,
    badge: appleIcon,
  },
  {
    name: "Android App",
    description:
      "Capture and organize content on Android devices. Build from source via the GitHub repo.",
    url: GITHUB_LINK,
    badge: googlePlayIcon,
  },
];

const browserExtensions: Listing[] = [
  {
    name: "Chrome Extension",
    description:
      "One-click saving from Chrome. Get it from the GitHub repository.",
    url: GITHUB_LINK,
    badge: chromeIcon,
  },
  {
    name: "Firefox Add-on",
    description:
      "Save pages directly from Firefox. Get it from the GitHub repository.",
    url: GITHUB_LINK,
    badge: firefoxIcon,
  },
  {
    name: "Safari Extension",
    description:
      "Save pages directly from Safari on macOS. Get it from the GitHub repository.",
    url: GITHUB_LINK,
    badge: safariIcon,
  },
];

const communityProjects: Listing[] = [
  {
    name: "Raycast Extension",
    description:
      "Manage your Saiye bookmarks directly from Raycast. See the GitHub repo for details.",
    url: GITHUB_LINK,
    badge: raycastIcon,
  },
  {
    name: "Obsidian Plugin",
    description:
      "Sync your Saiye bookmarks to Obsidian as markdown notes. See the GitHub repo for details.",
    url: GITHUB_LINK,
    badge: obsidianIcon,
  },
];

const agenticSkills: Listing[] = [
  {
    name: "Agent Skills",
    description:
      "Install the Saiye skill for agentic assistants. See the GitHub repo for details.",
    url: GITHUB_LINK,
    badge: openclawIcon,
  },
  {
    name: "skills.sh",
    description:
      "Install with npx skills add adrenalineinmyveins/karakeep from the GitHub repo.",
    url: GITHUB_LINK,
    initials: "SH",
  },
];

function ListingSection({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: Listing[];
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      <h2 className="text-2xl font-semibold text-gray-900">{title}</h2>
      <p className="mt-2 text-gray-600">{description}</p>
      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
        {items.map((item) => (
          <a
            key={item.name}
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="flex flex-row items-center gap-4 rounded-xl border border-gray-200 p-4 transition-colors hover:border-gray-300"
          >
            <div className="h-10 w-10 shrink-0">
              {item.badge ? (
                <img
                  className="h-full w-full object-contain"
                  alt={item.name}
                  src={item.badge}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded-lg bg-gray-900 text-xs font-semibold text-white">
                  {item.initials}
                </div>
              )}
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">{item.name}</h3>
              <p className="mt-1 text-sm text-gray-600">{item.description}</p>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

export default function Apps() {
  return (
    <div className="container mx-auto pb-16">
      <main className="px-4 py-8 sm:px-6 sm:py-14">
        <h1 className="text-4xl font-bold text-gray-900 sm:text-5xl">
          Apps & Extensions
        </h1>
        <p className="mt-3 max-w-2xl text-base text-gray-600 sm:text-lg">
          Use Saiye anywhere with our mobile apps and browser extensions. This
          fork is not published on the app stores — everything is available
          from the GitHub repository.
        </p>
        <div className="mt-10 space-y-6">
          <ListingSection
            title="Mobile Apps"
            description="Take your bookmarks with you on iOS and Android."
            items={mobileApps}
          />
          <ListingSection
            title="Browser Extensions"
            description="Save content from your browser in one click."
            items={browserExtensions}
          />
          <ListingSection
            title="Community Projects"
            description="Integrations built by the Saiye community."
            items={communityProjects}
          />
          <ListingSection
            title="Agentic Skills"
            description="Connect AI assistants to Saiye with installable skills."
            items={agenticSkills}
          />
        </div>
      </main>
    </div>
  );
}
