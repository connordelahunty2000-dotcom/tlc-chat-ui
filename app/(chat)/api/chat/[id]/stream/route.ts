// app/(chat)/api/chat/[id]/stream/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    { error: "Resumable streams are disabled." },
    { status: 404 }
  );
}
