// app/(chat)/api/chat/route.ts
import { NextRequest } from "next/server";

import { auth, type UserType } from "@/app/(auth)/auth";
import { ChatSDKError } from "@/lib/errors";
import {
  deleteChatById,
  getChatById,
  saveChat,
  saveMessages,
} from "@/lib/db/queries";
import { generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import {
  type PostRequestBody,
  postRequestBodySchema,
} from "./schema";

/**
 * Keep this (the UI reads it for function timeout on serverless).
 */
export const maxDuration = 60;

/**
 * Helper: normalize whatever n8n returns into a plain assistant string.
 * Supports JSON `{answer|text|content}`, or plain text.
 */
async function extractAssistantText(res: Response): Promise<string> {
  const ctype = res.headers.get("content-type") || "";
  try {
    if (ctype.includes("application/json")) {
      const json = await res.json();
      return (
        json?.answer ??
        json?.text ??
        json?.content ??
        JSON.stringify(json)
      );
    }
    // fallback to text (markdown OK)
    return await res.text();
  } catch {
    // last resort
    return await res.text();
  }
}

export async function POST(req: NextRequest) {
  // 1) Validate payload from the UI
  let body: PostRequestBody;
  try {
    const json = await req.json();
    body = postRequestBodySchema.parse(json);
  } catch {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  // 2) Check session
  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }
  const userId = session.user.id as string;
  const userType: UserType = session.user.type;

  // 3) Ensure chat exists (and belongs to this user); create with a title if needed
  const { id: chatId, message, selectedVisibilityType } = body;

  const existing = await getChatById({ id: chatId });
  if (existing) {
    if (existing.userId !== userId) {
      return new ChatSDKError("forbidden:chat").toResponse();
    }
  } else {
    const title = await generateTitleFromUserMessage({ message });
    await saveChat({
      id: chatId,
      userId,
      title,
      visibility: selectedVisibilityType,
    });
  }

  // 4) Save the user's message to DB (so history appears immediately)
  await saveMessages({
    messages: [
      {
        chatId,
        id: message.id,
        role: "user",
        parts: message.parts, // already in the UI format
        attachments: [],
        createdAt: new Date(),
      },
    ],
  });

  // 5) Forward the whole original payload to n8n
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return Response.json(
      { error: "Missing N8N_WEBHOOK_URL env var" },
      { status: 500 }
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.N8N_WEBHOOK_TOKEN) {
    headers.Authorization = `Bearer ${process.env.N8N_WEBHOOK_TOKEN}`;
  }

  let n8nResponse: Response;
  try {
    n8nResponse = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    return Response.json(
      { error: "Failed to reach n8n webhook", details: String(err?.message || err) },
      { status: 502 }
    );
  }

  // 6) Read the assistant text from n8n
  const assistantText = await extractAssistantText(n8nResponse);

  // 7) Persist the assistant message to DB
  const assistantMessageId = generateUUID();
  await saveMessages({
    messages: [
      {
        chatId,
        id: assistantMessageId,
        role: "assistant",
        parts: [
          {
            type: "text",
            text: assistantText,
          },
        ],
        attachments: [],
        createdAt: new Date(),
      },
    ],
  });

  // 8) Return a simple JSON payload to the UI.
  // (If you later want streaming, we can wrap this in SSE.)
  return Response.json(
    {
      id: assistantMessageId,
      role: "assistant",
      content: assistantText,
    },
    { status: n8nResponse.ok ? 200 : n8nResponse.status }
  );
}

/**
 * Keep the DELETE handler so the UI can delete chats.
 * (Unchanged from your template logic.)
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
