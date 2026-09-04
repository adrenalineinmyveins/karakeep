import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authOptions } from "@/server/auth";
import { Info } from "lucide-react";

import serverConfig from "@saiye/shared/config";

import CredentialsForm from "./CredentialsForm";
import OAuthAutoRedirect from "./OAuthAutoRedirect";
import SignInProviderButton from "./SignInProviderButton";

export default async function SignInForm() {
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
          <CardTitle className="text-2xl font-bold">Welcome Back</CardTitle>
          <CardDescription>Sign in to your Saiye account</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {serverConfig.demoMode && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-1">
                  <p className="font-semibold">Demo Mode</p>
                  <p>Email: {serverConfig.demoMode.email}</p>
                  <p>Password: {serverConfig.demoMode.password}</p>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {wechatProvider && (
            <>
              <SignInProviderButton
                provider={{ id: wechatProvider.id, name: wechatProvider.name }}
                label="微信扫码登录"
                className="h-12 bg-[#07C160] text-lg hover:bg-[#06AD56]"
              />
              <div className="flex w-full items-center">
                <div className="flex-1 grow border-t border-gray-200"></div>
                <span className="bg-white px-3 text-sm text-gray-500">
                  或使用邮箱密码
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
                <span className="bg-white px-3 text-sm text-gray-500">Or</span>
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
