"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton } from "@/components/ui/action-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { AlertCircle, CheckCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useTRPC } from "@saiye/shared-react/trpc";

const forgotPasswordSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
});

export default function ForgotPasswordForm() {
  const api = useTRPC();
  const { t } = useTranslation();
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const router = useRouter();

  const form = useForm<z.infer<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  const forgotPasswordMutation = useMutation(
    api.users.forgotPassword.mutationOptions(),
  );

  const onSubmit = async (values: z.infer<typeof forgotPasswordSchema>) => {
    try {
      setErrorMessage("");
      await forgotPasswordMutation.mutateAsync(values);
      setIsSubmitted(true);
    } catch (error) {
      if (error instanceof TRPCClientError) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(t("signin.forgot_password.unexpected_error"));
      }
    }
  };

  return (
    <Card className="w-full">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">
          {isSubmitted
            ? t("signin.forgot_password.check_email_title")
            : t("signin.forgot_password_title")}
        </CardTitle>
        <CardDescription>
          {isSubmitted
            ? t("signin.forgot_password.submitted_description")
            : t("signin.forgot_password.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isSubmitted ? (
          <>
            <div className="flex items-center justify-center">
              <CheckCircle className="h-12 w-12 text-green-600" />
            </div>
            <Alert>
              <AlertDescription className="text-center">
                {t("signin.forgot_password.submitted_description")}
              </AlertDescription>
            </Alert>
            <ActionButton
              variant="outline"
              loading={false}
              onClick={() => router.push("/signin")}
              className="w-full"
            >
              {t("signin.back_to_signin")}
            </ActionButton>
          </>
        ) : (
          <>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-4"
              >
                {errorMessage && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{errorMessage}</AlertDescription>
                  </Alert>
                )}

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("signin.email")}</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder={t("signin.email_placeholder")}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <ActionButton
                  type="submit"
                  loading={form.formState.isSubmitting}
                  className="w-full"
                >
                  {t("signin.forgot_password.send_reset_link")}
                </ActionButton>
              </form>
            </Form>

            <div className="text-center">
              <ActionButton
                variant="ghost"
                loading={false}
                onClick={() => router.push("/signin")}
                className="w-full"
              >
                {t("signin.back_to_signin")}
              </ActionButton>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
