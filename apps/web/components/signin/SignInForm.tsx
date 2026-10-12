import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authOptions } from "@/server/auth";
import { useTranslation } from "@/lib/i18n/server";
import { Info } from "lucide-react";

import serverConfig from "@saiye/shared/config";

import CredentialsForm from "./CredentialsForm";
import OAuthAutoRedirect from "./OAuthAutoRedirect";
import SignInProviderButton from "./SignInProviderButton";

export default async function SignInForm() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  const providers = authOptions.providers;
  let providerValues;
  if (providers) {
    providerValues = Object.values(providers).filter(
      // Credentials are handled manually by the sign in form
      (p) => p.id != "credentials",
    );
  }
  // 微信扫码为主入口；其余 OAuth 提供方与密码登录作为备选
  const wechatProvider = providerValues?.find((p) => p.id === "wechat");
  const otherProviders = providerValues?.filter((p) => p.id !== "wechat");

  return (
    <div className="w-full">
      {/* Auto-redirect to OAuth provider if configured */}
      {providerValues && providerValues.length > 0 && (
        <OAuthAutoRedirect oauthProviderId={providerValues[0].id} />
      )}
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">
            {t("signin.welcome_back")}
          </CardTitle>
          <CardDescription>{t("signin.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {serverConfig.demoMode && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-1">
                  <p className="font-semibold">{t("signin.demo_mode")}</p>
                  <p>
                    {t("signin.email")}: {serverConfig.demoMode.email}
                  </p>
                  <p>
                    {t("signin.password")}: {serverConfig.demoMode.password}
                  </p>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {wechatProvider && (
            <>
              <SignInProviderButton
                provider={{ id: wechatProvider.id, name: wechatProvider.name }}
                label={t("signin.wechat_login")}
                className="h-12 bg-[#07C160] text-lg hover:bg-[#06AD56]"
              />
              <div className="flex w-full items-center">
                <div className="flex-1 grow border-t border-gray-200"></div>
                <span className="bg-white px-3 text-sm text-gray-500">
                  {t("signin.or_email_password")}
                </span>
                <div className="flex-1 grow border-t border-gray-200"></div>
              </div>
            </>
          )}

          <CredentialsForm />

          {otherProviders && otherProviders.length > 0 && (
            <>
              <div className="flex w-full items-center">
                <div className="flex-1 grow border-t border-gray-200"></div>
                <span className="bg-white px-3 text-sm text-gray-500">
                  {t("signin.or")}
                </span>
                <div className="flex-1 grow border-t border-gray-200"></div>
              </div>
              <div className="space-y-2">
                {otherProviders.map((provider) => (
                  <SignInProviderButton
                    key={provider.id}
                    provider={{ id: provider.id, name: provider.name }}
                  />
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
