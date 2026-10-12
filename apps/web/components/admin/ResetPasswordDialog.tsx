import { useEffect, useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
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
import { useMutation } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useTRPC } from "@saiye/shared-react/trpc"; // Adjust the import path as needed

import { resetPasswordSchema } from "@saiye/shared/types/admin";

interface ResetPasswordDialogProps {
  userId: string;
  children?: React.ReactNode;
}

type ResetPasswordSchema = z.infer<typeof resetPasswordSchema>;

export default function ResetPasswordDialog({
  children,
  userId,
}: ResetPasswordDialogProps) {
  const api = useTRPC();
  const { t } = useTranslation();
  const [isOpen, onOpenChange] = useState(false);
  const form = useForm<ResetPasswordSchema>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: {
      userId,
      newPassword: "",
      newPasswordConfirm: "",
    },
  });
  const { mutate, isPending } = useMutation(
    api.admin.resetPassword.mutationOptions({
      onSuccess: () => {
        toast({
          description: t("admin.users_dialogs.password_reset"),
        });
        onOpenChange(false);
      },
      onError: (error) => {
        if (error instanceof TRPCClientError) {
          toast({
            variant: "destructive",
            description: error.message,
          });
        } else {
          toast({
            variant: "destructive",
            description: t("admin.users_dialogs.password_reset_failed"),
          });
        }
      },
    }),
  );

  useEffect(() => {
    if (isOpen) {
      form.reset();
    }
  }, [isOpen, form]);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.users_list.reset_password")}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((val) => mutate(val))}>
            <div className="flex w-full flex-col space-y-2">
              <FormField
                control={form.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t("admin.users_dialogs.new_password")}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={t("admin.users_dialogs.new_password")}
                        {...field}
                        className="w-full rounded border p-2"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="newPasswordConfirm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t("admin.users_dialogs.confirm_new_password")}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={t(
                          "admin.users_dialogs.confirm_new_password",
                        )}
                        {...field}
                        className="w-full rounded border p-2"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter className="sm:justify-end">
                <DialogClose asChild>
                  <Button type="button" variant="secondary">
                    {t("actions.close")}
                  </Button>
                </DialogClose>
                <ActionButton
                  type="submit"
                  loading={isPending}
                  disabled={isPending}
                >
                  {t("admin.users_dialogs.reset")}
                </ActionButton>
              </DialogFooter>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
