import { getClientId, getRedirectUri } from "@/lib/auth";

export function GET() {
  console.log("[contentful-bot] client metadata requested");

  const clientId = getClientId();
  const redirectUri = getRedirectUri();

  const metadata = {
    client_id: clientId,
    client_name: "Contentful Slack Bot",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  return Response.json(metadata, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
