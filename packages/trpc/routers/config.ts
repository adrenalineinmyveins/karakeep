import { clientConfig } from "@saiye/shared/config";
import { zClientConfigSchema } from "@saiye/shared/types/config";

import { publicProcedure, router } from "../index";

export const configAppRouter = router({
  clientConfig: publicProcedure
    .output(zClientConfigSchema)
    .query(() => clientConfig),
});
