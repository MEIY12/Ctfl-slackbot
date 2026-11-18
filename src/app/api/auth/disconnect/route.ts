import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { handleDisconnect } from "@/lib/slack-home";

export async function POST(request: Request) {
  try {
    await handleDisconnect();
    revalidatePath("/connect");
    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("text/html")) {
      return NextResponse.redirect(new URL("/connect?disconnected=1", request.url), 303);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Disconnect failed";
    console.error("[contentful-bot] web disconnect failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}