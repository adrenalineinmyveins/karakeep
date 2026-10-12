import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslation } from "@/lib/i18n/client";
import { Check, ChevronsUpDown } from "lucide-react";

import {
  ZWebhookEvent,
  zWebhookEventSchema,
} from "@saiye/shared/types/webhooks";

export function WebhookEventSelector({
  value,
  onChange,
}: {
  value: ZWebhookEvent[];
  onChange: (value: ZWebhookEvent[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="w-full justify-between"
        >
          {value.length > 0
            ? value.join(", ")
            : t("settings.webhooks.events.select_placeholder")}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <Command>
          <CommandInput
            placeholder={t("settings.webhooks.events.search_placeholder")}
          />
          <CommandList>
            <CommandEmpty>
              {t("settings.webhooks.events.no_events_found")}
            </CommandEmpty>
            <CommandGroup>
              {zWebhookEventSchema.options.map((eventType) => (
                <CommandItem
                  key={eventType}
                  value={eventType}
                  onSelect={() => {
                    const newEvents = value.includes(eventType)
                      ? value.filter((e) => e !== eventType)
                      : [...value, eventType];
                    onChange(newEvents);
                  }}
                >
                  {eventType}
                  {value?.includes(eventType) && (
                    <Check className="ml-auto h-4 w-4" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
