"use client";

import { useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/lib/i18n/client";
import { toast } from "@/components/ui/sonner";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useTRPC } from "@saiye/shared-react/trpc";

interface CreateInviteDialogProps {
  children: React.ReactNode;
}

export default function CreateInviteDialog({
  children,
}: CreateInviteDialogProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const createInviteSchema = z.object({
    email: z.string().email(t("admin.invites.invalid_email")),
  });

  const form = useForm<z.infer<typeof createInviteSchema>>({
    resolver: zodResolver(createInviteSchema),
    defaultValues: {
      email: "",
    },
  });

  const createInviteMutation = useMutation(
    api.invites.create.mutationOptions({
      onSuccess: () => {
        toast({
          description: t("admin.invites.invite_sent"),
        });
        queryClient.invalidateQueries(api.invites.list.pathFilter());
        setOpen(false);
        form.reset();
        setErrorMessage("");
      },
      onError: (e) => {
        if (e instanceof TRPCClientError) {
          setErrorMessage(e.message);
        } else {
          setErrorMessage(t("admin.invites.send_failed"));
        }
      },
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("admin.invites.send_user_invitation")}</DialogTitle>
          <DialogDescription>
            {t("admin.invites.invitation_description")}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(async (value) => {
              setErrorMessage("");
              await createInviteMutation.mutateAsync(value);
            })}
            className="space-y-4"
          >
            {errorMessage && (
              <p className="text-sm text-destructive">{errorMessage}</p>
            )}

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("admin.invites.email_address")}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="user@example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end space-x-2">
              <ActionButton
                type="button"
                variant="outline"
                loading={false}
                onClick={() => setOpen(false)}
              >
                {t("actions.cancel")}
              </ActionButton>
              <ActionButton
                type="submit"
                loading={createInviteMutation.isPending}
              >
                {t("admin.invites.send_invitation")}
              </ActionButton>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
