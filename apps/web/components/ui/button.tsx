import * as React from "react";

import type { ButtonProps } from "@saiye/shared-react/components/ui/button";
import { Button } from "@saiye/shared-react/components/ui/button";

import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipTrigger,
} from "./tooltip";

export {
  Button,
  buttonVariants,
  type ButtonProps,
} from "@saiye/shared-react/components/ui/button";

const ButtonWithTooltip = React.forwardRef<
  HTMLButtonElement,
  ButtonProps & { tooltip: string; delayDuration?: number }
>(({ tooltip, delayDuration, ...props }, ref) => {
  return (
    <Tooltip delayDuration={delayDuration}>
      <TooltipTrigger asChild>
        <Button ref={ref} {...props} />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent>{tooltip}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
});
ButtonWithTooltip.displayName = "ButtonWithTooltip";

export { ButtonWithTooltip };
