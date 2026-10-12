import type { TFunction } from "i18next";

import { ZBookmark } from "@saiye/shared/types/bookmarks";

export interface ContentRenderer {
  id: string;
  /** Display name; a function form enables i18n (evaluated at render time) */
  name: string | ((t: TFunction) => string);
  icon: React.ComponentType<{ className?: string }>;
  canRender: (bookmark: ZBookmark) => boolean;
  component: React.ComponentType<{ bookmark: ZBookmark }>;
  priority?: number;
}

export interface ContentRendererRegistry {
  register: (renderer: ContentRenderer) => void;
  getRenderers: (bookmark: ZBookmark) => ContentRenderer[];
  getAllRenderers: () => ContentRenderer[];
}
