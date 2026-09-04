import createClient from "openapi-fetch";

import type { components, paths } from "./saiye-api.d.ts";

export const createSaiyeClient = createClient<paths>;

export type SaiyeAPISchemas = components["schemas"];
