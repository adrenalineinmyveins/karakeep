import { useMemo } from "react";
import Link from "next/link";

const GITHUB_OWNER_REPO = "adrenalineinmyveins/karakeep";
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER_REPO}`;
const GITHUB_RELEASE_URL = `${GITHUB_REPO_URL}/releases/tag/`;

function isStableRelease(version?: string) {
  if (!version) {
    return false;
  }
  const normalized = version.toLowerCase();
  if (
    normalized.includes("nightly") ||
    normalized.includes("beta") ||
    normalized.includes("0.0.1")
  ) {
    return false;
  }
  return true;
}

interface SidebarVersionProps {
  // The actual version of the server
  serverVersion?: string;
  // The version that should be displayed in the changelog
  changeLogVersion?: string;
}

export default function SidebarVersion({
  serverVersion,
  changeLogVersion,
}: SidebarVersionProps) {
  const effectiveChangelogVersion = changeLogVersion ?? serverVersion;
  const displayVersion = serverVersion ?? "unknown";
  const versionLabel = `Saiye v${displayVersion}`;
  const releasePageUrl = useMemo(() => {
    if (
      !effectiveChangelogVersion ||
      !isStableRelease(effectiveChangelogVersion)
    ) {
      return GITHUB_REPO_URL;
    }
    return `${GITHUB_RELEASE_URL}v${effectiveChangelogVersion}`;
  }, [effectiveChangelogVersion]);

  return (
    <Link
      href={releasePageUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center px-2 text-sm text-gray-400 hover:underline"
    >
      {versionLabel}
    </Link>
  );
}
