// Resumable streaming is disabled because chat is proxied to n8n.
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response("Resumable streams are disabled.", { status: 410 });
}
