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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useTRPC } from "@saiye/shared-react/trpc";
import { zAdminCreateUserSchema } from "@saiye/shared/types/admin";

type AdminCreateUserSchema = z.infer<typeof zAdminCreateUserSchema>;

export default function AddUserDialog({
  children,
}: {
  children?: React.ReactNode;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [isOpen, onOpenChange] = useState(false);
  const form = useForm<AdminCreateUserSchema>({
    resolver: zodResolver(zAdminCreateUserSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
      role: "user",
    },
  });
  const { mutate, isPending } = useMutation(
    api.admin.createUser.mutationOptions({
      onSuccess: () => {
        toast({
          description: t("admin.users_dialogs.user_created"),
        });
        onOpenChange(false);
        queryClient.invalidateQueries(api.users.list.pathFilter());
        queryClient.invalidateQueries(api.admin.userStats.pathFilter());
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
            description: t("admin.users_dialogs.user_create_failed"),
          });
        }
      },
    }),
  );

  useEffect(() => {
    if (!isOpen) {
      form.reset();
    }
  }, [isOpen, form]);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.users_dialogs.add_user")}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((val) => mutate(val))}>
            <div className="flex w-full flex-col space-y-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("common.name")}</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        placeholder={t("common.name")}
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
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("common.email")}</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder={t("common.email")}
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
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("common.password")}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={t("common.password")}
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
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t("admin.users_list.confirm_password")}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={t("admin.users_list.confirm_password")}
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
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("common.role")}</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="user">
                            {t("common.roles.user")}
                          </SelectItem>
                          <SelectItem value="admin">
                            {t("common.roles.admin")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
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
                  {t("actions.create")}
                </ActionButton>
              </DialogFooter>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
