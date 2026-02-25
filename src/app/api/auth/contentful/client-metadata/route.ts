import { getClientId, getRedirectUri } from "@/lib/auth";

// OAuth 2.0 client metadata document - used as the client_id for the MCP server
// The MCP server fetches this URL to learn about our app (no pre-registration needed)
export function GET() {
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
