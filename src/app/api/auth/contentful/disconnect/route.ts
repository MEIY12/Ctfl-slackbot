import Redis from "ioredis";
import { clearToken } from "@/lib/auth";

export async function POST() {
  const redis = new Redis(process.env.REDIS_URL!);
  try {
    await clearToken(redis);
    return Response.json({ ok: true, message: "Disconnected from Contentful" });
  } finally {
    await redis.quit();
  }
}
